// The USB half of the transport session, against a fake node-usb.

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceSession,
  listUsbBoards,
  listUsbBoardsWithSerials,
} from "../electron/device/session.cjs";

const LIBUSB = {
  LIBUSB_TRANSFER_ERROR: 1,
  LIBUSB_TRANSFER_STALL: 4,
  LIBUSB_TRANSFER_NO_DEVICE: 5,
  LIBUSB_ERROR_IO: -1,
  LIBUSB_ERROR_NO_DEVICE: -4,
};

/** Delays the fake applies, in ms. Tests raise them to open race windows. */
const delays = { clearHalt: 0, release: 0 };
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

class FakeInEndpoint extends EventEmitter {
  address: number;
  direction = "in";
  pollActive = false;
  pollPending = 0;

  constructor(address: number) {
    super();
    this.address = address;
  }

  clearHalt(done: () => void) {
    later(delays.clearHalt, done);
  }

  startPoll(transfers: number) {
    if (this.pollActive) throw new Error("Polling already active");
    this.pollActive = true;
    this.pollPending = transfers;
  }

  stopPoll() {
    if (!this.pollActive) throw new Error("Polling is not active.");
    this.pollActive = false;
    setImmediate(() => {
      this.pollPending = 0;
      this.emit("end");
    });
  }

  /** node-usb's failed transfer: the error event, then its own stopPoll() in the same turn. */
  fail(errno: number) {
    if (!this.pollActive) return;
    this.emit("error", Object.assign(new Error(`transfer ${errno}`), { errno }));
    this.stopPoll();
  }
}

class FakeOutEndpoint {
  address: number;
  direction = "out";
  timeout = 0;

  constructor(address: number) {
    this.address = address;
  }

  clearHalt(done: () => void) {
    later(delays.clearHalt, done);
  }
}

class FakeInterface {
  interfaceNumber = 0;
  endpoints: [FakeInEndpoint, FakeOutEndpoint];
  claimed = false;

  constructor() {
    this.endpoints = [new FakeInEndpoint(0x81), new FakeOutEndpoint(0x01)];
  }

  isKernelDriverActive() {
    return false;
  }

  claim() {
    this.claimed = true;
  }

  release(_closeEndpoints: boolean, done: () => void) {
    later(delays.release, () => {
      this.claimed = false;
      done();
    });
  }

  endpoint(address: number) {
    return this.endpoints.find((e) => e.address === address);
  }
}

class FakeDevice {
  deviceDescriptor: { idVendor: number; idProduct: number; iSerialNumber: number };
  busNumber: number;
  portNumbers: number[];
  configDescriptor: { interfaces: { bInterfaceNumber: number; bInterfaceClass: number }[][] };
  interfaces: FakeInterface[] | undefined = undefined;
  handleOpen = false;
  opens = 0;
  closes = 0;
  resets = 0;
  serial: string;

  constructor(
    port: number,
    { vid = 0x1209, pid = 0x8008, itfClass = 0xff, serial = `SN${port}` } = {},
  ) {
    this.deviceDescriptor = { idVendor: vid, idProduct: pid, iSerialNumber: 3 };
    this.busNumber = 1;
    this.portNumbers = [port];
    this.configDescriptor = { interfaces: [[{ bInterfaceNumber: 0, bInterfaceClass: itfClass }]] };
    this.serial = serial;
  }

  /** Like node-usb: a second open in the same process reuses the handle. */
  open(defaultConfig = true) {
    if (!this.handleOpen) {
      this.handleOpen = true;
      this.opens += 1;
    }
    this.interfaces = defaultConfig ? [new FakeInterface()] : [];
  }

  close() {
    if (!this.handleOpen) throw new Error("not open");
    const pending = this.interfaces?.some((i) => i.endpoints[0].pollPending > 0);
    if (pending) throw new Error("Can't close device with a pending request");
    this.handleOpen = false;
    this.closes += 1;
    this.interfaces = undefined;
  }

  interface(n: number) {
    const found = this.interfaces?.[n];
    if (!found) throw new Error(`Interface not found for address: ${n}`);
    return found;
  }

  setAutoDetachKernelDriver() {}

  reset(done: () => void) {
    this.resets += 1;
    later(0, done);
  }

  getStringDescriptor(_index: number, done: (error: unknown, value?: string) => void) {
    later(0, () => done(undefined, this.serial));
  }

  get inEndpoint(): FakeInEndpoint {
    return this.interfaces![0].endpoints[0];
  }
}

let attached: FakeDevice[] = [];
const fakeUsb = { getDeviceList: () => [...attached], usb: LIBUSB };
const nodeRequire = createRequire(import.meta.url);
nodeRequire.cache[nodeRequire.resolve("usb")] = { exports: fakeUsb } as never;

type Event = { t: string; text?: string };

