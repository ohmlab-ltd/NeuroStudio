// Transport session for one window: reads the framed MJPEG + TLV stream over USB bulk or TCP.

const { EventEmitter } = require("node:events");
const net = require("node:net");

const {
  VendorFramedParser,
  TAG_THERMAL_FRAME,
  TAG_VD66_ISP_ENABLED,
  TAG_CAM_CAPS,
  TAG_TUNE_DESC,
  metaHasTlvType,
  metaHasThermalFrame,
  metaHasPerPacketTlv,
  findMetaFirstByte,
  findMetaTlvValue,
  findMetaIpv4,
  findMetaSoftAp,
  findAudioPcm,
  extractOverlayCategories,
  detectOverlayPresence,
  extractWarning,
  jpegWidthHeight,
  looksLikeJpeg,
} = require("./parser.cjs");
const { findLinkChallenge, frameHostCommand, linkAnswer } = require("./netlink.cjs");

let usbModule = null;
let usbLoadError = null;

/** False for a network-only run, which never loads libusb. */
let usbAllowed = true;
const USB_OFF_STATUS = "USB is off: Neuro Studio was started network-only";

function setUsbAllowed(on) {
  usbAllowed = on !== false;
}

function usbLib() {
  if (!usbAllowed) throw new Error(USB_OFF_STATUS);
  if (usbModule) return usbModule;
  if (usbLoadError) throw usbLoadError;
  try {
    usbModule = require("usb");
    return usbModule;
  } catch (error) {
    usbLoadError = error;
    throw error;
  }
}

/** Neuro N6 USB identities, tried in order: pid.codes, then the TinyUSB test pair. */
const DEVICE_IDENTITIES = [
  [0x1209, 0x8008],
  [0xcafe, 0x4013],
];

const WIFI_DEFAULT_HOST = "192.168.10.1";
const WIFI_DEFAULT_PORT = 5000;
const ETHERNET_DEFAULT_HOST = "192.168.20.1";
const ETHERNET_DEFAULT_PORT = 5000;

const STALE_AFTER_MS = 5000;

const TCP_CONNECT_TIMEOUT_MS = 3000;
/** Silence after video that means the link is lost. WiFi can stall for a few seconds. */
const TCP_STALE_AFTER_MS = 10000;
const TCP_KEEPALIVE_MS = 1000;

function isValidTcpTarget(host, port) {
  return (
    typeof host === "string" &&
    host.trim() !== "" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

/** Starts with "Disconnected" so the renderer drops its connected state. */
const SUSPENDED_STATUS = "Disconnected: the bootloader tool has the board";
/** Longest a connect attempt already in flight can take to land. */
const SUSPEND_SETTLE_MS = 8000;

const HEARTBEAT_LOG_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A node-usb method that calls back or, in some versions, returns a promise. Never rejects. */
function callAsync(receiver, method, ...args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const result = receiver[method](...args, () => done());
      if (result && typeof result.then === "function") {
        result.then(done, done);
      }
    } catch {
      done();
    }
    // A driver can forget its callback.
    setTimeout(done, 2000);
  });
}

/** "bus-port.port", such as "1-3" or "2-1.4". */
function portPathOf(bus, ports) {
  return !ports || ports.length === 0 ? String(bus) : `${bus}-${ports.join(".")}`;
}

const devicePortPath = (device) => portPathOf(device.busNumber, device.portNumbers || []);

/** Which session holds each board. node-usb lets a second open() or claim() succeed. */
const usbOwners = new Map(); // Device -> DeviceSession | SERIAL_PROBE
/** Holds a board while the transport menu reads its serial. */
const SERIAL_PROBE = "serial-probe";
/** Serials read so far, per plug-in. */
const usbSerials = new WeakMap(); // Device -> string

const USB_CLASS_CDC = 0x02;
const USB_CLASS_CDC_DATA = 0x0a;

/**
 * True when interface `itf` is CDC serial, as on the FSBL. Claiming it would
 * unbind the serial driver the bootloader tool needs.
 */
function isSerialInterface(device, itf) {
  let config;
  try {
    config = device.configDescriptor;
  } catch {
    return false;
  }
  if (!config || !Array.isArray(config.interfaces)) return false;
  for (const alternates of config.interfaces) {
    const descriptor = alternates && alternates[0];
    if (descriptor && descriptor.bInterfaceNumber === itf) {
      return (
        descriptor.bInterfaceClass === USB_CLASS_CDC ||
        descriptor.bInterfaceClass === USB_CLASS_CDC_DATA
      );
    }
  }
  return false;
}

/** Attached boards with their node-usb Device. A board `self` holds is not "in use". */
function enumerateBoards(self) {
  let devices;
  try {
    devices = usbLib().getDeviceList();
  } catch {
    return [];
  }

  const out = [];
  for (const device of devices) {
    const vid = device.deviceDescriptor.idVendor;
    const pid = device.deviceDescriptor.idProduct;
    if (!DEVICE_IDENTITIES.some(([v, p]) => v === vid && p === pid)) continue;

    const bus = device.busNumber;
    const ports = Array.isArray(device.portNumbers) ? [...device.portNumbers] : [];
    const owner = usbOwners.get(device);
    out.push({
      device,
      board: {
        vid,
        pid,
        bus,
        ports,
        serial: null,
        portPath: portPathOf(bus, ports),
        label: portPathOf(bus, ports),
        inUse: owner !== undefined && owner !== SERIAL_PROBE && owner !== self,
      },
    });
  }
  return out;
}

// Returns [] on any libusb failure; never throws.
/** @param {DeviceSession | null} [self] */
function listUsbBoards(self = null) {
  return enumerateBoards(self).map((entry) => entry.board);
}

/** Open a board no session holds and read its serial string. null on failure. */
async function readSerial(device, index) {
  usbOwners.set(device, SERIAL_PROBE);
  let opened = false;
  try {
    device.open(false);
    opened = true;
    const serial = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        device.getStringDescriptor(index, (error, value) => finish(error ? null : value || null));
      } catch {
        finish(null);
      }
      setTimeout(() => finish(null), 700);
    });
    return serial ? String(serial).trim() || null : null;
  } catch {
    return null;
  } finally {
    if (opened) {
      try {
        device.close();
      } catch {
        /* already gone */
      }
    }
    if (usbOwners.get(device) === SERIAL_PROBE) usbOwners.delete(device);
  }
}

