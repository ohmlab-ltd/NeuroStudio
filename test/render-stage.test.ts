// Stage and overlay rendering, and the camera tool states.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearMaskCache,
  createRepaintGate,
  drawOverlay,
  ellipsize,
  fitRect,
  intersectRect,
  sameMaskBits,
  type OverlayDrawOptions,
  type Rect,
} from "../src/render/overlay";
import { emptyOverlayData, type OverlayData, type OverlayMask } from "../src/device/tlv";
import * as store from "../src/state/device";
import { swapMainThermal } from "../src/state/options";
import { CameraStage, recordingStopNotice } from "../src/components/CameraStage";
import type { DeviceEvent } from "../src/vite-env";
import { tlv, u16 } from "./bytes";

const CHAR_W = 7;

interface Call {
  name: string;
  args: unknown[];
}

/** A 2D context that logs every method call and measures 7 px per char. */
function fakeContext(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string, unknown> = { font: "10px sans-serif", filter: "none" };
  return new Proxy(props, {
    get(target, prop: string) {
      if (prop === "measureText") {
        return (s: string) => {
          calls.push({ name: prop, args: [s] });
          return { width: s.length * CHAR_W };
        };
      }
      if (prop === "createImageData") {
        return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      }
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function options(patch: Partial<OverlayDrawOptions>): OverlayDrawOptions {
  return {
    data: emptyOverlayData,
    dest: { x: 0, y: 0, w: 640, h: 480 },
    dpr: 1,
    showInferenceText: false,
    showBoxes: false,
    showKeypoints: false,
    showBindings: false,
    showBoxLabels: false,
    showShading: false,
    maskFeather: 0,
    streamWidth: 640,
    kpConfMin: 30,
    lineW: 3,
    kpRadius: 4,
    boxW: 3,
    tofFrame: null,
    showDebugTofOverlay: false,
    tofDisplay: { minMm: 0, maxMm: 2000, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    warning: "",
    ...patch,
  };
}

const overlayWith = (patch: Partial<OverlayData>): OverlayData => ({
  ...emptyOverlayData,
  ...patch,
});

const texts = (calls: Call[]) =>
  calls
    .filter((c) => c.name === "fillText")
    .map((c) => ({ text: c.args[0] as string, x: c.args[1] as number, y: c.args[2] as number }));

function inside(r: Rect, x: number, y: number, w = 0, h = 0): boolean {
  return (
    x >= r.x - 1e-6 && y >= r.y - 1e-6 && x + w <= r.x + r.w + 1e-6 && y + h <= r.y + r.h + 1e-6
  );
}

describe("HUD in cover mode", () => {
  // The default window's stage with the board's portrait VD66GY stream.
  const stage: Rect = { x: 0, y: 0, w: 902, h: 808 };
  const dest = fitRect(1120, 1364, stage.w, stage.h, "cover");
  const hud = intersectRect(dest, stage);

  it("crops the video past the stage, so dest alone is not the visible area", () => {
    expect(dest.y).toBeLessThan(-100);
    expect(hud).toEqual(stage);
  });

  it("draws the warning banner and inference readout inside the visible area", () => {
    const calls: Call[] = [];
    drawOverlay(
      fakeContext(calls),
      options({
        dest,
        hud,
        streamWidth: 1120,
        showInferenceText: true,
        warning: "Sensor over temperature",
        data: overlayWith({ inferenceMs: 12 }),
      }),
    );
    const drawn = texts(calls);
    expect(drawn.map((t) => t.text)).toEqual(["inf 12ms  det 0", "Sensor over temperature"]);
    for (const t of drawn) {
      expect(inside(hud, t.x, t.y, t.text.length * CHAR_W)).toBe(true);
    }
    const banner = calls.find((c) => c.name === "roundRect");
    const [bx, by, bw, bh] = banner!.args as number[];
    expect(inside(hud, bx, by, bw, bh)).toBe(true);
  });

  it("keeps a label badge on screen and hides the badge of a box cropped out of view", () => {
    const calls: Call[] = [];
    drawOverlay(
      fakeContext(calls),
      options({
        dest,
        hud,
        streamWidth: 1120,
        showBoxLabels: true,
        data: overlayWith({
          boxes: [
            // Partly visible, near the cropped top edge.
            { xc: 0.5, yc: 0.2, w: 0.2, h: 0.1, score255: 200, cls: 0, label: "person" },
            // Entirely in the cropped band above the stage.
            { xc: 0.5, yc: 0.03, w: 0.2, h: 0.04, score255: 200, cls: 0, label: "hidden" },
          ],
        }),
      }),
    );
    const drawn = texts(calls);
    expect(drawn.map((t) => t.text)).toEqual(["person"]);
    const badge = calls.find((c) => c.name === "fillRect")!.args as number[];
    expect(inside(hud, badge[0], badge[1], badge[2], badge[3])).toBe(true);
  });

  it("falls back to dest when no hud is given (letterboxed views)", () => {
    const calls: Call[] = [];
    const contain = fitRect(1120, 1364, 400, 300, "contain");
    drawOverlay(fakeContext(calls), options({ dest: contain, warning: "hot" }));
    const [bx, by] = calls.find((c) => c.name === "roundRect")!.args as number[];
    expect(by).toBe(contain.y + 8);
    expect(bx).toBeGreaterThan(contain.x);
  });
});

describe("ellipsis truncation", () => {
  const measure = (s: string) => s.length * CHAR_W;

  it("returns text that fits unchanged", () => {
    expect(ellipsize("short", 100, measure)).toBe("short");
  });

  it("keeps the longest prefix that fits with the ellipsis", () => {
    const text = "a".repeat(50);
    const out = ellipsize(text, 70, measure);
    expect(out).toBe(`${"a".repeat(9)}…`);
    expect(measure(out)).toBeLessThanOrEqual(70);
  });

  it("falls back to the ellipsis alone when no character fits", () => {
    expect(ellipsize("abcdef", CHAR_W, measure)).toBe("…");
  });

  it("returns an empty string when not even the ellipsis fits", () => {
    expect(ellipsize("abcdef", 1, measure)).toBe("");
  });

  it("does not cut a leading surrogate pair when no character fits", () => {
    expect(ellipsize("\u{1F600}\u{1F600}\u{1F600}", 2 * CHAR_W, measure)).toBe("…");
  });

  it("does not cut a surrogate pair", () => {
    const text = `ab${"\u{1F600}".repeat(10)}`;
    // 28 px is four code units: "ab", half an emoji, then the ellipsis.
    const out = ellipsize(text, 28, measure);
    expect(out).toBe("ab…");
  });

  it("measures a 4000-character string about log2(n) times, not n times", () => {
    let count = 0;
    const counted = (s: string) => {
      count++;
      return measure(s);
    };
    ellipsize("x".repeat(4000), 700, counted);
    expect(count).toBeLessThan(20);
  });

  it("caches the fitted warning across repaints", () => {
    const warning = "w".repeat(4000);
    const first: Call[] = [];
    drawOverlay(fakeContext(first), options({ warning }));
    const firstMeasures = first.filter((c) => c.name === "measureText").length;
    expect(firstMeasures).toBeLessThan(20);

    const second: Call[] = [];
    drawOverlay(fakeContext(second), options({ warning }));
    // Only the fitted string's own width is measured again.
    expect(second.filter((c) => c.name === "measureText").length).toBe(1);
  });
});

describe("mask cache", () => {
  const mask = (packed: Uint8Array, w = 40, h = 100): OverlayMask => ({ objId: 0, w, h, packed });

  // Bytes 1 to 6 change, which a sample of every 7th byte would not see.
  const base = new Uint8Array(500).map((_, i) => (i * 37) & 0xff);
  const changed = base.slice();
  for (const i of [1, 2, 3, 4, 5, 6]) changed[i] ^= 0xff;

  it("sees a change in any byte", () => {
    expect(sameMaskBits(mask(base), mask(changed))).toBe(false);
    expect(sameMaskBits(mask(base), mask(base.slice()))).toBe(true);
    expect(sameMaskBits(mask(base), mask(base, 50, 80))).toBe(false);
  });

  describe("in drawShading", () => {
    const created: { kind: string; el: Record<string, unknown> }[] = [];
    const layerSizes: { w: number; h: number }[] = [];

    function fakeElement(kind: string): Record<string, unknown> {
      const attrs: Record<string, string> = {};
      const el: Record<string, unknown> = {
        style: {},
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
          if (k === "id") el.id = v;
        },
        getAttribute: (k: string) => attrs[k],
        appendChild: () => undefined,
        remove: () => undefined,
        attrs,
      };
      created.push({ kind, el });
      return el;
    }

    beforeAll(() => {
      vi.stubGlobal("document", {
        body: { appendChild: () => undefined },
        createElementNS: (_ns: string, tag: string) => fakeElement(tag),
        createElement: (tag: string) => {
          const el = fakeElement(tag);
          let w = 300;
          let h = 150;
          let isLayer = false;
          Object.defineProperty(el, "width", {
            get: () => w,
            set: (v: number) => {
              w = v;
              if (isLayer) layerSizes.push({ w, h });
            },
          });
          Object.defineProperty(el, "height", {
            get: () => h,
            set: (v: number) => {
              h = v;
              if (isLayer) layerSizes.push({ w, h });
            },
          });
          el.getContext = (_type: string, attrs?: { willReadFrequently?: boolean }) => {
            if (attrs && attrs.willReadFrequently === false) isLayer = true;
            return fakeContext([]);
          };
          return el;
        },
      });
    });

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    afterEach(() => clearMaskCache());

    const box = { xc: 0.5, yc: 0.5, w: 0.5, h: 0.5, score255: 200, cls: 1 };
    const draw = (m: OverlayMask, feather = 2, destW = 640) =>
      drawOverlay(
        fakeContext([]),
        options({
          dest: { x: 0, y: 0, w: destW, h: 480 },
          showShading: true,
          maskFeather: feather,
          data: overlayWith({ boxes: [box], masksByObjId: new Map([[0, m]]) }),
        }),
      );
    it("rebuilds the silhouette when unsampled bytes change, and not for an equal copy", () => {
      const canvases = () => created.filter((c) => c.kind === "canvas").length;
      draw(mask(base));
      const afterFirst = canvases();
      draw(mask(base.slice()));
      expect(canvases()).toBe(afterFirst);
      draw(mask(changed));
      expect(canvases()).toBe(afterFirst + 1);
    });

    it("gives each blur radius its own filter instead of rewriting a shared one", () => {
      const filters = () => created.filter((c) => c.kind === "filter").length;
      const blurs = () => created.filter((c) => c.kind === "feGaussianBlur");
      const before = filters();
      // Two views of different widths painting alternately.
      for (let i = 0; i < 5; i++) {
        draw(mask(base), 2, 640);
        draw(mask(base), 2, 320);
      }
      expect(filters() - before).toBeLessThanOrEqual(2);
      const radii = blurs().map((b) => (b.el.attrs as Record<string, string>).stdDeviation);
      expect(new Set(radii).size).toBe(radii.length);
    });

    it("never shrinks the scratch layer", () => {
      draw(mask(base), 2, 640);
      draw(mask(base), 2, 100);
      draw(mask(base), 2, 640);
      for (let i = 1; i < layerSizes.length; i++) {
        expect(layerSizes[i].w).toBeGreaterThanOrEqual(layerSizes[i - 1].w);
        expect(layerSizes[i].h).toBeGreaterThanOrEqual(layerSizes[i - 1].h);
      }
    });
  });
});

describe("repaint gate", () => {
  it("paints once per change, compared by identity", () => {
    const gate = createRepaintGate();
    const bitmap = {};
    expect(gate([bitmap, 100, "warn"])).toBe(true);
    expect(gate([bitmap, 100, "warn"])).toBe(false);
    expect(gate([{}, 100, "warn"])).toBe(true);
    expect(gate([{}, 100, "warn"])).toBe(true);
    const same = {};
    gate([same, 100, ""]);
    expect(gate([same, 100, ""])).toBe(false);
    expect(gate([same, 101, ""])).toBe(true);
  });
});

// Store-backed: thermal staleness, recording, the stage tools

describe("with the device store", () => {
  let emit: (event: DeviceEvent) => void = () => undefined;
  let stop: () => void = () => undefined;
  const appended: Uint8Array[] = [];

  beforeAll(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      neuro: {
        onEvent(listener: (event: DeviceEvent) => void) {
          emit = listener;
          return () => undefined;
        },
        appendRecording(bytes: Uint8Array) {
          appended.push(bytes);
        },
      },
    });
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ close: () => undefined }));
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
    stop = store.startDeviceStore();
  });

  afterAll(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    emit({ t: "clear_caches" });
    store.recordingState.set({ active: false, path: null });
    swapMainThermal.set(false);
    store.connection.set({
      status: null,
      connecting: false,
      connected: false,
      hasRecentFrame: false,
    });
  });

  const thermalMeta = () => {
    const header = [...u16(2), ...u16(2), 0, 1, ...u16(0)];
    const pixels = [30000, 30100, 30200, 30300].flatMap(u16);
    const meta = new Uint8Array(tlv(0x30, [...header, ...pixels]));
    emit({ t: "meta", id: 1, metaLen: meta.length, jpegLen: 0, meta });
  };

  it("ages a thermal frame out after 3 s without a new one", () => {
    thermalMeta();
    expect(store.thermalFrame.get()).not.toBeNull();
    expect(store.thermalStale.get()).toBe(false);

    vi.advanceTimersByTime(2500);
    expect(store.thermalStale.get()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(store.thermalStale.get()).toBe(true);

    thermalMeta();
    expect(store.thermalStale.get()).toBe(false);

    vi.advanceTimersByTime(3500);
    expect(store.thermalStale.get()).toBe(true);
    emit({ t: "clear_caches" });
    expect(store.thermalStale.get()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(store.thermalStale.get()).toBe(false);
  });

  it("hands no frames back for recording: the main process records from ingest", () => {
    store.recordingState.set({ active: true, path: "x.mjpeg" });
    emit({ t: "frame", jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
    expect(appended).toHaveLength(0);
  });

  it("reports how a recording ended", () => {
    expect(recordingStopNotice({ path: "a.mjpeg", frames: 10 })).toBe("Recording saved: a.mjpeg");
    expect(recordingStopNotice({ path: "a.mjpeg", frames: 0 })).toMatch(/no frames captured/);
    expect(recordingStopNotice({ path: "a.mjpeg" })).toMatch(/no frames captured/);
    expect(recordingStopNotice({ path: "a.mjpeg", frames: 7, droppedFrames: 3 })).toMatch(
      /3 frames dropped/,
    );
    expect(recordingStopNotice({ path: "a.mjpeg", frames: 0, droppedFrames: 4 })).toMatch(
      /no frames captured/,
    );
    expect(recordingStopNotice({ path: "a.mjpeg", frames: 10, error: "ENOSPC" })).toBe(
      "Recording failed: ENOSPC. Partial file: a.mjpeg",
    );
    expect(recordingStopNotice({ path: null })).toBe("Recording stopped.");
  });

  const stageMarkup = (fitMode = false) =>
    renderToStaticMarkup(createElement(CameraStage, { fitMode, onToggleFit: () => undefined }));

  /** The attributes of the tool button with this icon-independent title. */
  const button = (html: string, title: RegExp) => {
    const tags = html.match(/<button[^>]*>/g) ?? [];
    return tags.find((t) => title.test(t.match(/title="([^"]*)"/)?.[1] ?? ""));
  };

  it("keeps Stop enabled and above the connect overlay after the link drops", () => {
    store.recordingState.set({ active: true, path: "a.mjpeg" });
    emit({ t: "status", text: "Device removed" });
    const html = stageMarkup();
    expect(html).toContain("connect-overlay");
    expect(html).toContain('class="camera-tools pinned"');
    const stopButton = button(html, /^Stop recording$/);
    expect(stopButton).toBeDefined();
    expect(stopButton).not.toContain("disabled");
  });

  it("disables Record with a reason on a thermal-only board, and snapshots thermal", () => {
    store.connection.set({
      status: "Connected",
      connecting: false,
      connected: true,
      hasRecentFrame: true,
    });
    thermalMeta();
    const html = stageMarkup();
    expect(button(html, /no camera stream/)).toContain("disabled");
    expect(button(html, /^Snapshot thermal image$/)).not.toContain("disabled");
  });

  it("shows a stalled thermal stage without probes or a snapshot", () => {
    store.connection.set({
      status: "Connected",
      connecting: false,
      connected: true,
      hasRecentFrame: true,
    });
    thermalMeta();
    vi.advanceTimersByTime(3500);
    const html = stageMarkup();
    expect(html).toContain("Thermal stream stalled");
    expect(html).not.toContain("probe-layer");
    expect(button(html, /stalled/)).toContain("disabled");
  });

  it("disables the Fill toggle in fullscreen and shows it off", () => {
    const html = stageMarkup(true);
    const aspect = button(html, /^Fill viewport/);
    expect(aspect).toContain("disabled");
    expect(aspect).not.toContain("active");
    const normal = button(stageMarkup(false), /^Fill viewport/);
    expect(normal).not.toContain("disabled");
    expect(normal).toContain("active");
  });
});
