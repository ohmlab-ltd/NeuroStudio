// AprilTag 0x66 and evidence crop 0x70 decoding.

import { describe, expect, it } from "vitest";
import {
  kMetaAprilTag,
  kMetaBlobFrame,
  kMetaEvidenceCrop,
  kVisionKindAprilTag,
  kVisionKindBlob,
  mergeEvidenceCrops,
  parseOverlayMeta,
  type VisionFrame,
} from "../src/device/tlv";
import { bytes, i16, tlv, u16 } from "./bytes";

interface TagSpec {
  id: number;
  family?: number;
  hamming?: number;
  margin?: number;
  angleCdeg?: number;
  poseValid?: boolean;
  tMm?: [number, number, number];
  rCdeg?: [number, number, number];
  crop?: { w: number; h: number; pixels: number[] };
}

/** One 29-byte tag record plus its trailing crop. */
function tagRecord(t: TagSpec): number[] {
  const crop = t.crop ?? { w: 0, h: 0, pixels: [] };
  return [
    ...u16(32768), // cx
    ...u16(16384), // cy
    ...u16(6553), // w
    ...u16(6553), // h
    ...u16(t.id),
    t.family ?? 0,
    t.hamming ?? 0,
    ...u16(t.margin ?? 0),
    ...i16(t.angleCdeg ?? 0),
    t.poseValid ? 1 : 0,
    ...(t.tMm ?? [0, 0, 0]).flatMap(i16),
    ...(t.rCdeg ?? [0, 0, 0]).flatMap(i16),
    crop.w,
    crop.h,
    ...crop.pixels.flatMap(u16),
  ];
}

const aprilTag = (...tags: TagSpec[]) =>
  tlv(kMetaAprilTag, [tags.length, ...tags.flatMap(tagRecord)]);

/** Colour-blob result with no crop: box, u16 area, u16 hue, u16 px, 0,0. */
const blobRecord = (hue: number) => [
  ...u16(1000),
  ...u16(2000),
  ...u16(3000),
  ...u16(4000),
  ...u16(6553),
  ...u16(hue),
  ...u16(120),
  0,
  0,
];

const blobs = (count: number) =>
  tlv(kMetaBlobFrame, [
    count,
    ...Array.from({ length: count }, (_, k) => blobRecord(k * 10)).flat(),
  ]);

/** Evidence TLV: u8 count, then per crop u8 index, u8 w, u8 h, pixels. */
const evidence = (...crops: { index: number; w: number; h: number; pixels: number[] }[]) =>
  tlv(kMetaEvidenceCrop, [
    crops.length,
    ...crops.flatMap((c) => [c.index, c.w, c.h, ...c.pixels.flatMap(u16)]),
  ]);

describe("AprilTag (0x66)", () => {
  it("decodes a tag with pose, in metres and degrees", () => {
    const parsed = parseOverlayMeta(
      bytes(
        aprilTag({
          id: 42,
          hamming: 1,
          margin: 32768,
          angleCdeg: -1234,
          poseValid: true,
          tMm: [-150, 20, 1234],
          rCdeg: [9000, -4550, 18000],
        }),
      ),
    );

    const frame = parsed.vision!;
    expect(frame.kind).toBe(kVisionKindAprilTag);
    expect(frame.results).toHaveLength(1);
    const r = frame.results[0];
    expect(r.text).toBe("id 42");
    expect(r.detail).toBe("tag36h11  hamming 1  margin 0.50  -12.3 deg");
    expect(r.cx).toBeCloseTo(32768 / 65535, 9);
    expect(r.cy).toBeCloseTo(16384 / 65535, 9);
    expect(r.crop).toBeNull();
    expect(r.pose).not.toBeNull();
    expect(r.pose!.tx).toBeCloseTo(-0.15, 9);
    expect(r.pose!.ty).toBeCloseTo(0.02, 9);
    expect(r.pose!.tz).toBeCloseTo(1.234, 9);
    expect(r.pose!.rx).toBeCloseTo(90, 9);
    expect(r.pose!.ry).toBeCloseTo(-45.5, 9);
    expect(r.pose!.rz).toBeCloseTo(180, 9);
  });

  it("reports no pose without a calibration, whatever the pose bytes say", () => {
    const parsed = parseOverlayMeta(
      bytes(aprilTag({ id: 7, family: 3, poseValid: false, tMm: [1, 2, 3], angleCdeg: 450 })),
    );
    const r = parsed.vision!.results[0];
    expect(r.pose).toBeNull();
    expect(r.detail).toBe("family 3  hamming 0  margin 0.00  4.5 deg  ·  no calibration");
  });

  it("reads the trailing crop and walks on to the next tag", () => {
    const parsed = parseOverlayMeta(
      bytes(
        aprilTag(
          { id: 1, crop: { w: 2, h: 1, pixels: [0xf800, 0x001f] } },
          { id: 2, poseValid: true, tMm: [0, 0, 500] },
        ),
      ),
    );
    const [a, b] = parsed.vision!.results;
    expect(a.cropW).toBe(2);
    expect(a.cropH).toBe(1);
    expect([...a.crop!]).toEqual([0xf800, 0x001f]);
    expect(b.text).toBe("id 2");
    expect(b.pose!.tz).toBeCloseTo(0.5, 9);
  });

  it("publishes an empty frame for count = 0, which clears the panel", () => {
    const frame = parseOverlayMeta(bytes(tlv(kMetaAprilTag, [0]))).vision!;
    expect(frame.kind).toBe(kVisionKindAprilTag);
    expect(frame.results).toEqual([]);
  });

  it("drops a truncated record rather than publishing part of it", () => {
    const whole = aprilTag({ id: 9, poseValid: true });
    // Cut into the 29-byte record: keep the header, count and 27 bytes.
    const cut = whole.slice(0, 3 + 1 + 27);
    cut[1] = 28;
    cut[2] = 0;
    expect(parseOverlayMeta(bytes(cut)).vision).toBeUndefined();

    // Count says two tags, the record holds one.
    const one = tagRecord({ id: 9 });
    expect(parseOverlayMeta(bytes(tlv(kMetaAprilTag, [2, ...one]))).vision).toBeUndefined();

    // Crop dimensions promise more pixels than the record holds.
    const shortCrop = tagRecord({ id: 9, crop: { w: 2, h: 2, pixels: [1, 2, 3] } });
    expect(parseOverlayMeta(bytes(tlv(kMetaAprilTag, [1, ...shortCrop]))).vision).toBeUndefined();
  });
});

