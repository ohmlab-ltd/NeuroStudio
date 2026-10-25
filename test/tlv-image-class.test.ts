// The image classifier's result, TLV 0x54, and the limits that make a record corrupt.

import { describe, expect, it } from "vitest";
import { kMetaAudioClass, kMetaImageClass, parseOverlayMeta } from "../src/device/tlv";
import { bytes, tlv, u16 } from "./bytes";

/** One entry: u16 class_index, u16 score_x1000, u8 name_len, UTF-8 name. */
function entry(index: number, scoreX1000: number, name: string): number[] {
  const utf8 = [...new TextEncoder().encode(name)];
  return [...u16(index), ...u16(scoreX1000), utf8.length, ...utf8];
}

/** u8 count, u8 reserved, u16 num_classes, u16 threshold_x1000, then the entries. */
function imageClass(entries: number[][], numClasses = 1000, thresholdX1000 = 50): number[] {
  return [entries.length, 0, ...u16(numClasses), ...u16(thresholdX1000), ...entries.flat()];
}

const parse = (...parts: number[][]) => parseOverlayMeta(bytes(...parts));

/** Three entries above a 5% threshold, best first. */
const good = imageClass([
  entry(207, 712, "golden retriever"),
  entry(208, 184, "Labrador retriever"),
  entry(222, 61, "kuvasz"),
]);

describe("META_IMAGE_CLASS (0x54)", () => {
  it("decodes the entries best first, with the label set's size and the threshold", () => {
    const f = parse(tlv(kMetaImageClass, good)).imageClass!;
    expect(f.numClasses).toBe(1000);
    expect(f.threshold).toBeCloseTo(0.05, 9);
    expect(f.entries.map((e) => e.name)).toEqual([
      "golden retriever",
      "Labrador retriever",
      "kuvasz",
    ]);
    expect(f.entries.map((e) => e.index)).toEqual([207, 208, 222]);
    expect(f.entries[0].score).toBeCloseTo(0.712, 9);
    expect(f.entries[1].score).toBeCloseTo(0.184, 9);
  });

  it("reads count 0 as an answer: nothing above the threshold", () => {
    const f = parse(tlv(kMetaImageClass, imageClass([], 1000, 500))).imageClass!;
    expect(f.entries).toEqual([]);
    expect(f.threshold).toBeCloseTo(0.5, 9);
    expect(f.numClasses).toBe(1000);
  });

  it("ignores a truncated record, at every length", () => {
    for (let n = 0; n < good.length; n++) {
      expect(parse(tlv(kMetaImageClass, good.slice(0, n))).imageClass, `cut at ${n}`).toBe(
        undefined,
      );
    }
  });

  it("ignores a record longer than the metadata it arrived in", () => {
    const whole = tlv(kMetaImageClass, good);
    expect(parse(whole.slice(0, -1)).imageClass).toBeUndefined();
  });

  it("takes a 48-byte name and ignores a longer one", () => {
    const longest = parse(tlv(kMetaImageClass, imageClass([entry(1, 900, "x".repeat(48))])));
    expect(longest.imageClass!.entries[0].name).toBe("x".repeat(48));
    // Every byte of the 49-byte name is present: only the length is out of range.
    const over = parse(tlv(kMetaImageClass, imageClass([entry(1, 900, "y".repeat(49))])));
    expect(over.imageClass).toBeUndefined();
  });

  it("ignores more than 8 entries, or a score over 1000", () => {
    const eight = Array.from({ length: 8 }, (_, i) => entry(i, 100, `class${i}`));
    expect(parse(tlv(kMetaImageClass, imageClass(eight))).imageClass!.entries).toHaveLength(8);
    const nine = imageClass([...eight, entry(8, 100, "class8")]);
    expect(parse(tlv(kMetaImageClass, nine)).imageClass).toBeUndefined();
    const over = imageClass([entry(1, 1001, "overflow")]);
    expect(parse(tlv(kMetaImageClass, over)).imageClass).toBeUndefined();
  });

  it("skips bytes after the last entry by the record length, so the next record decodes", () => {
    const audio = [1, 0, ...u16(500), ...u16(400), ...u16(910)];
    const parsed = parse(
      tlv(kMetaImageClass, [...good, 0xde, 0xad, 0xbe, 0xef]),
      tlv(kMetaAudioClass, audio),
    );
    expect(parsed.imageClass!.entries.map((e) => e.name)).toEqual([
      "golden retriever",
      "Labrador retriever",
      "kuvasz",
    ]);
    expect(parsed.audioClass!.scores[0]).toBeCloseTo(0.91, 9);
  });

  it("decodes names as UTF-8, and takes an empty one", () => {
    const f = parse(
      tlv(kMetaImageClass, imageClass([entry(923, 700, "consommé"), entry(5, 90, "")])),
    ).imageClass!;
    expect(f.entries[0].name).toBe("consommé");
    expect(f.entries[1]).toEqual({ index: 5, score: 0.09, name: "" });
  });

  it("keeps a record whose name is not valid UTF-8", () => {
    // 0xC3 opens a two-byte sequence that never completes.
    const value = [1, 0, ...u16(1000), ...u16(50), ...u16(7), ...u16(800), 3, 0x61, 0xc3, 0x62];
    expect(parse(tlv(kMetaImageClass, value)).imageClass!.entries[0].name).toBe("a\ufffdb");
  });
});
