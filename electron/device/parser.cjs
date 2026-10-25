// Vendor frame parser. A frame is a 20-byte header of u32 LE magic, frame_id, meta_len,
// payload_len and flags, then meta_len bytes of TLV metadata and payload_len bytes of JPEG.

const VND_MAGIC = 0x30564e44;
const HEADER_LEN = 20;
const MAX_PENDING = 8 * 1024 * 1024;

// TLV tags that steer routing or become their own IPC event. The renderer decodes the rest.
const TAG_TOF_LEGACY = 0x14;
const TAG_TOF_FRAME = 0x15;
const TAG_TOF_STATUS = 0x16;
const TAG_DEBUG_TEXT = 0x17;
const TAG_MAG_FRAME = 0x1a;
const TAG_IMU_FRAME = 0x1b;
const TAG_BOARD_IPV4 = 0x20;
const TAG_BOARD_SOFTAP = 0x24;
const TAG_THERMAL_FRAME = 0x30;
const TAG_VD66_ISP_ENABLED = 0x40;
const TAG_AUDIO_PCM = 0x50;
const TAG_AUDIO_CLASS = 0x51;
const TAG_AUDIO_MEL = 0x52;
const TAG_AUDIO_LABELS = 0x53;
const TAG_IMAGE_CLASS = 0x54;
const TAG_VISION_ID = 0x60;
const TAG_QR_FRAME = 0x61;
const TAG_BARCODE_FRAME = 0x62;
const TAG_BLOB_FRAME = 0x63;
const TAG_CAM_CAPS = 0x64;
const TAG_TUNE_DESC = 0x65;
const TAG_APRILTAG = 0x66;
const TAG_EVENT = 0x67;
const TAG_EVIDENCE_CROP = 0x70;
const TAG_DEBUG_LOG = 0x71;

const TAG_ISEG_CLASS_STR = 10;
const TAG_ISEG_MASK = 11;
const TAG_WARNING = 18;

class VendorFramedParser {
  constructor() {
    this._buf = Buffer.allocUnsafe(512 * 1024);
    this._head = 0; // first unparsed byte
    this._len = 0; // one past the last valid byte
  }

  reset() {
    this._head = 0;
    this._len = 0;
  }

  feed(data) {
    if (!data || data.length === 0) return;
    const pending = this._len - this._head;

    // Compact when the consumed prefix dominates or space is needed.
    if (
      this._head > 0 &&
      (this._len + data.length > this._buf.length || this._head >= this._buf.length >> 1)
    ) {
      this._buf.copy(this._buf, 0, this._head, this._len);
      this._head = 0;
      this._len = pending;
    }

    if (this._len + data.length > this._buf.length) {
      let cap = this._buf.length;
      while (cap < this._len + data.length) cap <<= 1;
      const nb = Buffer.allocUnsafe(cap);
      this._buf.copy(nb, 0, 0, this._len);
      this._buf = nb;
    }

    data.copy(this._buf, this._len);
    this._len += data.length;

    // No frame in MAX_PENDING bytes: keep a tail so a header straddling the cut can resync.
    if (this._len - this._head > MAX_PENDING) {
      const keep = 64;
      this._buf.copy(this._buf, 0, this._len - keep, this._len);
      this._head = 0;
      this._len = keep;
    }
  }

  nextPacket() {
    for (;;) {
      if (this._len - this._head < HEADER_LEN) return null;

      const idx = this._indexOfMagic();
      if (idx < 0) {
        // No magic: the last 3 bytes may start one that straddles the next chunk.
        if (this._len - this._head > 3) this._head = this._len - 3;
        return null;
      }
      this._head = idx;
      if (this._len - this._head < HEADER_LEN) return null;

      const frameId = this._buf.readUInt32LE(this._head + 4);
      const metaLen = this._buf.readUInt32LE(this._head + 8);
      const payLen = this._buf.readUInt32LE(this._head + 12);

      if (metaLen > 2 * 1024 * 1024) {
        this._head++; // corrupt header: resync one byte on
        continue;
      }
      // payLen 0 is legal: meta-only frames carry TLVs and no JPEG.
      if (payLen > 4 * 1024 * 1024) {
        this._head++;
        continue;
      }
      if (metaLen === 0 && payLen === 0) {
        this._head++; // garbage frame, nothing to deliver
        continue;
      }

      const total = HEADER_LEN + metaLen + payLen;
      if (this._len - this._head < total) return null;

      const metaStart = this._head + HEADER_LEN;
      const payStart = metaStart + metaLen;
      // Copies, not views: later feed() calls overwrite this buffer.
      const meta = Buffer.from(this._buf.subarray(metaStart, metaStart + metaLen));
      const jpeg = Buffer.from(this._buf.subarray(payStart, payStart + payLen));

      this._head += total;

      return { frameId, metaLen, jpegLen: payLen, meta, jpeg };
    }
  }

