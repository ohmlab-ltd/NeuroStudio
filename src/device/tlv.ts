// TLV metadata decoder for the Neuro N6 vendor stream.
// Record: [type:u8][len:u16le][value]. Unknown types are skipped.

export const kMetaInferenceMs = 1;
export const kMetaBoxes = 2;
export const kMetaKeypoints = 3;
export const kMetaBindings = 4;

export const kMetaIsegClassStr = 10;
export const kMetaIsegMask = 11;

export const kMetaWarning = 18;

/** 4x4 ToF distance: 16 x uint32 mm, LE, row-major, 64 bytes, no header. */
export const kMetaTofFrameLegacy = 0x14;
/** VL53L1 ToF distance grid: header u8 rows, cols, roiSize, roiStep, then rows*cols u32 LE. */
export const kMetaTofFrame = 0x15;
/** VL53L1 per-zone RangeStatus: same header, then rows*cols u8, 0 = VALID. */
export const kMetaTofStatus = 0x16;
/** UTF-8 Terminal text, the latest line only. */
export const kMetaDebugText = 0x17;

/** Person-follower lock, 10 bytes LE: u16 xc, yc normalised, i16 v_mms, omega_mrads, u16 d_mm. */
export const kMetaFollowTarget = 0x18;
export const kMetaDebugTof = 0x19;

/** MMC5603NJ magnetometer: 4 x float32 LE: x, y, z field, degC. */
export const kMetaMagFrame = 0x1a;
/** LSM6DSL IMU: 7 x float32 LE: accel x/y/z g, gyro x/y/z dps, degC. */
export const kMetaImuFrame = 0x1b;

/**
 * FLIR Lepton frame: u16 width, u16 height, u8 format (0 = RAW16), u8 flags
 * (bit0 = radiometric, centikelvin), u16 reserved, then width*height u16 LE, row-major.
 */
export const kMetaThermalFrame = 0x30;

/**
 * Audio classifier result: u8 count, u8 top (0xFF = none above threshold),
 * u16 level (peak |sample|, 0..32767), u16 threshold_x1000, count x u16 score_x1000.
 */
export const kMetaAudioClass = 0x51;
/**
 * Network input log-mel spectrogram: u8 nMel, u8 nFrames, u8 layout
 * (0 = frame-major, 1 = mel-major), u8 reserved, then nMel*nFrames bytes.
 */
export const kMetaAudioMel = 0x52;
/** kMetaAudioClass names, ~1 Hz: u8 count, then per class u8 len + chars. */
export const kMetaAudioLabels = 0x53;

/**
 * Image classifier result: u8 count (0..8, best first), u8 reserved, u16 numClasses,
 * u16 threshold_x1000, then per entry u16 classIndex, u16 score_x1000 (0..1000),
 * u8 nameLen (0..48), UTF-8 name.
 */
export const kMetaImageClass = 0x54;
const kImageClassMaxEntries = 8;
const kImageClassMaxName = 48;

/** Classical-CV results. Their video overlay arrives as kMetaBoxes and kMetaIsegClassStr. */
export const kMetaVisionId = 0x60;
export const kMetaQrFrame = 0x61;
export const kMetaBarcodeFrame = 0x62;
export const kMetaBlobFrame = 0x63;

/**
 * AprilTag detections. u8 count, then per tag:
 *   u16 cx, cy, w, h   normalised box
 *   u16 id, u8 family (0 = tag36h11), u8 hamming (bits corrected)
 *   u16 margin         normalised 0..65535
 *   i16 angle          centi-degrees, CCW positive
 *   u8  poseValid      0 without a stored calibration
 *   i16 tx, ty, tz     millimetres
 *   i16 rx, ry, rz     Euler XYZ, centi-degrees
 *   u8 w, u8 h, w*h RGB565 crop
 */
export const kMetaAprilTag = 0x66;

/**
 * N6Events board event, 17 bytes LE: u32 id (0 = none), u32 tMs, u8 sources, u8 state,
 * u16 score, u16 preFrames, u16 postFrames, u8 sinksOk. Re-announced at 1 Hz for a few
 * seconds, so one id arrives several times.
 */
export const kMetaEvent = 0x67;

/**
 * Evidence crops, sent under a 'SUB0' subscription after the result TLV: u8 count,
 * then per crop u8 resultIndex, u8 w, u8 h, w*h u16 LE RGB565.
 */
export const kMetaEvidenceCrop = 0x70;

/**
 * Terminal lines from the last ~2 s, numbered from 1 each boot: u32 number of the first
 * line (with count 0, of the next), u8 count, then per line u8 length + text.
 */
export const kMetaDebugLog = 0x71;

export const kVisionKindQr = 0x01;
export const kVisionKindBarcode = 0x02;
export const kVisionKindBlob = 0x04;
export const kVisionKindAprilTag = 0x08;

const BARCODE_SYM_NAMES = ["?", "EAN-13", "UPC-A", "EAN-8"];
const QR_ECC_NAMES = ["M", "L", "H", "Q"];

const u16nTo01 = (v: number) => Math.min(65535, Math.max(0, v)) / 65535;

