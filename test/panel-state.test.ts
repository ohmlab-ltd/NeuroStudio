// Panel state across remounts and reconnects, the tune descriptor, and the menus.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as store from "../src/state/device";
import {
  cameraControls,
  cameraRestorePacket,
  ispForm,
  patchCameraControls,
  patchIspForm,
  setTuneValue,
  tuneValues,
} from "../src/state/controls";
import { overlayOptions, overlaysMasterOff, toggleAllOverlays } from "../src/state/options";
import {
  buildCameraControlPacket,
  kApplyAutoAwb,
  kApplyAutoExposure,
  kApplyAutoGain,
  kApplyExposureUs,
  kCamCapAwb,
  kCamCapExposure,
  kCamCapGain,
  kFlagAutoAwb,
  parseTuneDescriptor,
} from "../src/device/packets";
import { menuPlacement } from "../src/components/PanelPicker";
import { autoBoardPath, StatusBar } from "../src/components/StatusBar";
import { CameraControlsPanel } from "../src/components/panels/CameraControlsPanel";
import { floatStep, TuningPanel } from "../src/components/panels/TuningPanel";
import { OverlayOptionsPanel } from "../src/components/panels/OverlayOptionsPanel";
import { TofPanel } from "../src/components/panels/TofPanel";
import type { SlotControls } from "../src/components/PanelFrame";
import type { DeviceEvent, UsbBoardInfo } from "../src/vite-env";
import { ascii, tlv, u32 } from "./bytes";

let emit: (event: DeviceEvent) => void = () => undefined;
let stop: () => void = () => undefined;
const write = vi.fn<(bytes: Uint8Array) => void>();