  _indexOfMagic() {
    const b0 = VND_MAGIC & 0xff;
    const b1 = (VND_MAGIC >> 8) & 0xff;
    const b2 = (VND_MAGIC >> 16) & 0xff;
    const b3 = (VND_MAGIC >> 24) & 0xff;
    const buf = this._buf;
    const end = this._len - 3;
    for (let i = this._head; i < end; i++) {
      if (buf[i] === b0 && buf[i + 1] === b1 && buf[i + 2] === b2 && buf[i + 3] === b3) {
        return i;
      }
    }
    return -1;
  }
}

// TLV walkers. A malformed record ends the walk rather than throwing.

function metaHasTlvType(meta, type) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valEnd = i + 3 + len;
    if (valEnd > meta.length) return false;
    if (t === type) return true;
    i = valEnd;
  }
  return false;
}

/** A thermal frame TLV longer than its 8-byte header; a header-only 0x30 is an announce. */
function metaHasThermalFrame(meta) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valEnd = i + 3 + len;
    if (valEnd > meta.length) return false;
    if (t === TAG_THERMAL_FRAME && len > 8) return true;
    i = valEnd;
  }
  return false;
}

/** TLVs the renderer must see from every packet that carries them. */
const PER_PACKET_TAGS = new Set([
  TAG_THERMAL_FRAME,
  TAG_MAG_FRAME,
  TAG_IMU_FRAME,
  TAG_TOF_LEGACY,
  TAG_TOF_FRAME,
  TAG_TOF_STATUS,
  TAG_DEBUG_TEXT,
  TAG_DEBUG_LOG,
  TAG_AUDIO_CLASS,
  TAG_AUDIO_MEL,
  TAG_AUDIO_LABELS,
  TAG_IMAGE_CLASS,
  TAG_EVENT,
  TAG_VISION_ID,
  TAG_QR_FRAME,
  TAG_BARCODE_FRAME,
  TAG_BLOB_FRAME,
  TAG_APRILTAG,
  TAG_EVIDENCE_CROP,
]);

function metaHasPerPacketTlv(meta) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valEnd = i + 3 + len;
    if (valEnd > meta.length) return false;
    if (PER_PACKET_TAGS.has(t)) return true;
    i = valEnd;
  }
  return false;
}

/** First value byte of the first TLV of `type`, or null. */
function findMetaFirstByte(meta, type) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valStart = i + 3;
    const valEnd = valStart + len;
    if (valEnd > meta.length) return null;
    if (t === type && len >= 1) return meta[valStart];
    i = valEnd;
  }
  return null;
}

/** A copy of the value of the first TLV of `type`, or null. */
function findMetaTlvValue(meta, type) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valStart = i + 3;
    const valEnd = valStart + len;
    if (valEnd > meta.length) return null;
    if (t === type) return Buffer.from(meta.subarray(valStart, valEnd));
    i = valEnd;
  }
  return null;
}

/** META_BOARD_IPV4 0x20: 4 address bytes in network order, then a u32 LE port. */
function findMetaIpv4(meta) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const type = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valStart = i + 3;
    const valEnd = valStart + len;
    if (valEnd > meta.length) return null;
    if (type === TAG_BOARD_IPV4 && len === 8) {
      const host = `${meta[valStart]}.${meta[valStart + 1]}.${meta[valStart + 2]}.${meta[valStart + 3]}`;
      const port = meta.readUInt32LE(valStart + 4);
      if (port < 1 || port > 65535 || host === "0.0.0.0") return null;
      return { host, port };
    }
    i = valEnd;
  }
  return null;
}

/**
 * META_AUDIO_PCM 0x50: u32 sample_rate LE, u8 channels, u8 bits,
 * u16 sample_count LE, then sample_count x int16 LE PCM.
 */
function findAudioPcm(meta) {
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    const valStart = i + 3;
    const valEnd = valStart + len;
    if (valEnd > meta.length) return null;
    if (t === TAG_AUDIO_PCM && len >= 8) {
      const rate = meta.readUInt32LE(valStart);
      const channels = meta[valStart + 4];
      const pcm = Buffer.from(meta.subarray(valStart + 8, valEnd));
      return { rate, channels, pcm };
    }
    i = valEnd;
  }
  return null;
}

const utf8 = new TextDecoder("utf-8");

// C0 and C1 control characters and DEL, except tab, LF and CR.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * META_BOARD_SOFTAP 0x24, the network the board hosts: u8 ssid_len (1-32), the SSID, u8
 * pass_len (8-64), the passphrase. Anything else is null. Neither is altered: the user
 * picks the SSID and pastes the passphrase.
 */
