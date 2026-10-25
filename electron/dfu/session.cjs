// Serial side of the bootloader tool. Runs in the main process, so nothing blocks.

const {
  FLASH_BASE,
  FLASH_END,
  XSPI_SECTOR_SIZE,
  FSBL_REGION_SIZE,
  DFU_BAUD,
  DFU_CHUNK_SIZE,
  makePacket,
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
} = require("./protocol.cjs");

let serialModule = null;
/** Loaded on first use, so the pure helpers work without the native binding. */
function serialLib() {
  if (!serialModule) serialModule = require("serialport");
  return serialModule;
}

/** USB identities, preferred first. 0xCAFE:0x4013 comes last: an app and the FSBL share it. */
const VID = 0x1209;
const APP_PID = 0x8008;
const BOOTLOADER_PID = 0x8009;
const LEGACY_VID = 0xcafe;
const LEGACY_APP_PID = 0x4013;
const LEGACY_BOOT_PID = 0x4014;

const APP_IDENTITIES = [
  [VID, APP_PID],
  [LEGACY_VID, LEGACY_APP_PID],
];
const BOOTLOADER_IDENTITIES = [
  [VID, BOOTLOADER_PID],
  [LEGACY_VID, LEGACY_BOOT_PID],
  [LEGACY_VID, LEGACY_APP_PID],
];
/** Bootloader identities no app uses, so they can be trusted without a probe. */
const DISTINCT_BOOTLOADER_IDENTITIES = [
  [VID, BOOTLOADER_PID],
  [LEGACY_VID, LEGACY_BOOT_PID],
];

const REPLY_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 2000;
const OPEN_TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 5000;
const PORT_POLL_MS = 300;

function eraseTimeoutMs(eraseSize) {
  return 60000 + 2000 * Math.ceil(eraseSize / 0x10000);
}

function crcTimeoutMs(length) {
  return 30000 + 1000 * Math.ceil(length / 0x100000);
}

const CANCELLED = "Flash cancelled.";

class DfuError extends Error {
  constructor(message) {
    super(message);
    this.name = "DfuError";
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new DfuError(CANCELLED);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => (error && error.message) || String(error);
const hex4 = (v) => v.toString(16).padStart(4, "0");
const hexAddress = (v) => `0x${v.toString(16).toUpperCase()}`;
const hex32 = (v) => `0x${v.toString(16).toUpperCase().padStart(8, "0")}`;

function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DfuError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Port discovery

function parseUsbId(text) {
  return typeof text === "string" && /^[0-9a-f]{1,4}$/i.test(text)
    ? Number.parseInt(text, 16)
    : null;
}

function toPortInfo(raw) {
  // With no iSerial, Windows reports an instance id such as 6&2c2bc5b9&0&0001.
  const serial =
    typeof raw.serialNumber === "string" && raw.serialNumber && !raw.serialNumber.includes("&")
      ? raw.serialNumber
      : null;
  return {
    name: raw.path,
    vid: parseUsbId(raw.vendorId),
    pid: parseUsbId(raw.productId),
    serial,
    description: raw.friendlyName || raw.manufacturer || null,
  };
}

const matchesAny = (port, identities) =>
  identities.some(([vid, pid]) => port.vid === vid && port.pid === pid);

const isAppPort = (port) => matchesAny(port, APP_IDENTITIES);

const isBootloaderFamily = (port) =>
  matchesAny(port, BOOTLOADER_IDENTITIES) || port.vid === LEGACY_VID;

/** A Neuro N6 in either mode, as auto-detect counts boards. */
const isBoardPort = (port) => isAppPort(port) || matchesAny(port, BOOTLOADER_IDENTITIES);

/** Linux and macOS reuse a port name when a board re-enumerates with other IDs. */
const portKey = (port) => `${port.name}|${port.vid}|${port.pid}`;

function findPortIn(ports, identities) {
  for (const [vid, pid] of identities) {
    const hit = ports.find((p) => p.vid === vid && p.pid === pid);
    if (hit) return hit.name;
  }
  return null;
}

async function enumeratePorts() {
  const { SerialPort } = serialLib();
  const raw = await withDeadline(
    SerialPort.list(),
    LIST_TIMEOUT_MS,
    "listing serial ports timed out",
  );
  return raw.map(toPortInfo);
}

function describePorts(ports) {
  if (!ports.length) return "no serial ports at all";
  return ports
    .map((p) => {
      const id = p.vid === null || p.pid === null ? "id unknown" : `${hex4(p.vid)}:${hex4(p.pid)}`;
      const tag = isAppPort(p) ? " [app]" : isBootloaderFamily(p) ? " [bootloader]" : "";
      const serial = p.serial ? `, serial ${p.serial}` : "";
      return `${p.name} (${id}${serial})${tag}`;
    })
    .join(", ");
}

// serialport, promisified with deadlines

/** Opens at `baudRate`, 8N1, no flow control. */
function openPort(path, baudRate) {
  const { SerialPort } = serialLib();
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = new SerialPort({ path, baudRate, autoOpen: false });
    } catch (error) {
      reject(error);
      return;
    }
    // An unhandled 'error' event would take the main process down.
    port.on("error", () => undefined);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new DfuError(`timed out opening ${path}`));
    }, OPEN_TIMEOUT_MS);
    port.open((error) => {
      clearTimeout(timer);
      if (late) {
        if (!error) void closePort(port);
      } else if (error) {
        reject(error);
      } else {
        resolve(port);
      }
    });
  });
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port.isOpen) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, OPEN_TIMEOUT_MS);
    port.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** serialport's set() writes every modem line on each call. */
