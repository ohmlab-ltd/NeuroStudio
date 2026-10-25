// TLV text decoding, warnings, 0x16 debug text and box labels across 0x02 records.
// parser.cjs must decode strings the same way as the renderer.

import { describe, expect, it } from "vitest";
import {
  kMetaAudioLabels,
  kMetaBoxes,
  kMetaDebugText,
  kMetaIsegClassStr,
  kMetaQrFrame,
  kMetaTofFrame,
  kMetaTofFrameLegacy,
  kMetaTofStatus,
  kMetaWarning,
  parseOverlayMeta,
} from "../src/device/tlv";
import { parseTuneDescriptor } from "../src/device/packets";
import { extractOverlayCategories, extractWarning } from "../electron/device/parser.cjs";
import { ascii, bytes, tlv, u16, u32 } from "./bytes";

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/** One QR result with no crop. */
function qrValue(text: number[]): number[] {
  return [
    1, // count
    ...u16(32768),
    ...u16(32768),
    ...u16(6553),
    ...u16(6553),
    2, // version
    0, // ecc
    ...u16(text.length),
    ...text,
    0,
    0, // no crop
  ];
}

const box = (cls: number): number[] => [
  ...u16(32768),
  ...u16(32768),
  ...u16(6553),
  ...u16(6553),
  200,
  cls,
];

const legacyTof = (): number[] =>
  tlv(kMetaTofFrameLegacy, Array.from({ length: 16 }, (_, z) => u32(100 + z)).flat());

describe("TLV strings", () => {
  it("decodes QR text as UTF-8", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaQrFrame, qrValue(utf8("Zürich €")))));
    expect(parsed.vision?.results[0].text).toBe("Zürich €");
  });

  it("keeps line breaks in QR text", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaQrFrame, qrValue(ascii("a\r\nb")))));
    expect(parsed.vision?.results[0].text).toBe("a\r\nb");
  });

  it("decodes class labels as UTF-8, stopping at NUL and dropping control characters", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaBoxes, [1, ...box(0)]),
        tlv(kMetaIsegClassStr, [0, ...utf8("caf\u0007é "), 0, ...ascii("junk")]),
      ),
    );
    expect(parsed.overlay.boxes[0].label).toBe("café");
    expect(parsed.overlay.classLabelsByObjId.get(0)).toBe("café");
  });

  it("shows invalid UTF-8 as the replacement character", () => {
    const parsed = parseOverlayMeta(
      bytes(tlv(kMetaBoxes, [1, ...box(0)]), tlv(kMetaIsegClassStr, [0, 0x61, 0xff, 0x62])),
    );
    expect(parsed.overlay.boxes[0].label).toBe("a�b");
  });

  it("decodes audio labels as UTF-8", () => {
    const name = utf8("café");
    const parsed = parseOverlayMeta(bytes(tlv(kMetaAudioLabels, [1, name.length, ...name])));
    expect(parsed.audioLabels).toEqual(["café"]);
  });

  it("decodes tune parameter names as UTF-8", () => {
    const name = utf8("gain°");
    const value = [1, 3, 0, 0, name.length, ...name, ...u32(0), ...u32(10), ...u32(5)];
    expect(parseTuneDescriptor(new Uint8Array(value))?.[0].name).toBe("gain°");
  });
});

describe("warnings", () => {
  it("stops at NUL", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaWarning, [...ascii("Low light"), 0, 0, 0])));
    expect(parsed.overlay.warning).toBe("Low light");
  });

  it("keeps the last non-empty warning in the blob", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaWarning, ascii("first")),
        tlv(kMetaWarning, ascii("second")),
        tlv(kMetaWarning, [0x20, 0]),
      ),
    );
    expect(parsed.overlay.warning).toBe("second");
  });
});

