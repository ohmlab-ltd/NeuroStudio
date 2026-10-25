// Device store: the transport session's state, shaped for the UI.

import { Observable } from "./observable";
import {
  emptyOverlayData,
  emptyPresence,
  mergeBoardEvent,
  mergeEvidenceCrops,
  parseOverlayMeta,
  type AudioClassFrame,
  type AudioMelFrame,
  type BoardEvent,
  type DebugLog,
  type ImageClassFrame,
  type MetaPresence,
  type OverlayData,
  type SensorReading,
  type ThermalFrame,
  type TofFrame,
  type VisionFrame,
} from "../device/tlv";
import { parseTuneDescriptor, tuneParamsChanged, type TuneParam } from "../device/packets";
import { thermalFrameToRgba } from "../device/thermal";
import { appendTerminal } from "./terminal";
import { requestLinkKey } from "./linkKey";
import { clearThermalProbes } from "./probes";
import { overlayOptions, swapMainThermal } from "./options";
import { audioPlayback } from "../audio/playback";
import type { DeviceEvent, LaunchOptions, TransportMode, UsbBoardInfo } from "../vite-env";

// Connection + stream

export interface ConnectionState {
  status: string | null;
  connecting: boolean;
  connected: boolean;
  /** A camera or sensor frame arrived within the no-data timeout. */
  hasRecentFrame: boolean;
}

export const connection = new Observable<ConnectionState>({
  status: null,
  connecting: false,
  connected: false,
  hasRecentFrame: false,
});

export interface StreamInfo {
  width: number;
  height: number;
  fps: number;
}

export const streamInfo = new Observable<StreamInfo>({ width: 0, height: 0, fps: 0 });

// Sensors + capability beacons

export const tofFrame = new Observable<TofFrame | null>(null);

/** Latches on the first ToF frame; resets on disconnect. */
export const tofSeen = new Observable<boolean>(false);

export const thermalFrame = new Observable<ThermalFrame | null>(null);

/** True while the held thermal frame is older than THERMAL_STALE_MS. */
export const thermalStale = new Observable<boolean>(false);
const THERMAL_STALE_MS = 3000;
let thermalFrameAt = 0;

export const magReading = new Observable<SensorReading | null>(null);
export const imuReading = new Observable<SensorReading | null>(null);

/** An empty result list means nothing in view. */
export const visionFrame = new Observable<VisionFrame | null>(null);
/** META_VISION_ID beacon, ~0.5 Hz: bit0 QR, bit1 barcode, bit2 blob, bit3 AprilTag, 0 = none. */
export const visionKind = new Observable<number>(0);

export const audioClass = new Observable<AudioClassFrame | null>(null);
/** Optional on the device, so it can stay null while audioClass updates. */
export const audioMel = new Observable<AudioMelFrame | null>(null);
export const audioLabels = new Observable<string[]>([]);

export const imageClass = new Observable<ImageClassFrame | null>(null);

/** Newest first, one entry per id. */
export const boardEvents = new Observable<BoardEvent[]>([]);

/** META_VD66_ISP_ENABLED: 0 = off, 1 = host-driven, 2 = on-device auto white balance. */
export const ispMode = new Observable<number>(0);

/** META_CAM_CAPS: bit0 exposure, bit1 gain, bit2 white balance, bit3 autofocus; 0 = none. */
export const camCaps = new Observable<number>(0);

/** Parameters the sketch registered with n6_tune_*. */
export const tuneParams = new Observable<TuneParam[]>([]);

export const overlayCategories = new Observable<string[]>([]);

// Presence + linger

/** Overlay controls stay this long after their metadata stops arriving. */
const LINGER_MS = 3000;

export type LingerKey =
  | "hasInferenceMs"
  | "hasBoxes"
  | "hasKeypoints"
  | "hasBindings"
  | "hasBoxLabels"
  | "hasShading"
  | "hasDebugTof"
  | "hasThermal";

export const presenceLinger = new Observable<MetaPresence>({ ...emptyPresence });

const lingerTimers = new Map<LingerKey, ReturnType<typeof setTimeout>>();

function applyPresence(next: MetaPresence): void {
  const current = presenceLinger.get();
  const patch: Partial<MetaPresence> = {};
  let changed = false;

  (Object.keys(emptyPresence) as LingerKey[]).forEach((key) => {
    if (next[key]) {
      const timer = lingerTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        lingerTimers.delete(key);
      }
      if (!current[key]) {
        patch[key] = true;
        changed = true;
      }
    } else if (current[key] && !lingerTimers.has(key)) {
      lingerTimers.set(
        key,
        setTimeout(() => {
          lingerTimers.delete(key);
          presenceLinger.set({ ...presenceLinger.get(), [key]: false });
        }, LINGER_MS),
      );
    }
  });

  if (changed) presenceLinger.set({ ...current, ...patch });
}

