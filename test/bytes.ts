// Little-endian byte builders for hand-made TLV test buffers.

/** TLV: u8 type, u16 LE length, value. */
export const tlv = (type: number, value: number[]): number[] => [
  type,
  value.length & 0xff,
  (value.length >> 8) & 0xff,
  ...value,
];

export const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

/** Two's complement. */
export const i16 = (v: number): number[] => u16(v & 0xffff);

export const u32 = (v: number): number[] => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff,
];

export const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export const bytes = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat());