// listUsbBoards plus serials. Opens each board not read before, never one a session holds.
/** @param {DeviceSession | null} [self] */
async function listUsbBoardsWithSerials(self = null) {
  const entries = enumerateBoards(self);
  for (const { device, board } of entries) {
    const index = device.deviceDescriptor.iSerialNumber;
    if (!index) continue;
    if (!usbSerials.has(device) && !usbOwners.has(device)) {
      const serial = await readSerial(device, index);
      if (serial) usbSerials.set(device, serial);
    }
    const serial = usbSerials.get(device);
    if (serial) {
      board.serial = serial;
      board.label = `${board.portPath} · SN ${serial}`;
    }
  }
  return entries.map((entry) => entry.board);
}

/**
 * Whether a failed IN transfer means the board was unplugged. Windows and Linux
 * can report an unplug as a transfer error or stall.
 */
function readErrorMeansRemoved(errno, device) {
  const u = usbModule && usbModule.usb;
  if (!u) return false;
  if (
    errno === u.LIBUSB_TRANSFER_NO_DEVICE ||
    errno === u.LIBUSB_ERROR_NO_DEVICE ||
    errno === u.LIBUSB_ERROR_IO
  ) {
    return true;
  }
  if (errno === u.LIBUSB_TRANSFER_ERROR || errno === u.LIBUSB_TRANSFER_STALL) {
    try {
      return !usbModule.getDeviceList().includes(device);
    } catch {
      return false;
    }
  }
  return false;
}

class DeviceSession extends EventEmitter {
  constructor() {
    super();
    this.parser = new VendorFramedParser();
    this.queue = []; // newest-only video queue, max 2
    /**
     * Gets every valid JPEG as it is parsed, before the newest-only queue drops any:
     * a recording keeps every frame the board sent, whatever the window shows.
     * @type {((jpeg: Buffer) => void) | null}
     */
    this.frameSink = null;

    this.running = true;
    this.transport = "usb"; // 'usb' | 'tcp'
    this.wantConnected = false;
    this.autoReconnect = true;
    // Status bar toggle. When off, a quiet USB link is left alone.
    this.autoRecover = true;

    this.usbDevice = null;
    this.usbInterface = null;
    this.usbInEndpoint = null;
    this.usbOutEndpoint = null;
    this.connected = false;
    this.connecting = false;
    this.desiredIds = DEVICE_IDENTITIES;
    this.desiredBus = null;
    this.desiredPorts = null;
    this.itfNum = 0;
    this.epIn = 0x81;
    this.epOut = 0x01;
    this.connectedVid = 0;
    this.connectedPid = 0;
    this.lastDataMs = Date.now();
    this.silentCycles = 0;
    this.silentStrikes = 0;
    this.hardRestarting = false;
    // Bumped by every USB teardown.
    this.usbGen = 0;
    // USB teardowns run one at a time, in order; a connect waits on it too.
    this.usbTeardown = Promise.resolve();
    // Last failed-attempt status, resent only on change; null after any other status.
    this.usbRetryStatus = null;

    this.tcpSocket = null;
    this.tcpConnected = false;
    this.tcpConnecting = false;
    this.desiredTcpHost = WIFI_DEFAULT_HOST;
    this.desiredTcpPort = WIFI_DEFAULT_PORT;
    // Bumped when the TCP target changes or the link closes; an older attempt is dropped.
    this.tcpGen = 0;
    this.tcpAttempt = null; // promise of the connect attempt in flight
    this.tcpCancel = null; // settles that attempt at once
    this.tcpConnectTimeoutMs = TCP_CONNECT_TIMEOUT_MS;
    this.tcpStaleAfterMs = TCP_STALE_AFTER_MS;
    this.lastTcpDataMs = 0;
    this.tcpFramesAtConnect = 0;

    // Link keys by board address, kept for this session.
    this.linkKeys = new Map(); // host -> Buffer
    this.linkHost = null;
    this.linkChallenge = null;
    this.linkAnswered = false;
    this.linkAccepted = false;

    // Stream info
    this.fixedW = null;
    this.fixedH = null;
    this.framesInWindow = 0;
    this.windowStartMs = Date.now();
    this.fpsSmoothed = 0;

    this.lastCats = [];
    this.lastHasLabels = false;
    this.lastHasShading = false;
    this.lastWarning = "";

    this.ingestPackets = 0;
    this.ingestEmittedFrames = 0;
    this.ingestBadJpegs = 0;
    this.ingestMetaOnly = 0;
    this.ingestThermalTlv = 0;
    this.ingestThermalAnnounce = 0;
    this.ingestLastTickMs = 0;
    this.ingestLastLogMs = 0;
    this.ingestBadAtLastLog = 0;
    this.ingestFramesAtLastLog = 0;
    this.ingestPacketsAtLastLog = 0;
    this.frameStallSecs = 0;

    this.switchChain = Promise.resolve();

    // Set while the bootloader tool owns the board.
    this.suspended = false;
    this.resumeAction = null;

    this._startLoops();
  }

  // Emission

  emitEvent(message) {
    if (!this.running) return;
    this.emit("event", message);
  }

  emitStatus(text) {
    this.usbRetryStatus = null;
    this.emitEvent({ t: "status", text });
  }

  usbAttemptFailed(text) {
    if (text !== this.usbRetryStatus) this.emitStatus(text);
    this.usbRetryStatus = text;
  }

  log(text) {
    this.emitEvent({ t: "logline", text });
  }

  // Stream info

  resetStreamInfo() {
    this.fixedW = null;
    this.fixedH = null;
    this.framesInWindow = 0;
    this.windowStartMs = Date.now();
    this.fpsSmoothed = 0;
    this.lastCats = [];
    this.lastHasLabels = false;
    this.lastHasShading = false;
    this.lastWarning = "";
  }

