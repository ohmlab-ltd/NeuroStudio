// Board captures replayed through the ingest and the device store, read by read.
// NEURO_STUDIO_CAPTURES names a folder of <name>.bin, the bytes received, and <name>.json.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DeviceSession } from "../electron/device/session.cjs";
import * as store from "../src/state/device";
import { parseOverlayMeta } from "../src/device/tlv";
import { parseTuneDescriptor, type TuneParam } from "../src/device/packets";
import { clearTerminal, terminalFullText } from "../src/state/terminal";
import type { DeviceEvent } from "../src/vite-env";

interface Capture {
  transport: "usb" | "tcp";
  sketch: string;
  bytes: number;
  frames: number;
  /** [length, ms since the capture started] per read. */
  reads: [number, number][];
  sent: { t_ms: number; hex: string; ok: boolean }[];
  observed: {
    frames: number;
    jpeg: number;
    with_boxes: number;
    class_strs: number;
    classes: Record<string, number>;
    /** [id, type, hint, name, lo, hi, current] from the last descriptor. */
    tune: [number, number, number, string, number, number, number][];
    tags: Record<string, number>;
  };
}

/** No reconnect loops: the replay drives the parser directly. */
class ReplaySession extends DeviceSession {
  _startLoops() {}
}

const dir = process.env.NEURO_STUDIO_CAPTURES ?? "";
const names = dir
  ? fs
      .readdirSync(dir)
      .filter(
        (f) => f.endsWith(".json") && fs.existsSync(path.join(dir, f.replace(/json$/, "bin"))),
      )
      .map((f) => f.slice(0, -".json".length))
      .sort()
  : [];

describe.skipIf(names.length === 0)("board captures", () => {
  let emit: (event: DeviceEvent) => void = () => undefined;
  let stop: () => void = () => undefined;

  beforeAll(() => {
    vi.stubGlobal("window", {
      neuro: {
        onEvent(listener: (event: DeviceEvent) => void) {
          emit = listener;
          return () => undefined;
        },
        write: () => undefined,
        setAutoRecover: () => undefined,
      },
    });
    stop = store.startDeviceStore();
  });

  afterAll(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it.each(names)("%s", (name) => {
    const capture = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")) as Capture;
    const bytes = fs.readFileSync(path.join(dir, `${name}.bin`));
    expect(bytes.length).toBe(capture.bytes);

    emit({ t: "clear_caches" });
    clearTerminal();

    const session = new ReplaySession();
    session.transport = capture.transport;
    let frames = 0;
    const labels = new Map<string, number>();
    const descriptors: TuneParam[][] = [];
    const boardIps = new Set<string>();
    session.on("event", (event: DeviceEvent) => {
      // The canvas decode needs a browser; count camera frames instead.
      if (event.t === "frame") {
        frames += 1;
        return;
      }
      if (event.t === "meta" && event.jpegLen > 0) {
        for (const box of parseOverlayMeta(event.meta).overlay.boxes) {
          if (box.label) labels.set(box.label, (labels.get(box.label) ?? 0) + 1);
        }
      }
      if (event.t === "tune_desc") {
        const parsed = parseTuneDescriptor(event.data);
        if (parsed) descriptors.push(parsed);
      }
      if (event.t === "board_ip") boardIps.add(`${event.host}:${event.port}`);
      emit(event);
    });

    let offset = 0;
    for (const [length] of capture.reads) {
      session.ingestBytes(bytes.subarray(offset, offset + length));
      offset += length;
    }
    expect(offset).toBe(bytes.length);

    expect(session.ingestPackets).toBe(capture.observed.frames);
    expect(session.ingestBadJpegs).toBe(0);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(capture.observed.jpeg);
    expect(store.streamInfo.get().width).toBeGreaterThan(0);

    for (const label of Object.keys(capture.observed.classes)) {
      expect(labels.get(label) ?? 0, label).toBeGreaterThan(0);
    }

    const [id, type, hint, tuneName, lo, hi, current] = capture.observed.tune[0];
    expect(store.tuneParams.get().map((p) => ({ ...p, current: 0 }))).toEqual([
      { id, type, hint, name: tuneName, lo, hi, current: 0 },
    ]);
    expect(descriptors.at(-1)?.[0].current).toBe(current);

    // A WiFi board announces where it is.
    if (capture.observed.tags["0x20"]) expect([...boardIps]).toEqual(["192.168.10.1:5000"]);

    // The numbered Terminal log arrives whole.
    expect(terminalFullText()).not.toMatch(/Terminal lines? lost/);

    void session.stop();
  });
});