function setLines(port, { dtr, rts }) {
  return withDeadline(
    new Promise((resolve, reject) =>
      port.set({ dtr, rts }, (error) => (error ? reject(error) : resolve())),
    ),
    WRITE_TIMEOUT_MS,
    `setting modem lines on ${port.path} timed out`,
  );
}

function writeBytes(port, bytes, timeoutMs) {
  return withDeadline(
    new Promise((resolve, reject) =>
      port.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve())),
    ),
    timeoutMs,
    `write to ${port.path} timed out`,
  );
}

function flushPort(port) {
  return withDeadline(
    new Promise((resolve) => port.flush(() => resolve())),
    WRITE_TIMEOUT_MS,
    "flush timed out",
  ).catch(() => undefined);
}

function drainPort(port) {
  return withDeadline(
    new Promise((resolve) => port.drain(() => resolve())),
    WRITE_TIMEOUT_MS,
    "drain timed out",
  ).catch(() => undefined);
}

// One conversation with the bootloader

const EMPTY = Buffer.alloc(0);

class DfuSession {
  /** @param {string} portName @param {{ log?: (line: string) => void }} [options] */
  constructor(portName, { log = () => undefined } = {}) {
    this.portName = portName;
    this.log = log;
    this.port = null;
    this.gone = false;
    this.info = null;
    // The last probeInfo() got an N6ACK, even if no N6INFO came with it.
    this.answered = false;
    // Lines the last probeInfo() received, ACK or not.
    this.heard = [];
    this.lines = [];
    this.partial = EMPTY;
    this.waiter = null;
  }

  async open() {
    let port = null;
    try {
      port = await openPort(this.portName, DFU_BAUD);
      await setLines(port, { dtr: true, rts: true });
    } catch (error) {
      if (port) await closePort(port);
      throw new DfuError(`Cannot open bootloader port ${this.portName}: ${errorText(error)}`);
    }
    port.on("data", (chunk) => this.onData(chunk));
    port.on("close", () => this.onGone());
    this.port = port;
  }

  async close() {
    const port = this.port;
    this.port = null;
    this.onGone();
    if (port) await closePort(port);
  }