export interface OverlayBox {
  xc: number;
  yc: number;
  w: number;
  h: number;
  score255: number;
  cls: number;
  label?: string;
}

export interface OverlayKeypoint {
  id: number;
  colorId: number;
  x: number;
  y: number;
  conf255: number;
}

export interface OverlayBinding {
  a: number;
  b: number;
  colorId: number;
}

/** Decoded instance mask, 1bpp packed LSB-first per byte. */
export interface OverlayMask {
  objId: number;
  w: number;
  h: number;
  packed: Uint8Array;
}

export function maskBitAt(m: OverlayMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
  const i = y * m.w + x;
  return ((m.packed[i >> 3] >> (i & 7)) & 1) !== 0;
}

export interface FollowTarget {
  x: number;
  y: number;
  vMms: number;
  omegaMrads: number;
  distanceMm: number;
}

export interface TofFrame {
  rows: number;
  cols: number;
  roiSize: number;
  roiStep: number;
  distancesMm: number[];
  statuses: number[];
  /** From a 0x14 frame: the geometry is 4/4/4/4 and not configurable. */
  legacy: boolean;
}

export interface ThermalFrame {
  width: number;
  height: number;
  /** Pixels are centikelvin when true, raw AGC counts otherwise. */
  radiometric: boolean;
  pixels: Uint16Array;
}

export interface SensorReading {
  values: number[];
}

/** AprilTag pose in the camera frame, in metres and degrees. */
export interface TagPose {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface VisionResult {
  cx: number;
  cy: number;
  w: number;
  h: number;
  text: string;
  detail: string;
  cropW: number;
  cropH: number;
  crop: Uint16Array | null;
  /** AprilTag only; null without a stored calibration. */
  pose: TagPose | null;
}

export interface VisionFrame {
  kind: number;
  results: VisionResult[];
}

export interface EvidenceCrop {
  index: number;
  cropW: number;
  cropH: number;
  crop: Uint16Array;
}

export interface BoardEvent {
  id: number;
  /** Device clock, ms since boot. */
  tMs: number;
  /** Bit per BOARD_EVENT_SOURCES entry. */
  sources: number;
  /** Index into BOARD_EVENT_STATES. */
  state: number;
  /** Sketch-defined. */
  score: number;
  preFrames: number;
  postFrames: number;
  /** Bit i = sink i completed the clip. */
  sinksOk: number;
  /** Host Date.now() when this id was first seen. */
  receivedAt: number;
}

export const BOARD_EVENT_SOURCES = [
  "motion",
  "NN",
  "audio",
  "thermal",
  "ToF",
  "GPIO",
  "timer",
  "host",
] as const;

export const BOARD_EVENT_STATES = ["idle", "post-roll", "writing", "refractory"] as const;

export function boardEventSourcesLabel(ev: BoardEvent): string {
  const parts = BOARD_EVENT_SOURCES.filter((_, bit) => ((ev.sources >> bit) & 1) === 1);
  return parts.length ? parts.join(" + ") : "none";
}

export function boardEventStateLabel(ev: BoardEvent): string {
  return BOARD_EVENT_STATES[ev.state] ?? `state ${ev.state}`;
}

export const kBoardEventsKept = 20;

/** Merges an event into a newest-first list; a known id keeps its first receivedAt. */
export function mergeBoardEvent(list: readonly BoardEvent[], ev: BoardEvent): BoardEvent[] {
  const idx = list.findIndex((e) => e.id === ev.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...ev, receivedAt: list[idx].receivedAt };
    return next;
  }
  return [ev, ...list].slice(0, kBoardEventsKept);
}

/** `top` is -1 when no class cleared the threshold. */
export interface AudioClassFrame {
  /** Per-class score, 0..1. */
  scores: number[];
  top: number;
  /** Peak |sample|, 0..32767. */
  level: number;
  /** Device threshold, 0..1. */
  threshold: number;
}

/** Network input spectrogram, raw uint8 in the model's quantisation. */
export interface AudioMelFrame {
  nMel: number;
  nFrames: number;
  /** 0 = frame-major, 1 = mel-major. */
  layout: number;
  data: Uint8Array;
}

export function audioMelAt(m: AudioMelFrame, mel: number, frame: number): number {
  return m.layout === 0 ? m.data[frame * m.nMel + mel] : m.data[mel * m.nFrames + frame];
}

export interface ImageClassEntry {
  /** Index in the model's label set. */
  index: number;
  /** 0..1. */
  score: number;
  /** Empty when the device sent none. */
  name: string;
}

/** Entries above the device threshold, best first, possibly none. */
export interface ImageClassFrame {
  entries: ImageClassEntry[];
  numClasses: number;
  /** Device threshold, 0..1. */
  threshold: number;
}

/** kMetaDebugLog lines, each ending in a newline. */
export interface DebugLog {
  /** First line's number; with no lines, the next line's. */
  first: number;
  lines: string[];
  /** Fixed for one boot of the board; absent from older firmware. */
  boot?: number;
}

