// Device store state: link status, liveness, decodes, the Terminal store and audio playback.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../src/state/device";
import {
  appendTerminal,
  clearTerminal,
  terminalChunks,
  terminalFullText,
  terminalLength,
  terminalLines,
  terminalVersion,
} from "../src/state/terminal";
import { audioPlayback, MAX_LEAD_SECONDS } from "../src/audio/playback";
import type { DeviceEvent } from "../src/vite-env";
import { ascii, tlv, u16, u32 } from "./bytes";

let emit: (event: DeviceEvent) => void = () => undefined;
let stop: () => void = () => undefined;

/** createImageBitmap stub whose decodes finish only when the test says so. */
interface PendingDecode {
  bitmap: { close: ReturnType<typeof vi.fn> };
  finish: () => void;
}
const decodes: PendingDecode[] = [];

beforeAll(() => {
  vi.stubGlobal("window", {
    neuro: {
      onEvent(listener: (event: DeviceEvent) => void) {
        emit = listener;
        return () => undefined;
      },
    },
  });
  vi.stubGlobal("createImageBitmap", () => {
    const bitmap = { close: vi.fn() };
    return new Promise((resolve) => {
      decodes.push({ bitmap, finish: () => resolve(bitmap) });
    });
  });
  stop = store.startDeviceStore();
});

afterAll(() => {
  stop();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  emit({ t: "clear_caches" });
  emit({ t: "status", text: "Closed" });
});

// Finish anything a test left in flight so the next one starts idle.
afterEach(async () => {
  while (decodes.length) {
    decodes.shift()!.finish();
    await settle();
  }
});

function meta(jpegLen: number, ...parts: number[][]): void {
  const bytes = new Uint8Array(parts.flat());
  emit({ t: "meta", id: 1, metaLen: bytes.length, jpegLen, meta: bytes });
}

