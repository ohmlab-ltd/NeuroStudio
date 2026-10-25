// Overlay and ToF display options, and view state shared by the main stage and Secondary View.

import { Observable } from "./observable";
import type { ThermalColormap } from "../device/thermal";

export interface OverlayOptions {
  showInferenceText: boolean;
  showBoxes: boolean;
  showKeypoints: boolean;
  showBindings: boolean;
  /** Labels are independent of box visibility. */
  showBoxLabels: boolean;
  /** Instance mask shading. */
  showShading: boolean;

  thermalColormap: ThermalColormap;

  /** Thermal frame over the camera image, beneath the inference overlays; 0 = off. */
  thermalOverlayOpacity: number;
  thermalOverlayScale: number;
  thermalOverlayOffsetX: number;
  thermalOverlayOffsetY: number;
  /** Auto-alignment drives the scale and offsets. */
  thermalOverlayAuto: boolean;

  /** Mask edge smoothing radius, in stream pixels. */
  maskFeather: number;
}

export const overlayOptions = new Observable<OverlayOptions>({
  showInferenceText: true,
  showBoxes: true,
  showKeypoints: true,
  showBindings: true,
  showBoxLabels: true,
  showShading: true,
  thermalColormap: "grayscale",
  thermalOverlayOpacity: 0,
  thermalOverlayScale: 0.9,
  thermalOverlayOffsetX: 0,
  thermalOverlayOffsetY: 0,
  thermalOverlayAuto: true,
  maskFeather: 2,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function patchOverlayOptions(patch: Partial<OverlayOptions>): void {
  overlayOptions.set({ ...overlayOptions.get(), ...patch });
}

export function toggleOverlayOption(
  key:
    | "showInferenceText"
    | "showBoxes"
    | "showKeypoints"
    | "showBindings"
    | "showBoxLabels"
    | "showShading",
): void {
  const current = overlayOptions.get();
  patchOverlayOptions({ [key]: !current[key] } as Partial<OverlayOptions>);
}

export function setAllOverlays(enabled: boolean): void {
  patchOverlayOptions({
    showInferenceText: enabled,
    showBoxes: enabled,
    showKeypoints: enabled,
    showBindings: enabled,
    showBoxLabels: enabled,
    showShading: enabled,
  });
}

/** The "All overlays" chip: a command, not a readout of the six layers. */
export const overlaysMasterOff = new Observable<boolean>(false);

export function toggleAllOverlays(): void {
  const off = !overlaysMasterOff.get();
  overlaysMasterOff.set(off);
  setAllOverlays(!off);
}

export function setThermalColormap(cmap: ThermalColormap): void {
  if (overlayOptions.get().thermalColormap === cmap) return;
  patchOverlayOptions({ thermalColormap: cmap });
}

export function setThermalOverlayOpacity(v: number): void {
  patchOverlayOptions({ thermalOverlayOpacity: clamp(v, 0, 1) });
}

export function setThermalOverlayScale(v: number): void {
  patchOverlayOptions({ thermalOverlayScale: clamp(v, 0.1, 2) });
}

export function setThermalOverlayOffsetX(v: number): void {
  patchOverlayOptions({ thermalOverlayOffsetX: clamp(v, -0.5, 0.5) });
}

export function setThermalOverlayOffsetY(v: number): void {
  patchOverlayOptions({ thermalOverlayOffsetY: clamp(v, -0.5, 0.5) });
}

export function setThermalOverlayAuto(on: boolean): void {
  patchOverlayOptions({ thermalOverlayAuto: on });
}

/** All three alignment values in one update. */
export function setThermalAlignment(scale: number, ox: number, oy: number): void {
  patchOverlayOptions({
    thermalOverlayScale: clamp(scale, 0.1, 2),
    thermalOverlayOffsetX: clamp(ox, -0.5, 0.5),
    thermalOverlayOffsetY: clamp(oy, -0.5, 0.5),
  });
}

export function setMaskFeather(v: number): void {
  patchOverlayOptions({ maskFeather: clamp(v, 0, 8) });
}

export interface TofDisplayOptions {
  minMm: number;
  maxMm: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export const tofDisplayOptions = new Observable<TofDisplayOptions>({
  minMm: 0,
  maxMm: 2000,
  scaleX: 1,
  scaleY: 1,
  offsetX: 0,
  offsetY: 0,
});

export function patchTofDisplayOptions(patch: Partial<TofDisplayOptions>): void {
  tofDisplayOptions.set({ ...tofDisplayOptions.get(), ...patch });
}

/** When true the main stage shows plain thermal and the Secondary View shows the camera. */
export const swapMainThermal = new Observable<boolean>(false);

/** Main viewport fit: true = cover, false = contain. */
export const fillViewport = new Observable<boolean>(true);
