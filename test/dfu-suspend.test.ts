// DeviceSession suspend and resume: nothing reopens the board until resume().

import { describe, expect, it } from "vitest";
import { DeviceSession } from "../electron/device/session.cjs";

/** No loops and no libusb: records the connects that would have happened. */
class RecordingSession extends DeviceSession {
  connects: string[] = [];
  statuses: string[] = [];

  constructor() {
    super();
    this.on("event", (event: { t: string; text?: string }) => {
      if (event.t === "status" && event.text) this.statuses.push(event.text);
    });
  }

  _startLoops() {}

  async tryConnectUsbOnce() {
    this.connects.push("usb");
    return true;
  }

  async tryConnectTcpOnce() {
    this.connects.push("tcp");
    return true;
  }
}

/** open() takes its option types from the JS defaults, where bus and ports are null. */
const openPinned = (session: DeviceSession) =>
  (session.open as (options: object) => Promise<void>).call(session, { bus: 1, ports: [3] });

describe("DeviceSession suspend/resume", () => {
  it("refuses every open while suspended and reconnects the same board after", async () => {
    const session = new RecordingSession();
    await openPinned(session);
    await session.suspend();

    expect(session.wantConnected).toBe(false);
    expect(session.statuses.at(-1)).toMatch(/^Disconnected/);

    await session.open({});
    await session.openTcp({});
    expect(session.connects).toEqual(["usb"]);

    // The latest request made while suspended is the one resume() honours.
    await openPinned(session);
    await session.resume();
    expect(session.connects).toEqual(["usb", "usb"]);
    expect(session.desiredBus).toBe(1);
    expect(session.desiredPorts).toEqual([3]);
  });

  it("brings back a live connection without being asked", async () => {
    const session = new RecordingSession();
    await session.openTcp({ host: "192.168.20.1", port: 5000 });
    await session.suspend();
    await session.resume();
    expect(session.connects).toEqual(["tcp", "tcp"]);
    expect(session.desiredTcpHost).toBe("192.168.20.1");
  });

  it("defers a transport switch until resume", async () => {
    const session = new RecordingSession();
    await session.open({});
    await session.suspend();
    await session.switchTransport("wifi", {});
    expect(session.connects).toEqual(["usb"]);
    await session.resume();
    expect(session.connects).toEqual(["usb", "tcp"]);
  });

  it("leaves a closed session closed", async () => {
    const session = new RecordingSession();
    await session.suspend();
    await session.resume();
    expect(session.connects).toEqual([]);
    expect(session.statuses.at(-1)).toBe("Closed");

    await session.open({});
    await session.suspend();
    await session.close({ status: false }); // an explicit close wins
    await session.resume();
    expect(session.connects).toEqual(["usb"]);
  });
});