function findMetaSoftAp(meta) {
  const value = findMetaTlvValue(meta, TAG_BOARD_SOFTAP);
  if (!value || value.length < 1) return null;
  const ssidLen = value[0];
  if (ssidLen < 1 || ssidLen > 32 || value.length < 2 + ssidLen) return null;
  const passLen = value[1 + ssidLen];
  if (passLen < 8 || passLen > 64 || value.length !== 2 + ssidLen + passLen) return null;
  return {
    ssid: utf8.decode(value.subarray(1, 1 + ssidLen)),
    password: utf8.decode(value.subarray(2 + ssidLen)),
  };
}

/** Matches decodeTlvString in src/device/tlv.ts. */
function decodeTlvString(bytes) {
  const nul = bytes.indexOf(0);
  return utf8.decode(nul < 0 ? bytes : bytes.subarray(0, nul)).replace(CONTROL_CHARS, "");
}

/** Instance-segmentation class strings, TLV 10: u8 obj_id, then the name. */
function extractOverlayCategories(meta) {
  if (!meta.length) return [];
  const cats = [];
  const seen = new Set();
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    i += 3;
    if (i + len > meta.length) break;
    if (t === TAG_ISEG_CLASS_STR && len >= 2) {
      const trimmed = decodeTlvString(meta.subarray(i + 1, i + len)).trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        cats.push(trimmed);
      }
    }
    i += len;
  }
  return cats;
}

function detectOverlayPresence(meta) {
  if (!meta.length) return { hasBoxLabels: false, hasShading: false };
  let hasLabels = false;
  let hasMask = false;
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    i += 3;
    if (i + len > meta.length) break;
    if (t === TAG_ISEG_CLASS_STR) hasLabels = true;
    if (t === TAG_ISEG_MASK) hasMask = true;
    if (hasLabels && hasMask) break;
    i += len;
  }
  return { hasBoxLabels: hasLabels, hasShading: hasMask };
}

/** The last non-empty warning, TLV 18, as the renderer's parseOverlayMeta picks it, or null. */
function extractWarning(meta) {
  if (!meta.length) return null;
  let warning = null;
  let i = 0;
  while (i + 3 <= meta.length) {
    const t = meta[i];
    const len = meta[i + 1] | (meta[i + 2] << 8);
    i += 3;
    if (i + len > meta.length) break;
    if (t === TAG_WARNING) {
      const text = decodeTlvString(meta.subarray(i, i + len)).trim();
      if (text) warning = text;
    }
    i += len;
  }
  return warning;
}

// JPEG validation and dimensions

function jpegWidthHeight(jpeg) {
  if (jpeg.length < 4) return null;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;

  let i = 2;
  while (i + 3 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < jpeg.length && jpeg[i] === 0xff) i++;
    if (i >= jpeg.length) break;

    const marker = jpeg[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (i + 1 >= jpeg.length) break;
    const segLen = (jpeg[i] << 8) | jpeg[i + 1];
    i += 2;
    if (segLen < 2) return null;

    const segStart = i;
    const segEnd = segStart + (segLen - 2);
    if (segEnd > jpeg.length) return null;

    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSOF) {
      if (segStart + 5 <= segEnd) {
        const height = (jpeg[segStart + 1] << 8) | jpeg[segStart + 2];
        const width = (jpeg[segStart + 3] << 8) | jpeg[segStart + 4];
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    }
    i = segEnd;
  }
  return null;
}

function looksLikeJpeg(jpeg) {
  if (jpeg.length < 200) return { ok: false, width: 0, height: 0 };
  if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) return { ok: false, width: 0, height: 0 };
  const n = jpeg.length;
  if (!(jpeg[n - 2] === 0xff && jpeg[n - 1] === 0xd9)) return { ok: false, width: 0, height: 0 };
  const dims = jpegWidthHeight(jpeg);
  if (!dims) return { ok: true, width: 0, height: 0 };
  return { ok: true, width: dims.width, height: dims.height };
}

module.exports = {
  VendorFramedParser,
  VND_MAGIC,
  HEADER_LEN,
  TAG_TOF_LEGACY,
  TAG_TOF_FRAME,
  TAG_TOF_STATUS,
  TAG_DEBUG_TEXT,
  TAG_MAG_FRAME,
  TAG_IMU_FRAME,
  TAG_BOARD_IPV4,
  TAG_THERMAL_FRAME,
  TAG_VD66_ISP_ENABLED,
  TAG_AUDIO_PCM,
  TAG_AUDIO_CLASS,
  TAG_AUDIO_MEL,
  TAG_AUDIO_LABELS,
  TAG_CAM_CAPS,
  TAG_TUNE_DESC,
  TAG_EVENT,
  metaHasTlvType,
  metaHasThermalFrame,
  metaHasPerPacketTlv,
  findMetaFirstByte,
  findMetaTlvValue,
  findMetaIpv4,
  findMetaSoftAp,
  findAudioPcm,
  decodeTlvString,
  extractOverlayCategories,
  detectOverlayPresence,
  extractWarning,
  jpegWidthHeight,
  looksLikeJpeg,
};
