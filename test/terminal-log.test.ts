// Terminal lines through the device store. Each frame's debug slot carries
// META_DEBUG_TEXT 0x17, the latest line, and META_DEBUG_LOG 0x71, every recent line numbered.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../src/state/device";
import { kMetaDebugLog, parseOverlayMeta } from "../src/device/tlv";
import { clearTerminal, terminalLines } from "../src/state/terminal";
import type { DeviceEvent } from "../src/vite-env";
import { ascii, bytes, tlv, u32 } from "./bytes";

let emit: (event: DeviceEvent) => void = () => undefined;
let stop: () => void = () => undefined;

beforeAll(() => {
  vi.stubGlobal("window", {
    neuro: {
      onEvent(listener: (event: DeviceEvent) => void) {
        emit = listener;
        return () => undefined;
      },
    },
  });
  stop = store.startDeviceStore();
});

afterAll(() => {
  stop();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  emit({ t: "clear_caches" });
  clearTerminal();
});

/**
 * META_DEBUG_LOG value: u32 first number, u8 count, u8 length + text per line,
 * then the u8 boot mark, which older firmware does not send.
 */
const debugLog = (first: number, lines: string[], boot?: number) => [
  ...u32(first),
  lines.length,
  ...lines.flatMap((line) => [line.length, ...ascii(line)]),
  ...(boot === undefined ? [] : [boot]),
];

/** The debug slot as the firmware composes it. */
const slot = (first: number, lines: string[], boot?: number) => [
  ...(lines.length ? tlv(0x17, ascii(lines[lines.length - 1])) : []),
  ...tlv(0x71, debugLog(first, lines, boot)),
];

function meta(...parts: number[][]): void {
  const b = bytes(...parts);
  emit({ t: "meta", id: 1, metaLen: b.length, jpegLen: 0, meta: b });
}

describe("the numbered log record", () => {
  it("decodes to whole lines", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, debugLog(7, ["one\r\n", "", "two"]))));
    expect(parsed.debugLog).toEqual({ first: 7, lines: ["one\n", "\n", "two\n"] });
  });

  it("keeps the lines that fit when it is cut short", () => {
    // The count says two lines, but only the first fits in the value.
    const value = debugLog(1, ["complete", "cut short"]);
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, value.slice(0, -4))));
    expect(parsed.debugLog).toEqual({ first: 1, lines: ["complete\n"] });
  });

  it("is ignored when shorter than its header", () => {
    expect(parseOverlayMeta(bytes(tlv(kMetaDebugLog, [1, 0, 0, 0]))).debugLog).toBeUndefined();
  });

  it("reads the boot mark after the lines", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, debugLog(7, ["one"], 42))));
    expect(parsed.debugLog).toEqual({ first: 7, lines: ["one\n"], boot: 42 });
  });

  it("reads the boot mark of a record with no lines", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, debugLog(9, [], 5))));
    expect(parsed.debugLog).toEqual({ first: 9, lines: [], boot: 5 });
  });

  it("has no boot mark from older firmware", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, debugLog(7, ["one"]))));
    expect(parsed.debugLog).toEqual({ first: 7, lines: ["one\n"] });
  });

  it("takes no boot mark from a record cut short", () => {
    // The second line's bytes run past the end, so what is left is not a boot mark.
    const value = debugLog(1, ["complete", "cut short"]);
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugLog, value.slice(0, -4))));
    expect(parsed.debugLog?.boot).toBeUndefined();
  });
});

describe("the Terminal", () => {
  it("shows a line without a newline at once, not glued to the next", () => {
    meta(tlv(0x17, ascii("[APRILTAG] detector ready")));
    expect(terminalLines()).toEqual(["[APRILTAG] detector ready"]);
    meta(tlv(0x17, ascii("[APRILTAG] id=3")));
    expect(terminalLines()).toEqual(["[APRILTAG] detector ready", "[APRILTAG] id=3"]);
  });

  it("prints a repeated 0x17 latest line once", () => {
    meta(tlv(0x17, ascii("[BOOT] reset=POR\r\n")));
    meta(tlv(0x17, ascii("[BOOT] reset=POR\r\n")));
    expect(terminalLines()).toEqual(["[BOOT] reset=POR"]);
  });

  it("gets every line between two frames, once", () => {
    meta(slot(1, ["one", "two", "three"]));
    expect(terminalLines()).toEqual(["one", "two", "three"]);
    // The next frame repeats the same window: nothing new.
    meta(slot(1, ["one", "two", "three"]));
    expect(terminalLines()).toEqual(["one", "two", "three"]);
    // The window slides on.
    meta(slot(2, ["two", "three", "four"]));
    expect(terminalLines()).toEqual(["one", "two", "three", "four"]);
  });

  it("prints the same text twice when the numbers differ", () => {
    meta(slot(5, ["button pressed"]));
    meta(slot(5, ["button pressed", "button pressed"]));
    expect(terminalLines()).toEqual(["button pressed", "button pressed"]);
  });

  it("ignores the latest-line TLV once the board sends the log", () => {
    meta(slot(1, ["hello"]));
    expect(terminalLines()).toEqual(["hello"]);
    // A frame carrying only the latest-line TLV adds nothing once the log is known.
    meta(tlv(0x17, ascii("hello again")));
    expect(terminalLines()).toEqual(["hello"]);
  });

  it("reports missing numbers", () => {
    meta(slot(1, ["a"]));
    meta(slot(4, ["d"]));
    expect(terminalLines()).toEqual(["a", "[host] 2 Terminal lines lost", "d"]);
  });

  it("reports lines that aged out unseen, from an empty window", () => {
    meta(slot(1, ["a"]));
    // Count 0: the first number is the one the next line will get.
    meta(slot(3, []));
    expect(terminalLines()).toEqual(["a", "[host] 1 Terminal line lost"]);
  });

  it("starts afresh when the numbers go backwards, as the board restarted", () => {
    meta(slot(40, ["before reset"]));
    meta(slot(1, ["after reset"]));
    expect(terminalLines()).toEqual(["before reset", "after reset"]);
  });

  it("starts afresh on a new boot mark, even when the numbers keep rising", () => {
    meta(slot(1, ["a", "b", "c"], 7));
    // The restarted board logged past line 3 before this window reached the host.
    meta(slot(5, ["e", "f"], 9));
    expect(terminalLines()).toEqual(["a", "b", "c", "e", "f"]);
  });

  it("keeps counting lost lines within one boot mark", () => {
    meta(slot(1, ["a"], 7));
    meta(slot(4, ["d"], 7));
    expect(terminalLines()).toEqual(["a", "[host] 2 Terminal lines lost", "d"]);
  });

  it("does not repeat a window when the boot mark first appears", () => {
    // A host started before the update: the mark arrives with a known window.
    meta(slot(1, ["a", "b"]));
    meta(slot(1, ["a", "b"], 3));
    expect(terminalLines()).toEqual(["a", "b"]);
  });

  it("starts afresh in a new session, whatever the firmware sends", () => {
    meta(slot(10, ["first session"]));
    emit({ t: "clear_caches" });
    meta(slot(3, ["second session"]));
    emit({ t: "clear_caches" });
    meta(tlv(0x17, ascii("older firmware")));
    expect(terminalLines()).toEqual(["first session", "second session", "older firmware"]);
  });

  it("drops carriage returns and splits lines at embedded newlines", () => {
    meta(slot(1, ["[bootlog] --- pre-connect boot log ---\r\n", "x\ny"]));
    expect(terminalLines()).toEqual(["[bootlog] --- pre-connect boot log ---", "x", "y"]);
  });
});
