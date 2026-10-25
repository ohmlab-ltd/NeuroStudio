// A board on the network, through the app's own session, store and recorder.
// NEURO_STUDIO_LIVE=<host>:<port> runs these against it; without it they are skipped.
// USB stays off, so libusb is never loaded and no other USB device is touched.
//
// NEURO_STUDIO_LIVE_KEY        the board's link key, when it requires one
// NEURO_STUDIO_LIVE_RECORDING  keep the 10 s recording at this .mjpeg path
// NEURO_STUDIO_LIVE_WATCH_S    also follow the link this long, for a board reset

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DeviceSession, setUsbAllowed } from "../electron/device/session.cjs";
import { metaHasTlvType, VendorFramedParser } from "../electron/device/parser.cjs";
import { Recorder } from "../electron/recorder.cjs";
import * as store from "../src/state/device";
import { terminalLines } from "../src/state/terminal";
import { parseOverlayMeta } from "../src/device/tlv";
import {
  buildCameraControlPacket,
  buildTunePacket,
  parseTuneDescriptor,
  type TuneParam,
} from "../src/device/packets";
import type { DeviceEvent } from "../src/vite-env";

const nodeRequire = createRequire(import.meta.url);
const target = process.env.NEURO_STUDIO_LIVE ?? "";
const [host, portText] = target.split(":");
const port = Number(portText || 5000);
const linkKey = process.env.NEURO_STUDIO_LIVE_KEY;
const watchSeconds = Number(process.env.NEURO_STUDIO_LIVE_WATCH_S ?? 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text: string) => console.log(`[live] ${text}`);

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