/** No reconnect loop: each test drives the attempts itself. */
class TestSession extends DeviceSession {
  events: Event[] = [];

  constructor() {
    super();
    this.on("event", (event: Event) => this.events.push(event));
  }

  _startLoops() {}

  get statuses() {
    return this.events.filter((e) => e.t === "status").map((e) => e.text);
  }

  count(t: string) {
    return this.events.filter((e) => e.t === t).length;
  }
}

const sessions: TestSession[] = [];
function session() {
  const s = new TestSession();
  sessions.push(s);
  return s;
}

const openAny = (s: DeviceSession) => s.open({});
const openPinned = (s: DeviceSession, port: number) =>
  (s.open as (options: object) => Promise<void>).call(s, { bus: 1, ports: [port] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  attached = [];
  delays.clearHalt = 0;
  delays.release = 0;
});

describe("USB board ownership across windows", () => {
  it("gives a second window the next free board, not the one already streaming", async () => {
    const a = new FakeDevice(3);
    const b = new FakeDevice(4);
    attached = [a, b];
    const one = session();
    const two = session();

    await openAny(one);
    await openAny(two);

    expect(one.connected).toBe(true);
    expect(two.connected).toBe(true);
    expect(one.usbDevice).toBe(a);
    expect(two.usbDevice).toBe(b);
    expect(a.opens).toBe(1);
  });

  it("reports a board held by another window instead of sharing its handle", async () => {
    const a = new FakeDevice(3);
    attached = [a];
    const one = session();
    const two = session();
    await openAny(one);

    await openAny(two);
    expect(two.connected).toBe(false);
    expect(two.statuses.at(-1)).toBe("Board at USB port 1-3 is in use by another window");

    await openPinned(two, 3);
    expect(two.connected).toBe(false);
    expect(two.statuses.at(-1)).toBe("Board at USB port 1-3 is in use by another window");
    expect(a.inEndpoint.pollActive).toBe(true);

    await one.close();
    expect(await two.tryConnectUsbOnce()).toBe(true);
    expect(two.usbDevice).toBe(a);
  });

  it("never lets a stale entry block a board that was plugged back in", async () => {
    const old = new FakeDevice(3);
    attached = [old];
    const one = session();
    await openAny(one);

    // Replugged before the first window noticed: node-usb gives it a new Device object.
    const replugged = new FakeDevice(3);
    attached = [replugged];
    const two = session();
    await openPinned(two, 3);
    expect(two.connected).toBe(true);
    expect(two.usbDevice).toBe(replugged);
  });

  it("marks boards in use for other windows only, and never opens them for a serial", async () => {
    const a = new FakeDevice(3);
    const b = new FakeDevice(4);
    attached = [a, b];
    const one = session();
    const two = session();
    await openPinned(one, 3);

    expect(listUsbBoards(one).map((x) => x.inUse)).toEqual([false, false]);
    expect(listUsbBoards(two).map((x) => x.inUse)).toEqual([true, false]);

    const boards = await listUsbBoardsWithSerials(two);
    expect(boards.map((x) => [x.portPath, x.serial, x.inUse])).toEqual([
      ["1-3", null, true],
      ["1-4", "SN4", false],
    ]);
    expect(a.opens).toBe(1);
    expect(a.inEndpoint.pollActive).toBe(true);
    expect(b.handleOpen).toBe(false);

    // A serial read before the board was taken is still shown after.
    await openPinned(two, 4);
    const again = await listUsbBoardsWithSerials(one);
    expect(again.map((x) => [x.serial, x.inUse])).toEqual([
      [null, false],
      ["SN4", true],
    ]);
    expect(b.opens).toBe(2); // once for the serial, once by the session
  });
});

describe("USB hard restart", () => {
  const silent = (s: DeviceSession) => {
    s.lastDataMs = Date.now() - 6000;
    return s.usbWatchdogTick();
  };

  it("comes back to the pinned board, not the first one listed", async () => {
    const other = new FakeDevice(4);
    const pinned = new FakeDevice(3);
    attached = [other, pinned];
    const s = session();
    await openPinned(s, 3);

    for (let episode = 0; episode < 2; episode += 1) {
      await silent(s);
      expect(s.connected).toBe(false);
      expect(await s.tryConnectUsbOnce()).toBe(true);
    }
    expect(pinned.resets).toBe(1);

    await silent(s);
    expect(s.statuses).toContain("USB unrecoverable, restarting transport");
    await s.switchChain;

    expect(s.connected).toBe(true);
    expect(s.usbDevice).toBe(pinned);
    expect(s.desiredBus).toBe(1);
    expect(s.desiredPorts).toEqual([3]);
    expect(other.opens).toBe(0);
    // The restart did not also run the tick's own reset and cleanup.
    expect(pinned.resets).toBe(1);
  });

  it("needs three silent reports in a row: data in between starts the count again", async () => {
    attached = [new FakeDevice(3)];
    const s = session();
    await openAny(s);

    for (let episode = 0; episode < 4; episode += 1) {
      await silent(s);
      expect(await s.tryConnectUsbOnce()).toBe(true);
      (s.usbInEndpoint as FakeInEndpoint).emit("data", Buffer.alloc(0));
    }
    expect(s.statuses).not.toContain("USB unrecoverable, restarting transport");
  });
});