beforeAll(() => {
  vi.stubGlobal("window", {
    neuro: {
      onEvent(listener: (event: DeviceEvent) => void) {
        emit = listener;
        return () => undefined;
      },
      write,
      setAutoRecover: () => undefined,
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
  write.mockClear();
});

/** One tune parameter record: id, type, hint, name, lo, hi, current. */
const param = (id: number, name: string, lo: number, hi: number, current: number) => [
  id,
  0,
  0,
  name.length,
  ...ascii(name),
  ...u32(lo),
  ...u32(hi),
  ...u32(current),
];

const descriptor = (...params: number[][]) => new Uint8Array([params.length, ...params.flat()]);

const announce = (data: Uint8Array) => emit({ t: "tune_desc", data });

function tofMeta(roiSize: number, roiStep: number): void {
  const bytes = new Uint8Array(tlv(0x15, [1, 1, roiSize, roiStep, ...u32(1234)]));
  emit({ t: "meta", id: 1, metaLen: bytes.length, jpegLen: 0, meta: bytes });
}

const controls: SlotControls = {
  index: 0,
  selected: "overlay",
  available: new Set(["overlay"]),
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

describe("tune descriptor", () => {
  it("returns null for a malformed descriptor and [] for none", () => {
    const good = descriptor(param(1, "thresh", 0, 255, 100));
    expect(parseTuneDescriptor(good)).toHaveLength(1);
    expect(parseTuneDescriptor(good.subarray(0, 10))).toBeNull();
    expect(parseTuneDescriptor(good.subarray(0, 3))).toBeNull();
    expect(parseTuneDescriptor(new Uint8Array(0))).toBeNull();
    expect(parseTuneDescriptor(new Uint8Array([0]))).toEqual([]);
  });

  it("keeps the previous parameters when an announce is truncated", () => {
    const good = descriptor(param(1, "thresh", 0, 255, 100));
    announce(good);
    const before = store.tuneParams.get();
    expect(before).toHaveLength(1);
    setTuneValue(1, 140);

    announce(good.subarray(0, 10));
    expect(store.tuneParams.get()).toBe(before);
    expect(tuneValues.get()).toEqual({ 1: 140 });
  });
});

describe("tuning values", () => {
  it("seeds from the board, then keeps what the user set", () => {
    announce(descriptor(param(1, "thresh", 0, 255, 100), param(2, "hue", 0, 359, 30)));
    expect(tuneValues.get()).toEqual({ 1: 100, 2: 30 });

    setTuneValue(1, 140);
    // The ~1 Hz re-announce carries the board's value; it must not win.
    announce(descriptor(param(1, "thresh", 0, 255, 100), param(2, "hue", 0, 359, 30)));
    expect(tuneValues.get()).toEqual({ 1: 140, 2: 30 });
  });

  it("shows the stored value after a remount and copies it", () => {
    announce(descriptor(param(1, "thresh", 0, 255, 100)));
    setTuneValue(1, 140);
    // A fresh render is a fresh mount: no component state carries over.
    const html = render(TuningPanel);
    expect(html).toContain(">140<");
    expect(html).not.toContain(">100<");
  });

  it("steps a float in round values, so 0.53 and 0.05 can be picked", () => {
    // PixelKit's export: "confidence", float, 0.01 to 0.99, starting at 0.53.
    announce(
      new Uint8Array([
        1,
        0,
        1,
        0,
        10,
        ...ascii("confidence"),
        ...u32(10),
        ...u32(990),
        ...u32(530),
      ]),
    );
    const html = render(TuningPanel);
    expect(html).toMatch(/type="range"[^>]*step="10"[^>]*value="530"/);
    expect(floatStep({ lo: 10, hi: 990 })).toBe(10);
    expect(floatStep({ lo: 0, hi: 100_000 })).toBe(1000);
    expect(floatStep({ lo: 0, hi: 50 })).toBe(1);
    expect(floatStep({ lo: 5, hi: 5 })).toBe(1);
  });

  it("re-seeds from the board after a disconnect", () => {
    announce(descriptor(param(1, "thresh", 0, 255, 100)));
    setTuneValue(1, 140);
    emit({ t: "clear_caches" });
    expect(tuneValues.get()).toEqual({});
    announce(descriptor(param(1, "thresh", 0, 255, 150)));
    expect(tuneValues.get()).toEqual({ 1: 150 });
  });

  it("seeds a different parameter that reuses an id, and drops removed ids", () => {
    announce(descriptor(param(1, "thresh", 0, 255, 100), param(2, "gain", 0, 10, 5)));
    setTuneValue(1, 140);
    announce(descriptor(param(1, "area", 0, 5000, 900)));
    expect(tuneValues.get()).toEqual({ 1: 900 });
  });
});

describe("camera controls", () => {
  beforeEach(() => {
    patchCameraControls({
      autoExposure: true,
      autoAwb: true,
      exposureUs: 10000,
      exposureApplied: false,
    });
  });

  const allCaps = kCamCapExposure | kCamCapGain | kCamCapAwb;

  it("re-sends a lock when the board announces its caps again", () => {
    patchCameraControls({ autoExposure: false, exposureUs: 8000, exposureApplied: true });
    emit({ t: "cam_caps", value: allCaps });
    expect(write).toHaveBeenCalledTimes(1);
    expect([...write.mock.calls[0][0]]).toEqual([
      ...buildCameraControlPacket({
        flags: kFlagAutoAwb,
        applyMask: kApplyAutoExposure | kApplyAutoGain | kApplyExposureUs,
        exposureUs: 8000,
      }),
    ]);

    // Re-announced at ~1 Hz with the same value: nothing more is sent.
    emit({ t: "cam_caps", value: allCaps });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to a board in its power-on state", () => {
    emit({ t: "cam_caps", value: allCaps });
    expect(write).not.toHaveBeenCalled();
  });

  it("only restores controls the sensor has", () => {
    const state = { ...cameraControls.get(), autoExposure: false, autoAwb: false };
    const packet = cameraRestorePacket(state, kCamCapAwb)!;
    expect(packet[11]).toBe(kApplyAutoAwb);
    expect(cameraRestorePacket(state, 0)).toBeNull();
    // Without a committed slider value the lock holds the current exposure.
    expect(cameraRestorePacket(state, kCamCapExposure)![11]).toBe(kApplyAutoExposure);
  });

  it("keeps the lock across a remount and a disconnect", () => {
    patchCameraControls({ autoExposure: false });
    emit({ t: "clear_caches" });
    emit({ t: "cam_caps", value: allCaps });
    const html = render(CameraControlsPanel);
    expect(html).toContain('aria-label="Auto exposure"');
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Auto exposure"/);
    expect(html).toContain("Exposure");
  });
});

describe("ToF panel", () => {
  it("shows the grid and offers no sensor settings, which no firmware takes", () => {
    // The core ignores 'CFG0'.
    tofMeta(8, 2);
    const html = render(TofPanel);
    expect(html).toContain("spad-grid");
    expect(html).not.toContain("Apply");
    expect(html).not.toContain("Profile");
  });
});

describe("ISP form", () => {
  it("keeps its values across a disconnect without claiming they are applied", () => {
    patchIspForm({ gainR: 2.5, status: "Applied" });
    emit({ t: "clear_caches" });
    expect(ispForm.get()).toMatchObject({ gainR: 2.5, status: null });
  });
});

describe("overlay master chip", () => {
  it("is shared state, so a remount shows it off", () => {
    toggleAllOverlays();
    expect(overlaysMasterOff.get()).toBe(true);
    expect(overlayOptions.get().showBoxes).toBe(false);
    const html = render(OverlayOptionsPanel);
    expect(html).toMatch(/aria-pressed="false"[^>]*>All overlays</);
    toggleAllOverlays();
    expect(overlayOptions.get().showBoxes).toBe(true);
  });
});

describe("panel menu placement", () => {
  const viewport = { width: 1440, height: 900 };

  it("opens below the trigger when it fits", () => {
    expect(menuPlacement({ top: 100, bottom: 124, right: 1400 }, 200, viewport)).toEqual({
      top: 128,
      right: 40,
      maxHeight: 900 - 124 - 4 - 8,
    });
  });

  it("flips above when there is more room there", () => {
    expect(menuPlacement({ top: 800, bottom: 824, right: 1400 }, 370, viewport)).toEqual({
      bottom: 900 - 800 + 4,
      right: 40,
      maxHeight: 800 - 4 - 8,
    });
  });

  it("caps the height so a long menu scrolls", () => {
    const small = { width: 1440, height: 400 };
    // Neither side fits 370 px: it takes the larger side and scrolls.
    const up = menuPlacement({ top: 220, bottom: 244, right: 1400 }, 370, small);
    expect(up).toMatchObject({ bottom: 400 - 220 + 4, maxHeight: 220 - 4 - 8 });
    const down = menuPlacement({ top: 180, bottom: 204, right: 1400 }, 370, small);
    expect(down).toMatchObject({ top: 208, maxHeight: 400 - 204 - 4 - 8 });
  });
});

describe("transport menu", () => {
  const board = (portPath: string, inUse?: boolean): UsbBoardInfo => ({
    vid: 0x0483,
    pid: 0x5740,
    bus: 1,
    ports: [3],
    serial: null,
    portPath,
    label: portPath,
    inUse,
  });

  it("names the board in auto mode only when it is unambiguous", () => {
    expect(autoBoardPath([board("1-3")])).toBe("1-3");
    expect(autoBoardPath([board("1-3", true), board("1-4", false)])).toBe("1-4");
    expect(autoBoardPath([board("1-3"), board("1-4")])).toBeNull();
    expect(autoBoardPath([])).toBeNull();
  });

  it("has no dead Settings control", () => {
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(html).not.toContain('title="Settings"');
  });

  it("shows the app's version, from package.json", async () => {
    const { version } = (await import("../package.json")).default;
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(html).toContain(`>v${version}</span>`);
  });
});
