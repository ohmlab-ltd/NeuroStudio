// Which vendor frames reach the renderer as 'meta' events, and the Terminal heartbeat.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceSession } from "../electron/device/session.cjs";
import { u16, u32 } from "./bytes";

/** Never touches USB or TCP: only the ingest path runs. */
class IngestOnlySession extends DeviceSession {
  _startLoops() {}
}

interface Emitted {
  t: string;
  id?: number;
  jpegLen?: number;
}

const tlv = (type: number, len: number) => [type, ...u16(len), ...new Array<number>(len).fill(0)];

const BOXES = tlv(0x02, 1);
const MAG = tlv(0x1a, 16);
const DEBUG_TEXT = tlv(0x17, 4);
const DEBUG_LOG = tlv(0x71, 5);
const AUDIO_CLASS = tlv(0x51, 6);
const AUDIO_MEL = tlv(0x52, 4);
const AUDIO_LABELS = tlv(0x53, 1);
const IMAGE_CLASS = tlv(0x54, 6);
const EVENT = tlv(0x67, 17);
const CAM_CAPS = tlv(0x64, 1);
const BOARD_IP = [0x20, ...u16(8), 192, 168, 1, 110, ...u32(5000)];

/** Smallest payload looksLikeJpeg accepts: SOI, filler, EOI, 200 bytes. */
const JPEG = [0xff, 0xd8, ...new Array<number>(196).fill(0), 0xff, 0xd9];

function vendorFrame(id: number, meta: number[], jpeg: number[] = []): number[] {
  return [
    ...u32(0x30564e44),
    ...u32(id),
    ...u32(meta.length),
    ...u32(jpeg.length),
    ...u32(0),
    ...meta,
    ...jpeg,
  ];
}

function ingest(...frames: number[][]): Emitted[] {
  const session = new IngestOnlySession();
  const events: Emitted[] = [];
  session.on("event", (e: Emitted) => events.push(e));
  session.ingestBytes(Buffer.from(frames.flat()));
  return events;
}

const metas = (events: Emitted[]) => events.filter((e) => e.t === "meta");

describe("the recording sink", () => {
  it("gets every JPEG in a read, while the window gets only the newest", () => {
    const session = new IngestOnlySession();
    const events: Emitted[] = [];
    session.on("event", (e: Emitted) => events.push(e));
    const recorded: number[] = [];
    session.frameSink = (jpeg: Buffer) => recorded.push(jpeg.length);
    const jpeg = (n: number) => [0xff, 0xd8, ...new Array<number>(196 + n).fill(0), 0xff, 0xd9];

    // Three frames arrive in one read, as on a bursty link.
    session.ingestBytes(
      Buffer.from([
        ...vendorFrame(1, [], jpeg(1)),
        ...vendorFrame(2, CAM_CAPS),
        ...vendorFrame(3, [], jpeg(2)),
        ...vendorFrame(4, [], jpeg(3)),
      ]),
    );

    expect(recorded).toEqual([201, 202, 203]);
    expect(events.filter((e) => e.t === "frame")).toHaveLength(1);
  });

  it("skips a corrupt JPEG, and a failing sink does not stop the stream", () => {
    const session = new IngestOnlySession();
    const events: Emitted[] = [];
    session.on("event", (e: Emitted) => events.push(e));
    session.frameSink = () => {
      throw new Error("disk gone");
    };
    const corrupt = [0x00, ...JPEG.slice(1)];

    session.ingestBytes(Buffer.from([...vendorFrame(1, [], corrupt), ...vendorFrame(2, [], JPEG)]));

    expect(session.ingestBadJpegs).toBe(1);
    expect(events.filter((e) => e.t === "frame")).toHaveLength(1);
  });
});

describe("camera-less frames", () => {
  it("forwards a board event announce", () => {
    const out = metas(ingest(vendorFrame(1, EVENT)));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, jpegLen: 0 });
  });

  it("forwards each classifier TLV", () => {
    for (const meta of [AUDIO_CLASS, AUDIO_MEL, AUDIO_LABELS, IMAGE_CLASS]) {
      expect(metas(ingest(vendorFrame(2, meta)))).toHaveLength(1);
    }
  });

  it("still forwards sensor frames and Terminal text", () => {
    for (const meta of [MAG, DEBUG_TEXT, DEBUG_LOG]) {
      expect(metas(ingest(vendorFrame(5, meta)))).toHaveLength(1);
    }
  });

  it("stops looking at a truncated TLV", () => {
    // A value length running past the meta hides the event behind it.
    const broken = [0x02, ...u16(200), 0, 0];
    expect(metas(ingest(vendorFrame(6, [...broken, ...EVENT])))).toHaveLength(0);
  });

  it("keeps control-only frames control-only", () => {
    const out = ingest(vendorFrame(3, BOARD_IP), vendorFrame(4, CAM_CAPS));
    expect(metas(out)).toHaveLength(0);
    expect(out.some((e) => e.t === "board_ip")).toBe(true);
  });
});

