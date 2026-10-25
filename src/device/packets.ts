// Host-to-device control packets and the live-tuning descriptor. Multi-byte fields are LE.

import { decodeTlvString } from "./tlv";

// Live tuning: META_TUNE_DESC, 'TUN0'

/** Mirrors N6_TUNE_TYPE_* on the device. */
export const kTuneTypeInt = 0;
export const kTuneTypeFloat = 1;
export const kTuneTypeBool = 2;

/** Mirrors N6_TUNE_HINT_*; an unknown hint shows a plain slider. */
export const kTuneHintNone = 0;
export const kTuneHintHue = 1;

/** Float scale on the wire; mirrors N6_TUNE_FLOAT_SCALE. */
export const kTuneFloatScale = 1000;

/** `lo`, `hi` and `current` are wire units: raw for int and bool, milli-units for float. */
export interface TuneParam {
  id: number;
  type: number;
  hint: number;
  name: string;
  lo: number;
  hi: number;
  current: number;
}

export function tuneToDisplay(p: TuneParam, wire: number): number {
  return p.type === kTuneTypeFloat ? wire / kTuneFloatScale : wire;
}

export function tuneFromDisplay(p: TuneParam, v: number): number {
  return p.type === kTuneTypeFloat ? Math.round(v * kTuneFloatScale) : Math.round(v);
}

export function tuneLiteral(p: TuneParam, wire: number): string {
  if (p.type === kTuneTypeBool) return wire !== 0 ? "1" : "0";
  if (p.type === kTuneTypeFloat) return `${(wire / kTuneFloatScale).toFixed(3)}f`;
  return `${wire}`;
}

/**
 * META_TUNE_DESC: u8 count, then per parameter u8 id, u8 type, u8 hint, u8 name_len, name,
 * i32 lo, i32 hi, i32 current. Null when malformed or truncated.
 */
export function parseTuneDescriptor(v: Uint8Array): TuneParam[] | null {
  if (v.length === 0) return null;
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
  let p = 0;
  const count = v[p++];
  const out: TuneParam[] = [];

  for (let n = 0; n < count; n++) {
    if (p + 4 > v.length) return null;
    const id = v[p];
    const type = v[p + 1];
    const hint = v[p + 2];
    const nameLen = v[p + 3];
    p += 4;
    if (p + nameLen + 12 > v.length) return null;
    const name = decodeTlvString(v.subarray(p, p + nameLen));
    p += nameLen;
    const lo = view.getInt32(p, true);
    const hi = view.getInt32(p + 4, true);
    const current = view.getInt32(p + 8, true);
    p += 12;
    out.push({ id, type, hint, name, lo, hi, current });
  }
  return out;
}

/** True when the parameter set changed; current values are ignored. */
export function tuneParamsChanged(next: TuneParam[], prev: TuneParam[]): boolean {
  if (next.length !== prev.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (
      next[i].id !== prev[i].id ||
      next[i].name !== prev[i].name ||
      next[i].type !== prev[i].type ||
      next[i].lo !== prev[i].lo ||
      next[i].hi !== prev[i].hi
    ) {
      return true;
    }
  }
  return false;
}

/** 'TUN0'. The device clamps `wireValue` to the bounds the sketch declared. */
export function buildTunePacket(id: number, type: number, wireValue: number): Uint8Array {
  const buf = new ArrayBuffer(10);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x304e5554, true); // 'TUN0'
  dv.setUint8(4, id & 0xff);
  dv.setUint8(5, type & 0xff);
  dv.setInt32(6, wireValue, true);
  return new Uint8Array(buf);
}

// ISP tuning: 'ISP0'

/** From vd66gy_mai1_isp_param_conf.h: gains, 1.0 = neutral; 3x3 CCM in DCMIPP units, 256 = 1.0. */
export interface WbPreset {
  label: string;
  gainR: number;
  gainG: number;
  gainB: number;
  ccm: number[];
}

