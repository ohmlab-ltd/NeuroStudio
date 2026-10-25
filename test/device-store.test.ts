// The device store: what handleMeta folds across buffers, and what a disconnect clears.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../src/state/device";
import type { DeviceEvent } from "../src/vite-env";
import { ascii, i16, tlv, u16, u32 } from "./bytes";

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

beforeEach(() => emit({ t: "clear_caches" }));

function meta(...parts: number[][]): void {
  const bytes = new Uint8Array(parts.flat());
  emit({ t: "meta", id: 1, metaLen: bytes.length, jpegLen: 0, meta: bytes });
}

/** One AprilTag with pose and no crop. */
const aprilTag = (id: number, tzMm: number) =>
  tlv(0x66, [
    1,
    ...u16(32768),
    ...u16(32768),
    ...u16(1000),
    ...u16(1000),
    ...u16(id),
    0,
    0,
    ...u16(0),
    ...i16(0),
    1,
    ...i16(0),
    ...i16(0),
    ...i16(tzMm),
    ...i16(0),
    ...i16(0),
    ...i16(0),
    0,
    0,
  ]);

const evidence = (index: number, pixel: number) => tlv(0x70, [1, index, 1, 1, ...u16(pixel)]);

const event = (id: number, state: number) =>
  tlv(0x67, [...u32(id), ...u32(0), 1, state, ...u16(0), ...u16(0), ...u16(0), 0]);

const labels = (...names: string[]) =>
  tlv(0x53, [names.length, ...names.flatMap((n) => [n.length, ...ascii(n)])]);

describe("device store", () => {
  it("merges evidence from a later buffer into the frame on screen", () => {
    meta(aprilTag(3, 750));
    const before = store.visionFrame.get()!;

    meta(evidence(0, 0xbeef));
    const after = store.visionFrame.get()!;
    expect(after).not.toBe(before);
    expect([...after.results[0].crop!]).toEqual([0xbeef]);
    expect(after.results[0].pose!.tz).toBeCloseTo(0.75, 9);

    // A stale index changes nothing and does not notify.
    const listener = vi.fn();
    const unsubscribe = store.visionFrame.subscribe(listener);
    meta(evidence(4, 1));
    unsubscribe();
    expect(store.visionFrame.get()).toBe(after);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drops evidence when no frame is on screen", () => {
    meta(evidence(0, 1));
    expect(store.visionFrame.get()).toBeNull();
  });

  it("folds re-announced events by id, keeping the first arrival time", () => {
    meta(event(7, 1));
    const first = store.boardEvents.get()[0];

    meta(event(8, 0), event(7, 3));
    const list = store.boardEvents.get();
    expect(list.map((e) => e.id)).toEqual([8, 7]);
    expect(list[1].state).toBe(3);
    expect(list[1].receivedAt).toBe(first.receivedAt);
  });

  it("keeps the labels array while the beacon repeats itself", () => {
    meta(labels("dog", "bell"));
    const first = store.audioLabels.get();
    meta(labels("dog", "bell"));
    expect(store.audioLabels.get()).toBe(first);
    meta(labels("dog"));
    expect(store.audioLabels.get()).toEqual(["dog"]);
  });

  it("clears the vision, event and audio stores on disconnect", () => {
    meta(
      aprilTag(1, 100),
      event(1, 0),
      labels("dog"),
      tlv(0x51, [1, 0, ...u16(10), ...u16(500), ...u16(900)]),
      tlv(0x52, [1, 1, 0, 0, 42]),
    );
    expect(store.visionFrame.get()).not.toBeNull();
    expect(store.boardEvents.get()).toHaveLength(1);
    expect(store.audioLabels.get()).toEqual(["dog"]);
    expect(store.audioClass.get()).not.toBeNull();
    expect(store.audioMel.get()).not.toBeNull();

    emit({ t: "clear_caches" });
    expect(store.visionFrame.get()).toBeNull();
    expect(store.boardEvents.get()).toEqual([]);
    expect(store.audioLabels.get()).toEqual([]);
    expect(store.audioClass.get()).toBeNull();
    expect(store.audioMel.get()).toBeNull();
  });

  it("holds the image classifier's result through a corrupt record, and clears it on disconnect", () => {
    const result = (count: number, ...entries: number[][]) =>
      tlv(0x54, [count, 0, ...u16(1000), ...u16(50), ...entries.flat()]);
    const dog = [...u16(207), ...u16(712), 3, ...ascii("dog")];

    meta(result(1, dog));
    const first = store.imageClass.get();
    expect(first!.entries[0].name).toBe("dog");

    meta(result(2, dog)); // claims two entries, carries one
    expect(store.imageClass.get()).toBe(first);

    // An empty result, nothing above the threshold, is an answer too.
    meta(result(0));
    expect(store.imageClass.get()!.entries).toEqual([]);

    emit({ t: "clear_caches" });
    expect(store.imageClass.get()).toBeNull();
  });
});