  maybeEmitStreamInfo(jpeg) {
    const now = Date.now();
    this.framesInWindow += 1;

    if (this.fixedW === null || this.fixedH === null) {
      const dims = jpegWidthHeight(jpeg);
      if (dims) {
        this.fixedW = dims.width;
        this.fixedH = dims.height;
      }
    }

    const dt = now - this.windowStartMs;
    if (dt >= 500) {
      const instFps = (this.framesInWindow * 1000) / dt;
      this.fpsSmoothed = this.fpsSmoothed === 0 ? instFps : this.fpsSmoothed * 0.7 + instFps * 0.3;
      this.framesInWindow = 0;
      this.windowStartMs = now;
      this.emitEvent({
        t: "stream_info",
        w: this.fixedW || 0,
        h: this.fixedH || 0,
        fps: this.fpsSmoothed,
      });
    }
  }

  maybeEmitOverlayCategories(meta) {
    const cats = extractOverlayCategories(meta);
    if (cats.length === this.lastCats.length && cats.every((c, i) => c === this.lastCats[i])) {
      return;
    }
    this.lastCats = cats;
    this.emitEvent({ t: "overlay_categories", cats });
  }

  maybeEmitOverlayPresence(meta) {
    const p = detectOverlayPresence(meta);
    if (p.hasBoxLabels === this.lastHasLabels && p.hasShading === this.lastHasShading) {
      return;
    }
    this.lastHasLabels = p.hasBoxLabels;
    this.lastHasShading = p.hasShading;
    this.emitEvent({
      t: "overlay_presence",
      hasBoxLabels: p.hasBoxLabels,
      hasShading: p.hasShading,
    });
  }

  maybeEmitWarning(meta) {
    const w = extractWarning(meta);
    if (!w) return;
    if (w === this.lastWarning) return;
    this.lastWarning = w;
    this.emitEvent({ t: "warning", text: w });
  }

  // Ingest, shared by USB and TCP

  ingestBytes(chunk) {
    this.parser.feed(chunk);

    for (;;) {
      const pkt = this.parser.nextPacket();
      if (!pkt) break;

      this.ingestPackets += 1;
      if (this.linkAnswered) this.linkAccepted = true;

      // A keyed board sends its challenge first and nothing else until answered.
      if (this.transport === "tcp" && pkt.jpegLen === 0) {
        const challenge = findLinkChallenge(pkt.meta);
        if (challenge) {
          this.onLinkChallenge(challenge);
          continue;
        }
      }

      // META_AUDIO_PCM 0x50, read from every packet: the newest-only path below drops packets.
      const audio = findAudioPcm(pkt.meta);
      if (audio) {
        this.emitEvent({
          t: "audio",
          id: pkt.frameId,
          rate: audio.rate,
          channels: audio.channels,
          pcm: audio.pcm,
        });
      }

      // Meta-only frames, payload_len 0: IP announces, capability beacons, sensor-only carriers.
      if (pkt.jpegLen === 0) {
        this.ingestMetaOnly += 1;

        // The network the board hosts, learned over USB only. Never logged.
        if (this.transport === "usb") {
          const ipv4 = findMetaIpv4(pkt.meta);
          if (ipv4) this.emitEvent({ t: "board_ip", host: ipv4.host, port: ipv4.port });
          const softAp = findMetaSoftAp(pkt.meta);
          if (softAp) {
            this.emitEvent({ t: "board_softap", ssid: softAp.ssid, password: softAp.password });
          }
        }

        const ispMode = findMetaFirstByte(pkt.meta, TAG_VD66_ISP_ENABLED);
        if (ispMode !== null) this.emitEvent({ t: "isp_enabled", value: ispMode });

        const camCaps = findMetaFirstByte(pkt.meta, TAG_CAM_CAPS);
        if (camCaps !== null) this.emitEvent({ t: "cam_caps", value: camCaps });

        const tuneDesc = findMetaTlvValue(pkt.meta, TAG_TUNE_DESC);
        if (tuneDesc) this.emitEvent({ t: "tune_desc", data: tuneDesc });

        if (metaHasTlvType(pkt.meta, TAG_THERMAL_FRAME)) {
          if (metaHasThermalFrame(pkt.meta)) this.ingestThermalTlv += 1;
          else this.ingestThermalAnnounce += 1;
        }

        // Sensor, audio and event frames go to the UI; IP announces and beacons do not.
        if (metaHasPerPacketTlv(pkt.meta)) {
          this.emitEvent({
            t: "meta",
            id: pkt.frameId,
            metaLen: pkt.metaLen,
            jpegLen: 0,
            meta: pkt.meta,
          });
        }
        continue;
      }

      const { ok, width, height } = looksLikeJpeg(pkt.jpeg);
      if (!ok) {
        this.ingestBadJpegs += 1;
        continue;
      }

      if (this.frameSink) {
        try {
          this.frameSink(pkt.jpeg);
        } catch {
          /* a failing recording must not stop the stream */
        }
      }

      if (width > 0 && height > 0 && (width !== this.fixedW || height !== this.fixedH)) {
        this.fixedW = width;
        this.fixedH = height;
        this.emitEvent({ t: "stream_info", w: width, h: height, fps: this.fpsSmoothed });
      }

      if (metaHasTlvType(pkt.meta, TAG_THERMAL_FRAME)) {
        if (metaHasThermalFrame(pkt.meta)) this.ingestThermalTlv += 1;
        else this.ingestThermalAnnounce += 1;
      }

      // Per-packet TLVs are sent here: the video queue keeps only the newest packet.
      if (metaHasPerPacketTlv(pkt.meta)) {
        this.emitEvent({
          t: "meta",
          id: pkt.frameId,
          metaLen: pkt.metaLen,
          jpegLen: pkt.jpegLen,
          meta: pkt.meta,
        });
      }

      this.queue.push(pkt);
      while (this.queue.length > 2) this.queue.shift();
    }

    if (this.queue.length > 0) {
      const newest = this.queue.pop();
      this.queue.length = 0;
      this.ingestEmittedFrames += 1;

      this.emitEvent({ t: "frame", jpeg: newest.jpeg });
      // Per-packet TLV meta was sent above.
      if (!metaHasPerPacketTlv(newest.meta)) {
        this.emitEvent({
          t: "meta",
          id: newest.frameId,
          metaLen: newest.metaLen,
          jpegLen: newest.jpegLen,
          meta: newest.meta,
        });
      }

      this.maybeEmitOverlayCategories(newest.meta);
      this.maybeEmitOverlayPresence(newest.meta);
      this.maybeEmitWarning(newest.meta);
      this.maybeEmitStreamInfo(newest.jpeg);

      // The IP TLV may also ride a video frame; it is learned over USB only, as above.
      if (this.transport === "usb") {
        const ipv4 = findMetaIpv4(newest.meta);
        if (ipv4) this.emitEvent({ t: "board_ip", host: ipv4.host, port: ipv4.port });
      }
    }

    const now = Date.now();
    if (now - this.ingestLastTickMs > 1000) {
      this.ingestLastTickMs = now;
      // Frame stall: no new JPEG frames while packets still flow.
      if (
        this.ingestEmittedFrames === this.ingestFramesAtLastLog &&
        this.ingestPackets !== this.ingestPacketsAtLastLog &&
        this.ingestEmittedFrames > 0
      ) {
        this.frameStallSecs += 1;
        if (this.frameStallSecs === 3) {
          this.emitEvent({
            t: "logline",
            text:
              `Video stopped for 3 s while metadata still arrives ` +
              `(frames ${this.ingestEmittedFrames}, bad JPEGs ${this.ingestBadJpegs})`,
          });
        }
      } else {
        this.frameStallSecs = 0;
      }
      this.ingestFramesAtLastLog = this.ingestEmittedFrames;
      this.ingestPacketsAtLastLog = this.ingestPackets;
      if (
        now - this.ingestLastLogMs >= HEARTBEAT_LOG_MS ||
        this.ingestBadJpegs !== this.ingestBadAtLastLog
      ) {
        this.emitEvent({
          t: "logline",
          text:
            `ingest: pkts=${this.ingestPackets} frames=${this.ingestEmittedFrames} ` +
            `metaOnly=${this.ingestMetaOnly} thermal=${this.ingestThermalTlv} ` +
            `thermAnn=${this.ingestThermalAnnounce} badJpeg=${this.ingestBadJpegs}`,
        });
        this.ingestLastLogMs = now;
        this.ingestBadAtLastLog = this.ingestBadJpegs;
      }
    }
  }