export interface OverlayData {
  inferenceMs: number;
  boxes: OverlayBox[];
  keypoints: OverlayKeypoint[];
  bindings: OverlayBinding[];
  classLabelsByObjId: Map<number, string>;
  masksByObjId: Map<number, OverlayMask>;
  warning: string;
  followTarget: FollowTarget | null;
  /** True when the blob holds a debugTOF TLV. The overlay needs both flags. */
  debugTofPresent: boolean;
  debugTofEnabled: boolean;
}

export const emptyOverlayData: OverlayData = {
  inferenceMs: 0,
  boxes: [],
  keypoints: [],
  bindings: [],
  classLabelsByObjId: new Map(),
  masksByObjId: new Map(),
  warning: "",
  followTarget: null,
  debugTofPresent: false,
  debugTofEnabled: false,
};

export interface MetaPresence {
  hasInferenceMs: boolean;
  hasBoxes: boolean;
  hasKeypoints: boolean;
  hasBindings: boolean;
  hasBoxLabels: boolean;
  hasShading: boolean;
  hasDebugTof: boolean;
  hasThermal: boolean;
}

export const emptyPresence: MetaPresence = {
  hasInferenceMs: false,
  hasBoxes: false,
  hasKeypoints: false,
  hasBindings: false,
  hasBoxLabels: false,
  hasShading: false,
  hasDebugTof: false,
  hasThermal: false,
};

/** A sensor field is undefined when the blob had no such TLV; the caller keeps its last value. */
export interface ParsedMeta {
  overlay: OverlayData;
  presence: MetaPresence;
  tof?: TofFrame;
  thermal?: ThermalFrame;
  mag?: SensorReading;
  imu?: SensorReading;
  vision?: VisionFrame;
  visionKind?: number;
  /** Crops with no result TLV ahead of them, for the frame on screen. Never set with `vision`. */
  evidence?: EvidenceCrop[];
  /** Whole Terminal lines from 0x17, or from 0x16 when it holds text. */
  debugText?: string;
  /** When set, `debugText` is a duplicate. */
  debugLog?: DebugLog;
  audioClass?: AudioClassFrame;
  audioMel?: AudioMelFrame;
  audioLabels?: string[];
  imageClass?: ImageClassFrame;
  /** Wire order, id 0 dropped. */
  boardEvents?: BoardEvent[];
}

// Sub-decoders