describe("evidence crops (0x70)", () => {
  const pixels = [0x1234, 0x5678];

  it("merges into the frame decoded earlier in the same buffer", () => {
    const parsed = parseOverlayMeta(bytes(blobs(2), evidence({ index: 1, w: 2, h: 1, pixels })));
    const frame = parsed.vision!;
    expect(parsed.evidence).toBeUndefined();
    expect(frame.kind).toBe(kVisionKindBlob);
    expect(frame.results[0].crop).toBeNull();
    expect(frame.results[1].cropW).toBe(2);
    expect(frame.results[1].cropH).toBe(1);
    expect([...frame.results[1].crop!]).toEqual(pixels);
    expect(frame.results[1].detail).toBe("hue 10 deg / 10.0% / 120 px");
  });

  it("keeps the AprilTag pose on the rebuilt result", () => {
    const parsed = parseOverlayMeta(
      bytes(
        aprilTag({ id: 5, poseValid: true, tMm: [100, 200, 300] }),
        evidence({ index: 0, w: 1, h: 2, pixels }),
      ),
    );
    const r = parsed.vision!.results[0];
    expect([...r.crop!]).toEqual(pixels);
    expect(r.pose!.ty).toBeCloseTo(0.2, 9);
    expect(r.text).toBe("id 5");
  });

  it("hands crops for the frame on screen to the caller", () => {
    const previous = parseOverlayMeta(bytes(blobs(2))).vision!;
    const parsed = parseOverlayMeta(bytes(evidence({ index: 0, w: 2, h: 1, pixels })));
    expect(parsed.vision).toBeUndefined();
    expect(parsed.evidence).toHaveLength(1);

    const merged = mergeEvidenceCrops(previous, parsed.evidence!);
    expect(merged).not.toBe(previous);
    expect(merged.kind).toBe(previous.kind);
    expect([...merged.results[0].crop!]).toEqual(pixels);
    expect(merged.results[1]).toBe(previous.results[1]);
    // The frame already in the store is not mutated.
    expect(previous.results[0].crop).toBeNull();
  });

  it("drops a stale index instead of throwing", () => {
    const frame = parseOverlayMeta(bytes(blobs(1))).vision!;
    const stale = parseOverlayMeta(bytes(evidence({ index: 3, w: 2, h: 1, pixels }))).evidence!;
    // Nothing applied: the same object comes back, so the store does not notify.
    expect(mergeEvidenceCrops(frame, stale)).toBe(frame);

    const mixed = parseOverlayMeta(
      bytes(
        blobs(1),
        evidence({ index: 4, w: 1, h: 1, pixels: [9] }, { index: 0, w: 1, h: 1, pixels: [7] }),
      ),
    ).vision!;
    expect(mixed.results).toHaveLength(1);
    expect([...mixed.results[0].crop!]).toEqual([7]);
  });

  it("drops the whole TLV when any crop is truncated or empty", () => {
    const truncated = evidence({ index: 0, w: 2, h: 2, pixels: [1, 2, 3] });
    const parsed = parseOverlayMeta(bytes(blobs(1), truncated));
    expect(parsed.vision!.results[0].crop).toBeNull();
    expect(parseOverlayMeta(bytes(truncated)).evidence).toBeUndefined();

    const withEmpty = evidence(
      { index: 0, w: 1, h: 1, pixels: [5] },
      { index: 1, w: 0, h: 4, pixels: [] },
    );
    expect(parseOverlayMeta(bytes(withEmpty)).evidence).toBeUndefined();
  });

  it("discards evidence that precedes a result TLV in the same buffer", () => {
    // It belonged to the frame the new result replaces.
    const parsed = parseOverlayMeta(bytes(evidence({ index: 0, w: 2, h: 1, pixels }), blobs(1)));
    expect(parsed.evidence).toBeUndefined();
    expect(parsed.vision!.results[0].crop).toBeNull();
  });

  it("leaves a frame without results alone", () => {
    const empty: VisionFrame = { kind: kVisionKindBlob, results: [] };
    const crops = parseOverlayMeta(
      bytes(evidence({ index: 0, w: 1, h: 1, pixels: [1] })),
    ).evidence!;
    expect(mergeEvidenceCrops(empty, crops)).toBe(empty);
  });
});
