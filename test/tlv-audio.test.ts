// Audio classifier TLVs: 0x51 scores, 0x52 spectrogram, 0x53 labels.

import { describe, expect, it } from "vitest";
import {
  audioMelAt,
  kMetaAudioClass,
  kMetaAudioLabels,
  kMetaAudioMel,
  parseOverlayMeta,
} from "../src/device/tlv";
import { ascii, bytes, tlv, u16 } from "./bytes";

const labels = ["chainsaw", "clock tick", "dog"];

function labelsValue(names: string[]): number[] {
  return [names.length, ...names.flatMap((n) => [n.length, ...ascii(n)])];
}

describe("META_AUDIO_LABELS (0x53)", () => {
  it("decodes the class names", () => {
    const parsed = parseOverlayMeta(bytes(tlv(kMetaAudioLabels, labelsValue(labels))));
    expect(parsed.audioLabels).toEqual(labels);
  });

  it("keeps the previous names when a record is truncated", () => {
    // Claims three names, carries two.
    const value = labelsValue(labels.slice(0, 2));
    value[0] = 3;
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioLabels, value))).audioLabels).toBeUndefined();

    // A name running past the end of the record.
    const short = [1, 10, ...ascii("dog")];
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioLabels, short))).audioLabels).toBeUndefined();
  });

  it("ignores an empty list", () => {
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioLabels, [0]))).audioLabels).toBeUndefined();
  });
});

describe("META_AUDIO_CLASS (0x51)", () => {
  it("decodes scores, top, level and threshold", () => {
    // count, top, level, threshold_x1000, then u16 score_x1000 per class
    const value = [3, 1, ...u16(1234), ...u16(500), ...u16(100), ...u16(870), ...u16(30)];
    const f = parseOverlayMeta(bytes(tlv(kMetaAudioClass, value))).audioClass;

    expect(f).toBeDefined();
    expect(f!.top).toBe(1);
    expect(f!.level).toBe(1234);
    expect(f!.threshold).toBeCloseTo(0.5, 9);
    expect(f!.scores).toHaveLength(3);
    expect(f!.scores[1]).toBeCloseTo(0.87, 9);
  });

  it('reports "nothing above threshold" as top = -1', () => {
    const value = [2, 0xff, ...u16(10), ...u16(500), ...u16(10), ...u16(20)];
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioClass, value))).audioClass!.top).toBe(-1);
  });

  it("drops a record shorter than its score count", () => {
    const value = [3, 0, ...u16(10), ...u16(500), ...u16(10), ...u16(20)];
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioClass, value))).audioClass).toBeUndefined();
    expect(
      parseOverlayMeta(bytes(tlv(kMetaAudioClass, [0, 0, 0, 0, 0]))).audioClass,
    ).toBeUndefined();
  });
});

describe("META_AUDIO_MEL (0x52)", () => {
  it("decodes a frame-major spectrogram and maps (mel, frame)", () => {
    const nMel = 4;
    const nFrames = 3;
    // Frame-major: consecutive mel bins within a frame.
    const body: number[] = [];
    for (let f = 0; f < nFrames; f++) {
      for (let m = 0; m < nMel; m++) body.push(f * 10 + m);
    }
    const mel = parseOverlayMeta(
      bytes(tlv(kMetaAudioMel, [nMel, nFrames, 0, 0, ...body])),
    ).audioMel;

    expect(mel).toBeDefined();
    expect(mel!.nMel).toBe(nMel);
    expect(mel!.nFrames).toBe(nFrames);
    expect(audioMelAt(mel!, 2, 1)).toBe(12); // frame 1, mel 2
  });

  it("maps a mel-major spectrogram", () => {
    const nMel = 4;
    const nFrames = 3;
    const body: number[] = [];
    for (let m = 0; m < nMel; m++) {
      for (let f = 0; f < nFrames; f++) body.push(f * 10 + m);
    }
    const mel = parseOverlayMeta(
      bytes(tlv(kMetaAudioMel, [nMel, nFrames, 1, 0, ...body])),
    ).audioMel;
    expect(audioMelAt(mel!, 2, 1)).toBe(12);
    expect(audioMelAt(mel!, 3, 2)).toBe(23);
  });

  it("copies the data out of the transport buffer", () => {
    const buf = bytes(tlv(kMetaAudioMel, [1, 2, 0, 0, 7, 8]));
    const mel = parseOverlayMeta(buf).audioMel!;
    buf.fill(0);
    expect([...mel.data]).toEqual([7, 8]);
  });

  it("drops empty or short records", () => {
    expect(parseOverlayMeta(bytes(tlv(kMetaAudioMel, [0, 3, 0, 0]))).audioMel).toBeUndefined();
    expect(
      parseOverlayMeta(bytes(tlv(kMetaAudioMel, [2, 2, 0, 0, 1, 2, 3]))).audioMel,
    ).toBeUndefined();
  });
});

describe("audio TLVs together", () => {
  it("decodes a buffer with ONLY audio TLVs (audio-only board)", () => {
    const cls = [1, 0, ...u16(500), ...u16(400), ...u16(910)];
    const parsed = parseOverlayMeta(
      bytes(tlv(kMetaAudioClass, cls), tlv(kMetaAudioLabels, [1, 3, ...ascii("dog")])),
    );

    expect(parsed.audioLabels).toEqual(["dog"]);
    expect(parsed.audioClass!.scores).toHaveLength(1);
    expect(parsed.audioClass!.scores[0]).toBeCloseTo(0.91, 9);
  });

  it("decodes all three in one buffer, as the device composes them", () => {
    const cls = [3, 2, ...u16(900), ...u16(450), ...u16(10), ...u16(20), ...u16(950)];
    const mel = [2, 2, 0, 0, 1, 2, 3, 4];
    const parsed = parseOverlayMeta(
      bytes(
        tlv(kMetaAudioClass, cls),
        tlv(kMetaAudioMel, mel),
        tlv(kMetaAudioLabels, labelsValue(labels)),
      ),
    );

    expect(parsed.audioLabels).toEqual(labels);
    expect(parsed.audioClass!.top).toBe(2);
    expect(parsed.audioMel!.nMel).toBe(2);
  });

  it("leaves the audio fields unset when the blob carries none", () => {
    const parsed = parseOverlayMeta(bytes(tlv(0x01, u16(12))));
    expect(parsed.audioClass).toBeUndefined();
    expect(parsed.audioMel).toBeUndefined();
    expect(parsed.audioLabels).toBeUndefined();
  });
});