  // USB transport

  async cleanupUsb({ status = true } = {}) {
    // The retry loop runs this before every attempt; only a link that was up has caches to drop.
    const hadLink = this.connected;
    this.connected = false;
    // `connecting` is tryConnectUsbOnce's re-entry guard; that method clears it.
    this.usbGen += 1;

    this.parser.reset();
    this.queue.length = 0;
    this.resetStreamInfo();
    if (hadLink) this.emitEvent({ t: "clear_caches" });

    // Only these handles are torn down, never a connection opened after this call.
    const endpoint = this.usbInEndpoint;
    const iface = this.usbInterface;
    const device = this.usbDevice;
    this.usbInEndpoint = null;
    this.usbOutEndpoint = null;
    this.usbInterface = null;
    this.usbDevice = null;

    if (endpoint) {
      try {
        endpoint.removeAllListeners("data");
        endpoint.removeAllListeners("error");
        // node-usb can still report a failure while the poll winds down.
        endpoint.on("error", () => undefined);
        if (endpoint.pollActive) endpoint.stopPoll();
      } catch {
        /* already stopped */
      }
    }

    // A connect awaits this chain too, so it never opens a board still being closed.
    const teardown = this.usbTeardown
      .then(() => this.releaseUsb(endpoint, iface, device))
      .catch(() => undefined);
    this.usbTeardown = teardown;
    await teardown;

    if (status) this.emitStatus("Disconnected");
  }

