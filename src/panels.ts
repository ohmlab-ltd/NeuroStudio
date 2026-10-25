import type { IconName } from "./components/Icon";

/** Panels a sidebar slot can show. panelOrder decides what a new slot defaults to. */
export type PanelKind =
  | "stream"
  | "overlay"
  | "tof"
  | "terminal"
  | "isp"
  | "mag"
  | "imu"
  | "vision"
  | "audio"
  | "imageClass"
  | "camera"
  | "tuning"
  | "events";

export const panelOrder: PanelKind[] = [
  "stream",
  "overlay",
  "tof",
  "terminal",
  "isp",
  "mag",
  "imu",
  "vision",
  "audio",
  "imageClass",
  "camera",
  "tuning",
  "events",
];

export const panelLabels: Record<PanelKind, string> = {
  stream: "Secondary View",
  overlay: "Overlay Options",
  tof: "ToF Sensor",
  terminal: "Terminal",
  isp: "ISP Options",
  mag: "Magnetometer",
  imu: "IMU",
  vision: "Vision",
  audio: "Audio",
  imageClass: "Image Classifier",
  camera: "Camera Controls",
  tuning: "Tuning",
  events: "Events",
};

export const panelIcons: Record<PanelKind, IconName> = {
  stream: "video",
  overlay: "layers",
  tof: "grid",
  terminal: "terminal",
  isp: "sparkle",
  mag: "compass",
  imu: "wave",
  vision: "scan",
  audio: "mic",
  imageClass: "tag",
  camera: "device",
  tuning: "sliders",
  events: "bell",
};

/** The id never changes and keys everything under the slot. */
export interface SidebarSlot {
  id: number;
  panel: PanelKind;
  collapsed: boolean;
}

let slotIdCounter = 1;

export function createSlot(panel: PanelKind): SidebarSlot {
  return { id: slotIdCounter++, panel, collapsed: false };
}

export const MAX_SLOTS = 6;