function frame(): void {
  emit({ t: "frame", jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const audioClassTlv = tlv(0x51, [1, 0, ...u16(10), ...u16(500), ...u16(900)]);
const tofTlv = tlv(0x15, [1, 1, 8, 8, ...u32(1234)]);
const eventTlv = tlv(0x67, [...u32(7), ...u32(0), 1, 0, ...u16(0), ...u16(0), ...u16(0), 0]);
const imuTlv = tlv(0x1b, new Array<number>(28).fill(0));
const debugTlv = (text: string) => tlv(0x17, ascii(text));

describe("link status", () => {
  const cases: [string, store.LinkState][] = [
    ["Connected over USB", "connected"],
    ["Connected", "connected"],
    ["Connecting over USB…", "connecting"],
    ["Connecting TCP 192.168.10.1:5000…", "connecting"],
    ["Reconnecting", "connecting"],
    ["Waiting for a board on USB", "connecting"],
    ["Waiting for the board on USB port 1-3", "connecting"],
    ["USB silent, recovering", "connecting"],
    ["Disconnected", "disconnected"],
    ["Disconnected: the bootloader tool has the board", "disconnected"],
    ["Device removed", "disconnected"],
    ["Closed", "disconnected"],
    ["USB read error: -1", "disconnected"],
    ["USB poll failed: boom", "disconnected"],
    ["USB unrecoverable, restarting transport", "disconnected"],
    ["Enumeration failed: boom", "disconnected"],
    ["Connect exception: boom", "disconnected"],
    ["TCP connect to 192.168.10.1:5000 timed out", "disconnected"],
    ["TCP connect failed: ECONNREFUSED", "disconnected"],
    ["TCP connect exception: boom", "disconnected"],
    ["TCP error: ECONNRESET", "disconnected"],
    ["TCP disconnected", "disconnected"],
    ["Couldn't open the board: LIBUSB_ERROR_ACCESS", "disconnected"],
    ["claimInterface(0) failed: busy (driver/permissions?)", "disconnected"],
    ["Failed to load libusb: missing", "disconnected"],
    ["Board 1-3 is in use by another window", "disconnected"],
  ];

  it.each(cases)("classifies %s", (text, state) => {
    expect(store.linkStateOf(text)).toBe(state);
  });

  it.each(cases)("leaves exactly one flag state after %s", (text, state) => {
    // Start from each of the other states so nothing can be left over.
    for (const before of ["Connected (x)", "Connecting (x) ...", "Closed"]) {
      emit({ t: "status", text: before });
      emit({ t: "status", text });
      const conn = store.connection.get();
      expect(conn.status).toBe(text);
      expect(conn.connected).toBe(state === "connected");
      expect(conn.connecting).toBe(state === "connecting");
    }
  });

  it("keeps connecting set through the no-board retry loop", () => {
    for (let i = 0; i < 3; i++) {
      emit({ t: "status", text: "Connecting over USB…" });
      emit({ t: "clear_caches" });
      emit({ t: "status", text: "Waiting for a board on USB" });
      expect(store.connection.get().connecting).toBe(true);
      expect(store.connection.get().connected).toBe(false);
    }
  });

  it("clears the live frame on every status that means the link is gone", () => {
    for (const text of ["USB read error: -1", "TCP connect to h:1 timed out", "Closed"]) {
      emit({ t: "status", text: "Connected" });
      frame();
      expect(store.live.jpeg).not.toBeNull();
      expect(store.connection.get().hasRecentFrame).toBe(true);
      emit({ t: "status", text });
      expect(store.live.jpeg).toBeNull();
      expect(store.live.lastFrameAt).toBe(0);
      expect(store.connection.get().hasRecentFrame).toBe(false);
    }
  });
});

describe("the network the board hosts", () => {
  const network = { ssid: "Bench-AP", password: "s3cret-Pass" };

  beforeEach(() => {
    store.transportState.set({ ...store.transportState.get(), mode: "usb" });
    emit({ t: "status", text: "Connected over USB" });
  });

  it("is learned over USB and connects WiFi to the announced address", () => {
    expect(store.wifiTarget()).toEqual(store.WIFI_DEFAULT);
    emit({ t: "board_ip", host: "192.168.23.1", port: 5001 });
    emit({ t: "board_softap", ...network });
    expect(store.boardWifiNetwork.get()).toEqual(network);
    expect(store.wifiTarget()).toEqual({ host: "192.168.23.1", port: 5001 });
  });

  it("notifies only when the board's answer changes", () => {
    emit({ t: "board_softap", ...network });
    const listener = vi.fn();
    const unsubscribe = store.boardWifiNetwork.subscribe(listener);
    emit({ t: "board_softap", ...network });
    expect(listener).not.toHaveBeenCalled();
    emit({ t: "board_softap", ...network, password: "an0ther-Pass" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("outlives the switch to WiFi and a lost USB link", () => {
    emit({ t: "board_ip", host: "192.168.23.1", port: 5000 });
    emit({ t: "board_softap", ...network });
    emit({ t: "status", text: "USB read error: -1" });
    store.transportState.set({ ...store.transportState.get(), mode: "wifi" });
    emit({ t: "status", text: "Connected" });
    expect(store.boardWifiNetwork.get()).toEqual(network);
    expect(store.wifiTarget()).toEqual({ host: "192.168.23.1", port: 5000 });
  });

  it("is forgotten on the next USB link, which may be another board", () => {
    emit({ t: "board_ip", host: "192.168.23.1", port: 5000 });
    emit({ t: "board_softap", ...network });
    emit({ t: "status", text: "Connecting over USB…" });
    emit({ t: "status", text: "Connected over USB" });
    expect(store.boardWifiNetwork.get()).toBeNull();
    expect(store.wifiTarget()).toEqual(store.WIFI_DEFAULT);
  });
});

describe("liveness on a board without a camera", () => {
  beforeEach(() => emit({ t: "status", text: "Connected over USB" }));

  it.each([
    ["audio classifier", audioClassTlv],
    ["ToF", tofTlv],
    ["board event", eventTlv],
    ["IMU", imuTlv],
  ])("counts a %s packet as a live stream", (_name, data) => {
    expect(store.connection.get().hasRecentFrame).toBe(false);
    meta(0, data);
    expect(store.live.lastFrameAt).toBeGreaterThan(0);
    expect(store.connection.get().hasRecentFrame).toBe(true);
    expect(store.connection.get().connected).toBe(true);
  });

  it("counts microphone audio as a live stream", () => {
    emit({ t: "audio", id: 1, rate: 16000, channels: 1, pcm: new Uint8Array(64) });
    expect(store.connection.get().hasRecentFrame).toBe(true);
  });

  it("counts what the packet carried, not values held from earlier packets", () => {
    meta(0, imuTlv);
    store.live.lastFrameAt = 0;
    meta(0, debugTlv("still here\n"));
    expect(store.live.lastFrameAt).toBe(0);
  });

  it("counts only camera frames once a camera frame has been seen", () => {
    frame();
    store.live.lastFrameAt = 0;
    meta(0, audioClassTlv);
    emit({ t: "audio", id: 1, rate: 16000, channels: 1, pcm: new Uint8Array(64) });
    expect(store.live.lastFrameAt).toBe(0);
  });
});

describe("camera decode after a disconnect", () => {
  it.each(["status", "clear_caches"] as const)(
    "drops a decode that finishes after %s",
    async (kind) => {
      emit({ t: "status", text: "Connected" });
      frame(); // in flight
      frame(); // queued behind it
      expect(decodes).toHaveLength(1);

      if (kind === "status") emit({ t: "status", text: "Device removed" });
      else emit({ t: "clear_caches" });

      const stale = decodes.shift()!;
      stale.finish();
      await settle();
      expect(store.live.cameraBitmap).toBeNull();
      expect(stale.bitmap.close).toHaveBeenCalled();
      // The queued stale frame is not decoded either.
      expect(decodes).toHaveLength(0);
    },
  );

  it("decodes a new session's frame queued behind a stale decode", async () => {
    emit({ t: "status", text: "Connected" });
    frame();
    emit({ t: "clear_caches" });
    frame(); // new session, queued behind the stale decode
    decodes.shift()!.finish();
    await settle();
    expect(store.live.cameraBitmap).toBeNull();
    expect(decodes).toHaveLength(1);
    const fresh = decodes.shift()!;
    fresh.finish();
    await settle();
    expect(store.live.cameraBitmap).toBe(fresh.bitmap);
  });
});

describe("streamInfo", () => {
  it("resets on clear_caches", () => {
    emit({ t: "stream_info", w: 1120, h: 1364, fps: 30 });
    expect(store.streamInfo.get()).toEqual({ width: 1120, height: 1364, fps: 30 });
    emit({ t: "clear_caches" });
    expect(store.streamInfo.get()).toEqual({ width: 0, height: 0, fps: 0 });
  });
});

describe("debug text", () => {
  beforeEach(() => clearTerminal());

  it("appends a repeated chunk once", () => {
    for (let i = 0; i < 6; i++) meta(4096, tlv(0x01, u16(12)), debugTlv("person locked\n"));
    expect(terminalLines()).toEqual(["person locked"]);
  });

  it("is not reset by packets without debug text", () => {
    meta(4096, debugTlv("a\n"));
    meta(0, imuTlv);
    meta(4096, debugTlv("a\n"));
    meta(4096, debugTlv("b\n"));
    expect(terminalLines()).toEqual(["a", "b"]);
  });

  it("shows the same chunk again after a reconnect", () => {
    meta(0, debugTlv("hello\n"));
    emit({ t: "clear_caches" });
    meta(0, debugTlv("hello\n"));
    expect(terminalLines()).toEqual(["hello", "hello"]);
  });
});

describe("terminal store", () => {
  beforeEach(() => clearTerminal());

  it("caps the line count and keeps the newest lines", () => {
    for (let i = 0; i < 12000; i++) appendTerminal(`line ${i}\n`);
    const length = terminalLength();
    expect(length).toBeLessThanOrEqual(5000);
    expect(length).toBeGreaterThan(4500);
    const lines = terminalLines();
    expect(lines).toHaveLength(length);
    expect(lines[lines.length - 1]).toBe("line 11999");
    expect(lines[0]).toBe(`line ${12000 - length}`);
  });

  it("keeps existing chunks untouched when appending at the cap", () => {
    for (let i = 0; i < 5000; i++) appendTerminal(`line ${i}\n`);
    const before = [...terminalChunks()];
    const snapshot = before.map((chunk) => [...chunk.lines]);
    appendTerminal("one more\n");
    const after = terminalChunks();
    // At most the oldest chunk goes; every other is the same object with the same lines.
    const dropped = before.length + 1 - after.length;
    expect(dropped).toBeLessThanOrEqual(1);
    for (let i = dropped; i < before.length; i++) {
      expect(after[i - dropped]).toBe(before[i]);
      expect(after[i - dropped].lines).toEqual(snapshot[i]);
    }
    expect(terminalLines().at(-1)).toBe("one more");
  });

  it("joins a line split across chunks and keeps the trailing fragment", () => {
    appendTerminal("hel");
    expect(terminalLength()).toBe(0);
    appendTerminal("lo\nwor");
    expect(terminalLines()).toEqual(["hello"]);
    expect(terminalFullText()).toBe("hello\nwor");
    clearTerminal();
    appendTerminal("partial");
    expect(terminalFullText()).toBe("partial");
  });

  it("notifies once per batch of appends, and not for a partial line", () => {
    vi.useFakeTimers();
    try {
      clearTerminal();
      const start = terminalVersion.get();
      appendTerminal("partial");
      vi.advanceTimersByTime(50);
      expect(terminalVersion.get()).toBe(start);
      for (let i = 0; i < 100; i++) appendTerminal(`line ${i}\n`);
      expect(terminalVersion.get()).toBe(start);
      vi.advanceTimersByTime(50);
      expect(terminalVersion.get()).toBe(start + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface Scheduled {
  start: number;
  duration: number;
  at: number;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  state: AudioContextState = "running";
  readonly destination = {};
  readonly scheduled: Scheduled[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }

  createBuffer(channels: number, frames: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { duration: frames / rate, getChannelData: (i: number) => data[i] };
  }

  createBufferSource() {
    const source = {
      buffer: null as { duration: number } | null,
      connect() {},
      start: (when: number) => {
        this.scheduled.push({
          start: when,
          duration: source.buffer!.duration,
          at: this.currentTime,
        });
      },
    };
    return source;
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }

  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

describe("audio playback", () => {
  const DECLARED = 32552;
  const ACTUAL = 32590; // the device runs slightly fast
  const FRAMES = 1024;
  const pcm = new Uint8Array(FRAMES * 2);

  beforeAll(() => vi.stubGlobal("AudioContext", FakeAudioContext));

  beforeEach(async () => {
    FakeAudioContext.instances.length = 0;
    await audioPlayback.reset();
    await audioPlayback.setListening(true);
  });

  afterAll(async () => {
    await audioPlayback.setListening(false);
  });

  function expectNoOverlap(scheduled: Scheduled[]): void {
    for (let i = 1; i < scheduled.length; i++) {
      const prev = scheduled[i - 1];
      expect(scheduled[i].start).toBeGreaterThanOrEqual(prev.start + prev.duration - 1e-9);
    }
  }

  function maxLead(scheduled: Scheduled[]): number {
    return Math.max(...scheduled.map((s) => s.start - s.at));
  }

  it("never overlaps and stays bounded while the device clock runs fast", () => {
    const seconds = 450;
    const chunks = Math.floor((seconds * ACTUAL) / FRAMES);
    for (let k = 0; k < chunks; k++) {
      const ctx = FakeAudioContext.instances[0];
      if (ctx) ctx.currentTime = (k * FRAMES) / ACTUAL;
      audioPlayback.feed(pcm, DECLARED, 1);
    }
    const ctx = FakeAudioContext.instances[0];
    expect(FakeAudioContext.instances).toHaveLength(1);
    expectNoOverlap(ctx.scheduled);
    expect(maxLead(ctx.scheduled)).toBeLessThanOrEqual(MAX_LEAD_SECONDS + 1e-9);
    // Only the drift is dropped: about 1.2 ms per second.
    expect(chunks - ctx.scheduled.length).toBeLessThan(30);
  });

  it("drops a burst after a stall instead of scheduling over queued audio", () => {
    let t = 0;
    const step = FRAMES / DECLARED;
    for (let k = 0; k < 100; k++, t += step) {
      const ctx = FakeAudioContext.instances[0];
      if (ctx) ctx.currentTime = t;
      audioPlayback.feed(pcm, DECLARED, 1);
    }
    // A 0.8 s stall, then its backlog arrives at once.
    const ctx = FakeAudioContext.instances[0];
    ctx.currentTime = t + 0.8;
    for (let k = 0; k < Math.ceil(0.8 / step); k++) audioPlayback.feed(pcm, DECLARED, 1);
    expectNoOverlap(ctx.scheduled);
    expect(maxLead(ctx.scheduled)).toBeLessThanOrEqual(MAX_LEAD_SECONDS + 1e-9);
  });

  it("discards queued audio on mute, so unmuting starts from an empty queue", async () => {
    for (let k = 0; k < 10; k++) audioPlayback.feed(pcm, DECLARED, 1);
    const first = FakeAudioContext.instances[0];
    expect(first.scheduled.length).toBeGreaterThan(0);

    await audioPlayback.setListening(false);
    expect(first.state).toBe("closed");
    audioPlayback.feed(pcm, DECLARED, 1); // ignored while muted

    await audioPlayback.setListening(true);
    audioPlayback.feed(pcm, DECLARED, 1);
    expect(FakeAudioContext.instances).toHaveLength(2);
    const second = FakeAudioContext.instances[1];
    expect(second.scheduled).toHaveLength(1);
    expect(second.scheduled[0].start).toBeCloseTo(0.15, 9);
  });
});
