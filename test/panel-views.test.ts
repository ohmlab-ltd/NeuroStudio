// What the Audio, Image Classifier, Events and Vision panels show, and a static render of each.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AudioPanel,
  audioBarTone,
  audioClassName,
  audioMelToRgba,
  audioWinner,
} from "../src/components/panels/AudioPanel";
import {
  ImageClassPanel,
  imageClassName,
  thresholdPercent,
} from "../src/components/panels/ImageClassPanel";
import {
  EventsPanel,
  eventAge,
  eventDeviceClock,
  eventSummary,
} from "../src/components/panels/EventsPanel";
import {
  VisionPanel,
  formatTagPose,
  holdEvidenceSubscription,
  kindLabel,
} from "../src/components/panels/VisionPanel";
import type { SlotControls } from "../src/components/PanelFrame";
import {
  audioClass,
  audioLabels,
  audioMel,
  boardEvents,
  connection,
  imageClass,
  visionFrame,
  visionKind,
} from "../src/state/device";
import { buildEvidenceSubscriptionPacket, kEvidenceCrop } from "../src/device/packets";
import {
  kVisionKindAprilTag,
  kVisionKindBlob,
  kVisionKindQr,
  type AudioClassFrame,
  type AudioMelFrame,
  type BoardEvent,
} from "../src/device/tlv";

const frame = (top: number, scores: number[]): AudioClassFrame => ({
  scores,
  top,
  level: 1200,
  threshold: 0.5,
});

describe("image classifier panel", () => {
  it("names an entry, or falls back to its class index", () => {
    expect(imageClassName({ index: 3, score: 0.5, name: "tabby" })).toBe("tabby");
    expect(imageClassName({ index: 3, score: 0.5, name: "" })).toBe("class 3");
  });

  it("shows a threshold with a decimal only when it needs one", () => {
    expect(thresholdPercent(0.05)).toBe("5%");
    expect(thresholdPercent(0.125)).toBe("12.5%");
    expect(thresholdPercent(0.5)).toBe("50%");
  });
});

