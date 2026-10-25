/// <reference types="vite/client" />

/** A Neuro N6 on the USB tree, enumerated by the main process. */
export interface UsbBoardInfo {
  vid: number;
  pid: number;
  bus: number;
  ports: number[];
  serial: string | null;
  /** Bus and ports: "1-3", or "2-1.4" behind a hub. */
  portPath: string;
  /** Port path, plus serial when it could be read. */
  label: string;
  /** Another window's session holds this board. */
  inUse?: boolean;
}

/** "wifi" is the network the board hosts itself; a board streams over no other WiFi. */
export type TransportMode = "usb" | "wifi" | "ethernet";

export type DeviceEvent =
  | { t: "status"; text: string }
  | { t: "logline"; text: string }
  | { t: "frame"; jpeg: Uint8Array }
  | { t: "meta"; id: number; metaLen: number; jpegLen: number; meta: Uint8Array }
  | { t: "stream_info"; w: number; h: number; fps: number }
  | { t: "overlay_categories"; cats: string[] }
  | { t: "overlay_presence"; hasBoxLabels: boolean; hasShading: boolean }
  | { t: "warning"; text: string }
  | { t: "audio"; id: number; rate: number; channels: number; pcm: Uint8Array }
  | { t: "clear_caches" }
  | { t: "isp_enabled"; value: number }
  | { t: "cam_caps"; value: number }
  | { t: "tune_desc"; data: Uint8Array }
  /** Over USB only: where the board serves its stream on the network it hosts. */
  | { t: "board_ip"; host: string; port: number }
  /** Over USB only: the network the board hosts. Shown on request; never logged or saved. */
  | { t: "board_softap"; ssid: string; password: string }
  /** `wrong`: the board refused the key it was given; otherwise none is known. */
  | { t: "link_key_needed"; host: string; wrong: boolean }
  /** The recording file could not be written; main has ended the recording. */
  | { t: "recorder_error"; text: string };

export interface SaveResult {
  canceled: boolean;
  path?: string;
  error?: string;
}

export interface RecordingResult {
  path: string | null;
  error?: string;
  frames?: number;
  droppedFrames?: number;
}

export interface LaunchOptions {
  /** --network-only: USB is off and windows start on WiFi SoftAP. */
  networkOnly: boolean;
  /** WiFi SoftAP target in place of 192.168.10.1:5000, when given. */
  wifiHost: string | null;
  wifiPort: number | null;
}

export interface NeuroBridge {
  readonly launch: LaunchOptions;
  open(options?: {
    ids?: number[][];
    itf?: number;
    epIn?: number;
    epOut?: number;
    auto?: boolean;
    bus?: number | null;
    ports?: number[] | null;
  }): Promise<void>;
  openTcp(options?: { host?: string; port?: number; auto?: boolean }): Promise<void>;
  switchTransport(
    mode: TransportMode,
    options?: { host?: string; port?: number; board?: UsbBoardInfo | null },
  ): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): void;
  setAutoRecover(on: boolean): void;
  /** Answers the board at `host` with `key` now and on every reconnect this session. */
  setLinkKey(host: string, key: string): void;
  listBoards(): Promise<UsbBoardInfo[]>;
  defaults(): Promise<{
    identities: number[][];
    wifi: { host: string; port: number };
    ethernet: { host: string; port: number };
  }>;
  onEvent(listener: (event: DeviceEvent) => void): () => void;

  saveSnapshot(suggestedName: string, bytes: Uint8Array): Promise<SaveResult>;
  saveLog(suggestedName: string, text: string): Promise<SaveResult>;
  /** The main process records every frame the board sends until stopRecording. */
  startRecording(suggestedName: string): Promise<SaveResult>;
  /**
   * path is null when nothing was recording. frames were written; droppedFrames were
   * skipped while the disk lagged.
   */
  stopRecording(): Promise<RecordingResult>;

  newWindow(): Promise<void>;

  bootloader: BootloaderBridge;
}

export interface DfuPort {
  name: string;
  vid: number | null;
  pid: number | null;
  serial: string | null;
  description: string | null;
  isApp: boolean;
  /** A bootloader identity, or any device on VID 0xCAFE. */
  isBootloaderFamily: boolean;
}

/** A picked firmware file. Main keeps the bytes; the renderer sees this summary. */
export interface DfuFirmware {
  path: string;
  name: string;
  size: number;
  crc: number;
}

export type DfuPickResult =
  { canceled: true } | ({ canceled: false } & DfuFirmware) | { canceled: false; error: string };

export interface DfuFlashRequest {
  /** Must be the path the picker returned in this window. */
  path: string;
  /** Offset from the flash base, not an absolute address. */
  offset: number;
  /** null = auto-detect; otherwise a name from the last listPorts(). */
  port: string | null;
  /** Set only after the user confirmed writing into the FSBL region. */
  confirmFsbl?: boolean;
}

export interface DfuResult {
  ok: boolean;
  message: string;
}

export interface DfuProgress {
  label: string;
  written: number;
  total: number;
  imageIndex: number;
  imageCount: number;
}

export type DfuEvent =
  | { t: "log"; text: string }
  | ({ t: "progress" } & DfuProgress)
  /** critical: the board is being written; stopping leaves a partial image. */
  | { t: "stage"; critical: boolean }
  /** The flash has ended; sent as well as flash()'s reply. */
  | ({ t: "done" } & DfuResult);

export interface DfuFlashState {
  file: DfuFirmware;
  offset: number;
  port: string | null;
  log: string[];
  progress: DfuProgress | null;
  startedAt: number;
  critical: boolean;
  /** Date.now() of the last log line or progress from the flash. */
  lastActivityAt: number;
}

export interface BootloaderBridge {
  listPorts(): Promise<DfuPort[]>;
  pickFile(): Promise<DfuPickResult>;
  /** Resolves once the flash has finished and the video stream is back. */
  flash(request: DfuFlashRequest): Promise<DfuResult>;
  /** This window's flash in progress, or null. */
  state(): Promise<DfuFlashState | null>;
  /** Refused while the board is being written, unless forced after DFU_STALL_MS of silence. */
  cancel(force?: boolean): Promise<DfuResult>;
  onEvent(listener: (event: DfuEvent) => void): () => void;
}

declare global {
  /** package.json's version, set at build time. */
  const __APP_VERSION__: string;

  interface Window {
    neuro: NeuroBridge;
  }
}
