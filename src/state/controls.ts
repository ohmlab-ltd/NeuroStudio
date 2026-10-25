// Device-control panel state, kept outside the panels so it outlives their unmounts.

import { Observable } from "./observable";
import { camCaps, onClearCaches, tuneParams } from "./device";
import { appendTerminal } from "./terminal";
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
  kFlagAutoExposure,
  kFlagAutoGain,
  wbPresets,
  type TuneParam,
} from "../device/packets";

// Tuning

/** By parameter id, in wire units; seeded once from `current`, then owned by the panel. */
export const tuneValues = new Observable<Record<number, number>>({});

/** Seed descriptor per id; a different parameter reusing an id is seeded again. */
const tuneSeededFrom = new Map<number, TuneParam>();

function sameTuneParam(a: TuneParam, b: TuneParam): boolean {
  return a.name === b.name && a.type === b.type && a.lo === b.lo && a.hi === b.hi;
}

/** Seeds new parameters, keeps known values and drops ids missing from `params`. */
export function syncTuneValues(params: readonly TuneParam[]): void {
  const current = tuneValues.get();
  const next: Record<number, number> = {};
  let changed = false;

  for (const p of params) {
    const seed = tuneSeededFrom.get(p.id);
    if (seed && sameTuneParam(seed, p) && current[p.id] !== undefined) {
      next[p.id] = current[p.id];
    } else {
      next[p.id] = p.current;
      tuneSeededFrom.set(p.id, p);
      changed = true;
    }
  }
  const ids = new Set(params.map((p) => p.id));
  for (const id of [...tuneSeededFrom.keys()]) {
    if (!ids.has(id)) tuneSeededFrom.delete(id);
  }

  if (changed || Object.keys(next).length !== Object.keys(current).length) {
    tuneValues.set(next);
  }
}

export function setTuneValue(id: number, wire: number): void {
  const current = tuneValues.get();
  if (current[id] === wire) return;
  tuneValues.set({ ...current, [id]: wire });
}

function clearTuneValues(): void {
  tuneSeededFrom.clear();
  tuneValues.set({});
}

// Camera controls: 'CAM0'

export interface CameraControlState {
  autoExposure: boolean;
  autoAwb: boolean;
  exposureUs: number;
  /** The slider's exposure was sent since exposure was last locked. */
  exposureApplied: boolean;
}

/** Starts on auto, the board's power-on state. Survives a disconnect and is re-sent. */
export const cameraControls = new Observable<CameraControlState>({
  autoExposure: true,
  autoAwb: true,
  exposureUs: 10000,
  exposureApplied: false,
});

export function patchCameraControls(patch: Partial<CameraControlState>): CameraControlState {
  const next = { ...cameraControls.get(), ...patch };
  cameraControls.set(next);
  return next;
}

export function cameraFlags(state: CameraControlState): number {
  return (
    (state.autoExposure ? kFlagAutoExposure | kFlagAutoGain : 0) |
    (state.autoAwb ? kFlagAutoAwb : 0)
  );
}

/** A CAM0 packet that puts a board announcing `caps` into `state`; null when all is on auto. */
export function cameraRestorePacket(state: CameraControlState, caps: number): Uint8Array | null {
  let applyMask = 0;
  if (!state.autoExposure && caps & kCamCapExposure) {
    applyMask |= kApplyAutoExposure;
    if (caps & kCamCapGain) applyMask |= kApplyAutoGain;
    if (state.exposureApplied) applyMask |= kApplyExposureUs;
  }
  if (!state.autoAwb && caps & kCamCapAwb) applyMask |= kApplyAutoAwb;
  if (applyMask === 0) return null;
  return buildCameraControlPacket({
    flags: cameraFlags(state),
    applyMask,
    exposureUs: Math.round(state.exposureUs),
  });
}

let lastCamCaps = camCaps.get();

/** The board cannot report its CAM0 state, so its first caps announce gets the panel's state. */
function onCamCaps(caps: number): void {
  const previous = lastCamCaps;
  lastCamCaps = caps;
  if (previous !== 0 || caps === 0) return;
  const packet = cameraRestorePacket(cameraControls.get(), caps);
  if (!packet) return;
  window.neuro.write(packet);
  appendTerminal("[ui] Camera controls re-sent after reconnect\n");
}

// ISP: 'ISP0'

export interface IspFormState {
  preset: number;
  gainR: number;
  gainG: number;
  gainB: number;
  black: number;
  sharp: number;
  gamma: boolean;
  ccm: number[];
  status: string | null;
}

/** Defaults to the D65 preset, the device's baseline. */
export const ispForm = new Observable<IspFormState>({
  preset: 0,
  gainR: wbPresets[0].gainR,
  gainG: wbPresets[0].gainG,
  gainB: wbPresets[0].gainB,
  black: 16,
  sharp: 4,
  gamma: true,
  ccm: wbPresets[0].ccm,
  status: null,
});

export function patchIspForm(patch: Partial<IspFormState>): void {
  ispForm.set({ ...ispForm.get(), ...patch });
}

// Wiring

syncTuneValues(tuneParams.get());
tuneParams.subscribe(() => syncTuneValues(tuneParams.get()));
camCaps.subscribe(() => onCamCaps(camCaps.get()));

onClearCaches(() => {
  clearTuneValues();
  if (ispForm.get().status !== null) patchIspForm({ status: null });
});