describe.skipIf(!target)(`board at ${target}`, () => {
  let session: DeviceSession;
  let emitToStore: (event: DeviceEvent) => void = () => undefined;
  let stopStore: () => void = () => undefined;
  let usbRequested = 0;

  let frames = 0;
  const statuses: string[] = [];
  const logLines: string[] = [];
  let clearCaches = 0;
  /** Numbered Terminal lines as the board sent them, for the current boot. */
  const numbered = new Map<number, string>();
  /** Boot marks in the order they first arrived. */
  const bootMarks: number[] = [];
  let latestTune: TuneParam[] = [];
  /** Frames on the network link carrying 0x24, which a board sends over USB only. */
  let softApOnNetwork = 0;

  beforeAll(async () => {
    nodeRequire.cache[nodeRequire.resolve("usb")] = {
      get exports() {
        usbRequested += 1;
        return { getDeviceList: () => [] };
      },
    } as never;
    setUsbAllowed(false);

    session = new DeviceSession();
    // A second parser sees every frame the network delivers, before the session filters any.
    const raw = new VendorFramedParser();
    const ingest = session.ingestBytes.bind(session);
    session.ingestBytes = (chunk: Buffer) => {
      raw.feed(chunk);
      for (let pkt = raw.nextPacket(); pkt; pkt = raw.nextPacket()) {
        if (metaHasTlvType(pkt.meta, 0x24)) softApOnNetwork += 1;
      }
      ingest(chunk);
    };
    vi.stubGlobal("window", {
      neuro: {
        onEvent(listener: (event: DeviceEvent) => void) {
          emitToStore = listener;
          return () => undefined;
        },
        write: (bytes: Uint8Array) => session.write(Buffer.from(bytes)),
        setAutoRecover: () => undefined,
        setLinkKey: (keyHost: string, key: string) => session.setLinkKey(keyHost, key),
      },
    });
    // The canvas decode is a browser API; the rest of the frame path runs as in the app.
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ close: () => undefined }));
    stopStore = store.startDeviceStore();

    session.on("event", (event: DeviceEvent) => {
      if (event.t === "frame") frames += 1;
      else if (event.t === "status") statuses.push(event.text);
      else if (event.t === "logline") logLines.push(event.text);
      else if (event.t === "clear_caches") clearCaches += 1;
      else if (event.t === "tune_desc") latestTune = parseTuneDescriptor(event.data) ?? latestTune;
      else if (event.t === "link_key_needed" && linkKey) session.setLinkKey(event.host, linkKey);
      else if (event.t === "meta") {
        const debugLog = parseOverlayMeta(event.meta).debugLog;
        if (debugLog) {
          const boot = debugLog.boot;
          if (boot !== undefined && !bootMarks.includes(boot)) {
            if (bootMarks.length) numbered.clear(); // a restart: the store starts afresh too
            bootMarks.push(boot);
          }
          debugLog.lines.forEach((line, k) => numbered.set(debugLog.first + k, line));
        }
      }
      emitToStore(event);
    });

    await session.openTcp({ host, port });
  }, 20_000);

  afterAll(async () => {
    await session?.stop();
    stopStore();
    setUsbAllowed(true);
    delete nodeRequire.cache[nodeRequire.resolve("usb")];
    vi.unstubAllGlobals();
  });

  it("streams camera frames over TCP", async () => {
    const start = Date.now();
    expect(await until(() => frames >= 30, 15_000)).toBe(true);
    const fps = (frames * 1000) / (Date.now() - start);
    expect(session.tcpConnected).toBe(true);
    expect(session.ingestBadJpegs).toBe(0);
    const info = store.streamInfo.get();
    expect(info.width).toBeGreaterThan(0);
    expect(info.height).toBeGreaterThan(0);
    log(
      `${info.width}x${info.height}, ${fps.toFixed(1)} fps measured, ${info.fps.toFixed(1)} reported`,
    );
  }, 20_000);

  it("prints every numbered Terminal line once, in order", async () => {
    // A sketch that links PostProcess sends 0x71 about every 2 s; others send none.
    const sent = await until(() => numbered.size > 0, 6000);
    log(
      sent
        ? `0x71 lines arriving, boot marks ${bootMarks.join(", ") || "none (older firmware)"}`
        : "this sketch sends no 0x71",
    );
    if (!sent) return;
    await sleep(2500); // let a window or two slide
    const expected = [...numbered.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, line]) => line)
      .join("")
      .split("\n")
      .slice(0, -1);
    const shown = terminalLines().filter((line) => !/^\[(host|ui)\]/.test(line));
    expect(shown).toEqual(expected);
    expect(terminalLines().some((line) => /Terminal lines? lost/.test(line))).toBe(false);
    expect(bootMarks.length).toBeLessThanOrEqual(1);
  }, 12_000);

  it("keeps the link up through camera and tuning commands", async () => {
    // apply_mask 0: a well-formed CAM0 that changes nothing on the board.
    session.write(Buffer.from(buildCameraControlPacket({ flags: 0, applyMask: 0 })));
    const param = latestTune[0];
    if (param) {
      const original = param.current;
      const wanted = original === param.lo ? param.hi : param.lo;
      const sentAt = Date.now();
      session.write(Buffer.from(buildTunePacket(param.id, param.type, wanted)));
      const seen = await until(
        () => latestTune.find((p) => p.id === param.id)?.current === wanted,
        5000,
      );
      log(
        `TUN0 "${param.name}" ${original} -> ${wanted}: ` +
          (seen ? `echoed in the descriptor after ${Date.now() - sentAt} ms` : "not echoed in 5 s"),
      );
      expect(seen).toBe(true);
      session.write(Buffer.from(buildTunePacket(param.id, param.type, original)));
      await until(() => latestTune.find((p) => p.id === param.id)?.current === original, 5000);
    } else {
      log("this sketch registers no tuning parameters");
    }
    const before = frames;
    await sleep(1500);
    expect(session.tcpConnected).toBe(true);
    expect(frames).toBeGreaterThan(before);
    expect(logLines.filter((line) => line.startsWith("Command not sent"))).toEqual([]);
  }, 20_000);

  it("records every frame for 10 s, as the Record button does", async () => {
    const keep = process.env.NEURO_STUDIO_LIVE_RECORDING;
    const file = keep || path.join(os.tmpdir(), `neuro-studio-live-${Date.now()}.mjpeg`);
    const recorder = await Recorder.open(file);
    let bytes = 0;
    const shownBefore = frames;
    // As main.cjs wires it on recorder:start.
    session.frameSink = (jpeg: Buffer) => {
      recorder.append(jpeg);
      bytes += jpeg.length;
    };
    await sleep(10_000);
    session.frameSink = null;
    const shown = frames - shownBefore;
    const result = await recorder.stop();

    expect(result.error).toBeUndefined();
    expect(result.droppedFrames).toBe(0);
    expect(result.frames).toBeGreaterThan(0);
    // The window may show fewer frames than arrive; the file keeps them all.
    expect(result.frames).toBeGreaterThanOrEqual(shown);
    const data = fs.readFileSync(file);
    expect(data.length).toBe(bytes);
    expect([data[0], data[1]]).toEqual([0xff, 0xd8]);
    expect([data.at(-2), data.at(-1)]).toEqual([0xff, 0xd9]);
    log(
      `recorded ${result.frames} frames (${(result.frames / 10).toFixed(1)} fps), ` +
        `${bytes} bytes; the window showed ${shown}${keep ? `; kept at ${file}` : ""}`,
    );
    if (!keep) fs.rmSync(file);
  }, 20_000);

  it("closes and reconnects cleanly", async () => {
    const clearsBefore = clearCaches;
    await session.close();
    expect(session.tcpConnected).toBe(false);
    expect(clearCaches).toBe(clearsBefore + 1);
    const before = frames;
    await session.openTcp({ host, port });
    expect(await until(() => frames > before + 10, 15_000)).toBe(true);
    log(`reconnected; statuses ${statuses.slice(-3).join(" | ")}`);
  }, 25_000);

  it.skipIf(!watchSeconds)(
    "follows a board reset",
    async () => {
      // The mark of the boot before the reset, so a later one can be told apart.
      await until(() => bootMarks.length > 0, 6000);
      const marksBefore = bootMarks.length;
      const statusesBefore = statuses.length;
      log(
        `watching ${watchSeconds} s from boot mark ${bootMarks.at(-1) ?? "none"}: reset the board now`,
      );
      await sleep(watchSeconds * 1000);
      log(`statuses: ${statuses.slice(statusesBefore).join(" | ") || "none"}`);
      log(`boot marks: ${bootMarks.join(", ")}`);
      const restarted = marksBefore > 0 && bootMarks.length > marksBefore;
      log(restarted ? "the boot mark changed" : "no new boot mark seen");
      if (!restarted) return;
      const before = frames;
      expect(await until(() => frames > before, 15_000)).toBe(true);
      expect(terminalLines().some((line) => /Terminal lines? lost/.test(line))).toBe(false);
    },
    (watchSeconds + 30) * 1000,
  );

  it("never received the network's password over the network", () => {
    expect(softApOnNetwork).toBe(0);
    expect(store.boardWifiNetwork.get()).toBeNull();
  });

  it("never loaded libusb", () => {
    expect(usbRequested).toBe(0);
  });
});