describe("parser.cjs agrees with the renderer", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["NUL terminated", bytes(tlv(kMetaWarning, [...ascii("Low light"), 0]))],
    ["NUL padded", bytes(tlv(kMetaWarning, [...ascii("Low light"), 0, 0, 0, 0]))],
    ["UTF-8", bytes(tlv(kMetaWarning, utf8("Hot 45°C")))],
    ["invalid UTF-8", bytes(tlv(kMetaWarning, [0x41, 0xc3, 0x42]))],
    ["control characters", bytes(tlv(kMetaWarning, ascii("\u001b[1mBad\r\n")))],
    [
      "several warnings",
      bytes(tlv(kMetaWarning, ascii("first")), tlv(kMetaWarning, ascii("second"))),
    ],
    ["trailing empty warning", bytes(tlv(kMetaWarning, ascii("kept")), tlv(kMetaWarning, [0]))],
    ["empty", bytes(tlv(kMetaWarning, [0x20]))],
  ];

  for (const [name, meta] of cases) {
    it(`warning: ${name}`, () => {
      const renderer = parseOverlayMeta(meta).overlay.warning;
      expect(extractWarning(Buffer.from(meta)) ?? "").toBe(renderer);
    });
  }

  it("warning text", () => {
    expect(extractWarning(Buffer.from(cases[0][1]))).toBe("Low light");
    expect(extractWarning(Buffer.from(cases[2][1]))).toBe("Hot 45°C");
    expect(extractWarning(Buffer.from(cases[5][1]))).toBe("second");
    expect(extractWarning(Buffer.from(cases[7][1]))).toBeNull();
  });

  it("class names", () => {
    const meta = bytes(
      tlv(kMetaIsegClassStr, [0, ...ascii("person"), 0]),
      tlv(kMetaIsegClassStr, [1, ...utf8("café\u0007")]),
      tlv(kMetaIsegClassStr, [2, ...ascii(" person ")]),
      tlv(kMetaIsegClassStr, [3, 0, ...ascii("hidden")]),
    );
    const renderer = [...new Set(parseOverlayMeta(meta).overlay.classLabelsByObjId.values())];
    expect(extractOverlayCategories(Buffer.from(meta))).toEqual(["person", "café"]);
    expect(extractOverlayCategories(Buffer.from(meta))).toEqual(renderer);
  });
});

describe("debug text", () => {
  it("decodes UTF-8 and drops carriage returns", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugText, utf8("temp 23.5°C\r\n\tok\n"))));
    expect(parsed.debugText).toBe("temp 23.5°C\n\tok\n");
  });

  it("ends the text with a newline, so the line shows at once", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaDebugText, ascii("[BOOT] reset=POR"))));
    expect(parsed.debugText).toBe("[BOOT] reset=POR\n");
  });

  it("drops NUL and other control characters", () => {
    const parsed = parseOverlayMeta(
      bytes(tlv(kMetaDebugText, [...ascii("a"), 0, 0x07, ...ascii("b\n"), 0, 0])),
    );
    expect(parsed.debugText).toBe("ab\n");
  });

  it("joins several 0x17 records in wire order", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaDebugText, ascii("one\n")),
        tlv(kMetaDebugText, ascii("tw")),
        tlv(kMetaDebugText, ascii("o\n")),
      ),
    );
    expect(parsed.debugText).toBe("one\ntwo\n");
  });

  it("decodes a character split across two records", () => {
    const deg = utf8("°");
    const parsed = parseOverlayMeta(
      bytes(tlv(kMetaDebugText, [...ascii("5"), deg[0]]), tlv(kMetaDebugText, [deg[1], 0x0a])),
    );
    expect(parsed.debugText).toBe("5°\n");
  });

  it("is absent when a record holds nothing printable", () => {
    expect(parseOverlayMeta(bytes(tlv(kMetaDebugText, [0, 0]))).debugText).toBeUndefined();
    expect(parseOverlayMeta(bytes(tlv(kMetaDebugText, [0x0d]))).debugText).toBeUndefined();
  });
});