  async releaseUsb(endpoint, iface, device) {
    // libusb will not close a handle with transfers pending.
    if (endpoint && endpoint.pollPending > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        endpoint.once("end", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (iface) await callAsync(iface, "release", true);
    if (device) {
      try {
        device.close();
      } catch {
        /* already gone */
      }
      if (usbOwners.get(device) === this) usbOwners.delete(device);
    }
  }

  idsLabel(ids = this.desiredIds) {
    return ids
      .map(([v, p]) => `0x${v.toString(16).toUpperCase()}:0x${p.toString(16).toUpperCase()}`)
      .join(" / ");
  }

  /**
   * { device, vid, pid, busy, bootloader }: device is null when none is usable, `busy`
   * the ports other windows hold, `bootloader` the port of a board in its bootloader.
   */
  findUsbDevice() {
    const usb = usbLib();
    const devices = usb.getDeviceList();
    const busy = [];
    let bootloader = null;
    const usable = (device) => {
      const owner = usbOwners.get(device);
      if (owner !== undefined && owner !== this) {
        // A serial read holds a board for well under a second.
        if (owner !== SERIAL_PROBE) busy.push(devicePortPath(device));
        return false;
      }
      if (isSerialInterface(device, this.itfNum)) {
        if (bootloader === null) bootloader = devicePortPath(device);
        return false;
      }
      return true;
    };

    // A pinned port opens only that board; otherwise the first free match, in identity order.
    if (this.desiredBus !== null && this.desiredPorts !== null) {
      for (const device of devices) {
        const vid = device.deviceDescriptor.idVendor;
        const pid = device.deviceDescriptor.idProduct;
        if (!this.desiredIds.some(([v, p]) => v === vid && p === pid)) continue;
        if (device.busNumber !== this.desiredBus) continue;
        const ports = device.portNumbers || [];
        if (ports.length !== this.desiredPorts.length) continue;
        if (!ports.every((p, i) => p === this.desiredPorts[i])) continue;
        if (usable(device)) return { device, vid, pid, busy, bootloader };
      }
      return { device: null, vid: 0, pid: 0, busy, bootloader };
    }

    for (const [vid, pid] of this.desiredIds) {
      const device = devices.find(
        (d) =>
          d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid && usable(d),
      );
      if (device) return { device, vid, pid, busy, bootloader };
    }
    return { device: null, vid: 0, pid: 0, busy, bootloader };
  }

  noUsbDeviceStatus({ busy, bootloader }) {
    if (bootloader !== null)
      return `Board at USB port ${bootloader} is in its bootloader, not streaming`;
    if (busy.length === 1) return `Board at USB port ${busy[0]} is in use by another window`;
    if (busy.length > 1)
      return `Boards at USB ports ${busy.join(", ")} are in use by other windows`;
    if (this.desiredBus !== null && this.desiredPorts !== null) {
      const path = portPathOf(this.desiredBus, this.desiredPorts);
      return `Waiting for the board on USB port ${path}`;
    }
    return "Waiting for a board on USB";
  }

  /** False once a close, switch, suspend or stop has overtaken an attempt. */
  usbAttemptWanted() {
    return this.running && this.wantConnected && this.transport === "usb";
  }

  async tryConnectUsbOnce() {
    if (!this.wantConnected) return false;
    if (this.connecting) return false;
    this.connecting = true;

    await this.cleanupUsb({ status: false });
    if (!this.usbAttemptWanted()) {
      this.connecting = false;
      return false;
    }
    const gen = this.usbGen;
    const overtaken = () => gen !== this.usbGen || !this.usbAttemptWanted();
    const abandon = async () => {
      // A teardown that moved usbGen has already closed what this opened.
      if (gen === this.usbGen) await this.cleanupUsb({ status: false });
      this.connecting = false;
      return false;
    };

    // Once per run of failed attempts, not on every retry.
    if (this.usbRetryStatus === null) this.emitStatus("Connecting over USB…");

    try {
      usbLib();
    } catch (error) {
      this.usbAttemptFailed(
        usbAllowed ? `Failed to load libusb: ${error && error.message}` : USB_OFF_STATUS,
      );
      this.connecting = false;
      return false;
    }

    let match;
    try {
      match = this.findUsbDevice();
    } catch (error) {
      this.usbAttemptFailed(`Couldn't list USB devices: ${error && error.message}`);
      this.connecting = false;
      return false;
    }

    if (!match.device) {
      this.usbAttemptFailed(this.noUsbDeviceStatus(match));
      this.connecting = false;
      return false;
    }

    try {
      match.device.open();
    } catch (error) {
      this.usbAttemptFailed(`Couldn't open the board: ${error && error.message}`);
      this.connecting = false;
      return false;
    }
    // Held until cleanupUsb closes it; no await since the search, so no other session has it.
    usbOwners.set(match.device, this);
    this.usbDevice = match.device;
    this.connectedVid = match.vid;
    this.connectedPid = match.pid;

    try {
      this.usbDevice.setAutoDetachKernelDriver(true);
    } catch {
      // Not supported on macOS.
    }

    try {
      const iface = this.usbDevice.interface(this.itfNum);
      if (!iface) throw new Error(`interface ${this.itfNum} not present`);
      try {
        if (iface.isKernelDriverActive()) iface.detachKernelDriver();
      } catch {
        // Not supported on this platform.
      }
      iface.claim();
      this.usbInterface = iface;

      this.usbInEndpoint = iface.endpoint(this.epIn);
      this.usbOutEndpoint = iface.endpoint(this.epOut);
      if (!this.usbInEndpoint) throw new Error(`IN endpoint 0x${this.epIn.toString(16)} not found`);
    } catch (error) {
      this.usbAttemptFailed(
        `Couldn't claim the board (is another program using it?): ${error && error.message}`,
      );
      await this.cleanupUsb({ status: false });
      this.connecting = false;
      return false;
    }

    // An aborted transfer can leave the data toggles out of step, dropping every packet.
    const inEndpoint = this.usbInEndpoint;
    const outEndpoint = this.usbOutEndpoint;
    await callAsync(inEndpoint, "clearHalt");
    if (overtaken()) return abandon();
    if (outEndpoint) {
      await callAsync(outEndpoint, "clearHalt");
      if (overtaken()) return abandon();
    }

    // Four 64 KB transfers in flight; the device ends each frame with a short packet.
    try {
      inEndpoint.on("data", (data) => {
        if (!data || data.length === 0) {
          // A zero-length packet ends a transfer; it counts as activity.
          this.lastDataMs = Date.now();
          this.silentCycles = 0;
          this.silentStrikes = 0;
          return;
        }
        this.lastDataMs = Date.now();
        this.silentCycles = 0;
        this.silentStrikes = 0;
        try {
          this.ingestBytes(data);
        } catch (error) {
          this.emitEvent({ t: "logline", text: `USB ingest exception: ${error && error.message}` });
        }
      });

      // Next turn: node-usb stops the poll after this event and throws if cleanup did first.
      inEndpoint.on("error", (error) => {
        setImmediate(() => this.onUsbReadError(inEndpoint, error));
      });

      inEndpoint.startPoll(4, 64 * 1024);
    } catch (error) {
      this.usbAttemptFailed(`USB poll failed: ${error && error.message}`);
      await this.cleanupUsb({ status: false });
      this.connecting = false;
      return false;
    }

    this.lastDataMs = Date.now();
    this.connected = true;
    this.connecting = false;
    this.emitStatus("Connected over USB");
    this.log(
      `USB connected: ${this.idsLabel([[this.connectedVid, this.connectedPid]])} ` +
        `at port ${devicePortPath(this.usbDevice)}`,
    );
    return true;
  }

  onUsbReadError(endpoint, error) {
    if (endpoint !== this.usbInEndpoint) return; // that link is already down
    const errno = error && error.errno;
    if (readErrorMeansRemoved(errno, this.usbDevice)) {
      this.emitStatus("Device removed");
      this.emitEvent({ t: "logline", text: `USB device removed (errno=${errno})` });
    } else {
      this.emitStatus(`USB read error: ${errno ?? (error && error.message)}`);
    }
    void this.cleanupUsb({ status: false });
  }

  /** Last-resort recovery: reopens the USB transport, queued behind any switch under way. */
  restartUsbTransport() {
    if (this.hardRestarting || this.suspended) return;
    this.hardRestarting = true;
    this.emitStatus("USB unrecoverable, restarting transport");
    this.emitEvent({
      t: "logline",
      text: "USB did not recover after 3 attempts; restarting the USB transport",
    });
    this.switchChain = this.switchChain
      .catch(() => undefined)
      .then(async () => {
        // A switch queued ahead of this one has already replaced the link.
        if (this.suspended || !this.usbAttemptWanted()) return;
        const reopen = this.reopenAction();
        await this.close({ status: false });
        await reopen();
      })
      .catch(() => undefined)
      .finally(() => {
        this.hardRestarting = false;
      });
  }

  /** Stale-handle watchdog: after a replug, macOS libusb may never fail the old handle. */
  async usbWatchdogTick() {
    if (this.transport !== "usb" || !this.connected || this.hardRestarting) {
      this.lastDataMs = Date.now();
      return;
    }
    const now = Date.now();
    if (now - this.lastDataMs <= STALE_AFTER_MS) return;

    if (!this.autoRecover) {
      // A quiet link is expected with auto recovery off; an unplug still fails the endpoint.
      this.lastDataMs = now;
      return;
    }

    // Three silent reports in a row: reopen, clear-halt and device reset have all failed.
    this.silentStrikes += 1;
    if (this.silentStrikes >= 3) {
      this.silentStrikes = 0;
      this.lastDataMs = now;
      this.restartUsbTransport();
      return;
    }

    this.silentCycles += 1;
    const gen = this.usbGen;
    const device = this.usbDevice;
    if (this.silentCycles >= 2 && device) {
      // After two reopens, a port reset clears device-side state a clear-halt cannot.
      this.log(`USB still silent, resetting device (cycle ${this.silentCycles})`);
      await callAsync(device, "reset");
      // Closed, switched or unplugged meanwhile: nothing left to recover.
      if (gen !== this.usbGen) return;
    } else {
      this.log(
        `USB silent ${Math.floor(STALE_AFTER_MS / 1000)}s, reopening device ` +
          `(clear-halt on reconnect)`,
      );
    }
    this.emitStatus("USB silent, recovering");
    await this.cleanupUsb({ status: false });
    this.lastDataMs = Date.now();
  }

  async reconnectUsbLoop() {
    let backoffMs = 100;
    while (this.running) {
      if (this.transport !== "usb") {
        await sleep(100);
        backoffMs = 100;
        continue;
      }
      if (!this.wantConnected || !this.autoReconnect) {
        await sleep(100);
        backoffMs = 100;
        continue;
      }
      if (this.connected) {
        await this.usbWatchdogTick();
        await sleep(200);
        backoffMs = 100;
        continue;
      }
      let ok = false;
      try {
        ok = await this.tryConnectUsbOnce();
      } catch (error) {
        this.emitStatus(`Connect exception: ${error && error.message}`);
        this.connecting = false;
      }
      if (ok) {
        backoffMs = 100;
        continue;
      }
      await sleep(backoffMs);
      backoffMs = Math.min(300, Math.max(100, backoffMs * 2));
    }
  }

  // TCP transport

  async cleanupTcp({ status = true } = {}) {
    // Not tcpConnected: the socket's close and error handlers clear that as soon as a link
    // drops, before this runs. The socket stays until here, so it marks a link to clean up.
    const hadLink = this.tcpSocket !== null;
    this.tcpConnected = false;
    // `tcpConnecting` is tryConnectTcpOnce's re-entry guard; that method clears it.

    this.parser.reset();
    this.queue.length = 0;
    this.resetStreamInfo();
    if (hadLink) this.emitEvent({ t: "clear_caches" });
    this.linkChallenge = null;

    if (this.tcpSocket) {
      try {
        this.tcpSocket.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        this.tcpSocket.destroy();
      } catch {
        /* ignore */
      }
      this.tcpSocket = null;
    }

    if (status) this.emitStatus("Disconnected");
  }

  /** The TCP attempt in flight settles at once and is neither adopted nor reported. */
  abandonTcpAttempt() {
    this.tcpGen += 1;
    if (this.tcpCancel) this.tcpCancel();
  }

  tcpAttemptIsCurrent(gen) {
    return this.running && this.wantConnected && this.transport === "tcp" && gen === this.tcpGen;
  }

  async tryConnectTcpOnce() {
    if (!this.wantConnected) return false;
    if (this.transport !== "tcp") return false;
    if (this.tcpConnecting) return false;
    this.tcpConnecting = true;
    const attempt = this.runTcpAttempt();
    this.tcpAttempt = attempt;
    try {
      return await attempt;
    } finally {
      // On every exit, a throw included, or no attempt could run again.
      this.tcpConnecting = false;
      if (this.tcpAttempt === attempt) this.tcpAttempt = null;
    }
  }

  async runTcpAttempt() {
    const gen = this.tcpGen;
    const host = this.desiredTcpHost;
    const port = this.desiredTcpPort;

    await this.cleanupTcp({ status: false });
    if (!this.tcpAttemptIsCurrent(gen)) return false;

    this.emitStatus(`Connecting TCP ${host}:${port}…`);

    const socket = await new Promise((resolve) => {
      const s = new net.Socket();
      let settled = false;
      let timer = null;
      const onClose = () => finish(null);
      const cancel = () => finish(null);
      const fail = (text) => {
        if (this.tcpAttemptIsCurrent(gen)) this.emitStatus(text);
        finish(null);
      };
      const onError = (error) => fail(`TCP connect failed: ${error && error.message}`);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.tcpCancel === cancel) this.tcpCancel = null;
        if (value) {
          s.removeListener("error", onError);
          s.removeListener("close", onClose);
        } else {
          try {
            s.destroy();
          } catch {
            /* ignore */
          }
        }
        resolve(value);
      };
      this.tcpCancel = cancel;
      timer = setTimeout(
        () =>
          fail(
            `TCP connect failed: ${host}:${port} timed out after ` +
              `${this.tcpConnectTimeoutMs / 1000} s`,
          ),
        this.tcpConnectTimeoutMs,
      );
      s.on("error", onError);
      s.on("close", onClose);
      try {
        // Throws at once on arguments net rejects, such as a bad port.
        s.connect(port, host, () => finish(s));
      } catch (error) {
        fail(`TCP connect failed: ${error && error.message}`);
      }
    });

    if (!socket) {
      // A stale attempt must not reset the parser under whatever replaced it.
      if (this.tcpAttemptIsCurrent(gen)) await this.cleanupTcp({ status: false });
      return false;
    }

    if (!this.tcpAttemptIsCurrent(gen)) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return false;
    }

