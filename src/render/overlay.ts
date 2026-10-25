// Canvas 2D overlay painting, in canvas pixels against the rectangle the video occupies.
// Screen-constant sizes are CSS pixels times the device pixel ratio.

import {
  maskBitAt,
  overlayColorFromId,
  type FollowTarget,
  type OverlayBox,
  type OverlayData,
  type OverlayMask,
  type TofFrame,
} from "../device/tlv";
import { tofDistanceColor } from "../device/thermal";
import type { TofDisplayOptions } from "../state/options";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayDrawOptions {
  data: OverlayData;
  dest: Rect;
  /** The on-screen part of `dest`, holding the banner, readout and badges. Defaults to `dest`. */
  hud?: Rect;
  dpr: number;
  showInferenceText: boolean;
  showBoxes: boolean;
  showKeypoints: boolean;
  showBindings: boolean;
  showBoxLabels: boolean;
  showShading: boolean;
  maskFeather: number;
  /** In stream pixels; converts the feather radius to canvas px. */
  streamWidth: number;
  kpConfMin: number;
  lineW: number;
  kpRadius: number;
  boxW: number;
  tofFrame: TofFrame | null;
  showDebugTofOverlay: boolean;
  tofDisplay: TofDisplayOptions;
  warning: string;
}

// Mask cache + hold

interface HeldMask {
  canvas: HTMLCanvasElement;
  mask: OverlayMask;
  lastSeenMs: number;
}

/** How long a mask is held while its box persists without TLV 11. */
const MASK_HOLD_MS = 500;
const MAX_MASK_ENTRIES = 64;

const heldMasks = new Map<number, HeldMask>();

export function sameMaskBits(a: OverlayMask, b: OverlayMask): boolean {
  if (a === b) return true;
  if (a.w !== b.w || a.h !== b.h) return false;
  const p = a.packed;
  const q = b.packed;
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== q[i]) return false;
  }
  return true;
}

function buildMaskCanvas(m: OverlayMask): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = m.w;
  canvas.height = m.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const image = ctx.createImageData(m.w, m.h);
  const data = image.data;
  let o = 0;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = maskBitAt(m, x, y) ? 255 : 0;
      o += 4;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function evictMasks(): void {
  if (heldMasks.size <= MAX_MASK_ENTRIES) return;
  const entries = [...heldMasks.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
  for (let i = 0; i < entries.length - MAX_MASK_ENTRIES; i++) {
    heldMasks.delete(entries[i][0]);
  }
}

export function clearMaskCache(): void {
  heldMasks.clear();
}

// Mask upscale filter

/** Blur, then a steep alpha ramp. An SVG filter, as CSS filter functions cannot act on alpha. */
const STEEP = 12; // slope of the re-threshold
const FILTER_ID_PREFIX = "neuro-mask-upscale";

/** One filter per blur radius: rewriting a shared filter invalidates it on every paint. */
const MAX_FILTERS = 8;
const filtersByRadius = new Map<string, SVGFilterElement>();
let filterHost: SVGSVGElement | null = null;
let nextFilterId = 0;
let svgFilterSupported: boolean | null = null;

function ensureFilterHost(): SVGSVGElement | null {
  if (filterHost) return filterHost;
  if (typeof document === "undefined") return null;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.pointerEvents = "none";
  svg.setAttribute("aria-hidden", "true");
  document.body.appendChild(svg);
  filterHost = svg;
  return svg;
}

function maskFilterId(stdDeviation: number): string | null {
  const radius = Math.max(0.01, stdDeviation).toFixed(2);
  const known = filtersByRadius.get(radius);
  if (known) {
    // Re-insert so the map stays in least-recently-used order.
    filtersByRadius.delete(radius);
    filtersByRadius.set(radius, known);
    return known.id;
  }
  const host = ensureFilterHost();
  if (!host) return null;

  if (filtersByRadius.size >= MAX_FILTERS) {
    const oldest = filtersByRadius.keys().next().value;
    if (oldest !== undefined) {
      filtersByRadius.get(oldest)?.remove();
      filtersByRadius.delete(oldest);
    }
  }

  const svgNs = "http://www.w3.org/2000/svg";
  const filter = document.createElementNS(svgNs, "filter");
  filter.setAttribute("id", `${FILTER_ID_PREFIX}-${nextFilterId++}`);
  filter.setAttribute("x", "-25%");
  filter.setAttribute("y", "-25%");
  filter.setAttribute("width", "150%");
  filter.setAttribute("height", "150%");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const blur = document.createElementNS(svgNs, "feGaussianBlur");
  blur.setAttribute("stdDeviation", radius);

  const transfer = document.createElementNS(svgNs, "feComponentTransfer");
  const funcA = document.createElementNS(svgNs, "feFuncA");
  funcA.setAttribute("type", "linear");
  funcA.setAttribute("slope", String(STEEP));
  // Steep alpha ramp centred on 0.5: a' = STEEP * a - (STEEP - 1) / 2.
  funcA.setAttribute("intercept", String(-((STEEP - 1) / 2)));
  transfer.appendChild(funcA);

  filter.appendChild(blur);
  filter.appendChild(transfer);
  host.appendChild(filter);

  filtersByRadius.set(radius, filter);
  return filter.id;
}

function supportsSvgFilter(ctx: CanvasRenderingContext2D, filterId: string): boolean {
  if (svgFilterSupported !== null) return svgFilterSupported;
  const previous = ctx.filter;
  try {
    ctx.filter = `url(#${filterId})`;
    svgFilterSupported = ctx.filter !== "none";
  } catch {
    svgFilterSupported = false;
  }
  ctx.filter = previous;
  return svgFilterSupported;
}

/** The re-threshold by hand, where the SVG filter is unavailable. */
function applySteepAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const offset = -((STEEP - 1) / 2) * 255;
  for (let i = 3; i < data.length; i += 4) {
    const a = STEEP * data[i] + offset;
    data[i] = a < 0 ? 0 : a > 255 ? 255 : a;
  }
  ctx.putImageData(image, 0, 0);
}

