// Thermal and ToF colour ramps.

import type { ThermalFrame } from "./tlv";

export type ThermalColormap = "grayscale" | "ironbow" | "inferno";

interface ColorStop {
  t: number;
  r: number;
  g: number;
  b: number;
}

const IRONBOW: ColorStop[] = [
  { t: 0.0, r: 0, g: 0, b: 0 },
  { t: 0.2, r: 40, g: 0, b: 90 },
  { t: 0.4, r: 130, g: 0, b: 110 },
  { t: 0.6, r: 215, g: 50, b: 30 },
  { t: 0.75, r: 255, g: 120, b: 0 },
  { t: 0.9, r: 255, g: 215, b: 40 },
  { t: 1.0, r: 255, g: 255, b: 235 },
];

const INFERNO: ColorStop[] = [
  { t: 0.0, r: 0, g: 0, b: 4 },
  { t: 0.2, r: 66, g: 10, b: 104 },
  { t: 0.4, r: 147, g: 38, b: 103 },
  { t: 0.6, r: 221, g: 81, b: 58 },
  { t: 0.8, r: 252, g: 165, b: 10 },
  { t: 1.0, r: 252, g: 255, b: 164 },
];

function sampleStops(stops: ColorStop[], t: number): [number, number, number] {
  let s = 0;
  while (s < stops.length - 1 && t > stops[s + 1].t) s++;
  const a = stops[s];
  const b = s < stops.length - 1 ? stops[s + 1] : a;
  const span = b.t - a.t;
  const segT = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  return [
    Math.round(a.r + (b.r - a.r) * segT),
    Math.round(a.g + (b.g - a.g) * segT),
    Math.round(a.b + (b.b - a.b) * segT),
  ];
}

/** Inferno at `t`, as a CSS colour. */
export function tofInfernoSample(t: number): string {
  const c = Number.isNaN(t) ? 1 : Math.min(1, Math.max(0, t));
  const [r, g, b] = sampleStops(INFERNO, c);
  return `rgb(${r}, ${g}, ${b})`;
}

export const kTofEmptyColor = "#1a1a1a";

/** Near is bright and far is dark over the minMm..maxMm window. */
export function tofDistanceColor(mm: number, minMm: number, maxMm: number): string {
  if (mm <= 0) return kTofEmptyColor;
  if (maxMm <= minMm) return tofInfernoSample(0.5);
  const t = Math.min(1, Math.max(0, (maxMm - mm) / (maxMm - minMm)));
  return tofInfernoSample(t);
}

/** RGBA8888, normalised over the frame's own min..max. */
export function thermalFrameToRgba(f: ThermalFrame, cmap: ThermalColormap): ImageData | null {
  const n = f.width * f.height;
  if (n <= 0 || f.pixels.length < n) return null;

  let lo = 0xffff;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const v = f.pixels[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi > lo ? hi - lo : 1;

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (f.pixels[i] - lo) / span));
    const o = i * 4;
    if (cmap === "grayscale") {
      const g = Math.round(t * 255);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    } else {
      const [r, g, b] = sampleStops(cmap === "ironbow" ? IRONBOW : INFERNO, t);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
    out[o + 3] = 0xff;
  }
  return new ImageData(out, f.width, f.height);
}

/** Centre-pixel temperature in degC for a radiometric frame, else null. */
export function centreTempCelsius(f: ThermalFrame | null): number | null {
  if (!f || !f.radiometric) return null;
  const idx = Math.floor(f.height / 2) * f.width + Math.floor(f.width / 2);
  if (idx < 0 || idx >= f.pixels.length) return null;
  return f.pixels[idx] / 100 - 273.15;
}

/** Temperature, or raw AGC count, at a normalised probe position. */
export function probeLabel(f: ThermalFrame | null, u: number, v: number): string {
  if (!f) return "--";
  const x = Math.min(f.width - 1, Math.max(0, Math.floor(u * f.width)));
  const y = Math.min(f.height - 1, Math.max(0, Math.floor(v * f.height)));
  const raw = f.pixels[y * f.width + x];
  if (f.radiometric) return `${(raw / 100 - 273.15).toFixed(1)}°`;
  return `${raw}`;
}