const u16le = (b: Uint8Array, off: number) => b[off] | (b[off + 1] << 8);
const i16le = (b: Uint8Array, off: number) => (u16le(b, off) << 16) >> 16;
const u32le = (b: Uint8Array, off: number) =>
  (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;

const utf8 = new TextDecoder("utf-8");

// C0 and C1 control characters and DEL, except tab, LF and CR.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** UTF-8, invalid bytes as U+FFFD, control characters other than tab, LF and CR removed. */
export function decodeTlvText(b: Uint8Array): string {
  return utf8.decode(b).replace(CONTROL_CHARS, "");
}

/** As decodeTlvText, ending at the first NUL. */
export function decodeTlvString(b: Uint8Array): string {
  const nul = b.indexOf(0);
  return decodeTlvText(nul < 0 ? b : b.subarray(0, nul));
}

/** As decodeTlvText, without CR and ending in a newline; empty when nothing is left. */
function decodeTerminalText(b: Uint8Array): string {
  const text = decodeTlvText(b).replace(/\r/g, "");
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** A count running past the end keeps the lines that fit. */
function decodeDebugLog(meta: Uint8Array, start: number, end: number): DebugLog | null {
  if (end - start < 5) return null;
  const count = meta[start + 4];
  const lines: string[] = [];
  let p = start + 5;
  let k = 0;
  for (; k < count && p < end; k++) {
    const n = meta[p];
    if (p + 1 + n > end) break;
    lines.push(decodeTerminalText(meta.subarray(p + 1, p + 1 + n)) || "\n");
    p += 1 + n;
  }
  const log: DebugLog = { first: u32le(meta, start), lines };
  // The boot mark is the byte after a complete set of lines; older firmware ends at the lines.
  if (k === count && p < end) log.boot = meta[p];
  return log;
}

/** Null for a truncated or out-of-range record, so the previous result stays. */
function decodeImageClass(meta: Uint8Array, start: number, end: number): ImageClassFrame | null {
  if (end - start < 6) return null;
  const count = meta[start];
  if (count > kImageClassMaxEntries) return null;
  const entries: ImageClassEntry[] = [];
  let p = start + 6;
  for (let k = 0; k < count; k++) {
    if (p + 5 > end) return null;
    const score = u16le(meta, p + 2);
    const n = meta[p + 4];
    if (score > 1000 || n > kImageClassMaxName || p + 5 + n > end) return null;
    entries.push({
      index: u16le(meta, p),
      score: score / 1000,
      name: decodeTlvString(meta.subarray(p + 5, p + 5 + n)),
    });
    p += 5 + n;
  }
  return {
    entries,
    numClasses: u16le(meta, start + 2),
    threshold: u16le(meta, start + 4) / 1000,
  };
}

/** A 0x14 record anywhere in the blob changes how 0x15 and 0x16 are read. */
function hasLegacyTofFrame(meta: Uint8Array): boolean {
  let i = 0;
  while (i + 3 <= meta.length) {
    const type = meta[i];
    const len = u16le(meta, i + 1);
    i += 3;
    if (i + len > meta.length) break;
    if (type === kMetaTofFrameLegacy && len === 64) return true;
    i += len;
  }
  return false;
}

/** n u16 LE RGB565 pixels from p, or null when they run past end. */
function readRgb565(meta: Uint8Array, p: number, n: number, end: number): Uint16Array | null {
  if (p + n * 2 > end) return null;
  const out = new Uint16Array(n);
  for (let q = 0; q < n; q++, p += 2) out[q] = u16le(meta, p);
  return out;
}

/** Result crop: u8 w, u8 h, then w*h RGB565; a zero dimension means none. Null when truncated. */
function readResultCrop(
  meta: Uint8Array,
  p: number,
  end: number,
): { cropW: number; cropH: number; crop: Uint16Array | null; next: number } | null {
  if (p + 2 > end) return null;
  const cropW = meta[p];
  const cropH = meta[p + 1];
  p += 2;
  if (cropW === 0 || cropH === 0) return { cropW, cropH, crop: null, next: p };
  const crop = readRgb565(meta, p, cropW * cropH, end);
  if (!crop) return null;
  return { cropW, cropH, crop, next: p + cropW * cropH * 2 };
}

/** QR, barcode or blob TLV; null when malformed or truncated, so the previous result stays. */
function decodeVisionFrame(
  meta: Uint8Array,
  start: number,
  len: number,
  tag: number,
): VisionFrame | null {
  const end = start + len;
  let p = start;

  if (p >= end) return null;
  const count = meta[p++];

  const results: VisionResult[] = [];
  for (let r = 0; r < count; r++) {
    if (p + 8 > end) return null;
    const cx = (meta[p] | (meta[p + 1] << 8)) / 65535;
    const cy = (meta[p + 2] | (meta[p + 3] << 8)) / 65535;
    const bw = (meta[p + 4] | (meta[p + 5] << 8)) / 65535;
    const bh = (meta[p + 6] | (meta[p + 7] << 8)) / 65535;
    p += 8;

    let text = "";
    let detail: string;

    if (tag === kMetaQrFrame) {
      if (p + 4 > end) return null;
      const version = meta[p];
      const ecc = meta[p + 1] & 0x03;
      const textLen = meta[p + 2] | (meta[p + 3] << 8);
      p += 4;
      if (p + textLen > end) return null;
      text = decodeTlvString(meta.subarray(p, p + textLen));
      p += textLen;
      detail = `v${version} ecc=${QR_ECC_NAMES[ecc]}`;
    } else if (tag === kMetaBarcodeFrame) {
      if (p + 3 > end) return null;
      const sym = meta[p];
      const textLen = meta[p + 1] | (meta[p + 2] << 8);
      p += 3;
      if (p + textLen > end) return null;
      text = decodeTlvString(meta.subarray(p, p + textLen));
      p += textLen;
      detail = sym < BARCODE_SYM_NAMES.length ? BARCODE_SYM_NAMES[sym] : "?";
    } else if (tag === kMetaBlobFrame) {
      if (p + 6 > end) return null;
      const area = meta[p] | (meta[p + 1] << 8);
      const hue = meta[p + 2] | (meta[p + 3] << 8);
      const px = meta[p + 4] | (meta[p + 5] << 8);
      p += 6;
      const areaPct = (area / 65535) * 100;
      detail = `hue ${hue} deg / ${areaPct.toFixed(1)}% / ${px} px`;
    } else {
      return null;
    }

    const c = readResultCrop(meta, p, end);
    if (!c) return null;
    p = c.next;

    results.push({
      cx,
      cy,
      w: bw,
      h: bh,
      text,
      detail,
      cropW: c.cropW,
      cropH: c.cropH,
      crop: c.crop,
      pose: null,
    });
  }

  const kind =
    tag === kMetaQrFrame
      ? kVisionKindQr
      : tag === kMetaBarcodeFrame
        ? kVisionKindBarcode
        : kVisionKindBlob;
  return { kind, results };
}

/** Null on any truncation. */
function decodeAprilTagFrame(meta: Uint8Array, start: number, len: number): VisionFrame | null {
  const end = start + len;
  let p = start;

  if (p >= end) return null;
  const count = meta[p++];

  const results: VisionResult[] = [];
  for (let r = 0; r < count; r++) {
    if (p + 29 > end) return null;
    const cx = u16le(meta, p) / 65535;
    const cy = u16le(meta, p + 2) / 65535;
    const bw = u16le(meta, p + 4) / 65535;
    const bh = u16le(meta, p + 6) / 65535;
    const id = u16le(meta, p + 8);
    const family = meta[p + 10];
    const hamming = meta[p + 11];
    const margin = u16le(meta, p + 12) / 65535;
    const angle = i16le(meta, p + 14) / 100;
    const poseValid = meta[p + 16] !== 0;
    const pose: TagPose | null = poseValid
      ? {
          tx: i16le(meta, p + 17) / 1000,
          ty: i16le(meta, p + 19) / 1000,
          tz: i16le(meta, p + 21) / 1000,
          rx: i16le(meta, p + 23) / 100,
          ry: i16le(meta, p + 25) / 100,
          rz: i16le(meta, p + 27) / 100,
        }
      : null;
    p += 29;

    const c = readResultCrop(meta, p, end);
    if (!c) return null;
    p = c.next;

    const fam = family === 0 ? "tag36h11" : `family ${family}`;
    let detail = `${fam}  hamming ${hamming}  margin ${margin.toFixed(2)}  ${angle.toFixed(1)} deg`;
    if (!poseValid) detail += "  ·  no calibration";

    results.push({
      cx,
      cy,
      w: bw,
      h: bh,
      text: `id ${id}`,
      detail,
      cropW: c.cropW,
      cropH: c.cropH,
      crop: c.crop,
      pose,
    });
  }

  return { kind: kVisionKindAprilTag, results };
}

/** Null on any truncation or zero-sized crop. mergeEvidenceCrops checks the indices. */
function decodeEvidenceCrops(meta: Uint8Array, start: number, len: number): EvidenceCrop[] | null {
  const end = start + len;
  let p = start;

  if (p >= end) return null;
  const count = meta[p++];

  const out: EvidenceCrop[] = [];
  for (let k = 0; k < count; k++) {
    if (p + 3 > end) return null;
    const index = meta[p];
    const cropW = meta[p + 1];
    const cropH = meta[p + 2];
    p += 3;
    const n = cropW * cropH;
    if (n === 0) return null;
    const crop = readRgb565(meta, p, n, end);
    if (!crop) return null;
    p += n * 2;
    out.push({ index, cropW, cropH, crop });
  }
  return out;
}

/** Returns `frame` itself when nothing applied, so a store holding it does not notify. */
export function mergeEvidenceCrops(
  frame: VisionFrame,
  crops: readonly EvidenceCrop[],
): VisionFrame {
  let results: VisionResult[] | null = null;
  for (const c of crops) {
    if (c.index >= frame.results.length) continue;
    results ??= frame.results.slice();
    results[c.index] = { ...results[c.index], cropW: c.cropW, cropH: c.cropH, crop: c.crop };
  }
  return results ? { kind: frame.kind, results } : frame;
}

/** Null under 17 bytes; bytes past 17 are reserved. */
function decodeBoardEvent(meta: Uint8Array, start: number, len: number): BoardEvent | null {
  if (len < 17) return null;
  return {
    id: u32le(meta, start),
    tMs: u32le(meta, start + 4),
    sources: meta[start + 8],
    state: meta[start + 9],
    score: u16le(meta, start + 10),
    preFrames: u16le(meta, start + 12),
    postFrames: u16le(meta, start + 14),
    sinksOk: meta[start + 16],
    receivedAt: Date.now(),
  };
}

/** RGB565 -> RGBA8888. High bits repeat into the low ones so 0x1F maps to 0xFF, not 0xF8. */
export function visionCropToRgba(r: VisionResult): Uint8ClampedArray<ArrayBuffer> | null {
  const src = r.crop;
  if (!src || r.cropW <= 0 || r.cropH <= 0) return null;
  const n = r.cropW * r.cropH;
  if (src.length < n) return null;

  const out = new Uint8ClampedArray(n * 4);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const p = src[i];
    const r5 = (p >> 11) & 0x1f;
    const g6 = (p >> 5) & 0x3f;
    const b5 = p & 0x1f;
    out[o++] = (r5 << 3) | (r5 >> 2);
    out[o++] = (g6 << 2) | (g6 >> 4);
    out[o++] = (b5 << 3) | (b5 >> 2);
    out[o++] = 0xff;
  }
  return out;
}

// The decoder

/** Never throws; returns empty data on bad input. */
export function parseOverlayMeta(meta: Uint8Array): ParsedMeta {
  if (meta.length === 0) {
    return { overlay: emptyOverlayData, presence: emptyPresence };
  }

  const view = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);

  let i = 0;
  let inferenceMs = 0;
  const boxes: OverlayBox[] = [];
  const keypoints: OverlayKeypoint[] = [];
  const bindings: OverlayBinding[] = [];
  let followTarget: FollowTarget | null = null;

  const labelsByObj = new Map<number, string>();
  const masksByObj = new Map<number, OverlayMask>();

  let sawInference = false;
  let sawBoxes = false;
  let sawKeypoints = false;
  let sawBindings = false;
  let sawBoxLabels = false;
  let sawShading = false;
  let sawDebugTof = false;
  let debugTofEnabled = false;
  let sawThermal = false;

  let thermalThisFrame: ThermalFrame | undefined;
  let magThisFrame: SensorReading | undefined;
  let imuThisFrame: SensorReading | undefined;
  let visionThisFrame: VisionFrame | undefined;
  let visionKindThisFrame: number | undefined;
  let evidenceThisFrame: EvidenceCrop[] | undefined;
  const debugTextChunks: Uint8Array[] = [];
  let debugLogThisFrame: DebugLog | undefined;
  let audioClassThisFrame: AudioClassFrame | undefined;
  let audioMelThisFrame: AudioMelFrame | undefined;
  let audioLabelsThisFrame: string[] | undefined;
  let imageClassThisFrame: ImageClassFrame | undefined;
  const boardEventsThisFrame: BoardEvent[] = [];

  let warning = "";

  // ToF ids are 0x15/0x16/0x17 for distance/status/debug text, or 0x14/0x15/0x16 when a 0x14
  // record is in the blob.
  let tofRows = 0;
  let tofCols = 0;
  let tofRoiSize = 0;
  let tofRoiStep = 0;
  let tofDistancesMm: number[] | null = null;
  let tofStatuses: number[] | null = null;
  let tofStatusRows = 0;
  let tofStatusCols = 0;
  const tofLegacy = hasLegacyTofFrame(meta);

  const readU16le = (off: number) => u16le(meta, off);
  const readF32le = (off: number) => view.getFloat32(off, true);

  while (i + 3 <= meta.length) {
    const type = meta[i];
    const len = readU16le(i + 1);
    i += 3;

    if (i + len > meta.length) break;

    const start = i;
    const end = i + len;

    try {
      if (type === kMetaInferenceMs) {
        sawInference = true;
        if (len >= 2) inferenceMs = readU16le(start);
      } else if (type === kMetaBoxes) {
        sawBoxes = true;
        if (len >= 1) {
          const n = meta[start];
          let off = start + 1;
          for (let b = 0; b < n; b++) {
            if (off + 10 > end) break;
            const box: OverlayBox = {
              xc: u16nTo01(readU16le(off)),
              yc: u16nTo01(readU16le(off + 2)),
              w: u16nTo01(readU16le(off + 4)),
              h: u16nTo01(readU16le(off + 6)),
              score255: meta[off + 8],
              cls: meta[off + 9],
            };
            boxes.push(box);
            off += 10;
          }
        }
      } else if (type === kMetaKeypoints) {
        sawKeypoints = true;
        if (len >= 1) {
          const n = meta[start];
          let off = start + 1;
          for (let k = 0; k < n; k++) {
            if (off + 7 > end) break;
            keypoints.push({
              id: meta[off],
              colorId: meta[off + 1],
              x: u16nTo01(readU16le(off + 2)),
              y: u16nTo01(readU16le(off + 4)),
              conf255: meta[off + 6],
            });
            off += 7;
          }
        }
      } else if (type === kMetaBindings) {
        sawBindings = true;
        if (len >= 1) {
          const n = meta[start];
          let off = start + 1;
          for (let b = 0; b < n; b++) {
            if (off + 3 > end) break;
            bindings.push({ a: meta[off], b: meta[off + 1], colorId: meta[off + 2] });
            off += 3;
          }
        }
      } else if (type === kMetaMagFrame) {
        if (len >= 16) {
          magThisFrame = {
            values: [
              readF32le(start),
              readF32le(start + 4),
              readF32le(start + 8),
              readF32le(start + 12),
            ],
          };
        }
      } else if (type === kMetaImuFrame) {
        if (len >= 28) {
          imuThisFrame = {
            values: [
              readF32le(start),
              readF32le(start + 4),
              readF32le(start + 8),
              readF32le(start + 12),
              readF32le(start + 16),
              readF32le(start + 20),
              readF32le(start + 24),
            ],
          };
        }
      } else if (type === kMetaIsegClassStr) {
        // u8 obj_id, then the name.
        if (len >= 2) {
          const objId = meta[start];
          const name = decodeTlvString(meta.subarray(start + 1, end)).trim();
          if (name.length) {
            labelsByObj.set(objId, name);
            sawBoxLabels = true;
          }
        }
      } else if (type === kMetaIsegMask) {
        // u8 obj_id, u8 w, u8 h, u16 bytes, then packed 1bpp.
        if (len >= 5) {
          const objId = meta[start];
          const mw = meta[start + 1];
          const mh = meta[start + 2];
          const bytes = readU16le(start + 3);
          const dataStart = start + 5;
          const dataEnd = dataStart + bytes;
          if (mw > 0 && mh > 0 && bytes > 0 && dataEnd <= end) {
            masksByObj.set(objId, {
              objId,
              w: mw,
              h: mh,
              packed: new Uint8Array(meta.subarray(dataStart, dataEnd)),
            });
            sawShading = true;
          }
        }
      } else if (type === kMetaFollowTarget) {
        if (len === 10) {
          const vRaw = readU16le(start + 4);
          const wRaw = readU16le(start + 6);
          followTarget = {
            x: u16nTo01(readU16le(start)),
            y: u16nTo01(readU16le(start + 2)),
            vMms: vRaw < 0x8000 ? vRaw : vRaw - 0x10000,
            omegaMrads: wRaw < 0x8000 ? wRaw : wRaw - 0x10000,
            distanceMm: readU16le(start + 8),
          };
        }
      } else if (type === kMetaDebugTof) {
        if (len === 1) {
          sawDebugTof = true;
          debugTofEnabled = meta[start] !== 0;
        }
      } else if (type === kMetaWarning) {
        const text = decodeTlvString(meta.subarray(start, end)).trim();
        if (text) warning = text;
      } else if (type === kMetaTofFrameLegacy) {
        if (len === 64) {
          const dists = new Array<number>(16);
          for (let z = 0; z < 16; z++) {
            dists[z] = view.getUint32(start + z * 4, true);
          }
          tofRows = 4;
          tofCols = 4;
          tofRoiSize = 4;
          tofRoiStep = 4;
          tofDistancesMm = dists;
        }
      } else if (type === kMetaTofFrame && !tofLegacy) {
        if (len >= 4) {
          const r = meta[start];
          const c = meta[start + 1];
          const rs = meta[start + 2];
          const rt = meta[start + 3];
          const n = r * c;
          if (n > 0 && len === 4 + n * 4) {
            const dists = new Array<number>(n);
            for (let z = 0; z < n; z++) {
              dists[z] = view.getUint32(start + 4 + z * 4, true);
            }
            tofRows = r;
            tofCols = c;
            tofRoiSize = rs;
            tofRoiStep = rt;
            tofDistancesMm = dists;
          }
        }
      } else if (type === kMetaTofStatus) {
        // Text when 0x14 is in the blob or the record is not a valid status grid.
        const n = len >= 4 ? meta[start] * meta[start + 1] : 0;
        if (!tofLegacy && n > 0 && len === 4 + n) {
          const statuses = new Array<number>(n);
          for (let z = 0; z < n; z++) statuses[z] = meta[start + 4 + z];
          tofStatuses = statuses;
          tofStatusRows = meta[start];
          tofStatusCols = meta[start + 1];
        } else {
          debugTextChunks.push(meta.subarray(start, end));
        }
      } else if (type === kMetaThermalFrame) {
        // A header-only record, len 8, announces that thermal frames are coming.
        if (len >= 8) {
          const w = readU16le(start);
          const h = readU16le(start + 2);
          const format = meta[start + 4];
          const flags = meta[start + 5];
          const n = w * h;
          if (format === 0 && n > 0 && len === 8 + n * 2) {
            const px = new Uint16Array(n);
            let off = start + 8;
            for (let p = 0; p < n; p++) {
              px[p] = meta[off] | (meta[off + 1] << 8);
              off += 2;
            }
            thermalThisFrame = {
              width: w,
              height: h,
              radiometric: (flags & 0x01) !== 0,
              pixels: px,
            };
            sawThermal = true;
          } else if (len === 8) {
            sawThermal = true;
          }
        }
      } else if (type === kMetaVisionId) {
        if (len >= 1) visionKindThisFrame = meta[start];
      } else if (
        type === kMetaQrFrame ||
        type === kMetaBarcodeFrame ||
        type === kMetaBlobFrame ||
        type === kMetaAprilTag
      ) {
        // count = 0 means nothing in view and clears the panel.
        const vf =
          type === kMetaAprilTag
            ? decodeAprilTagFrame(meta, start, len)
            : decodeVisionFrame(meta, start, len, type);
        if (vf) {
          visionThisFrame = vf;
          // Earlier evidence in this blob belonged to the replaced frame.
          evidenceThisFrame = undefined;
        }
      } else if (type === kMetaEvidenceCrop) {
        const crops = decodeEvidenceCrops(meta, start, len);
        if (crops?.length) {
          if (visionThisFrame) visionThisFrame = mergeEvidenceCrops(visionThisFrame, crops);
          else evidenceThisFrame = (evidenceThisFrame ?? []).concat(crops);
        }
      } else if (type === kMetaEvent) {
        const ev = decodeBoardEvent(meta, start, len);
        if (ev && ev.id !== 0) boardEventsThisFrame.push(ev);
      } else if (type === kMetaAudioClass) {
        if (len >= 6) {
          const count = meta[start];
          if (len >= 6 + count * 2) {
            const scores = new Array<number>(count);
            for (let k = 0; k < count; k++) scores[k] = readU16le(start + 6 + k * 2) / 1000;
            const top = meta[start + 1];
            audioClassThisFrame = {
              scores,
              top: top === 0xff ? -1 : top,
              level: readU16le(start + 2),
              threshold: readU16le(start + 4) / 1000,
            };
          }
        }
      } else if (type === kMetaAudioMel) {
        if (len >= 4) {
          const nMel = meta[start];
          const nFrames = meta[start + 1];
          const need = nMel * nFrames;
          if (nMel > 0 && nFrames > 0 && len >= 4 + need) {
            audioMelThisFrame = {
              nMel,
              nFrames,
              layout: meta[start + 2],
              data: new Uint8Array(meta.subarray(start + 4, start + 4 + need)),
            };
          }
        }
      } else if (type === kMetaAudioLabels) {
        // A truncated record keeps the previous names.
        if (len >= 1) {
          const count = meta[start];
          const names: string[] = [];
          let p = start + 1;
          for (let k = 0; k < count; k++) {
            if (p >= end) break;
            const n = meta[p++];
            if (p + n > end) break;
            names.push(decodeTlvString(meta.subarray(p, p + n)));
            p += n;
          }
          if (names.length === count && count > 0) audioLabelsThisFrame = names;
        }
      } else if (type === kMetaImageClass) {
        const cls = decodeImageClass(meta, start, end);
        if (cls) imageClassThisFrame = cls;
      } else if (type === kMetaDebugText) {
        // Decoded together below, so a character split across records survives.
        debugTextChunks.push(meta.subarray(start, end));
      } else if (type === kMetaDebugLog) {
        const log = decodeDebugLog(meta, start, end);
        if (log) debugLogThisFrame = log;
      }
      // Unknown types, and 0x15 when tofLegacy, are ignored.
    } catch {
      // Ignore bad TLV payloads.
    }

    i = end;
  }

  // obj_id is the box's index across all 0x02 records.
  if (sawBoxLabels) {
    for (let idx = 0; idx < boxes.length; idx++) {
      const label = labelsByObj.get(idx);
      if (label) boxes[idx].label = label;
    }
  }

  const result: ParsedMeta = {
    overlay: {
      inferenceMs,
      boxes,
      keypoints,
      bindings,
      classLabelsByObjId: labelsByObj,
      masksByObjId: masksByObj,
      warning,
      followTarget,
      debugTofPresent: sawDebugTof,
      debugTofEnabled,
    },
    presence: {
      hasInferenceMs: sawInference,
      hasBoxes: sawBoxes,
      hasKeypoints: sawKeypoints,
      hasBindings: sawBindings,
      hasBoxLabels: sawBoxLabels,
      hasShading: sawShading,
      hasDebugTof: sawDebugTof,
      hasThermal: sawThermal,
    },
  };

  if (tofDistancesMm && tofRows > 0 && tofCols > 0) {
    // A status grid shaped unlike the distance grid would misalign every cell,
    // so it is dropped, whichever record came first.
    const statusesFit = tofStatusRows === tofRows && tofStatusCols === tofCols;
    result.tof = {
      rows: tofRows,
      cols: tofCols,
      roiSize: tofRoiSize,
      roiStep: tofRoiStep,
      distancesMm: tofDistancesMm,
      statuses: statusesFit ? (tofStatuses ?? []) : [],
      legacy: tofLegacy,
    };
  }
  if (thermalThisFrame) result.thermal = thermalThisFrame;
  if (magThisFrame) result.mag = magThisFrame;
  if (imuThisFrame) result.imu = imuThisFrame;
  if (visionThisFrame) result.vision = visionThisFrame;
  if (visionKindThisFrame !== undefined) result.visionKind = visionKindThisFrame;
  if (evidenceThisFrame) result.evidence = evidenceThisFrame;
  if (debugTextChunks.length) {
    let raw = debugTextChunks[0];
    if (debugTextChunks.length > 1) {
      raw = new Uint8Array(debugTextChunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of debugTextChunks) {
        raw.set(c, o);
        o += c.length;
      }
    }
    const text = decodeTerminalText(raw);
    if (text) result.debugText = text;
  }
  if (debugLogThisFrame) result.debugLog = debugLogThisFrame;
  if (audioClassThisFrame) result.audioClass = audioClassThisFrame;
  if (audioMelThisFrame) result.audioMel = audioMelThisFrame;
  if (audioLabelsThisFrame) result.audioLabels = audioLabelsThisFrame;
  if (imageClassThisFrame) result.imageClass = imageClassThisFrame;
  if (boardEventsThisFrame.length) result.boardEvents = boardEventsThisFrame;

  return result;
}

