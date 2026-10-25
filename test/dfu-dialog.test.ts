// The bootloader dialog: no flash until a file and a valid in-range address are chosen.

import { describe, expect, it } from "vitest";
import * as protocol from "../electron/dfu/protocol.cjs";
import {
  ADDRESS_ERROR,
  DFU_TARGETS,
  FLASH_BASE,
  FLASH_END,
  FSBL_REGION_SIZE,
  XSPI_SECTOR_SIZE,
  addressError,
  canFlash,
  dfuTarget,
  filterAddressInput,
  fitsInFlash,
  flashRate,
  formatBytes,
  formatCrc,
  parseFlashAddress,
  portLabel,
  targetOffset,
} from "../src/device/dfu";

const application = dfuTarget("application");

describe("bootloader dialog", () => {
  it("keeps Flash disabled until a file is chosen", () => {
    const offset = targetOffset(application, "");
    expect(canFlash({ busy: false, size: null, offset })).toBe(false);
    expect(canFlash({ busy: false, size: 0, offset })).toBe(false);
    expect(canFlash({ busy: false, size: 105 * 1024, offset })).toBe(true);
    expect(canFlash({ busy: true, size: 105 * 1024, offset })).toBe(false);
  });

  it("puts the irreversibility warning on the FSBL target only", () => {
    const fsbl = dfuTarget("bootloader");
    expect(fsbl.label).toBe("Bootloader (FSBL)");
    expect(fsbl.offset).toBe(0);
    expect(fsbl.warning).toContain("BOOT1 + SWD");
    expect(DFU_TARGETS.filter((t) => t.warning).map((t) => t.id)).toEqual(["bootloader"]);
  });

  it("rejects a custom address outside flash", () => {
    const custom = dfuTarget("custom");
    expect(addressError("0x20000000")).toContain("not a valid address");
    expect(targetOffset(custom, "0x20000000")).toBeNull();
    expect(canFlash({ busy: false, size: 1024, offset: targetOffset(custom, "0x20000000") })).toBe(
      false,
    );

    expect(addressError("0x90100000")).toBeNull();
    expect(targetOffset(custom, "0x90100000")).toBe(0x100000);
  });

  it("parses custom addresses as 0x hex on a sector boundary", () => {
    expect(parseFlashAddress("0x90100000")).toBe(0x100000);
    expect(parseFlashAddress(" 0X91C80000 ")).toBe(0x01c80000);
    expect(parseFlashAddress("0x100000")).toBe(0x100000); // already an offset
    expect(parseFlashAddress("2415919104")).toBeNull(); // bare digits are ambiguous
    expect(parseFlashAddress("0x91FFF000")).toBe(0x01fff000);
    expect(parseFlashAddress("0x91FFFFFF")).toBeNull(); // not on a sector boundary
    expect(parseFlashAddress("0x92000000")).toBeNull();
    expect(parseFlashAddress("0x")).toBeNull();
    expect(parseFlashAddress("")).toBeNull();
    expect(parseFlashAddress("12ab")).toBeNull();
    expect(ADDRESS_ERROR).toBe("not a valid address between 0x90000000 and 0x91FFFFFF");
  });

  it("only lets hex digits and x into the address field", () => {
    expect(filterAddressInput("0x9010 00zz-")).toBe("0x901000");
  });

  it("checks the image fits at the chosen address", () => {
    const slotB = dfuTarget("slotB").offset;
    expect(slotB).toBe(0x01c80000);
    expect(fitsInFlash(FLASH_END - FLASH_BASE - slotB! + 1, slotB)).toBe(true);
    expect(fitsInFlash(FLASH_END - FLASH_BASE - slotB! + 2, slotB)).toBe(false);
    expect(fitsInFlash(1024, null)).toBe(false);
  });

  it("shares the flash map with the protocol module", () => {
    expect(FLASH_BASE).toBe(protocol.FLASH_BASE);
    expect(FLASH_END).toBe(protocol.FLASH_END);
    expect(XSPI_SECTOR_SIZE).toBe(protocol.XSPI_SECTOR_SIZE);
    expect(FSBL_REGION_SIZE).toBe(protocol.FSBL_REGION_SIZE);
    expect(dfuTarget("application").offset).toBe(protocol.FSBL_REGION_SIZE);
  });

  it("formats sizes, CRCs, rates and ports", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(105 * 1024)).toBe("105.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
    expect(formatCrc(0x3610a686)).toBe("0x3610A686");
    expect(formatCrc(0x1f)).toBe("0x0000001F");
    expect(flashRate(0, 0, 1000)).toBe("");
    expect(flashRate(2048, null, 1000)).toBe("");
    expect(flashRate(200 * 1024, 0, 2000)).toBe("100 KB/s");

    const port = { name: "COM8", vid: 0xcafe, pid: 0x4013, serial: null, description: null };
    expect(portLabel({ ...port, isApp: true, isBootloaderFamily: true })).toBe("COM8 (bootloader)");
    expect(portLabel({ ...port, isApp: true, isBootloaderFamily: false })).toBe("COM8 (app)");
    expect(portLabel({ ...port, isApp: false, isBootloaderFamily: false })).toBe("COM8");
  });
});