describe("the network the board hosts", () => {
  const softAp = (ssid: number[], password: number[]) => [
    0x24,
    ...u16(2 + ssid.length + password.length),
    ssid.length,
    ...ssid,
    password.length,
    ...password,
  ];
  const ascii = (text: string) => [...Buffer.from(text, "latin1")];
  const BENCH = softAp(ascii("Bench-AP"), ascii("s3cret-Pass"));

  function ingestOver(transport: "usb" | "tcp", ...frames: number[][]) {
    const session = new IngestOnlySession();
    session.transport = transport;
    const events: Record<string, unknown>[] = [];
    session.on("event", (e: Record<string, unknown>) => events.push(e));
    session.ingestBytes(Buffer.from(frames.flat()));
    return events.filter((e) => e.t === "board_softap" || e.t === "board_ip");
  }

  it("is read from a camera-less frame over USB, and goes to no meta event", () => {
    const events = ingestOver("usb", vendorFrame(1, BENCH), vendorFrame(2, BOARD_IP));
    expect(events).toEqual([
      { t: "board_softap", ssid: "Bench-AP", password: "s3cret-Pass" },
      { t: "board_ip", host: "192.168.1.110", port: 5000 },
    ]);
    expect(metas(ingest(vendorFrame(1, BENCH)))).toHaveLength(0);
  });

  it("is ignored over the network", () => {
    expect(ingestOver("tcp", vendorFrame(1, BENCH), vendorFrame(2, BOARD_IP))).toEqual([]);
    expect(ingestOver("tcp", vendorFrame(3, BOARD_IP, JPEG))).toEqual([]);
  });

  it("keeps the bytes of the SSID and the passphrase as sent", () => {
    const ssid = [...Buffer.from("Café-AP", "utf8")];
    const hex = ascii("0123456789abcdef".repeat(4));
    expect(ingestOver("usb", vendorFrame(1, softAp(ssid, hex)))).toEqual([
      { t: "board_softap", ssid: "Café-AP", password: "0123456789abcdef".repeat(4) },
    ]);
    // Bytes that are not UTF-8 show as U+FFFD.
    expect(ingestOver("usb", vendorFrame(1, softAp([0x41, 0xff], ascii("password"))))).toEqual([
      { t: "board_softap", ssid: "A\uFFFD", password: "password" },
    ]);
  });

  it.each([
    ["an empty SSID", softAp([], ascii("password"))],
    ["a 33-byte SSID", softAp(new Array<number>(33).fill(0x41), ascii("password"))],
    ["a 7-character passphrase", softAp(ascii("AP"), ascii("passwor"))],
    ["a 65-character passphrase", softAp(ascii("AP"), new Array<number>(65).fill(0x61))],
    ["a value cut short", [0x24, ...u16(5), 2, 0x41, 0x50, 8, 0x61]],
    ["trailing bytes", [0x24, ...u16(13), 2, 0x41, 0x50, 8, ...ascii("password"), 0]],
  ])("drops %s", (_name, record) => {
    expect(ingestOver("usb", vendorFrame(1, record))).toEqual([]);
  });
});

describe("video frames", () => {
  it("delivers an event riding a frame the queue coalesces away", () => {
    const out = ingest(vendorFrame(10, [...BOXES, ...EVENT], JPEG), vendorFrame(11, BOXES, JPEG));
    expect(metas(out).map((e) => e.id)).toEqual([10, 11]);
    expect(out.filter((e) => e.t === "frame")).toHaveLength(1);
  });

  it("still drops the meta of a plain coalesced frame", () => {
    const out = ingest(vendorFrame(10, BOXES, JPEG), vendorFrame(11, BOXES, JPEG));
    expect(metas(out).map((e) => e.id)).toEqual([11]);
  });

  it("sends the newest frame's meta once when it carries audio", () => {
    const out = ingest(vendorFrame(20, [...BOXES, ...AUDIO_CLASS], JPEG));
    expect(metas(out)).toEqual([expect.objectContaining({ id: 20, jpegLen: JPEG.length })]);
  });
});

describe("the Terminal heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  /** `seconds` of a 45 fps stream, then the ingest lines it printed. */
  function run(seconds: number, bad: (second: number) => boolean = () => false) {
    vi.useFakeTimers({ toFake: ["Date"] });
    const session = new IngestOnlySession();
    const lines: { second: number; text: string }[] = [];
    let second = 0;
    session.on("event", (e: { t: string; text?: string }) => {
      if (e.t === "logline" && e.text?.startsWith("ingest:")) lines.push({ second, text: e.text });
    });
    for (second = 0; second < seconds; second++) {
      for (let k = 0; k < 45; k++) {
        vi.setSystemTime(1_000_000 + second * 1000 + k * 22);
        const jpeg = bad(second) && k === 0 ? [0xff, 0xd8, ...JPEG.slice(2, -2), 0, 0] : JPEG;
        session.ingestBytes(Buffer.from(vendorFrame(second * 45 + k, BOXES, jpeg)));
      }
    }
    return lines;
  }

  it("prints the counts every 10 s while the stream is healthy", () => {
    expect(run(25).map((l) => l.second)).toEqual([0, 10, 20]);
  });

  it("prints at once when a JPEG is rejected", () => {
    const lines = run(25, (second) => second === 4);
    expect(lines.map((l) => l.second)).toEqual([0, 4, 14, 24]);
    expect(lines[1].text).toContain("badJpeg=1");
  });
});