/** Scratch layer shared by all masks. It only grows; each mask uses its top-left w x h. */
let layerCanvas: HTMLCanvasElement | null = null;

function scratchLayer(w: number, h: number): CanvasRenderingContext2D | null {
  if (!layerCanvas) layerCanvas = document.createElement("canvas");
  if (layerCanvas.width < w || layerCanvas.height < h) {
    layerCanvas.width = Math.max(layerCanvas.width, w);
    layerCanvas.height = Math.max(layerCanvas.height, h);
  }
  const ctx = layerCanvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// Geometry

function boxRect(b: OverlayBox, dest: Rect): Rect {
  const W = dest.w;
  const H = dest.h;
  const bw = Math.min(W, Math.max(1, b.w * W));
  const bh = Math.min(H, Math.max(1, b.h * H));
  const xc = Math.min(W, Math.max(0, b.xc * W));
  const yc = Math.min(H, Math.max(0, b.yc * H));

  const left = Math.floor(Math.min(W, Math.max(0, xc - bw / 2)));
  const top = Math.floor(Math.min(H, Math.max(0, yc - bh / 2)));
  const right = Math.ceil(Math.min(W, Math.max(0, xc + bw / 2)));
  const bottom = Math.ceil(Math.min(H, Math.max(0, yc + bh / 2)));

  return { x: dest.x + left, y: dest.y + top, w: right - left, h: bottom - top };
}

function shadeColorFor(b: OverlayBox, objId: number): string {
  const pick = b.cls >= 0 ? b.cls : objId;
  return overlayColorFromId(pick % 5);
}

function withAlpha(color: string, alpha: number): string {
  // Colours from overlayColorFromId are always #rrggbb.
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Layers

function drawShading(ctx: CanvasRenderingContext2D, o: OverlayDrawOptions): void {
  const now = Date.now();
  const scale = o.streamWidth > 0 ? o.dest.w / o.streamWidth : 1;
  const blurPx = o.maskFeather * scale;
  const useFilter = o.maskFeather > 0.05;
  const filterId = useFilter ? maskFilterId(blurPx) : null;

  for (let idx = 0; idx < o.data.boxes.length; idx++) {
    const b = o.data.boxes[idx];
    const objId = idx;

    const maskNow = o.data.masksByObjId.get(objId);
    let canvas: HTMLCanvasElement | null = null;

    if (maskNow) {
      const held = heldMasks.get(objId);
      if (held && sameMaskBits(held.mask, maskNow)) {
        held.mask = maskNow;
        held.lastSeenMs = now;
        canvas = held.canvas;
      } else {
        canvas = buildMaskCanvas(maskNow);
        heldMasks.set(objId, { canvas, mask: maskNow, lastSeenMs: now });
        evictMasks();
      }
    } else {
      // No mask TLV: the held mask stays while the box exists.
      const held = heldMasks.get(objId);
      if (held && now - held.lastSeenMs <= MASK_HOLD_MS) {
        held.lastSeenMs = now;
        canvas = held.canvas;
      } else if (held) {
        heldMasks.delete(objId);
      }
    }

    if (!canvas) continue;

    const dst = boxRect(b, o.dest);
    if (dst.w <= 1 || dst.h <= 1) continue;

    const lw = Math.max(1, Math.round(dst.w));
    const lh = Math.max(1, Math.round(dst.h));
    const layer = scratchLayer(lw, lh);
    if (!layer) continue;

    // Confines the filter and the source-in fill to this mask's corner.
    layer.save();
    layer.beginPath();
    layer.rect(0, 0, lw, lh);
    layer.clip();

    const filterSupported = filterId !== null && supportsSvgFilter(layer, filterId);
    if (filterSupported) layer.filter = `url(#${filterId})`;
    else if (useFilter) layer.filter = `blur(${Math.max(0.01, blurPx)}px)`;

    layer.imageSmoothingEnabled = useFilter;
    if (useFilter) layer.imageSmoothingQuality = "high";
    layer.drawImage(canvas, 0, 0, lw, lh);
    layer.filter = "none";

    if (useFilter && !filterSupported) applySteepAlpha(layer, lw, lh);

    layer.globalCompositeOperation = "source-in";
    layer.fillStyle = withAlpha(shadeColorFor(b, objId), 90 / 255);
    layer.fillRect(0, 0, lw, lh);
    layer.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    ctx.clip();
    ctx.drawImage(layer.canvas, 0, 0, lw, lh, dst.x, dst.y, lw, lh);
    ctx.restore();
  }
}

/** Shortens `text` with a trailing ellipsis to fit `maxWidth`, by binary search. */
export function ellipsize(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  // Largest prefix that fits with the ellipsis, at least one character.
  let lo = 1;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  // Do not cut a surrogate pair in half.
  const last = text.charCodeAt(lo - 1);
  if (last >= 0xd800 && last <= 0xdbff) lo--;
  // The search starts from lo = 1 unverified: when not even one character
  // fits, fall back to the ellipsis alone rather than overflow.
  if (lo < 1 || measure(`${text.slice(0, lo)}…`) > maxWidth) {
    return measure("…") <= maxWidth ? "…" : "";
  }
  return `${text.slice(0, lo)}…`;
}

const fittedText = new Map<string, string>();
const MAX_FITTED_TEXT = 128;

/** ellipsize() with the ctx's current font, cached. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const key = `${ctx.font}\u0000${maxWidth}\u0000${text}`;
  let fitted = fittedText.get(key);
  if (fitted === undefined) {
    fitted = ellipsize(text, maxWidth, (s) => ctx.measureText(s).width);
    if (fittedText.size >= MAX_FITTED_TEXT) fittedText.clear();
    fittedText.set(key, fitted);
  }
  return fitted;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  b: OverlayBox,
  hud: Rect,
  dpr: number,
): void {
  const label = b.label;
  if (!label) return;
  // A box cropped out of view by cover mode has no badge.
  if (!rectsOverlap(r, hud)) return;

  const padX = 4 * dpr;
  const padY = 2 * dpr;
  const fontSize = 12 * dpr;

  ctx.font = `600 ${fontSize}px Inter, sans-serif`;
  ctx.textBaseline = "top";

  const maxTextWidth = Math.max(1, hud.w - padX * 2);
  const text = fitText(ctx, label, maxTextWidth);
  const textWidth = ctx.measureText(text).width;

  const badgeW = textWidth + padX * 2;
  const badgeH = fontSize * 1.2 + padY * 2;

  const bx = Math.max(hud.x, Math.min(r.x, hud.x + hud.w - badgeW));
  const by = Math.max(hud.y, Math.min(r.y - badgeH - 2 * dpr, hud.y + hud.h - badgeH));

  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(bx, by, badgeW, badgeH);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + padX, by + padY);
}

/** The follow-controller values, centred on the locked person's box centre. */
function drawFollowTarget(
  ctx: CanvasRenderingContext2D,
  t: FollowTarget,
  dest: Rect,
  hud: Rect,
  dpr: number,
): void {
  const omegaRad = t.omegaMrads / 1000;
  const lines = [
    `v ${t.vMms >= 0 ? "+" : ""}${t.vMms} mm/s`,
    `w ${omegaRad >= 0 ? "+" : ""}${omegaRad.toFixed(2)} rad/s`,
    t.distanceMm === 0 ? "d --" : `d ${t.distanceMm} mm`,
  ];

  const fontSize = 8 * dpr;
  ctx.font = `500 ${fontSize}px Inter, sans-serif`;
  ctx.textBaseline = "top";

  const lineH = fontSize * 1.1;
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);

  const padX = 4 * dpr;
  const padY = 2 * dpr;
  const boxW = maxW + padX * 2;
  const boxH = lineH * lines.length + padY * 2;

  const xc = dest.x + Math.min(dest.w, Math.max(0, t.x * dest.w));
  const yc = dest.y + Math.min(dest.h, Math.max(0, t.y * dest.h));

  let bx = xc - boxW / 2;
  let by = yc - boxH / 2;
  if (bx < hud.x) bx = hud.x;
  if (by < hud.y) by = hud.y;
  if (bx + boxW > hud.x + hud.w) bx = hud.x + hud.w - boxW;
  if (by + boxH > hud.y + hud.h) by = hud.y + hud.h - boxH;

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(bx, by, boxW, boxH);

  ctx.fillStyle = "#ffffff";
  let y = by + padY;
  for (const line of lines) {
    const lx = bx + (boxW - ctx.measureText(line).width) / 2;
    ctx.fillText(line, lx, y);
    y += lineH;
  }
}

function drawDebugTofGrid(ctx: CanvasRenderingContext2D, o: OverlayDrawOptions): void {
  const frame = o.tofFrame;
  if (!o.showDebugTofOverlay || !frame) return;
  if (frame.rows <= 0 || frame.cols <= 0 || frame.distancesMm.length === 0) return;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const clampPm1 = (v: number) => Math.min(1, Math.max(-1, v));

  const overlayW = clamp01(o.tofDisplay.scaleX) * o.dest.w;
  const overlayH = clamp01(o.tofDisplay.scaleY) * o.dest.h;
  if (overlayW <= 1 || overlayH <= 1) return;

  const centerX = o.dest.x + o.dest.w * 0.5 + clampPm1(o.tofDisplay.offsetX) * o.dest.w;
  const centerY = o.dest.y + o.dest.h * 0.5 + clampPm1(o.tofDisplay.offsetY) * o.dest.h;
  const left = centerX - overlayW / 2;
  const top = centerY - overlayH / 2;
  const cellW = overlayW / frame.cols;
  const cellH = overlayH / frame.rows;

  ctx.save();
  ctx.beginPath();
  ctx.rect(o.dest.x, o.dest.y, o.dest.w, o.dest.h);
  ctx.clip();

  ctx.lineWidth = 1 * o.dpr;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.44)";

  for (let row = 0; row < frame.rows; row++) {
    for (let col = 0; col < frame.cols; col++) {
      const srcRow = frame.rows - 1 - row;
      const idx = srcRow * frame.cols + col;
      if (idx >= frame.distancesMm.length) continue;

      const x = left + col * cellW;
      const y = top + row * cellH;
      const mm = frame.distancesMm[idx];
      if (mm > 0) {
        const color = tofDistanceColor(mm, o.tofDisplay.minMm, o.tofDisplay.maxMm);
        ctx.fillStyle = color.replace("rgb(", "rgba(").replace(")", ", 0.43)");
        ctx.fillRect(x, y, cellW, cellH);
      }
      ctx.strokeRect(x, y, cellW, cellH);
    }
  }

  ctx.restore();
}