describe("audio panel", () => {
  it("names a class with no label by its index", () => {
    expect(audioClassName(["yes", "no"], 1)).toBe("no");
    expect(audioClassName(["yes", "no"], 2)).toBe("class 2");
    expect(audioClassName([], 0)).toBe("class 0");
  });

  it("shows nothing above threshold for top = -1", () => {
    expect(audioWinner(frame(-1, [0.2, 0.3]), ["a", "b"])).toBeNull();
  });

  it("names the winner, with or without a labels beacon", () => {
    expect(audioWinner(frame(1, [0.1, 0.9]), ["a", "b"])).toEqual({ name: "b", score: 0.9 });
    // The headline must agree with the score rows when labels are missing.
    expect(audioWinner(frame(1, [0.1, 0.9]), [])).toEqual({ name: "class 1", score: 0.9 });
  });

  it("treats a top with no score behind it as no winner", () => {
    expect(audioWinner(frame(3, [0.1, 0.9]), ["a", "b", "c", "d"])).toBeNull();
  });

  it("colours bars as the device does", () => {
    expect(audioBarTone(0.2, 0.5, true)).toBe("win");
    expect(audioBarTone(0.5, 0.5, false)).toBe("over");
    expect(audioBarTone(0.49, 0.5, false)).toBe("under");
  });

  /** The colour one value maps to. */
  const one = (v: number) =>
    Array.from(audioMelToRgba({ nMel: 1, nFrames: 1, layout: 0, data: Uint8Array.from([v]) }));
  const pixel = (rgba: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

  it("draws low bands at the bottom and the newest frame on the right", () => {
    // 2 mel x 3 frames holding 120 * mel + 40 * frame, in both layouts.
    const frameMajor: AudioMelFrame = {
      nMel: 2,
      nFrames: 3,
      layout: 0,
      data: Uint8Array.from([0, 120, 40, 160, 80, 200]),
    };
    const melMajor: AudioMelFrame = {
      nMel: 2,
      nFrames: 3,
      layout: 1,
      data: Uint8Array.from([0, 40, 80, 120, 160, 200]),
    };
    const image = audioMelToRgba(frameMajor);
    expect(audioMelToRgba(melMajor)).toEqual(image);
    expect(image.length).toBe(2 * 3 * 4);
    expect(pixel(image, 3, 0, 1)).toEqual(one(0)); // mel 0, oldest frame
    expect(pixel(image, 3, 2, 1)).toEqual(one(80)); // mel 0, newest frame
    expect(pixel(image, 3, 0, 0)).toEqual(one(120)); // mel 1, oldest frame
    expect(pixel(image, 3, 2, 0)).toEqual(one(200)); // mel 1, newest frame
  });

  it("uses the on-device ramp", () => {
    expect(one(0)).toEqual([0, 0, 0, 255]);
    expect(one(255)).toEqual([255, 255, 255, 255]);
    // 51 / 255 * 6 = 1.2: a fifth of the way from 0x140050 to 0x78008C.
    expect(one(51)).toEqual([40, 0, 92, 255]);
  });
});

const event = (patch: Partial<BoardEvent>): BoardEvent => ({
  id: 1,
  tMs: 0,
  sources: 1,
  state: 2,
  score: 7,
  preFrames: 0,
  postFrames: 0,
  sinksOk: 0,
  receivedAt: 0,
  ...patch,
});

describe("events panel", () => {
  it("counts the age up in seconds, then minutes, then hours", () => {
    expect(eventAge(0)).toBe("0s ago");
    expect(eventAge(59.9)).toBe("59s ago");
    expect(eventAge(60)).toBe("1m 0s ago");
    expect(eventAge(3599)).toBe("59m 59s ago");
    expect(eventAge(3600)).toBe("1h 0m ago");
    expect(eventAge(3725)).toBe("1h 2m ago");
    expect(eventAge(-0.4)).toBe("0s ago");
  });

  it("shows the device clock as time since boot", () => {
    expect(eventDeviceClock(0)).toBe("device +00:00:00");
    expect(eventDeviceClock(3_723_999)).toBe("device +01:02:03");
    expect(eventDeviceClock(360_000_000)).toBe("device +100:00:00");
  });

  it("reports a clip still being gathered", () => {
    expect(eventSummary(event({ state: 1 }))).toBe("post-roll  ·  score 7  ·  clip pending");
  });

  it("says nothing about saving until the write is over", () => {
    expect(eventSummary(event({ state: 2, preFrames: 30, postFrames: 60 }))).toBe(
      "writing  ·  score 7  ·  90 frames  (30 before / 60 after)",
    );
  });

  it("says whether the finished clip was kept", () => {
    const clip = { preFrames: 30, postFrames: 60 };
    expect(eventSummary(event({ ...clip, state: 3, sinksOk: 1 }))).toBe(
      "refractory  ·  score 7  ·  90 frames  (30 before / 60 after)  ·  saved",
    );
    expect(eventSummary(event({ ...clip, state: 0, sinksOk: 0 }))).toBe(
      "idle  ·  score 7  ·  90 frames  (30 before / 60 after)  ·  not saved",
    );
    // No frames and no sinks: nothing was meant to be written.
    expect(eventSummary(event({ state: 0 }))).toBe("idle  ·  score 7  ·  clip pending");
  });

  it("names an unknown state by number", () => {
    expect(eventSummary(event({ state: 9 }))).toBe("state 9  ·  score 7  ·  clip pending");
  });
});

describe("vision panel", () => {
  it("names the AprilTag sketch", () => {
    expect(kindLabel(kVisionKindAprilTag)).toBe("APRILTAG");
    expect(kindLabel(kVisionKindQr)).toBe("QR CODE");
    // Several sketches at once has no single name.
    expect(kindLabel(kVisionKindQr | kVisionKindBlob)).toBe("VISION");
  });

  describe("evidence subscription", () => {
    const setConnected = (connected: boolean) => connection.set({ ...connection.get(), connected });

    /** Starts holding the subscription and returns the writes seen so far. */
    function hold() {
      const writes: Uint8Array[] = [];
      vi.useFakeTimers();
      vi.stubGlobal("window", { neuro: { write: (b: Uint8Array) => writes.push(b) } });
      return { writes, release: holdEvidenceSubscription(kEvidenceCrop) };
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      setConnected(false);
    });

    it("asks at once, renews every second and cancels on release", () => {
      setConnected(true);
      const { writes, release } = hold();
      const on = buildEvidenceSubscriptionPacket(kEvidenceCrop);
      expect(writes).toEqual([on]);
      vi.advanceTimersByTime(999);
      expect(writes).toEqual([on]);
      vi.advanceTimersByTime(1);
      expect(writes).toEqual([on, on]);
      vi.advanceTimersByTime(2000);
      expect(writes).toEqual([on, on, on, on]);
      release();
      expect(writes).toEqual([on, on, on, on, buildEvidenceSubscriptionPacket(0)]);
      vi.advanceTimersByTime(5000);
      expect(writes.length).toBe(5);
    });

    it("stays quiet while disconnected and resumes on reconnect", () => {
      const { writes, release } = hold();
      vi.advanceTimersByTime(3000);
      expect(writes).toEqual([]);
      setConnected(true);
      vi.advanceTimersByTime(1000);
      expect(writes).toEqual([buildEvidenceSubscriptionPacket(kEvidenceCrop)]);
      setConnected(false);
      release();
      expect(writes.length).toBe(1);
    });

    it("keeps the ask alive while another panel still holds it", () => {
      setConnected(true);
      const { writes, release } = hold();
      const releaseSecond = holdEvidenceSubscription(kEvidenceCrop);
      const on = buildEvidenceSubscriptionPacket(kEvidenceCrop);
      const off = buildEvidenceSubscriptionPacket(0);
      writes.length = 0;
      // One renewal a second, however many panels are open.
      vi.advanceTimersByTime(1000);
      expect(writes).toEqual([on]);
      // Closing one of two Vision slots must not send mask 0 under the other.
      release();
      expect(writes).toEqual([on, on]);
      release(); // a second release of the same hold is a no-op
      vi.advanceTimersByTime(1000);
      expect(writes).toEqual([on, on, on]);
      releaseSecond();
      expect(writes).toEqual([on, on, on, off]);
      vi.advanceTimersByTime(5000);
      expect(writes.length).toBe(4);
    });
  });

  it("formats pose in metres and whole degrees", () => {
    const pose = { tx: 0.123, ty: -0.045, tz: 1.5, rx: -12.34, ry: 0, rz: 179.9 };
    expect(formatTagPose(pose)).toEqual([
      "x 0.123  y -0.045  z 1.500 m",
      "rx -12  ry 0  rz 180 deg",
    ]);
  });
});

