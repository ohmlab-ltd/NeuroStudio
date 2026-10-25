// DFU protocol and session. The golden vectors are the reference uploader's output.

import { describe, expect, it } from "vitest";
import {
  FLASH_BASE,
  XSPI_SECTOR_SIZE,
  addrToOffset,
  cmdCrc32,
  cmdData,
  cmdEnd,
  cmdErase,
  cmdInfo,
  cmdNext,
  cmdReset,
  cmdStart,
  crc32,
  eraseSizeFor,
  makePacket,
  parseCrc32Reply,
  parseN6Info,
} from "../electron/dfu/protocol.cjs";
import {
  DfuSession,
  describePorts,
  findPortIn,
  APP_IDENTITIES,
  BOOTLOADER_IDENTITIES,
  isAppPort,
  isBootloaderFamily,
  programImage,
  runFlash,
  toPortInfo,
} from "../electron/dfu/session.cjs";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const ascii = (s: string) => Buffer.from(s, "latin1");

const golden = {
  empty: "0200000003",
  one_byte_00: "020100000003",
  one_byte_FF: "020100ffff03",
  DFU_INFO: "0208004446555f494e464f0603",
  DFU_START_0x100000: "020d00444655205354415254000010002703",
  DFU_ERASE_64k: "020d004446555f4552415345000001004903",
  DFU_DATA: "0208004446555f444154411803",
  DFU_NEXT: "0208004446555f4e4558540f03",
  DFU_END: "0207004446555f454e444703",
  DFU_RESET: "0209004446555f52455345545d03",
  DFU_CRC32: "0211004446555f43524333320000100000800000cb03",
  payload_1234: "021000000102030405060708090a0b0c0d0e0f0003",
  payload_ABC: "0203004142434003",
};

describe("DFU framing", () => {
  it("make_packet matches the Python reference", () => {
    expect(hex(makePacket([]))).toBe(golden.empty);
    expect(hex(makePacket([0x00]))).toBe(golden.one_byte_00);
    expect(hex(makePacket([0xff]))).toBe(golden.one_byte_FF);
    expect(hex(makePacket(Array.from({ length: 16 }, (_, i) => i)))).toBe(golden.payload_1234);
    expect(hex(makePacket(ascii("ABC")))).toBe(golden.payload_ABC);
  });

  it("command builders match the reference byte layouts", () => {
    expect(hex(cmdInfo())).toBe(golden.DFU_INFO);
    expect(hex(cmdStart(0x100000))).toBe(golden.DFU_START_0x100000);
    expect(hex(cmdErase(0x10000))).toBe(golden.DFU_ERASE_64k);
    expect(hex(cmdData())).toBe(golden.DFU_DATA);
    expect(hex(cmdNext())).toBe(golden.DFU_NEXT);
    expect(hex(cmdEnd())).toBe(golden.DFU_END);
    expect(hex(cmdReset())).toBe(golden.DFU_RESET);
    expect(hex(cmdCrc32(0x100000, 0x8000))).toBe(golden.DFU_CRC32);
  });

  it("writes the length little-endian and refuses more than LEN16", () => {
    const packet = makePacket(new Uint8Array(0x1234));
    expect([packet[1], packet[2]]).toEqual([0x34, 0x12]);
    expect(packet.length).toBe(0x1234 + 5);
    expect(() => makePacket(new Uint8Array(0x10000))).toThrow(/too large/);
  });
});