describe("legacy 0x16 debug text", () => {
  it("is read when no 0x14 is in the blob", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaTofStatus, ascii("ToF init failed\n"))));
    expect(parsed.debugText).toBe("ToF init failed\n");
    expect(parsed.tof).toBeUndefined();
  });

  it("is read when it comes before 0x14", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaTofStatus, ascii("hello\n")), legacyTof()));
    expect(parsed.debugText).toBe("hello\n");
    expect(parsed.tof?.legacy).toBe(true);
    expect(parsed.tof?.distancesMm[0]).toBe(100);
  });

  it("is read when it comes after 0x14", () => {
    const parsed = parseOverlayMeta(bytes(legacyTof(), tlv(kMetaTofStatus, ascii("hello\n"))));
    expect(parsed.debugText).toBe("hello\n");
  });

  it("is read even when it happens to look like a status record, if 0x14 is present", () => {
    // "\n\n" is a 10x10 header, and this text is exactly 4 + 100 bytes.
    const text = `\n\n${"x".repeat(101)}\n`;
    const parsed = parseOverlayMeta(bytes(tlv(kMetaTofStatus, ascii(text)), legacyTof()));
    expect(parsed.debugText).toBe(text);
    expect(parsed.tof?.statuses).toEqual([]);
  });

  it("ignores the legacy 0x15 status enum before 0x14", () => {
    // Statuses 1 and 3 would read as a valid 1x3 distance grid.
    const statuses = [1, 3, ...new Array<number>(14).fill(0)];
    const parsed = parseOverlayMeta(bytes(tlv(kMetaTofFrame, statuses), legacyTof()));
    expect(parsed.tof?.legacy).toBe(true);
    expect(parsed.tof?.rows).toBe(4);
    expect(parsed.tof?.distancesMm).toHaveLength(16);
  });

  it("leaves a valid new-format status record alone", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaTofFrame, [2, 2, 8, 8, ...u32(1), ...u32(2), ...u32(3), ...u32(4)]),
        tlv(kMetaTofStatus, [2, 2, 8, 8, 0, 4, 0, 7]),
      ),
    );
    expect(parsed.debugText).toBeUndefined();
    expect(parsed.tof?.statuses).toEqual([0, 4, 0, 7]);
    expect(parsed.tof?.legacy).toBe(false);
  });

  it.each([
    ["after", false],
    ["before", true],
  ])("drops a status grid shaped unlike the distance grid, sent %s it", (_, statusFirst) => {
    // 1x4 statuses against a 2x2 distance grid: every cell would misalign.
    const distances = tlv(kMetaTofFrame, [2, 2, 8, 8, ...u32(1), ...u32(2), ...u32(3), ...u32(4)]);
    const statuses = tlv(kMetaTofStatus, [1, 4, 8, 8, 0, 4, 0, 7]);
    const parsed = parseOverlayMeta(
      statusFirst ? bytes(statuses, distances) : bytes(distances, statuses),
    );
    expect(parsed.debugText).toBeUndefined();
    expect(parsed.tof?.statuses).toEqual([]);
    expect(parsed.tof?.distancesMm).toEqual([1, 2, 3, 4]);
  });

  it("keeps a matching status grid sent before the distance grid", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaTofStatus, [2, 2, 8, 8, 0, 4, 0, 7]),
        tlv(kMetaTofFrame, [2, 2, 8, 8, ...u32(1), ...u32(2), ...u32(3), ...u32(4)]),
      ),
    );
    expect(parsed.tof?.statuses).toEqual([0, 4, 0, 7]);
  });
});

describe("box labels", () => {
  it("go by position across every 0x02 record, labels first", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaIsegClassStr, [0, ...ascii("a")]),
        tlv(kMetaIsegClassStr, [1, ...ascii("b")]),
        tlv(kMetaIsegClassStr, [2, ...ascii("c")]),
        tlv(kMetaBoxes, [2, ...box(0), ...box(1)]),
        tlv(kMetaBoxes, [1, ...box(2)]),
      ),
    );
    expect(parsed.overlay.boxes.map((b) => b.label)).toEqual(["a", "b", "c"]);
  });

  it("go by position across every 0x02 record, labels last", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaBoxes, [1, ...box(0)]),
        tlv(kMetaBoxes, [1, ...box(1)]),
        tlv(kMetaIsegClassStr, [1, ...ascii("second")]),
      ),
    );
    expect(parsed.overlay.boxes.map((b) => b.label)).toEqual([undefined, "second"]);
  });

  it("use the last class string for an object", () => {
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaIsegClassStr, [0, ...ascii("old")]),
        tlv(kMetaBoxes, [1, ...box(0)]),
        tlv(kMetaIsegClassStr, [0, ...ascii("new")]),
      ),
    );
    expect(parsed.overlay.boxes[0].label).toBe("new");
    expect(parsed.overlay.classLabelsByObjId.get(0)).toBe("new");
  });
});