  onData(chunk) {
    let buffer = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline).toString("latin1").trim();
      buffer = buffer.subarray(newline + 1);
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(line);
      } else {
        this.lines.push(line);
      }
    }
    this.partial = buffer;
  }

  /** The port closed or went away: a pending read ends now rather than at its deadline. */
  onGone() {
    this.gone = true;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter("");
  }

  async send(packet) {
    if (!this.port) throw new DfuError("port is not open");
    if (this.gone) throw new DfuError(`${this.portName} disconnected`);
    await writeBytes(this.port, packet, WRITE_TIMEOUT_MS);
  }

  /** One LF-terminated line, trimmed, or '' on timeout. */
  readLine(timeoutMs = REPLY_TIMEOUT_MS) {
    if (!this.port) return Promise.reject(new DfuError("port is not open"));
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.gone || timeoutMs <= 0) return Promise.resolve("");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.partial = EMPTY; // a half-read line is dropped
        resolve("");
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  async discardInput() {
    if (!this.port) return;
    this.lines = [];
    this.partial = EMPTY;
    await flushPort(this.port);
    this.lines = [];
    this.partial = EMPTY;
  }

  // Returns the lines before N6ACK, also kept in `seen` for a caller after a throw.
  // The timeout is per line unless `bounded`.
  /** @param {string} what @param {{ badReplies?: string[], timeoutMs?: number, bounded?: boolean, seen?: string[] }} [options] */
  async waitAck(
    what,
    { badReplies = [], timeoutMs = REPLY_TIMEOUT_MS, bounded = false, seen = [] } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const resp = await this.readLine(bounded ? deadline - Date.now() : timeoutMs);
      if (resp === "N6ACK") return seen;
      if (!resp) throw new DfuError(`No response from bootloader during ${what}`);
      if (badReplies.includes(resp)) throw new DfuError(`Bootloader rejected ${what}: ${resp}`);
      seen.push(resp);
    }
  }

  /** Asks the FSBL to identify itself. null from a v1 FSBL, which only ACKs. */
  async probeInfo() {
    this.answered = false;
    this.heard = [];
    await this.discardInput();
    await this.send(cmdInfo());
    const seen = this.heard;
    try {
      // Bounded overall: a chatty port that is not a bootloader would never time out per line.
      await this.waitAck("DFU_INFO", { timeoutMs: 3000, bounded: true, seen });
    } catch (error) {
      if (error instanceof DfuError) return null; // even the ACK went missing
      throw error;
    }
    this.answered = true;
    for (const line of seen) {
      const parsed = parseN6Info(line);
      if (parsed) {
        this.info = parsed;
        return parsed;
      }
    }
    return null;
  }

  /** Device-side CRC32 of `length` bytes at `offset`; null if unsupported or unanswered. */
  async crc32(offset, length) {
    if (!this.info || !this.info.supportsCrc) return null;
    await this.send(cmdCrc32(offset, length));
    let seen;
    try {
      seen = await this.waitAck("DFU_CRC32", { timeoutMs: crcTimeoutMs(length), bounded: true });
    } catch (error) {
      if (error instanceof DfuError) return null;
      throw error;
    }
    return parseCrc32Reply(seen);
  }

  /**
   * START, ERASE, DATA, then DFU_NEXT or DFU_END. With `nextImage` the session
   * stays open; otherwise the device resets.
   *
   * @param {Uint8Array} data
   * @param {number} offset
   * @param {string} label
   * @param {{ nextImage?: boolean, onProgress?: (written: number, total: number) => void }} [options]
   */
  async program(data, offset, label, { nextImage = false, onProgress } = {}) {
    const total = data.length;
    if (total === 0) throw new DfuError(`Refusing to program an empty image (${label})`);

    // Every wait is bounded: a port that talks without ever ACKing cannot hold the flash.
    await this.send(cmdStart(offset));
    await this.waitAck("DFU START", { badReplies: ["START_BAD_ADDR"], bounded: true });

    const erase = eraseSizeFor(total);
    this.log(`erase: ${erase} bytes at ${hexAddress(FLASH_BASE + offset)}`);
    await this.send(cmdErase(erase));
    await this.waitAck("DFU_ERASE", {
      badReplies: ["ERASE_BAD_SIZE"],
      timeoutMs: eraseTimeoutMs(erase),
      bounded: true,
    });

    await this.send(cmdData());
    await this.waitAck("DFU_DATA", { bounded: true });

    let written = 0;
    let since16k = 0;
    if (onProgress) onProgress(0, total);
    for (let i = 0; i < total; i += DFU_CHUNK_SIZE) {
      const chunk = data.subarray(i, Math.min(i + DFU_CHUNK_SIZE, total));
      await this.send(makePacket(chunk));
      let ack = await this.readLine();
      if (ack !== "N6ACK") {
        throw new DfuError(
          `Lost sync while writing ${label} at byte ${written} (got "${ack}"). Re-run the upload.`,
        );
      }
      written += chunk.length;
      since16k += chunk.length;
      // The bootloader sends a second ACK every 16 KB, at each page flush.
      if (since16k >= 16384) {
        ack = await this.readLine();
        if (ack !== "N6ACK") {
          throw new DfuError(`Lost sync (16 KB ack) while writing ${label} (got "${ack}")`);
        }
        since16k = 0;
      }
      if (onProgress) onProgress(written, total);
    }

    if (nextImage) {
      await this.send(cmdNext());
      const seen = await this.waitAck("DFU_NEXT", { bounded: true });
      if (!seen.some((line) => line.startsWith("NEXT_OK"))) {
        throw new DfuError("Bootloader did not confirm DFU_NEXT (image boundary); flash stopped.");
      }
    } else {
      await this.send(cmdEnd());
      // The device resets here, so '' is the expected answer.
      const resp = await this.readLine(5000).catch(() => "");
      if (resp && resp !== "DFU_DONE") this.log(`device: ${resp}`);
    }
  }

  /** Resets from idle, valid only after a DFU_NEXT-terminated image. */
  async resetDevice() {
    await this.send(cmdReset());
    await this.readLine(3000).catch(() => "");
  }
}

