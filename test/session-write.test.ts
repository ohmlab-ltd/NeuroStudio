// What session.write() logs to the Terminal, and its framing over TCP.

import { describe, expect, it } from "vitest";
import { DeviceSession } from "../electron/device/session.cjs";
import { buildEvidenceSubscriptionPacket, kEvidenceCrop } from "../src/device/packets";

/** Never touches USB or TCP: endpoints are stubbed per test. */
class WriteOnlySession extends DeviceSession {
  _startLoops() {}
}

type Transfer = (buffer: Buffer, done: (error?: { errno: number }) => void) => void;

function usbSession(transfer: Transfer) {
  const session = new WriteOnlySession();
  session.transport = "usb";
  session.usbOutEndpoint = { timeout: 0, transfer };
  const lines: string[] = [];
  session.on("event", (e: { t: string; text?: string }) => {
    if (e.t === "logline") lines.push(e.text ?? "");
  });
  return { session, lines };
}

const SUB0 = buildEvidenceSubscriptionPacket(kEvidenceCrop);
const OTHER = new Uint8Array([0x54, 0x55, 0x4e, 0x30, 1, 2, 3, 4]); // same length, other magic

describe("session.write logging", () => {
  it("logs nothing when a packet is sent", () => {
    const { session, lines } = usbSession((_b, done) => done());
    session.write(SUB0);
    session.write(OTHER);
    session.write(buildEvidenceSubscriptionPacket(0));
    expect(lines).toEqual([]);
  });

  it("logs a packet the USB transfer fails", () => {
    const { session, lines } = usbSession((_b, done) => done({ errno: -7 }));
    session.write(SUB0);
    expect(lines).toEqual(["Command not sent (8 bytes): USB error -7"]);
  });

  it("logs a packet dropped for want of a USB handle", () => {
    const { session, lines } = usbSession(() => undefined);
    session.usbOutEndpoint = null;
    session.write(OTHER);
    expect(lines).toEqual(["Command not sent (8 bytes): no USB connection"]);
  });

  it("logs nothing over TCP when packets are sent, and a drop when not connected", () => {
    const { session, lines } = usbSession(() => undefined);
    session.transport = "tcp";
    session.tcpConnected = true;
    const sent: number[] = [];
    session.tcpSocket = { write: (b: Buffer) => sent.push(b.length) };
    session.write(SUB0);
    session.write(OTHER);
    expect(sent).toEqual([28, 28]);
    expect(lines).toEqual([]);
    session.tcpConnected = false;
    session.write(OTHER);
    expect(lines).toEqual(["Command not sent (8 bytes): no network connection"]);
  });
});

describe("session.write over TCP", () => {
  function tcpSession() {
    const { session } = usbSession(() => undefined);
    session.transport = "tcp";
    session.tcpConnected = true;
    const sent: Buffer[] = [];
    session.tcpSocket = { write: (b: Buffer) => sent.push(b) };
    return { session, sent };
  }

  it("puts each packet behind a frame header, as the board's network link requires", () => {
    const { session, sent } = tcpSession();
    session.write(SUB0);
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    expect(frame.subarray(0, 4).toString("latin1")).toBe("DNV0");
    expect(frame.readUInt32LE(4)).toBe(0); // frame_id
    expect(frame.readUInt32LE(8)).toBe(0); // meta_len
    expect(frame.readUInt32LE(12)).toBe(SUB0.length); // payload_len
    expect(frame.readUInt32LE(16)).toBe(0); // flags
    expect([...frame.subarray(20)]).toEqual([...SUB0]);
  });

  it("sends nothing for an empty packet", () => {
    const { session, sent } = tcpSession();
    session.write(new Uint8Array(0));
    expect(sent).toEqual([]);
  });
});