/** First full thermal frame in the blob, or null. */
export function extractThermalFrame(meta: Uint8Array): ThermalFrame | null {
  let i = 0;
  while (i + 3 <= meta.length) {
    const type = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    i += 3;
    if (i + len > meta.length) break;
    if (type === kMetaThermalFrame && len >= 8) {
      const w = meta[i] | (meta[i + 1] << 8);
      const h = meta[i + 2] | (meta[i + 3] << 8);
      const format = meta[i + 4];
      const flags = meta[i + 5];
      const n = w * h;
      if (format === 0 && n > 0 && len === 8 + n * 2) {
        const px = new Uint16Array(n);
        let off = i + 8;
        for (let p = 0; p < n; p++) {
          px[p] = meta[off] | (meta[off + 1] << 8);
          off += 2;
        }
        return { width: w, height: h, radiometric: (flags & 0x01) !== 0, pixels: px };
      }
    }
    i += len;
  }
  return null;
}

/** True for a thermal TLV with at least its 8-byte header, a frame or an announce. */
export function metaAnnouncesThermal(meta: Uint8Array): boolean {
  let i = 0;
  while (i + 3 <= meta.length) {
    const type = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    i += 3;
    if (i + len > meta.length) break;
    if (type === kMetaThermalFrame && len >= 8) return true;
    i += len;
  }
  return false;
}

/** Device colour ids: 0 head, 1 arms, 2 trunk, 3 legs, 4 box. */
export function overlayColorFromId(id: number): string {
  switch (id) {
    case 0:
      return "#00ff00";
    case 1:
      return "#0000ff";
    case 2:
      return "#ff00ff";
    case 3:
      return "#ffa500";
    case 4:
      return "#ff0000";
    default:
      return "#ffffff";
  }
}