describe("panel markup", () => {
  const controls: SlotControls = {
    index: 0,
    selected: "audio",
    available: new Set(),
    collapsed: false,
    canAdd: true,
    canRemove: true,
    onSelect: () => undefined,
    onToggleCollapse: () => undefined,
    onAdd: () => undefined,
    onRemove: () => undefined,
    onDragStart: () => undefined,
    onDragEnd: () => undefined,
  };
  const render = (panel: FunctionComponent<{ controls: SlotControls }>) =>
    renderToStaticMarkup(createElement(panel, { controls }));

  afterEach(() => {
    audioClass.set(null);
    audioMel.set(null);
    audioLabels.set([]);
    imageClass.set(null);
    boardEvents.set([]);
    visionFrame.set(null);
    visionKind.set(0);
  });

  it("audio: says what arrived while waiting for scores", () => {
    audioLabels.set(["yes", "no"]);
    const html = render(AudioPanel);
    expect(html).toContain("Waiting for a classification…");
    expect(html).toContain("labels 2   spectrogram none");
  });

  it("audio: shows the winner, unnamed classes and the spectrogram caption", () => {
    audioLabels.set(["yes"]);
    audioClass.set(frame(1, [0.1, 0.9]));
    audioMel.set({ nMel: 2, nFrames: 3, layout: 1, data: new Uint8Array(6) });
    const html = render(AudioPanel);
    expect(html).toContain(">class 1<");
    expect(html).toContain("90%");
    expect(html).toContain("threshold 0.50");
    expect(html).toContain("2 mel x 3 frames, mel-major  (low frequencies");
  });

  it("audio: shows nothing above threshold for top = -1", () => {
    audioClass.set(frame(-1, [0.1, 0.2]));
    expect(render(AudioPanel)).toContain("nothing above threshold");
  });

  it("image classifier: waits for the first result", () => {
    expect(render(ImageClassPanel)).toContain("Waiting for a classification…");
  });

  it("image classifier: shows the best class, then every class the device sent", () => {
    imageClass.set({
      entries: [
        { index: 207, score: 0.712, name: "golden retriever" },
        { index: 5, score: 0.061, name: "" },
      ],
      numClasses: 1000,
      threshold: 0.05,
    });
    const html = render(ImageClassPanel);
    expect(html).toContain("IMAGE CLASSIFIER");
    expect(html).toContain("golden retriever");
    expect(html).toContain("71%");
    expect(html).toContain(">class 5<");
    expect(html).toContain("1000 classes");
    expect(html).toContain("threshold 5%");
  });

  it("image classifier: says when nothing cleared the threshold", () => {
    imageClass.set({ entries: [], numClasses: 1000, threshold: 0.125 });
    const html = render(ImageClassPanel);
    expect(html).toContain("Nothing above 12.5%");
    expect(html).not.toContain("audio-score");
  });

  it("events: lists events newest first", () => {
    expect(render(EventsPanel)).toContain("No events yet");
    boardEvents.set([event({ id: 6, sources: 0b11, tMs: 1500 }), event({ id: 5, sources: 0b100 })]);
    const html = render(EventsPanel);
    expect(html.indexOf("#6")).toBeLessThan(html.indexOf("#5"));
    expect(html).toContain("motion + NN");
    expect(html).toContain("device +00:00:01");
  });

  it("vision: shows an AprilTag's pose only when it has one", () => {
    const tag = {
      cx: 0.5,
      cy: 0.25,
      w: 0.1,
      h: 0.1,
      text: "id 3",
      detail: "tag36h11  hamming 0  margin 0.50  0.0 deg",
      cropW: 0,
      cropH: 0,
      crop: null,
    };
    visionKind.set(kVisionKindAprilTag);
    visionFrame.set({
      kind: kVisionKindAprilTag,
      results: [{ ...tag, pose: { tx: 0.1, ty: 0, tz: 0.5, rx: 0, ry: 0, rz: 90 } }],
    });
    const html = render(VisionPanel);
    expect(html).toContain("APRILTAG");
    expect(html).toContain("x 0.100  y 0.000  z 0.500 m");
    expect(html).toContain("rx 0  ry 0  rz 90 deg");
    expect(html).toContain("x 50%  y 25%");

    visionFrame.set({ kind: kVisionKindAprilTag, results: [{ ...tag, pose: null }] });
    expect(render(VisionPanel)).not.toContain("vision-pose");
  });
});
