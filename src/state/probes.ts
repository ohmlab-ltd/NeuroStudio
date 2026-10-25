import { Observable } from "./observable";

/** A temperature probe on the thermal image, in normalised coordinates. */
export interface ThermalProbe {
  id: number;
  /** 0..1 across the thermal frame, left -> right. */
  u: number;
  /** 0..1 down the thermal frame, top -> bottom. */
  v: number;
}

/** Shared by the main stage and the Secondary View. */
export const thermalProbes = new Observable<ThermalProbe[]>([]);

let nextProbeId = 1;

export function addThermalProbe(u: number, v: number): void {
  thermalProbes.set([...thermalProbes.get(), { id: nextProbeId++, u, v }]);
}

export function removeThermalProbe(id: number): void {
  thermalProbes.set(thermalProbes.get().filter((p) => p.id !== id));
}

export function clearThermalProbes(): void {
  if (thermalProbes.get().length) thermalProbes.set([]);
}