function resetPresence(): void {
  for (const timer of lingerTimers.values()) clearTimeout(timer);
  lingerTimers.clear();
  presenceLinger.set({ ...emptyPresence });
}

// Warning hold

/** The last non-empty warning stays this long after it was last seen. */
const WARNING_HOLD_MS = 2500;
let warningText = "";
let warningSeenMs = 0;

function updateWarning(text: string): void {
  const t = text.trim();
  if (t) {
    warningText = t;
    warningSeenMs = Date.now();
  }
  // An empty update does not clear; currentWarning expires the text.
}

export function currentWarning(): string {
  if (!warningText) return "";
  if (Date.now() - warningSeenMs > WARNING_HOLD_MS) {
    warningText = "";
    warningSeenMs = 0;
    return "";
  }
  return warningText;
}

function clearWarning(): void {
  warningText = "";
  warningSeenMs = 0;
}

// Per-frame holder, read by the canvas render loops and never by React

export interface LiveFrameState {
  jpeg: Uint8Array | null;
  cameraBitmap: ImageBitmap | null;
  /** Colormapped thermal frame. */
  thermalBitmap: ImageBitmap | null;
  overlay: OverlayData;
  lastFrameAt: number;
  /** Set by any 0x30 TLV; auto mode then holds the slot for thermal. */
  thermalExpected: boolean;
}

export const live: LiveFrameState = {
  jpeg: null,
  cameraBitmap: null,
  thermalBitmap: null,
  overlay: emptyOverlayData,
  lastFrameAt: 0,
  thermalExpected: false,
};

// Transport selection

/** Defaults apply without a bridge, as in tests. */
const launch: LaunchOptions = (typeof window !== "undefined" &&
  (window as Partial<Window>).neuro?.launch) || {
  networkOnly: false,
  wifiHost: null,
  wifiPort: null,
};

/** --network-only: USB is off and the window starts on WiFi SoftAP. */
export const NETWORK_ONLY = launch.networkOnly;

export interface TransportState {
  mode: TransportMode;
  /** USB board for this window; null = the first VID/PID match. */
  pinnedBoard: UsbBoardInfo | null;
  autoRecover: boolean;
}

export const transportState = new Observable<TransportState>({
  mode: NETWORK_ONLY ? "wifi" : "usb",
  pinnedBoard: null,
  autoRecover: true,
});

/** The main process writes the frames; this only drives the Record button. */
export const recordingState = new Observable<{ active: boolean; path: string | null }>({
  active: false,
  path: null,
});

/** The board's own SoftAP, unless the launch options name another. */
export const WIFI_DEFAULT = {
  host: launch.wifiHost ?? "192.168.10.1",
  port: launch.wifiPort ?? 5000,
};
export const ETHERNET_DEFAULT = { host: "192.168.20.1", port: 5000 };

/** META_BOARD_IPV4, learned over USB: where the board serves its stream on the network it hosts. */
export const boardWifiAddress = new Observable<{ host: string; port: number } | null>(null);

export interface BoardWifiNetwork {
  ssid: string;
  password: string;
}

/**
 * META_BOARD_SOFTAP, learned over USB: the network the board hosts. Held in memory for the
 * WiFi connect help, which shows the password only on request; never logged or saved.
 */
export const boardWifiNetwork = new Observable<BoardWifiNetwork | null>(null);

/** Where WiFi connects: a target named at launch, else the board's announced address. */
export function wifiTarget(address = boardWifiAddress.get()): { host: string; port: number } {
  if (launch.wifiHost !== null || launch.wifiPort !== null || !address) return WIFI_DEFAULT;
  return address;
}

function forgetBoardNetwork(): void {
  if (boardWifiAddress.get() !== null) boardWifiAddress.set(null);
  if (boardWifiNetwork.get() !== null) boardWifiNetwork.set(null);
}

// Image decoding

let cameraDecodePending: Uint8Array | null = null;
let cameraDecoding = false;
/** Bumped when the live frame is cleared, so a late decode is dropped. */
let cameraDecodeEpoch = 0;