    socket.setNoDelay(true); // matches TCP_NODELAY on the device side
    // Nothing else notices a peer that reset or vanished while the host is not writing.
    socket.setKeepAlive(true, TCP_KEEPALIVE_MS);
    this.tcpSocket = socket;
    this.lastTcpDataMs = Date.now();
    this.tcpFramesAtConnect = this.ingestEmittedFrames;
    this.linkHost = host;
    this.linkChallenge = null;
    this.linkAnswered = false;
    this.linkAccepted = false;

    let rxBytes = 0;
    let rxChunks = 0;
    let lastLogMs = 0;
    socket.on("data", (data) => {
      if (!data || data.length === 0) return;
      this.lastTcpDataMs = Date.now();
      rxBytes += data.length;
      rxChunks += 1;
      const now = Date.now();
      if (now - lastLogMs >= HEARTBEAT_LOG_MS) {
        this.emitEvent({ t: "logline", text: `TCP rx: ${rxBytes} bytes / ${rxChunks} chunks` });
        lastLogMs = now;
      }
      try {
        this.ingestBytes(data);
      } catch (error) {
        this.emitEvent({ t: "logline", text: `TCP ingest exception: ${error && error.message}` });
      }
    });

    socket.on("error", (error) => {
      this.emitEvent({ t: "logline", text: `TCP error: ${error && error.message}` });
      this.emitStatus(`TCP error: ${error && error.message}`);
      this.tcpConnected = false;
    });

