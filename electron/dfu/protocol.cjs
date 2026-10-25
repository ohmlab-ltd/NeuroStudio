// DFU protocol for the Neuro N6 FSBL. The bytes must match the Arduino core's uploader.

/** Frame: STX 0x02 | payload length u16 LE | payload | XOR of payload | ETX 0x03 */
const DFU_STX = 0x02;
const DFU_ETX = 0x03;

/** Commands carry offsets from FLASH_BASE. */
const FLASH_BASE = 0x90000000;
const FLASH_END = 0x91ffffff;
const XSPI_SECTOR_SIZE = 0x1000;
/** The FSBL owns the first 1 MB of flash; writing in it overwrites the bootloader. */
const FSBL_REGION_SIZE = 0x00100000;
const DFU_CHUNK_SIZE = 4096;
const DFU_BAUD = 115200;

function makePacket(payload) {
  const length = payload.length;
  if (length > 0xffff) {
    throw new RangeError(`payload too large for LEN16: ${length}`);
  }
  const out = Buffer.alloc(length + 5);
  out[0] = DFU_STX;
  out[1] = length & 0xff;
  out[2] = (length >> 8) & 0xff;
  let checksum = 0;
  for (let i = 0; i < length; i++) {
    const b = payload[i] & 0xff;
    out[3 + i] = b;
    checksum ^= b;
  }
  out[3 + length] = checksum;
  out[4 + length] = DFU_ETX;
  return out;
}

function addrToOffset(addr) {
  return addr >= FLASH_BASE ? addr - FLASH_BASE : addr;
}

function eraseSizeFor(imageLength) {
  return Math.ceil(imageLength / XSPI_SECTOR_SIZE) * XSPI_SECTOR_SIZE;
}

const ascii = (text) => Buffer.from(text, "latin1");

function u32le(value) {
  const v = value >>> 0;
  return Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

// Command payloads. 'DFU START' has a space.
const cmdInfo = () => makePacket(ascii("DFU_INFO"));
const cmdStart = (offset) => makePacket(Buffer.concat([ascii("DFU START"), u32le(offset)]));
const cmdErase = (eraseSize) => makePacket(Buffer.concat([ascii("DFU_ERASE"), u32le(eraseSize)]));
const cmdData = () => makePacket(ascii("DFU_DATA"));
const cmdNext = () => makePacket(ascii("DFU_NEXT"));
const cmdEnd = () => makePacket(ascii("DFU_END"));
const cmdReset = () => makePacket(ascii("DFU_RESET"));
const cmdCrc32 = (offset, length) =>
  makePacket(Buffer.concat([ascii("DFU_CRC32"), u32le(offset), u32le(length)]));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib.crc32, as the FSBL reports for DFU_CRC32. */
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * An `N6INFO 2 CRC32 MULTI OTA-AB UID <hex>` line, or null. UID takes the next token;
 * every other token is a capability.
 */
function parseN6Info(line) {
  if (!line.startsWith("N6INFO")) return null;
  const parts = line.split(/\s+/);
  const hasVersion = parts.length >= 2 && /^[+-]?\d+$/.test(parts[1]);
  const version = hasVersion ? Number(parts[1]) : 1;
  const caps = new Set();
  let serial = null;
  // With no version, the token after N6INFO is already a capability.
  const tokens = parts.slice(hasVersion ? 2 : 1);
  for (let i = 0; i < tokens.length;) {
    if (tokens[i] === "UID" && i + 1 < tokens.length) {
      serial = tokens[i + 1];
      i += 2;
    } else {
      caps.add(tokens[i]);
      i += 1;
    }
  }
  return {
    version,
    caps,
    serial,
    supportsCrc: caps.has("CRC32"),
    supportsMulti: caps.has("MULTI"),
    supportsOtaAb: caps.has("OTA-AB"),
  };
}

/** The CRC from a DFU_CRC32 reply's `CRC32 0x1234ABCD` line, or null. */
function parseCrc32Reply(lines) {
  for (const line of lines) {
    if (!line.startsWith("CRC32")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) return null;
    const digits = parts[1].replace(/^0x/i, "");
    return /^[0-9a-fA-F]+$/.test(digits) ? Number.parseInt(digits, 16) : null;
  }
  return null;
}

module.exports = {
  DFU_STX,
  DFU_ETX,
  FLASH_BASE,
  FLASH_END,
  XSPI_SECTOR_SIZE,
  FSBL_REGION_SIZE,
  DFU_CHUNK_SIZE,
  DFU_BAUD,
  makePacket,
  addrToOffset,
  eraseSizeFor,
  cmdInfo,
  cmdStart,
  cmdErase,
  cmdData,
  cmdNext,
  cmdEnd,
  cmdReset,
  cmdCrc32,
  crc32,
  parseN6Info,
  parseCrc32Reply,
};