/** Decodes the newest JPEG only; frames queued behind a slow decode are dropped. */
function decodeCameraFrame(bytes: Uint8Array): void {
  if (cameraDecoding) {
    cameraDecodePending = bytes;
    return;
  }
  cameraDecoding = true;
  const epoch = cameraDecodeEpoch;
  const buffer = bytes.slice().buffer as ArrayBuffer;
  createImageBitmap(new Blob([buffer], { type: "image/jpeg" }))
    .then((bitmap) => {
      if (epoch !== cameraDecodeEpoch) {
        bitmap.close();
        return;
      }
      live.cameraBitmap?.close();
      live.cameraBitmap = bitmap;
    })
    .catch(() => {
      /* Bad frame: the previous image stays. */
    })
    .finally(() => {
      cameraDecoding = false;
      const next = cameraDecodePending;
      cameraDecodePending = null;
      if (next) decodeCameraFrame(next);
    });
}

function resetCameraDecode(): void {
  cameraDecodeEpoch++;
  cameraDecodePending = null;
  live.cameraBitmap?.close();
  live.cameraBitmap = null;
}

let thermalDecodeEpoch = 0;
let thermalSource: ThermalFrame | null = null;
let thermalCmapUsed: string | null = null;

/** Rebuilds live.thermalBitmap when the frame or colormap changed, or when forced. */
export function rebuildThermalBitmap(force = false): void {
  const frame = thermalFrame.get();
  if (!frame) return;
  const cmap = overlayOptions.get().thermalColormap;
  if (!force && frame === thermalSource && cmap === thermalCmapUsed && live.thermalBitmap) {
    return;
  }
  thermalSource = frame;
  thermalCmapUsed = cmap;

  const imageData = thermalFrameToRgba(frame, cmap);
  if (!imageData) return;

  const epoch = ++thermalDecodeEpoch;
  createImageBitmap(imageData)
    .then((bitmap) => {
      if (epoch !== thermalDecodeEpoch) {
        bitmap.close();
        return;
      }
      live.thermalBitmap?.close();
      live.thermalBitmap = bitmap;
    })
    .catch(() => {
      /* cosmetic */
    });
}

function clearThermalBitmap(): void {
  thermalDecodeEpoch++;
  thermalSource = null;
  thermalCmapUsed = null;
  live.thermalBitmap?.close();
  live.thermalBitmap = null;
}

// Cache clearing

type CacheListener = () => void;
const cacheListeners = new Set<CacheListener>();

/** Overlay renderers register here to drop their mask image caches. */
export function onClearCaches(listener: CacheListener): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}

/** The board repeats its latest meta on every video frame, so one chunk arrives many times. */
let lastDebugText: string | undefined;

/** Number and boot mark of the last log line printed, and whether the board sends the log. */
let lastLogLine: number | null = null;
let lastLogBoot: number | undefined;
let debugLogSeen = false;

/** Prints the lines not printed yet, after a note of how many were lost. */
function printDebugLog({ first, lines, boot }: DebugLog): void {
  // With no lines, `first` is the number the next line will get.
  const newest = first + lines.length - 1;
  // A changed boot mark means the board restarted. Older firmware sends none,
  // and then a step back in the numbers, which only rise within a boot, is the sign.
  const restarted =
    (boot !== undefined && lastLogBoot !== undefined && boot !== lastLogBoot) ||
    (lastLogLine !== null && newest < lastLogLine);
  const last = restarted ? null : lastLogLine;
  let text = "";
  if (last !== null && first > last + 1) {
    const lost = first - last - 1;
    text += `[host] ${lost} Terminal line${lost === 1 ? "" : "s"} lost\n`;
  }
  lines.forEach((line, k) => {
    if (last === null || first + k > last) text += line;
  });
  appendTerminal(text);
  lastLogLine = newest;
  if (boot !== undefined) lastLogBoot = boot;
}

/** Clears every visual cache; called on device disconnect and reconnect. */
export function clearOverlayCaches(): void {
  for (const listener of cacheListeners) listener();
  clearWarning();
  lastDebugText = undefined;
  lastLogLine = null;
  lastLogBoot = undefined;
  debugLogSeen = false;
  resetPresence();
  tofFrame.set(null);
  tofSeen.set(false);
  thermalFrame.set(null);
  thermalFrameAt = 0;
  thermalStale.set(false);
  clearThermalProbes();
  clearThermalBitmap();
  magReading.set(null);
  imuReading.set(null);
  visionFrame.set(null);
  visionKind.set(0);
  audioClass.set(null);
  audioMel.set(null);
  audioLabels.set([]);
  imageClass.set(null);
  boardEvents.set([]);
  overlayCategories.set([]);

  live.jpeg = null;
  resetCameraDecode();
  live.overlay = emptyOverlayData;
  live.lastFrameAt = 0;
  live.thermalExpected = false;
}

