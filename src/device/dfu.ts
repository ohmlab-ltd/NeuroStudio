// Bootloader dialog rules.
// The flash map repeats electron/dfu/protocol.cjs, which the renderer cannot load.

import type { DfuPort } from "../vite-env";

export const FLASH_BASE = 0x90000000;
export const FLASH_END = 0x91ffffff;
export const XSPI_SECTOR_SIZE = 0x1000;
/** The FSBL owns the first 1 MB; writing anywhere in it overwrites the bootloader. */
export const FSBL_REGION_SIZE = 0x00100000;

/** Board silence mid-write after which a flash may be stopped. Main enforces the same value. */
export const DFU_STALL_MS = 30000;

const FSBL_WARNING =
  "Replacing the bootloader. If this is interrupted the board can only be " +
  "recovered with BOOT1 + SWD. Keep it powered and plugged in.";

export type DfuTargetId = "application" | "slotB" | "bootloader" | "custom";

export interface DfuTarget {
  id: DfuTargetId;
  label: string;
  /** Offset from FLASH_BASE; null for a custom address. */
  offset: number | null;
  /** Shown under the picker and confirmed before flashing. */
  warning?: string;
}

/** Offsets follow the Arduino core's flash layout. */
export const DFU_TARGETS: readonly DfuTarget[] = [
  { id: "application", label: "Application", offset: 0x00100000 },
  { id: "slotB", label: "Application slot B", offset: 0x01c80000 },
  {
    id: "bootloader",
    label: "Bootloader (FSBL)",
    offset: 0x00000000,
    warning: FSBL_WARNING,
  },
  { id: "custom", label: "Custom address", offset: null },
];

export const DEFAULT_CUSTOM_ADDRESS = "0x90100000";

export function dfuTarget(id: DfuTargetId): DfuTarget {
  return DFU_TARGETS.find((t) => t.id === id) ?? DFU_TARGETS[0];
}

export const formatAddress = (value: number): string => `0x${value.toString(16).toUpperCase()}`;

export const formatCrc = (crc: number): string =>
  `0x${crc.toString(16).toUpperCase().padStart(8, "0")}`;

export const ADDRESS_ERROR = `not a valid address between ${formatAddress(FLASH_BASE)} and ${formatAddress(FLASH_END)}`;

export const filterAddressInput = (text: string): string => text.replace(/[^0-9a-fA-FxX]/g, "");

export const ADDRESS_PREFIX_ERROR = "type the address in hex with a 0x prefix, e.g. 0x90100000";

export const ADDRESS_ALIGN_ERROR = `must be on a ${XSPI_SECTOR_SIZE / 1024} KB sector boundary (end in 000)`;

/** Offset from FLASH_BASE, or why the text is refused. A value below the base is an offset. */
function checkFlashAddress(text: string): { offset: number } | { error: string } {
  const t = text.trim();
  if (!/^0x/i.test(t)) return { error: t === "" ? ADDRESS_ERROR : ADDRESS_PREFIX_ERROR };
  const digits = t.slice(2);
  if (!/^[0-9a-f]+$/i.test(digits)) return { error: ADDRESS_ERROR };
  const value = Number.parseInt(digits, 16);
  const offset = value >= FLASH_BASE ? value - FLASH_BASE : value;
  if (FLASH_BASE + offset > FLASH_END) return { error: ADDRESS_ERROR };
  if (offset % XSPI_SECTOR_SIZE !== 0) return { error: ADDRESS_ALIGN_ERROR };
  return { offset };
}

export function parseFlashAddress(text: string): number | null {
  const checked = checkFlashAddress(text);
  return "offset" in checked ? checked.offset : null;
}

export function addressError(text: string): string | null {
  const checked = checkFlashAddress(text);
  return "error" in checked ? checked.error : null;
}

/** Only the start matters: the FSBL region starts at offset 0. */
export const overlapsFsbl = (offset: number | null): boolean =>
  offset !== null && offset < FSBL_REGION_SIZE;

/** The warning to show and confirm before flashing, or null. */
export function flashWarning(target: DfuTarget, offset: number | null): string | null {
  if (target.warning) return target.warning;
  return overlapsFsbl(offset)
    ? `This address is inside the bootloader (FSBL) region. ${FSBL_WARNING}`
    : null;
}

export function stopWarning(offset: number | null, quietMs: number): string {
  const seconds = Math.round(quietMs / 1000);
  return (
    `Nothing has come back from the board for ${seconds} s. Erasing a large image can ` +
    "take a few minutes. Stopping now leaves the image partly written, so the board " +
    "will not run it until it is flashed again." +
    (overlapsFsbl(offset)
      ? " This is the bootloader region: if the board loses power before it is " +
        "flashed again, it can only be recovered with BOOT1 + SWD."
      : "")
  );
}

export function targetOffset(target: DfuTarget, customAddress: string): number | null {
  return target.offset ?? parseFlashAddress(customAddress);
}

export function fitsInFlash(size: number | null, offset: number | null): boolean {
  if (size === null || offset === null) return false;
  return FLASH_BASE + offset + size - 1 <= FLASH_END;
}

export function canFlash({
  busy,
  size,
  offset,
}: {
  busy: boolean;
  size: number | null;
  offset: number | null;
}): boolean {
  return !busy && size !== null && size > 0 && offset !== null && fitsInFlash(size, offset);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function flashRate(written: number, startedAt: number | null, now: number): string {
  if (startedAt === null || written === 0) return "";
  const secs = (now - startedAt) / 1000;
  if (secs <= 0) return "";
  return `${(written / secs / 1024).toFixed(0)} KB/s`;
}

export function portLabel(port: DfuPort): string {
  const kind = port.isBootloaderFamily ? "bootloader" : port.isApp ? "app" : null;
  const parts = [kind, port.serial ? `serial ${port.serial}` : null].filter(Boolean);
  return parts.length ? `${port.name} (${parts.join(", ")})` : port.name;
}