// Getting into the bootloader

/** 1200 baud then a DTR drop, which the core watches for even with the debug console off. */
async function touch1200(portName, log) {
  let port = null;
  try {
    port = await openPort(portName, 1200);
    await setLines(port, { dtr: true, rts: true });
    await sleep(100);
    await setLines(port, { dtr: false, rts: true });
    await sleep(50);
    await closePort(port);
    port = null;
    log(`1200-baud touch on ${portName}`);
    return true;
  } catch {
    return false;
  } finally {
    if (port) await closePort(port);
  }
}

const portBusy = (portName) =>
  `Could not open ${portName}: another program, such as the Serial Monitor or ` +
  "another Neuro Studio window, may be using it.";

async function sendRebootCommand(portName, log) {
  let port;
  try {
    port = await openPort(portName, DFU_BAUD);
  } catch {
    log(portBusy(portName));
    return false;
  }
  try {
    await setLines(port, { dtr: true, rts: true });
    await sleep(100);
    await flushPort(port);
    await writeBytes(port, Buffer.from("b\n", "latin1"), 1000);
    await drainPort(port);
    await sleep(300);
    await closePort(port);
    port = null;
    log(`asked the app on ${portName} to enter the bootloader`);
    return true;
  } catch {
    return true; // the port vanishing mid-reboot is success
  } finally {
    if (port) await closePort(port);
  }
}

/** Ports new since `before`. A port seen gone counts as new when it comes back. */
function freshSince(before) {
  const stale = new Set((before || []).map(portKey));
  return (ports) => {
    const present = new Set(ports.map(portKey));
    for (const key of stale) if (!present.has(key)) stale.delete(key);
    return ports.filter((p) => !stale.has(portKey(p)));
  };
}

/**
 * Waits for a bootloader port new since `before`. A bootloader identity is trusted at
 * once; anything else on LEGACY_VID only once the app port has gone.
 */