function drawWarningBanner(
  ctx: CanvasRenderingContext2D,
  warning: string,
  hud: Rect,
  dpr: number,
): void {
  if (!warning) return;

  const margin = 8 * dpr;
  const padX = 10 * dpr;
  const padY = 6 * dpr;
  const fontSize = 14 * dpr;

  ctx.font = `700 ${fontSize}px Inter, sans-serif`;
  ctx.textBaseline = "top";

  const maxWidth = Math.max(10, hud.w * 0.55);
  const text = fitText(ctx, warning, maxWidth);

  const boxW = ctx.measureText(text).width + padX * 2;
  const boxH = fontSize * 1.25 + padY * 2;
  const left = Math.max(hud.x, hud.x + hud.w - margin - boxW);
  const top = hud.y + margin;

  ctx.fillStyle = "#d00000";
  ctx.beginPath();
  ctx.roundRect(left, top, boxW, boxH, 6 * dpr);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, left + padX, top + padY);
}

// Entry point

export function drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayDrawOptions): void {
  if (o.dest.w <= 1 || o.dest.h <= 1) return;
  const hud = o.hud && o.hud.w > 1 && o.hud.h > 1 ? o.hud : o.dest;

  ctx.save();
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  drawDebugTofGrid(ctx, o);

  // Shading first, so boxes and keypoints sit on top of it.
  if (o.showShading && o.data.boxes.length) drawShading(ctx, o);

  if (o.showBoxes) {
    ctx.lineWidth = o.boxW * o.dpr;
    ctx.strokeStyle = overlayColorFromId(4);
    for (const b of o.data.boxes) {
      const r = boxRect(b, o.dest);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }

  if (o.showBoxLabels) {
    for (const b of o.data.boxes) {
      drawLabel(ctx, boxRect(b, o.dest), b, hud, o.dpr);
    }
  }

  if (o.data.followTarget) drawFollowTarget(ctx, o.data.followTarget, o.dest, hud, o.dpr);

  const kpById = new Map(o.data.keypoints.map((k) => [k.id, k]));

  if (o.showBindings) {
    ctx.lineCap = "round";
    ctx.lineWidth = o.lineW * o.dpr;
    for (const e of o.data.bindings) {
      const a = kpById.get(e.a);
      const b = kpById.get(e.b);
      if (!a || !b) continue;
      if (a.conf255 < o.kpConfMin || b.conf255 < o.kpConfMin) continue;
      ctx.strokeStyle = overlayColorFromId(e.colorId);
      ctx.beginPath();
      ctx.moveTo(o.dest.x + a.x * o.dest.w, o.dest.y + a.y * o.dest.h);
      ctx.lineTo(o.dest.x + b.x * o.dest.w, o.dest.y + b.y * o.dest.h);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  if (o.showKeypoints) {
    for (const k of o.data.keypoints) {
      if (k.conf255 < o.kpConfMin) continue;
      ctx.fillStyle = overlayColorFromId(k.colorId);
      ctx.beginPath();
      ctx.arc(
        o.dest.x + k.x * o.dest.w,
        o.dest.y + k.y * o.dest.h,
        o.kpRadius * o.dpr,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  if (o.showInferenceText) {
    const fontSize = 12 * o.dpr;
    ctx.font = `${fontSize}px Inter, sans-serif`;
    ctx.textBaseline = "top";
    const text = `inf ${o.data.inferenceMs}ms  det ${o.data.boxes.length}`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.33)";
    ctx.fillRect(hud.x + 6 * o.dpr, hud.y + 6 * o.dpr, w + 10 * o.dpr, fontSize * 1.2 + 8 * o.dpr);
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.fillText(text, hud.x + 11 * o.dpr, hud.y + 10 * o.dpr);
  }

  // Warning banner last, over everything.
  drawWarningBanner(ctx, o.warning, hud, o.dpr);

  ctx.restore();
}

/** Where the video sits inside the viewport for a given fit. */
export function fitRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
  fit: "contain" | "cover" | "fill",
): Rect {
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) {
    return { x: 0, y: 0, w: boxW, h: boxH };
  }
  if (fit === "fill") return { x: 0, y: 0, w: boxW, h: boxH };

  const srcAspect = srcW / srcH;
  const boxAspect = boxW / boxH;
  const useWidth = fit === "contain" ? boxAspect > srcAspect : boxAspect < srcAspect;

  if (useWidth) {
    const w = boxH * srcAspect;
    return { x: (boxW - w) / 2, y: 0, w, h: boxH };
  }
  const h = boxW / srcAspect;
  return { x: 0, y: (boxH - h) / 2, w: boxW, h };
}

/** The overlap of two rectangles; zero-sized when they do not meet. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The gate returns true when any of `parts` differs by identity from the last true call. */
export function createRepaintGate(): (parts: readonly unknown[]) => boolean {
  let last: readonly unknown[] | null = null;
  return (parts) => {
    if (
      last !== null &&
      last.length === parts.length &&
      last.every((value, i) => Object.is(value, parts[i]))
    ) {
      return false;
    }
    last = parts.slice();
    return true;
  };
}