describe("USB read errors", () => {
  it("reports an unplug as Device removed, and survives node-usb stopping the poll", async () => {
    const a = new FakeDevice(3);
    attached = [a];
    const s = session();
    await openAny(s);
    const endpoint = a.inEndpoint;

    attached = [];
    endpoint.fail(LIBUSB.LIBUSB_TRANSFER_NO_DEVICE); // would throw if cleanup stopped it first
    await settle();

    expect(s.statuses.at(-1)).toBe("Device removed");
    expect(s.connected).toBe(false);
    expect(s.usbDevice).toBe(null);
  });

  it("counts a generic transfer error as removal only when the board has gone", async () => {
    const a = new FakeDevice(3);
    attached = [a];
    const s = session();
    await openAny(s);
    a.inEndpoint.fail(LIBUSB.LIBUSB_TRANSFER_ERROR);
    await settle();
    expect(s.statuses.at(-1)).toBe("USB read error: 1");

    expect(await s.tryConnectUsbOnce()).toBe(true);
    attached = [];
    a.inEndpoint.fail(LIBUSB.LIBUSB_TRANSFER_ERROR);
    await settle();
    expect(s.statuses.at(-1)).toBe("Device removed");
  });
});

describe("USB teardown ordering", () => {
  it("a Disconnect during an attempt's opening cleanup leaves nothing streaming", async () => {
    const a = new FakeDevice(3);
    attached = [a];
    const s = session();
    await openAny(s);
    delays.release = 20;

    // A read error; the next attempt starts while cleanup still releases, then a disconnect.
    a.inEndpoint.fail(LIBUSB.LIBUSB_TRANSFER_STALL);
    await new Promise((resolve) => setImmediate(resolve));
    const attempt = s.tryConnectUsbOnce();
    await s.close();
    expect(await attempt).toBe(false);
    await settle();

    expect(s.connected).toBe(false);
    expect(s.usbInEndpoint).toBe(null);
    expect(a.handleOpen).toBe(false);
    expect(a.interfaces).toBe(undefined);
    expect(s.statuses.at(-1)).toBe("Closed");
  });

  it("a Disconnect while an attempt waits on clear-halt drops that attempt quietly", async () => {
    const a = new FakeDevice(3);
    attached = [a];
    const s = session();
    delays.clearHalt = 20;

    const attempt = openAny(s);
    await settle();
    await s.close();
    await attempt;
    await settle();

    expect(s.connected).toBe(false);
    expect(a.handleOpen).toBe(false);
    expect(s.statuses.some((t) => t?.startsWith("USB poll failed"))).toBe(false);
    expect(s.statuses.at(-1)).toBe("Closed");

    const two = session();
    delays.clearHalt = 0;
    await openAny(two);
    expect(two.usbDevice).toBe(a);
  });
});

describe("USB retry churn", () => {
  it("sends clear_caches once per lost link and unchanged retry statuses once", async () => {
    const s = session();
    await openAny(s);
    for (let i = 0; i < 5; i += 1) await s.tryConnectUsbOnce();
    expect(s.count("clear_caches")).toBe(0);
    expect(s.statuses).toEqual(["Connecting over USB…", "Waiting for a board on USB"]);

    attached = [new FakeDevice(3)];
    expect(await s.tryConnectUsbOnce()).toBe(true);
    expect(s.statuses.at(-1)).toBe("Connected over USB");
    await s.close();
    expect(s.count("clear_caches")).toBe(1);
  });
});

describe("USB board in its bootloader", () => {
  it("is not claimed, and an app board listed after it is used instead", async () => {
    const fsbl = new FakeDevice(3, { vid: 0xcafe, pid: 0x4013, itfClass: 0x02 });
    attached = [fsbl];
    const s = session();
    await openAny(s);
    expect(s.connected).toBe(false);
    expect(fsbl.opens).toBe(0);
    expect(s.statuses.at(-1)).toBe("Board at USB port 1-3 is in its bootloader, not streaming");

    const legacyApp = new FakeDevice(4, { vid: 0xcafe, pid: 0x4013 });
    attached = [fsbl, legacyApp];
    expect(await s.tryConnectUsbOnce()).toBe(true);
    expect(s.usbDevice).toBe(legacyApp);
  });
});