// Event ingestion

function patchConnection(patch: Partial<ConnectionState>): void {
  connection.set({ ...connection.get(), ...patch });
}

export type LinkState = "connected" | "connecting" | "disconnected";

/** Maps a session status to exactly one link state. */
export function linkStateOf(text: string): LinkState {
  const t = text.toLowerCase();
  if (t.startsWith("connected")) return "connected";
  if (
    t.startsWith("connecting") ||
    t.startsWith("reconnecting") ||
    t.startsWith("waiting") ||
    t.startsWith("usb silent")
  ) {
    return "connecting";
  }
  return "disconnected";
}

function handleStatus(text: string): void {
  const state = linkStateOf(text);
  const patch: Partial<ConnectionState> = {
    status: text,
    connected: state === "connected",
    connecting: state === "connecting",
  };

  if (state === "disconnected") {
    patch.hasRecentFrame = false;
    live.jpeg = null;
    resetCameraDecode();
    live.overlay = emptyOverlayData;
    live.lastFrameAt = 0;
    clearThermalBitmap();
  }
  // A new USB link may be another board, or one that no longer hosts a network.
  if (state === "connected" && transportState.get().mode === "usb") forgetBoardNetwork();

  patchConnection(patch);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function handleMeta(event: Extract<DeviceEvent, { t: "meta" }>): void {
  const parsed = parseOverlayMeta(event.meta);

  applyPresence(parsed.presence);
  updateWarning(parsed.overlay.warning);

  if (parsed.tof) {
    tofFrame.set(parsed.tof);
    if (!tofSeen.get()) tofSeen.set(true);
  }
  if (parsed.mag) magReading.set(parsed.mag);
  if (parsed.imu) imuReading.set(parsed.imu);
  if (parsed.vision) {
    visionFrame.set(parsed.vision);
  } else if (parsed.evidence) {
    const current = visionFrame.get();
    if (current) visionFrame.set(mergeEvidenceCrops(current, parsed.evidence));
  }
  if (parsed.visionKind !== undefined && parsed.visionKind !== visionKind.get()) {
    visionKind.set(parsed.visionKind);
  }
  // A blob without text keeps lastDebugText, as camera-less frames interleave with video.
  if (parsed.debugLog) {
    debugLogSeen = true;
    printDebugLog(parsed.debugLog);
  } else if (
    !debugLogSeen &&
    parsed.debugText !== undefined &&
    parsed.debugText !== lastDebugText
  ) {
    lastDebugText = parsed.debugText;
    appendTerminal(parsed.debugText);
  }

  if (parsed.audioClass) audioClass.set(parsed.audioClass);
  if (parsed.audioMel) audioMel.set(parsed.audioMel);
  if (parsed.audioLabels && !sameStrings(parsed.audioLabels, audioLabels.get())) {
    audioLabels.set(parsed.audioLabels);
  }
  if (parsed.imageClass) imageClass.set(parsed.imageClass);
  if (parsed.boardEvents) {
    boardEvents.set(parsed.boardEvents.reduce(mergeBoardEvent, boardEvents.get()));
  }

  if (parsed.thermal) {
    thermalFrameAt = Date.now();
    thermalStale.set(false);
    thermalFrame.set(parsed.thermal);
    live.thermalExpected = true;
    rebuildThermalBitmap();
  } else if (parsed.presence.hasThermal) {
    live.thermalExpected = true;
  }

  // Inference TLVs ride JPEG frames; a meta-only packet must not replace the overlay.
  if (event.jpegLen > 0) {
    live.overlay = parsed.overlay;
  }

  // On a camera-less board, data this packet carried keeps the stream live. After the first
  // camera frame, only camera frames count.
  const carriedData =
    parsed.thermal !== undefined ||
    parsed.presence.hasThermal ||
    parsed.tof !== undefined ||
    parsed.mag !== undefined ||
    parsed.imu !== undefined ||
    parsed.audioClass !== undefined ||
    parsed.audioMel !== undefined ||
    parsed.audioLabels !== undefined ||
    parsed.imageClass !== undefined ||
    parsed.boardEvents !== undefined;
  if (!live.jpeg && event.jpegLen === 0 && carriedData) markDataLive();
}

/** Refreshes liveness as a camera frame would, for a board with no camera stream. */
function markDataLive(): void {
  live.lastFrameAt = Date.now();
  const state = connection.get();
  if (state.connecting || !state.connected || !state.hasRecentFrame) {
    patchConnection({ connecting: false, connected: true, hasRecentFrame: true });
  }
}

let unsubscribe: (() => void) | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;

const NO_DATA_TIMEOUT_MS = 2000;
const WATCHDOG_PERIOD_MS = 250;

/** Subscribes the store to the transport; idempotent. */
export function startDeviceStore(): () => void {
  if (unsubscribe) return () => undefined;

  unsubscribe = window.neuro.onEvent((event: DeviceEvent) => {
    try {
      switch (event.t) {
        case "status":
          handleStatus(event.text);
          break;

        case "logline":
          appendTerminal(`[host] ${event.text}\n`);
          break;

        case "frame": {
          const bytes = event.jpeg instanceof Uint8Array ? event.jpeg : new Uint8Array(event.jpeg);
          live.jpeg = bytes;
          live.lastFrameAt = Date.now();
          decodeCameraFrame(bytes);
          const state = connection.get();
          if (state.connecting || !state.connected || !state.hasRecentFrame) {
            patchConnection({ connecting: false, connected: true, hasRecentFrame: true });
          }
          break;
        }

        case "meta":
          handleMeta(event);
          break;

        case "stream_info": {
          const current = streamInfo.get();
          const width = event.w > 0 ? event.w : current.width;
          const height = event.h > 0 ? event.h : current.height;
          if (width !== current.width || height !== current.height || event.fps !== current.fps) {
            streamInfo.set({ width, height, fps: event.fps });
          }
          break;
        }

        case "overlay_categories":
          overlayCategories.set(event.cats);
          break;

        case "overlay_presence":
          // The transport's debounced view of two flags handleMeta also sets.
          applyPresence({
            ...presenceLinger.get(),
            hasBoxLabels: event.hasBoxLabels,
            hasShading: event.hasShading,
          });
          break;

        case "warning":
          updateWarning(event.text);
          break;

        case "audio": {
          const pcm = event.pcm instanceof Uint8Array ? event.pcm : new Uint8Array(event.pcm);
          // Microphone-only packets produce no meta event.
          if (!live.jpeg) markDataLive();
          audioPlayback.feed(pcm, event.rate, event.channels);
          break;
        }

        case "clear_caches": {
          clearOverlayCaches();
          // Capabilities stay off until the board announces them again.
          ispMode.set(0);
          camCaps.set(0);
          tuneParams.set([]);
          // stream_info comes only with camera frames.
          const info = streamInfo.get();
          if (info.width !== 0 || info.height !== 0 || info.fps !== 0) {
            streamInfo.set({ width: 0, height: 0, fps: 0 });
          }
          void audioPlayback.reset();
          patchConnection({ hasRecentFrame: false });
          break;
        }

        case "isp_enabled":
          ispMode.set(event.value);
          break;

        case "cam_caps":
          camCaps.set(event.value);
          break;

        case "tune_desc": {
          // Re-sent at ~1 Hz. Published only when the parameter set changes: once the set is
          // known, the panel owns the values.
          const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
          const parsed = parseTuneDescriptor(data);
          if (parsed === null) break;
          if (tuneParamsChanged(parsed, tuneParams.get())) tuneParams.set(parsed);
          break;
        }

        case "board_ip": {
          const current = boardWifiAddress.get();
          if (!current || current.host !== event.host || current.port !== event.port) {
            boardWifiAddress.set({ host: event.host, port: event.port });
          }
          break;
        }

        case "board_softap": {
          const current = boardWifiNetwork.get();
          if (!current || current.ssid !== event.ssid || current.password !== event.password) {
            boardWifiNetwork.set({ ssid: event.ssid, password: event.password });
          }
          break;
        }

        case "link_key_needed":
          requestLinkKey(event.host, event.wrong);
          break;
      }
    } catch (error) {
      console.error("device event failed", error);
    }
  });

  watchdog = setInterval(() => {
    const recent = live.lastFrameAt > 0 && Date.now() - live.lastFrameAt <= NO_DATA_TIMEOUT_MS;
    if (recent !== connection.get().hasRecentFrame) {
      patchConnection({ hasRecentFrame: recent });
    }
    const stale = thermalFrameAt > 0 && Date.now() - thermalFrameAt > THERMAL_STALE_MS;
    if (stale !== thermalStale.get()) thermalStale.set(stale);
  }, WATCHDOG_PERIOD_MS);

  const stopOptions = overlayOptions.subscribe(() => rebuildThermalBitmap());
  const stopSwap = swapMainThermal.subscribe(() => rebuildThermalBitmap());

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    stopOptions();
    stopSwap();
  };
}