export const wbPresets: WbPreset[] = [
  {
    label: "Daylight 6500K (D65)",
    gainR: 1.71,
    gainG: 1.0,
    gainB: 1.51,
    ccm: [361, 29, -134, -88, 473, -129, -22, -101, 380],
  },
  {
    label: "Fluorescent 4000K (TL84)",
    gainR: 1.2,
    gainG: 1.0,
    gainB: 2.31,
    ccm: [410, -51, -102, -103, 422, -62, 5, -216, 466],
  },
  {
    label: "Incandescent 2850K (INCA)",
    gainR: 1.0,
    gainG: 1.09,
    gainB: 3.23,
    ccm: [313, 102, -160, -128, 443, -58, -26, -245, 528],
  },
  {
    label: "Warm white 2500K (U30)",
    gainR: 1.0,
    gainG: 1.06,
    gainB: 3.36,
    ccm: [426, -49, -120, -118, 419, -44, 15, -357, 598],
  },
];

/** gain -> DCMIPP (shift, multiplier), 128 = 1.0x, as ST's To_Shift_Multiplier. */
function shiftMultiplier(gain: number): [number, number] {
  let val = Math.floor(gain * 128);
  if (val < 1) val = 1;
  let shift = 0;
  while (val >> shift > 255 && shift < 7) shift++;
  return [shift, Math.min(255, Math.max(0, val >> shift))];
}