async function waitBootloader(timeoutMs, prevAppPort, before, signal = null) {
  const deadline = Date.now() + timeoutMs;
  const fresh = freshSince(before);
  let appGone = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const ports = await enumeratePorts();
    const candidates = fresh(ports);
    const port = findPortIn(candidates, BOOTLOADER_IDENTITIES);
    if (port !== null) return port;
    if (prevAppPort !== null && !ports.some((p) => p.name === prevAppPort)) appGone = true;
    if (appGone || prevAppPort === null) {
      const boot = candidates.find(isBootloaderFamily);
      if (boot) return boot.name;
    }
    await sleep(PORT_POLL_MS);
  }
  throwIfAborted(signal);
  // The app's port may itself be a bootloader.
  if (prevAppPort !== null) {
    const ports = await enumeratePorts();
    if (ports.some((p) => p.name === prevAppPort && isBootloaderFamily(p))) return prevAppPort;
  }
  return null;
}

async function probeIsBootloader(portName) {
  const session = new DfuSession(portName);
  try {
    await session.open();
    await session.probeInfo();
    // An ACK alone counts: a v1 FSBL answers DFU_INFO without an N6INFO line.
    return session.answered;
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

/**
 * Gets the board into its bootloader and returns that port, or null. A `preferredPort`
 * is the only board this touches; auto-detect refuses to choose between several.
 */
async function enterBootloader(preferredPort, log, { timeoutMs = 12000, signal = null } = {}) {
  const ports = await enumeratePorts();
  let chosen;
  if (preferredPort !== null) {
    chosen = ports.find((p) => p.name === preferredPort);
    if (!chosen) {
      throw new DfuError(`${preferredPort} is no longer present. Rescan the ports and pick again.`);
    }
  } else {
    const boards = ports.filter(isBoardPort);
    if (boards.length > 1) {
      throw new DfuError(
        `Several boards found (${boards.map((p) => p.name).join(", ")}). ` +
          "Pick the port of the board to flash.",
      );
    }
    if (boards.length === 0) {
      log("no board found; waiting for a bootloader to appear");
      log("(double-tap the reset button if nothing happens)");
      const boot = await waitBootloader(timeoutMs, null, ports, signal);
      if (boot !== null) log(`bootloader on ${boot}`);
      return boot;
    }
    chosen = boards[0];
  }
  const name = chosen.name;

  if (matchesAny(chosen, DISTINCT_BOOTLOADER_IDENTITIES)) {
    log(`bootloader already present on ${name}`);
    return name;
  }
  // 0xCAFE:0x4013 is both the FSBL and an app; other IDs prove nothing either way.
  if (!matchesAny(chosen, [[VID, APP_PID]])) {
    const id =
      chosen.vid === null || chosen.pid === null
        ? "USB IDs unknown"
        : `${hex4(chosen.vid)}:${hex4(chosen.pid)}`;
    log(`${name} (${id}) may be the bootloader; probing it…`);
    if (await probeIsBootloader(name)) {
      log(`${name} answered the DFU protocol, using it`);
      return name;
    }
    throwIfAborted(signal);
    log(`${name} did not answer; treating it as a running app`);
  }

  // The touch first: core sketches and BSP apps answer it, while a core sketch with its debug
  // console off would take 'b' as Serial input. 'b' goes only to an app that ignores the touch.
  let boot = null;
  if (await touch1200(name, log)) {
    boot = await waitBootloader(6000, name, ports, signal);
    if (boot === null && (await enumeratePorts()).some((p) => p.name === name)) {
      await sendRebootCommand(name, log);
    }
  } else {
    log(portBusy(name));
  }
  if (boot === null) boot = await waitBootloader(timeoutMs, name, ports, signal);
  if (boot !== null) log(`bootloader on ${boot}`);
  return boot;
}

/**
 * The flashed board's app port once it is back, new since `before`, or null on timeout or
 * abort. `strict` accepts only VID:APP_PID, since the FSBL shares the other identity.
 */
async function waitForApp(timeoutMs, { strict = false, before = [], signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const fresh = freshSince(before);
  while (Date.now() < deadline && !(signal && signal.aborted)) {
    const ports = fresh(await enumeratePorts());
    const port = strict ? findPortIn(ports, [[VID, APP_PID]]) : findPortIn(ports, APP_IDENTITIES);
    if (port !== null) return port;
    await sleep(PORT_POLL_MS);
  }
  return null;
}

// The flash job

/**
 * With MULTI, checks the image against the device's CRC32 and rewrites it once on a
 * mismatch. Without it, DFU_END resets the device and nothing is verified.
 *
 * @param {DfuSession} session
 * @param {{ label: string, data: Uint8Array, offset: number }} image
 * @param {{ multi: boolean, log: (line: string) => void, onProgress?: (written: number, total: number) => void }} options
 */
async function programImage(session, image, { multi, log, onProgress }) {
  const want = crc32(image.data);
  log(
    `${image.label}: ${image.data.length} bytes -> ${hexAddress(FLASH_BASE + image.offset)}` +
      `  (crc ${hex32(want)})`,
  );

  const attempts = multi ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await session.program(image.data, image.offset, image.label, { nextImage: multi, onProgress });
    if (!multi) return; // the device is already resetting

    const got = await session.crc32(image.offset, image.data.length);
    if (got === null) {
      // A lost or garbled reply is not a missing capability.
      if (session.info && session.info.supportsCrc) {
        throw new DfuError(
          `${image.label}: the bootloader did not return a CRC, so the write could not be ` +
            "verified. The board was not reset; re-run the upload.",
        );
      }
      log("verify: not supported by this bootloader; skipped");
      return;
    }
    if (got === want) {
      log(`verify: device crc ${hex32(got)} ok`);
      return;
    }
    log(`verify: mismatch (device ${hex32(got)}, host ${hex32(want)})`);
    if (attempt >= attempts) {
      throw new DfuError(
        `${image.label} failed flash verification after a retry. The flash contents ` +
          "do not match the file. Flash the board again before using it.",
      );
    }
    log(`retry: rewriting ${image.label}`);
  }
}

/**
 * Why `image` must not be written where it asks, or null.
 *
 * @param {{ label: string, data: Uint8Array, offset: number }} image
 * @param {{ allowFsbl?: boolean }} [options]
 */
function imagePlacementError(image, { allowFsbl = false } = {}) {
  if (!image.data.length) return `${image.label}: file is empty`;
  const { offset } = image;
  if (!Number.isInteger(offset) || offset < 0) return `${image.label}: not a valid flash offset`;
  const endAddr = FLASH_BASE + offset + image.data.length - 1;
  if (endAddr > FLASH_END) {
    return `${image.label}: image runs past the end of flash (${hexAddress(endAddr)})`;
  }
  const start = hexAddress(FLASH_BASE + offset);
  if (offset % XSPI_SECTOR_SIZE !== 0) {
    return `${image.label}: ${start} is not on a ${XSPI_SECTOR_SIZE / 1024} KB sector boundary`;
  }
  if (offset < FSBL_REGION_SIZE && !allowFsbl) {
    return (
      `${image.label}: ${start} is inside the bootloader (FSBL) region, ` +
      "and replacing the bootloader was not confirmed"
    );
  }
  return null;
}

/**
 * Ports a video session could take for the app, as 0xCAFE:0x4013 is also an app's ID:
 * the port the flash used, or one that appeared after the flash began.
 *
 * @param {{ name: string, vid: number | null, pid: number | null }[]} ports
 * @param {{ bootPort?: string | null, portsBefore?: { name: string, vid: number | null, pid: number | null }[] | null }} [trace]
 */
function lingeringFsblPorts(ports, { bootPort = null, portsBefore = null } = {}) {
  const before = new Set((portsBefore || []).map(portKey));
  return ports.filter((p) => {
    const ambiguous = matchesAny(p, [[LEGACY_VID, LEGACY_APP_PID]]);
    if (p.name === bootPort) return ambiguous || p.vid === null;
    return ambiguous && portsBefore !== null && !before.has(portKey(p));
  });
}

/**
 * Flashes `images`, offsets from FLASH_BASE. Resolves to { ok, message, bootPort, portsBefore },
 * never rejects. A `signal` abort after onStage(true) leaves a partial image.
 */
async function runFlash({
  images,
  preferredPort = null,
  rebootAfter = true,
  allowFsbl = false,
  signal = null,
  log = () => undefined,
  onProgress = () => undefined,
  onStage = () => undefined,
}) {
  let session = null;
  let writing = false;
  const trace = { bootPort: undefined, portsBefore: undefined };
  const onAbort = () => {
    if (session) void session.close();
  };
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    for (const image of images) {
      const problem = imagePlacementError(image, { allowFsbl });
      if (problem) throw new DfuError(problem);
    }

    const portsBefore = await enumeratePorts();
    trace.portsBefore = portsBefore;
    log(`ports: ${describePorts(portsBefore)}`);
    throwIfAborted(signal);
    log("entering the bootloader…");
    const port = await enterBootloader(preferredPort, log, { signal });
    if (port !== null) trace.bootPort = port;
    throwIfAborted(signal);
    if (port === null) {
      throw new DfuError(
        "No Neuro N6 bootloader found.\n" +
          `Ports seen: ${describePorts(await enumeratePorts())}\n` +
          "Double-tap the reset button, or pick the port by hand above if you know which one it is.",
      );
    }

    session = new DfuSession(port, { log });
    await session.open();
    throwIfAborted(signal);

    const info = await session.probeInfo();
    throwIfAborted(signal);
    // No ACK but other lines: an app console. Only a silent port may be a v1 FSBL.
    if (!session.answered && session.heard.length > 0) {
      trace.bootPort = undefined;
      throw new DfuError(
        `${port} is talking but is not the DFU bootloader (it said "${session.heard[0].slice(0, 80)}"). ` +
          "Double-tap the reset button to enter the bootloader, or pick another port.",
      );
    }
    if (info === null) {
      log("bootloader: legacy v1 (no capability report)");
    } else {
      const caps = info.caps.size ? [...info.caps].join(" ") : "none";
      log(
        `bootloader: v${info.version}  caps: ${caps}` +
          (info.serial !== null ? `  uid: ${info.serial}` : ""),
      );
    }

    const multi = info !== null && info.supportsMulti;
    if (!multi && images.length > 1) {
      throw new DfuError(
        "This bootloader cannot take multiple images in one session " +
          "(no MULTI capability). Flash them one at a time.",
      );
    }

    // The flashed board is in its FSBL, so every app port listed here is another board's.
    const appPortsBefore = rebootAfter ? await enumeratePorts().catch(() => []) : [];
    throwIfAborted(signal);

    writing = true;
    onStage(true);
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      await programImage(session, image, {
        multi,
        log,
        onProgress: (written, total) =>
          onProgress({
            label: image.label,
            written,
            total,
            imageIndex: index,
            imageCount: images.length,
          }),
      });
    }
    writing = false;
    onStage(false);

    if (multi && rebootAfter) {
      log("resetting the board…");
      await session.resetDevice();
    }
    await session.close();
    session = null;

    if (rebootAfter) {
      const appPort = await waitForApp(10000, {
        strict: true,
        before: appPortsBefore,
        signal,
      }).catch(() => null);
      log(
        appPort !== null
          ? `application is back on ${appPort}`
          : "device reset; the application has not re-enumerated yet",
      );
    }

    return { ok: true, message: "Flash complete.", ...trace };
  } catch (error) {
    if (session) await session.close();
    let message = errorText(error);
    if (signal && signal.aborted) {
      message = writing
        ? "Flash stopped while writing, so the image on the board is incomplete. Flash it again."
        : CANCELLED;
    }
    if (writing) onStage(false);
    return { ok: false, message, ...trace };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

module.exports = {
  VID,
  APP_PID,
  BOOTLOADER_PID,
  LEGACY_VID,
  LEGACY_APP_PID,
  LEGACY_BOOT_PID,
  APP_IDENTITIES,
  BOOTLOADER_IDENTITIES,
  DfuError,
  DfuSession,
  toPortInfo,
  isAppPort,
  isBootloaderFamily,
  findPortIn,
  describePorts,
  enumeratePorts,
  enterBootloader,
  waitForApp,
  eraseTimeoutMs,
  imagePlacementError,
  lingeringFsblPorts,
  programImage,
  runFlash,
};