describe("CRC32", () => {
  it("matches zlib.crc32", () => {
    expect(crc32(ascii("123456789"))).toBe(0xcbf43926);
    expect(crc32(ascii("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("flash geometry", () => {
  it("rounds the erase up to a whole sector", () => {
    expect(eraseSizeFor(1)).toBe(XSPI_SECTOR_SIZE);
    expect(eraseSizeFor(XSPI_SECTOR_SIZE)).toBe(XSPI_SECTOR_SIZE);
    expect(eraseSizeFor(XSPI_SECTOR_SIZE + 1)).toBe(2 * XSPI_SECTOR_SIZE);
    expect(eraseSizeFor(80896)).toBe(20 * XSPI_SECTOR_SIZE);
  });

  it("converts addresses to offsets", () => {
    expect(addrToOffset(0x90100000)).toBe(0x100000);
    expect(addrToOffset(0x100000)).toBe(0x100000); // already an offset
    expect(addrToOffset(FLASH_BASE)).toBe(0);
  });
});

describe("reply parsing", () => {
  it("parses N6INFO like probe_info()", () => {
    const i = parseN6Info("N6INFO 2 CRC32 MULTI OTA-AB UID DEADBEEF01");
    expect(i).not.toBeNull();
    expect(i!.version).toBe(2);
    expect(i!.supportsCrc).toBe(true);
    expect(i!.supportsMulti).toBe(true);
    expect(i!.supportsOtaAb).toBe(true);
    expect(i!.serial).toBe("DEADBEEF01");
    expect([...i!.caps]).toEqual(["CRC32", "MULTI", "OTA-AB"]);

    const j = parseN6Info("N6INFO 2 CRC32 MULTI UID ABC");
    expect(j!.supportsOtaAb).toBe(false);
    expect(j!.serial).toBe("ABC");

    // A bare UID has nothing to consume, so it is a capability.
    expect([...parseN6Info("N6INFO 3 UID")!.caps]).toEqual(["UID"]);
    expect(parseN6Info("N6INFO")!.version).toBe(1);
    expect(parseN6Info("N6INFO x")!.version).toBe(1);
    // Without a version, the first token is a capability, not dropped.
    const noVersion = parseN6Info("N6INFO CRC32 MULTI")!;
    expect(noVersion.version).toBe(1);
    expect(noVersion.supportsCrc).toBe(true);
    expect(noVersion.supportsMulti).toBe(true);
    expect(parseN6Info("RESETTING")).toBeNull();
  });

  it("takes the CRC from the first CRC32 line", () => {
    expect(parseCrc32Reply(["busy", "CRC32 0x3610A686"])).toBe(0x3610a686);
    expect(parseCrc32Reply(["CRC32 0X3610A686"])).toBe(0x3610a686);
    expect(parseCrc32Reply(["CRC32 cbf43926"])).toBe(0xcbf43926);
    expect(parseCrc32Reply(["CRC32"])).toBeNull();
    expect(parseCrc32Reply(["CRC32 0xZZ", "CRC32 0x01"])).toBeNull();
    expect(parseCrc32Reply(["N6INFO 2"])).toBeNull();
  });
});

describe("port identification", () => {
  // What serialport lists on Windows for the board's composite CDC interface.
  const windowsApp = {
    path: "COM7",
    vendorId: "1209",
    productId: "8008",
    serialNumber: "6&2c2bc5b9&0&0001",
    pnpId: "USB\\VID_1209&PID_8008&MI_01\\6&2C2BC5B9&0&0001",
    friendlyName: "USB Serial Device (COM7)",
  };

  it("reads VID/PID as hex and drops a bus path posing as a serial", () => {
    expect(toPortInfo(windowsApp)).toEqual({
      name: "COM7",
      vid: 0x1209,
      pid: 0x8008,
      serial: null,
      description: "USB Serial Device (COM7)",
    });
    expect(
      toPortInfo({
        path: "/dev/ttyACM0",
        vendorId: "cafe",
        productId: "4013",
        serialNumber: "N6-01",
      }),
    ).toMatchObject({ vid: 0xcafe, pid: 0x4013, serial: "N6-01" });
    expect(toPortInfo({ path: "COM1" })).toMatchObject({ vid: null, pid: null, serial: null });
  });

  it("tags app and bootloader identities, legacy last", () => {
    const port = (name: string, vid: number | null, pid: number | null) => ({
      name,
      vid,
      pid,
      serial: null,
      description: null,
    });
    const app = port("COM7", 0x1209, 0x8008);
    const boot = port("COM8", 0x1209, 0x8009);
    const legacy = port("COM9", 0xcafe, 0x4013);
    const unknown = port("COM1", null, null);

    expect(isAppPort(app)).toBe(true);
    expect(isBootloaderFamily(app)).toBe(false);
    expect(isBootloaderFamily(boot)).toBe(true);
    // 0xCAFE:0x4013 is both an app and the FSBL.
    expect(isAppPort(legacy)).toBe(true);
    expect(isBootloaderFamily(legacy)).toBe(true);
    expect(isBootloaderFamily(port("COM5", 0xcafe, 0x1234))).toBe(true);

    // Preferred identity wins regardless of list order.
    expect(findPortIn([legacy, boot], BOOTLOADER_IDENTITIES)).toBe("COM8");
    expect(findPortIn([legacy, app], APP_IDENTITIES)).toBe("COM7");
    expect(findPortIn([unknown], APP_IDENTITIES)).toBeNull();

    expect(describePorts([app, legacy, unknown])).toBe(
      "COM7 (1209:8008) [app], COM9 (cafe:4013) [app], COM1 (id unknown)",
    );
    expect(describePorts([boot])).toBe("COM8 (1209:8009) [bootloader]");
    expect(describePorts([])).toBe("no serial ports at all");
  });
});

// A DfuSession against a scripted FSBL

const COMMANDS = ["DFU_INFO", "DFU_DATA", "DFU_NEXT", "DFU_END", "DFU_RESET"];

/** A scripted FSBL: ACKs, the extra ACK every 16 KB, NEXT_OK, and a CRC of what it was sent. */
class FakeFsbl {
  path = "FAKE";
  flash = new Map<number, number>();
  dataPhase = false;
  cursor = 0;
  imageStart = 0;
  sinceFlush = 0;
  starts = 0;
  session: DfuSession | null = null;
  infoLine = "N6INFO 2 CRC32 MULTI UID ABC";
  /** Images that land with their first byte flipped. */
  corruptImages = 0;
  /** Stands in for the CRC32 line of a DFU_CRC32 reply. */
  crcLine: string | null = null;

  reply(text: string) {
    setTimeout(() => this.session?.onData(Buffer.from(text, "latin1")), 0);
  }

  flush(callback: () => void) {
    callback();
  }

  write(bytes: Buffer, callback: (error?: Error | null) => void) {
    callback(null);
    const length = bytes[1] | (bytes[2] << 8);
    const payload = bytes.subarray(3, 3 + length);
    const text = payload.toString("latin1");
    const command = COMMANDS.find((c) => c === text);

    if (text.startsWith("DFU START")) {
      this.cursor = payload.readUInt32LE(9);
      this.imageStart = this.cursor;
      this.starts += 1;
      this.reply("N6ACK\r\n");
    } else if (text.startsWith("DFU_ERASE")) {
      this.reply("N6ACK\r\n");
    } else if (text.startsWith("DFU_CRC32")) {
      const offset = payload.readUInt32LE(9);
      const size = payload.readUInt32LE(13);
      const image = Uint8Array.from({ length: size }, (_, i) => this.flash.get(offset + i) ?? 0xff);
      const line = this.crcLine ?? `CRC32 0x${crc32(image).toString(16).toUpperCase()}`;
      this.reply(`${line}\r\nN6ACK\r\n`);
    } else if (command === "DFU_INFO") {
      this.reply(`${this.infoLine}\r\nN6ACK\r\n`);
    } else if (command === "DFU_DATA") {
      this.dataPhase = true;
      this.sinceFlush = 0;
      this.reply("N6ACK\r\n");
    } else if (command === "DFU_NEXT") {
      this.dataPhase = false;
      if (this.corruptImages > 0) {
        this.corruptImages -= 1;
        this.flash.set(this.imageStart, (this.flash.get(this.imageStart) ?? 0) ^ 0xff);
      }
      this.reply("NEXT_OK\r\nN6ACK\r\n");
    } else if (this.dataPhase) {
      payload.forEach((b, i) => this.flash.set(this.cursor + i, b));
      this.cursor += payload.length;
      this.sinceFlush += payload.length;
      let acks = "N6ACK\r\n";
      if (this.sinceFlush >= 16384) {
        acks += "N6ACK\r\n";
        this.sinceFlush = 0;
      }
      this.reply(acks);
    }
  }
}

function attach(fsbl: FakeFsbl, logs: string[] = []) {
  const session = new DfuSession("FAKE", { log: (line: string) => logs.push(line) });
  Object.assign(session, { port: fsbl });
  fsbl.session = session;
  return session;
}

describe("DfuSession", () => {
  it("splits lines across chunks and trims CR", async () => {
    const session = attach(new FakeFsbl());
    session.onData(Buffer.from("N6A"));
    session.onData(Buffer.from("CK\r\nNEXT"));
    session.onData(Buffer.from("_OK\r\n"));
    expect(await session.readLine(100)).toBe("N6ACK");
    expect(await session.readLine(100)).toBe("NEXT_OK");
  });

  it("returns '' on timeout and drops the half line", async () => {
    const session = attach(new FakeFsbl());
    session.onData(Buffer.from("partial"));
    expect(await session.readLine(20)).toBe("");
    session.onData(Buffer.from("N6ACK\n"));
    expect(await session.readLine(20)).toBe("N6ACK");
  });

  it("fails an ack wait on a listed bad reply", async () => {
    const session = attach(new FakeFsbl());
    session.onData(Buffer.from("START_BAD_ADDR\r\n"));
    await expect(
      session.waitAck("DFU START", { badReplies: ["START_BAD_ADDR"], timeoutMs: 100 }),
    ).rejects.toThrow("Bootloader rejected DFU START: START_BAD_ADDR");
  });

  it("gives up on a chatty non-bootloader within the probe's bound", async () => {
    const session = attach(new FakeFsbl());
    const chatter = setInterval(() => session.onData(Buffer.from("app log line\r\n")), 5);
    try {
      const started = Date.now();
      await expect(session.waitAck("DFU_INFO", { timeoutMs: 120, bounded: true })).rejects.toThrow(
        "No response",
      );
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      clearInterval(chatter);
    }
  });

  it("programs across the 16 KB double-ACK and verifies by CRC", async () => {
    const fsbl = new FakeFsbl();
    const logs: string[] = [];
    const session = attach(fsbl, logs);

    const info = await session.probeInfo();
    expect(info?.supportsMulti).toBe(true);
    expect(session.answered).toBe(true);

    const image = Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 7) & 0xff));
    const progress: number[] = [];
    await session.program(image, 0x100000, "app.bin", {
      nextImage: true,
      onProgress: (written: number) => progress.push(written),
    });

    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(image.length);
    expect(progress.length).toBe(Math.ceil(image.length / 4096) + 1);
    expect(logs).toContain("erase: 40960 bytes at 0x90100000");
    expect(await session.crc32(0x100000, image.length)).toBe(crc32(image));
  });
});

describe("programImage", () => {
  const image = {
    label: "app.bin",
    data: Buffer.from(Array.from({ length: 9000 }, (_, i) => (i * 13) & 0xff)),
    offset: 0x100000,
  };

  async function flashWith(setup: (fsbl: FakeFsbl) => void) {
    const fsbl = new FakeFsbl();
    setup(fsbl);
    const logs: string[] = [];
    const session = attach(fsbl, logs);
    const info = await session.probeInfo();
    const multi = info !== null && info.supportsMulti;
    const run = programImage(session, image, { multi, log: (line: string) => logs.push(line) });
    return { fsbl, logs, run };
  }

  it("verifies the write by the device's CRC", async () => {
    const { fsbl, logs, run } = await flashWith(() => undefined);
    await run;
    expect(fsbl.starts).toBe(1);
    expect(logs).toContain(
      `verify: device crc 0x${crc32(image.data).toString(16).toUpperCase()} ok`,
    );
  });

  it("rewrites once on a mismatch", async () => {
    const { fsbl, logs, run } = await flashWith((f) => (f.corruptImages = 1));
    await run;
    expect(fsbl.starts).toBe(2);
    expect(logs.some((l) => l.startsWith("verify: mismatch"))).toBe(true);
    expect(logs).toContain("retry: rewriting app.bin");
    expect(logs.at(-1)).toMatch(/ok$/);
  });

  it("fails when the retry mismatches too", async () => {
    const { fsbl, run } = await flashWith((f) => (f.corruptImages = 2));
    await expect(run).rejects.toThrow("failed flash verification after a retry");
    expect(fsbl.starts).toBe(2);
  });

  it("does not take a garbled CRC from a CRC32 bootloader as unsupported", async () => {
    const { fsbl, logs, run } = await flashWith((f) => (f.crcLine = "CRC32 0xZZ"));
    await expect(run).rejects.toThrow("could not be verified");
    expect(fsbl.starts).toBe(1);
    expect(logs.some((l) => l.includes("skipped"))).toBe(false);
  });

  it("skips the check on a MULTI bootloader without CRC32", async () => {
    const { logs, run } = await flashWith((f) => (f.infoLine = "N6INFO 2 MULTI"));
    await run;
    expect(logs).toContain("verify: not supported by this bootloader; skipped");
  });
});

describe("runFlash", () => {
  it("refuses an empty image before touching any port", async () => {
    const result = await runFlash({
      images: [{ label: "a.bin", data: Buffer.alloc(0), offset: 0 }],
    });
    expect(result).toEqual({ ok: false, message: "a.bin: file is empty" });
  });

  it("refuses an image that runs past the end of flash", async () => {
    const result = await runFlash({
      images: [{ label: "a.bin", data: Buffer.alloc(2), offset: 0x01ffffff }],
    });
    expect(result).toEqual({
      ok: false,
      message: "a.bin: image runs past the end of flash (0x92000000)",
    });
  });
});