    socket.on("close", () => {
      this.emitEvent({
        t: "logline",
        text: `TCP connection closed after ${rxBytes} bytes`,
      });
      this.emitStatus("TCP disconnected");
      this.tcpConnected = false;
      if (this.linkAnswered && !this.linkAccepted) {
        // Closed on the answer: the key is wrong.
        this.linkKeys.delete(host);
        this.emitEvent({ t: "link_key_needed", host, wrong: true });
      }
      this.linkAnswered = false;
    });

    this.tcpConnected = true;
    this.emitStatus("Connected");
    return true;
  }

  onLinkChallenge(challenge) {
    this.linkChallenge = challenge;
    if (this.linkKeys.has(this.linkHost)) this.answerLinkChallenge();
    else this.emitEvent({ t: "link_key_needed", host: this.linkHost, wrong: false });
  }

  answerLinkChallenge() {
    const challenge = this.linkChallenge;
    const key = this.linkKeys.get(this.linkHost);
    const socket = this.tcpSocket;
    if (!challenge || !key || !socket) return;
    this.linkChallenge = null;
    this.linkAnswered = true;
    this.linkAccepted = false;
    try {
      socket.write(frameHostCommand(linkAnswer(key, challenge)));
      this.log("link key: answered the board");
    } catch (error) {
      this.log(`link key: the answer failed: ${error && error.message}`);
    }
  }

  /** Key for `host`: answers its waiting challenge, and every reconnect to it this session. */
  setLinkKey(host, key) {
    if (typeof host !== "string" || typeof key !== "string" || !key) return;
    this.linkKeys.set(host, Buffer.from(key, "utf8"));
    if (host === this.linkHost) this.answerLinkChallenge();
  }

  /** TCP liveness once a link has carried video; a quiet sensor sketch is not a lost link. */
  tcpWatchdogTick() {
    const socket = this.tcpSocket;
    if (!socket || socket.destroyed) return;
    if (this.ingestEmittedFrames === this.tcpFramesAtConnect) return;
    const silentMs = Date.now() - this.lastTcpDataMs;
    if (silentMs <= this.tcpStaleAfterMs) return;
    this.emitEvent({
      t: "logline",
      text: `TCP silent for ${Math.round(silentMs / 1000)} s after video, reconnecting`,
    });
    // The 'close' handler reports the loss and clears tcpConnected.
    socket.destroy();
  }

  async reconnectTcpLoop() {
    let backoffMs = 200;
    while (this.running) {
      if (this.transport !== "tcp") {
        await sleep(100);
        backoffMs = 200;
        continue;
      }
      if (!this.wantConnected || !this.autoReconnect) {
        await sleep(100);
        backoffMs = 200;
        continue;
      }
      if (this.tcpConnected) {
        this.tcpWatchdogTick();
        await sleep(200);
        backoffMs = 200;
        continue;
      }
      let ok = false;
      try {
        ok = await this.tryConnectTcpOnce();
      } catch (error) {
        this.emitStatus(`TCP connect exception: ${error && error.message}`);
        this.tcpConnecting = false;
      }
      if (ok) {
        backoffMs = 200;
        continue;
      }
      await sleep(backoffMs);
      backoffMs = Math.min(2000, Math.max(200, backoffMs * 2));
    }
  }

  _startLoops() {
    void this.reconnectUsbLoop();
    void this.reconnectTcpLoop();
  }

  // Public commands

  async open({
    ids,
    itf = 0,
    epIn = 0x81,
    epOut = 0x01,
    auto = true,
    bus = null,
    ports = null,
  } = {}) {
    if (this.suspended) {
      return this.deferWhileSuspended(() => this.open({ ids, itf, epIn, epOut, auto, bus, ports }));
    }
    if (!usbAllowed) {
      // Any link that is up stays: there is no USB to switch to.
      this.emitStatus(USB_OFF_STATUS);
      return;
    }
    this.desiredIds =
      Array.isArray(ids) && ids.length
        ? ids.filter((p) => Array.isArray(p) && p.length >= 2)
        : DEVICE_IDENTITIES;
    if (!this.desiredIds.length) this.desiredIds = DEVICE_IDENTITIES;
    this.itfNum = itf;
    this.epIn = epIn;
    this.epOut = epOut;
    this.autoReconnect = auto;
    this.desiredBus = typeof bus === "number" ? bus : null;
    this.desiredPorts = Array.isArray(ports) ? ports : null;

    if (this.transport === "tcp") await this.cleanupTcp({ status: false });
    this.transport = "usb";
    this.wantConnected = true;
    this.usbRetryStatus = null; // an explicit open reports afresh
    this.resetStreamInfo();

    await this.tryConnectUsbOnce();
  }

  async openTcp({ host = WIFI_DEFAULT_HOST, port = WIFI_DEFAULT_PORT, auto = true } = {}) {
    if (this.suspended) return this.deferWhileSuspended(() => this.openTcp({ host, port, auto }));
    if (!isValidTcpTarget(host, port)) {
      this.emitStatus(`TCP connect failed: invalid address ${host}:${port}`);
      return;
    }
    this.desiredTcpHost = host;
    this.desiredTcpPort = port;
    this.autoReconnect = auto;
    // An attempt in flight is for the old target, or a retry this replaces.
    this.abandonTcpAttempt();
    const pending = this.tcpAttempt;

    if (this.transport === "usb") await this.cleanupUsb({ status: false });
    this.transport = "tcp";
    this.wantConnected = true;
    this.resetStreamInfo();

    // It unwinds first, so this call starts the new attempt itself.
    if (pending) await pending.catch(() => false);
    await this.tryConnectTcpOnce();
  }

  /** Tears the old transport all the way down before bringing the new one up. */
  switchTransport(mode, { host, port, board } = {}) {
    if (this.suspended) {
      return this.deferWhileSuspended(() => this.switchTransport(mode, { host, port, board }));
    }
    const run = this.switchChain.then(async () => {
      await this.close({ status: false });
      if (mode === "wifi") {
        await this.openTcp({ host: host || WIFI_DEFAULT_HOST, port: port || WIFI_DEFAULT_PORT });
      } else if (mode === "ethernet") {
        await this.openTcp({
          host: host || ETHERNET_DEFAULT_HOST,
          port: port || ETHERNET_DEFAULT_PORT,
        });
      } else {
        await this.open({
          bus: board ? board.bus : null,
          ports: board ? board.ports : null,
        });
      }
    });
    // The caller sees a failure, but later switches must still run.
    this.switchChain = run.catch(() => undefined);
    return run;
  }

  async close({ status = true } = {}) {
    this.wantConnected = false;
    this.resumeAction = null; // an explicit close outranks a pending resume
    this.abandonTcpAttempt();
    if (this.transport === "tcp") await this.cleanupTcp({ status });
    else await this.cleanupUsb({ status });
    if (status) this.emitStatus("Closed");
  }

  /**
   * One host->device packet, such as 'ISP0', 'CAM0', 'TUN0' or 'SUB0': one bulk OUT
   * transfer over USB, behind a frame header over TCP. Only failures are logged.
   */
  write(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const failed = (why) =>
      this.emitEvent({ t: "logline", text: `Command not sent (${buffer.length} bytes): ${why}` });
    if (this.transport === "tcp") {
      if (!this.tcpSocket || !this.tcpConnected) {
        failed("no network connection");
        return;
      }
      if (!buffer.length) return;
      try {
        this.tcpSocket.write(frameHostCommand(buffer));
      } catch (error) {
        failed(error && error.message);
      }
      return;
    }

    // Gated on the endpoint only: `connected` can lag the USB state during reconnects.
    if (!this.usbOutEndpoint) {
      failed("no USB connection");
      return;
    }
    if (!buffer.length) return;

    try {
      this.usbOutEndpoint.timeout = 500;
      this.usbOutEndpoint.transfer(buffer, (error) => {
        if (error) failed(`USB error ${error.errno ?? error.message}`);
      });
    } catch (error) {
      failed(error && error.message);
    }
  }

  setAutoRecover(on) {
    this.autoRecover = on !== false;
  }

  /**
   * Hands the board to the bootloader tool until resume(). Open requests made
   * meanwhile are replayed then.
   */
  async suspend() {
    if (this.suspended) return;
    this.suspended = true;
    // A queued switch runs first; the guard defers its open() until resume().
    await this.switchChain.catch(() => undefined);
    if (!this.resumeAction && this.wantConnected) this.resumeAction = this.reopenAction();
    this.wantConnected = false;
    // An attempt past its wantConnected check can still claim the device.
    const deadline = Date.now() + SUSPEND_SETTLE_MS;
    while ((this.connecting || this.tcpConnecting) && Date.now() < deadline) await sleep(50);
    if (this.transport === "tcp") await this.cleanupTcp({ status: false });
    else await this.cleanupUsb({ status: false });
    this.emitStatus(SUSPENDED_STATUS);
  }

  /** Reconnect to whatever was wanted before suspend(), or asked for since. */
  async resume() {
    if (!this.suspended) return;
    this.suspended = false;
    const action = this.resumeAction;
    this.resumeAction = null;
    if (!this.running) return;
    if (action) await action();
    else this.emitStatus("Closed");
  }

  deferWhileSuspended(action) {
    this.resumeAction = action;
    this.emitStatus(SUSPENDED_STATUS);
    return Promise.resolve();
  }

  reopenAction() {
    if (this.transport === "tcp") {
      const options = {
        host: this.desiredTcpHost,
        port: this.desiredTcpPort,
        auto: this.autoReconnect,
      };
      return () => this.openTcp(options);
    }
    const options = {
      ids: this.desiredIds,
      itf: this.itfNum,
      epIn: this.epIn,
      epOut: this.epOut,
      auto: this.autoReconnect,
      bus: this.desiredBus,
      ports: this.desiredPorts,
    };
    return () => this.open(options);
  }

  async stop() {
    this.running = false;
    this.wantConnected = false;
    this.abandonTcpAttempt();
    await this.cleanupUsb({ status: false });
    await this.cleanupTcp({ status: false });
    this.removeAllListeners();
  }
}

module.exports = {
  DeviceSession,
  listUsbBoards,
  listUsbBoardsWithSerials,
  setUsbAllowed,
  USB_OFF_STATUS,
  DEVICE_IDENTITIES,
  WIFI_DEFAULT_HOST,
  WIFI_DEFAULT_PORT,
  ETHERNET_DEFAULT_HOST,
  ETHERNET_DEFAULT_PORT,
};