export function buildIspPacket(options: {
  gainR: number;
  gainG: number;
  gainB: number;
  black: number;
  sharp: number;
  gamma: boolean;
  ccm: number[];
}): Uint8Array {
  const [rs, rm] = shiftMultiplier(options.gainR);
  const [gs, gm] = shiftMultiplier(options.gainG);
  const [bs, bm] = shiftMultiplier(options.gainB);

  const buf = new ArrayBuffer(32);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x30505349, true); // 'ISP0'
  dv.setUint8(4, rs);
  dv.setUint8(5, rm);
  dv.setUint8(6, gs);
  dv.setUint8(7, gm);
  dv.setUint8(8, bs);
  dv.setUint8(9, bm);
  dv.setUint8(10, Math.min(255, Math.max(0, Math.round(options.black))));
  dv.setUint8(11, Math.min(7, Math.max(0, Math.round(options.sharp))));
  dv.setUint8(12, options.gamma ? 0x01 : 0x00);
  dv.setUint8(13, 0);
  for (let i = 0; i < 9; i++) {
    dv.setInt16(14 + i * 2, options.ccm[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

// Camera capture controls: 'CAM0'

/** META_CAM_CAPS bits; mirror ImageSensor::N6_CAM_CAP_*. */
export const kCamCapExposure = 0x01;
export const kCamCapGain = 0x02;
export const kCamCapAwb = 0x04;
export const kCamCapAutofocus = 0x08;

/** 'CAM0' flag bits; mirror N6_CAM0_FLAG_*. */
export const kFlagAutoExposure = 0x01;
export const kFlagAutoGain = 0x02;
export const kFlagAutoAwb = 0x04;

/** 'CAM0' apply-mask bits; mirror N6_CAM0_APPLY_*. */
export const kApplyAutoExposure = 0x01;
export const kApplyAutoGain = 0x02;
export const kApplyAutoAwb = 0x04;
export const kApplyExposureUs = 0x08;

/** `applyMask` selects the fields the device applies. */
export function buildCameraControlPacket(options: {
  flags: number;
  applyMask: number;
  exposureUs?: number;
  gainX256?: number;
}): Uint8Array {
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x304d4143, true); // 'CAM0'
  dv.setUint8(4, options.flags & 0xff);
  dv.setUint32(5, options.exposureUs ?? 0, true);
  dv.setUint16(9, (options.gainX256 ?? 256) & 0xffff, true);
  dv.setUint8(11, options.applyMask & 0xff);
  return new Uint8Array(buf);
}

// Evidence subscription: 'SUB0'

/** Evidence classes; mirror N6_EVIDENCE_*. */
export const kEvidenceCrop = 1 << 0;

/** The board drops a subscription after 3 s; callers renew it each second. Mask 0 unsubscribes. */
export function buildEvidenceSubscriptionPacket(mask: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x30425553, true); // 'SUB0'
  dv.setUint32(4, mask >>> 0, true);
  return new Uint8Array(buf);
}

// Stored WiFi settings: 'ASR0', 'AST1', 'AST2'

/** Asset-store record type of the WiFi settings, N6_ASSET_REC_WIFI. */
export const kAssetRecordWifi = 2;

/** WifiSecurity values from the core's MayaW476.h. */
export const kWifiWpa2 = 3;
export const kWifiWpa3 = 5;
export const kWifiWpa2Wpa3 = 6;

/** The only ones core 0.1.3 stores, for joining and hosting alike; it refuses 0, 1, 2 and 4. */
export const kWifiSecurities = [kWifiWpa2, kWifiWpa2Wpa3, kWifiWpa3];

export type WifiMode = "join" | "host";

export interface WifiSettings {
  mode: WifiMode;
  ssid: string;
  /** Empty when hosting: the board uses its own password. */
  passphrase: string;
  security: number;
  /** Hosting only: 2.4 GHz channel 1 to 11. */
  channel: number;
  /** For DHCP and mDNS; empty for the board's default. */
  hostname: string;
  /** Proved by a host before it gets the stream; empty for none. */
  linkKey: string;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Why these settings cannot be stored, or null when they can. */
export function checkWifiSettings(s: WifiSettings): string | null {
  const ssid = utf8Length(s.ssid);
  if (ssid < 1 || ssid > 32) return "A network name is 1 to 32 bytes.";
  if (!kWifiSecurities.includes(s.security)) return "Only WPA2 and WPA3 networks are supported.";
  // The board checks only the length, so the rest is checked here.
  const password = s.passphrase;
  if (password === "") {
    if (s.mode === "join") return "Joining a network needs its password.";
  } else if (/^[0-9A-Fa-f]{64}$/.test(password)) {
    if (s.security !== kWifiWpa2) return "A 64-digit hex key works with WPA2 only.";
  } else if (password.length < 8 || password.length > 63) {
    return "A password is 8 to 63 characters, or 64 hex digits with WPA2.";
  } else if (!/^[ -~]*$/.test(password)) {
    return "A password is plain ASCII: letters, digits, spaces and symbols.";
  }
  if (s.hostname && !/^[A-Za-z0-9-]{1,32}$/.test(s.hostname)) {
    return "A hostname is up to 32 letters, digits and hyphens.";
  }
  const key = utf8Length(s.linkKey);
  if (s.linkKey && (key < 8 || key > 64))
    return "A link key is 8 to 64 bytes: one per ASCII character, more for others.";
  return null;
}

/** The record WiFi.begin() reads: TLVs of u8 tag, u8 length, value; tags are N6_WIFI_TLV_*. */
export function buildWifiRecord(s: WifiSettings): Uint8Array {
  const text = new TextEncoder();
  const out: number[] = [];
  const tlv = (tag: number, value: ArrayLike<number>) =>
    out.push(tag, value.length, ...Array.from(value));
  tlv(1, [s.mode === "host" ? 2 : 1]);
  tlv(2, text.encode(s.ssid));
  // No password when hosting: the board uses its own.
  if (s.passphrase) tlv(3, text.encode(s.passphrase));
  tlv(4, [s.security]);
  if (s.mode === "host") tlv(5, [s.channel]);
  if (s.hostname) tlv(6, text.encode(s.hostname));
  if (s.linkKey) tlv(7, text.encode(s.linkKey));
  return new Uint8Array(out);
}

/** zlib CRC-32, which the board checks a record with. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 'ASR0' with length, CRC and record type, the payload in 'AST1' chunks of at most 48 bytes,
 * then 'AST2', which restarts the board so its bootloader writes the record.
 * An empty payload removes the record. The board ignores these over a network.
 */
export function buildRecordCommands(type: number, payload: Uint8Array): Uint8Array[] {
  const begin = new DataView(new ArrayBuffer(16));
  begin.setUint32(0, 0x30525341, true); // 'ASR0'
  begin.setUint32(4, payload.length, true);
  begin.setUint32(8, crc32(payload), true);
  begin.setUint8(12, type);
  const commands = [new Uint8Array(begin.buffer)];
  for (let offset = 0; offset < payload.length; offset += 48) {
    const chunk = payload.subarray(offset, offset + 48);
    const command = new Uint8Array(7 + chunk.length);
    const head = new DataView(command.buffer);
    head.setUint32(0, 0x31545341, true); // 'AST1'
    head.setUint16(4, offset, true);
    head.setUint8(6, chunk.length);
    command.set(chunk, 7);
    commands.push(command);
  }
  commands.push(new Uint8Array([0x41, 0x53, 0x54, 0x32])); // 'AST2'
  return commands;
}
