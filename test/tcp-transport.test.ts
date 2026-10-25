// TCP transport against local servers: timeouts, bad endpoints, switching and liveness.

import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceSession } from "../electron/device/session.cjs";
import { findMetaIpv4, metaHasPerPacketTlv } from "../electron/device/parser.cjs";
import { u16, u32 } from "./bytes";

/** No reconnect loops: every connect is driven by the test. */
class QuietSession extends DeviceSession {
  _startLoops() {}
}

/** The TCP reconnect loop only, so libusb is never touched. */
class LoopingSession extends DeviceSession {
  _startLoops() {
    void this.reconnectTcpLoop();
  }
}

interface Emitted {
  t: string;
  text?: string;
  id?: number;
}

const sessions: DeviceSession[] = [];
const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.stop();
  for (const close of servers.splice(0)) await close();
});

function track<T extends DeviceSession>(session: T) {
  sessions.push(session);
  const events: Emitted[] = [];
  session.on("event", (e: Emitted) => events.push(e));
  const statuses = () => events.filter((e) => e.t === "status").map((e) => e.text ?? "");
  const logs = () => events.filter((e) => e.t === "logline").map((e) => e.text ?? "");
  return { session, events, statuses, logs };
}

async function listen(onConnection: (socket: net.Socket) => void = () => undefined) {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => undefined);
    socket.resume(); // so a client hang-up is seen
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of accepted) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { port, accepted };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Smallest payload looksLikeJpeg accepts: SOI, filler, EOI, 200 bytes. */
const JPEG = [0xff, 0xd8, ...new Array<number>(196).fill(0), 0xff, 0xd9];

function vendorFrame(id: number, meta: number[], jpeg: number[] = []): Buffer {
  return Buffer.from([
    ...u32(0x30564e44),
    ...u32(id),
    ...u32(meta.length),
    ...u32(jpeg.length),
    ...u32(0),
    ...meta,
    ...jpeg,
  ]);
}

const tlv = (type: number, len: number) => [type, ...u16(len), ...new Array<number>(len).fill(0)];

/** net.Socket.connect without its overloads, for wrapping in a spy. */
type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;
const realConnect = () => net.Socket.prototype.connect as unknown as Connect;

describe("TCP connect", () => {
  it("reports a connect that never completes as a failure", async () => {
    // A SYN dropped on the floor: connect never calls back and never errors.
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
      return this;
    });
    const { session, statuses } = track(new QuietSession());
    session.tcpConnectTimeoutMs = 50;

    await session.openTcp({ host: "192.168.10.1", port: 5000 });

    expect(statuses().at(-2)).toBe("Connecting TCP 192.168.10.1:5000…");
    expect(statuses().at(-1)).toMatch(/^TCP connect failed: 192\.168\.10\.1:5000 timed out/);
    expect(session.tcpConnecting).toBe(false);
    expect(session.tcpConnected).toBe(false);
  });

  it("turns on keepalive for an adopted socket", async () => {
    const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const server = await listen();
    const { session, statuses } = track(new QuietSession());

    await session.openTcp({ host: "127.0.0.1", port: server.port });

    expect(statuses().at(-1)).toBe("Connected");
    expect(keepAlive).toHaveBeenCalledWith(true, 1000);
  });

  it("recovers when connect throws", async () => {
    const { session, statuses } = track(new QuietSession());
    // Past openTcp's own check, as a port set some other way would be.
    session.transport = "tcp";
    session.wantConnected = true;
    session.desiredTcpHost = "127.0.0.1";
    session.desiredTcpPort = 70000;

    expect(await session.tryConnectTcpOnce()).toBe(false);
    expect(session.tcpConnecting).toBe(false);
    expect(statuses().at(-1)).toMatch(/^TCP connect failed: .*70000/);

    const server = await listen();
    await session.openTcp({ host: "127.0.0.1", port: server.port });
    expect(session.tcpConnected).toBe(true);
  });
});

describe("TCP retry churn", () => {
  it("sends clear_caches once per lost link, not on every failed attempt", async () => {
    const { session, events } = track(new QuietSession());
    const count = () => events.filter((e) => e.t === "clear_caches").length;
    session.transport = "tcp";
    session.wantConnected = true;
    session.desiredTcpHost = "127.0.0.1";
    session.desiredTcpPort = 1; // nothing listens here
    session.tcpConnectTimeoutMs = 50;

    for (let i = 0; i < 5; i += 1) await session.tryConnectTcpOnce();
    expect(count()).toBe(0);

    const server = await listen();
    await session.openTcp({ host: "127.0.0.1", port: server.port });
    expect(session.tcpConnected).toBe(true);
    await session.close();
    expect(count()).toBe(1);
  });
});

describe("TCP endpoints", () => {
  it("refuses a port net would throw on without wedging later switches", async () => {
    const { session, statuses } = track(new QuietSession());

    await session.switchTransport("wifi", { host: "192.168.1.110", port: 70000 });
    expect(statuses().at(-1)).toBe("TCP connect failed: invalid address 192.168.1.110:70000");
    expect(session.tcpConnecting).toBe(false);

    const server = await listen();
    await session.switchTransport("ethernet", { host: "127.0.0.1", port: server.port });
    expect(session.tcpConnected).toBe(true);
    expect(statuses().at(-1)).toBe("Connected");
  });

  it("refuses a non-numeric port", async () => {
    const { session, statuses } = track(new QuietSession());
    await session.openTcp({ host: "192.168.1.110", port: "5000" as unknown as number });
    expect(statuses()).toEqual(["TCP connect failed: invalid address 192.168.1.110:5000"]);
    expect(session.wantConnected).toBe(false);
  });

  it("keeps running switches after one fails", async () => {
    class FailingOpen extends QuietSession {
      failures = 1;
      async open() {
        if (this.failures-- > 0) throw new Error("open blew up");
      }
    }
    const { session } = track(new FailingOpen());
    await expect(session.switchTransport("usb")).rejects.toThrow("open blew up");

    const server = await listen();
    await session.switchTransport("ethernet", { host: "127.0.0.1", port: server.port });
    expect(session.tcpConnected).toBe(true);
  });

  it("drops board announces nobody can connect to", () => {
    const announce = (a: number[], port: number) =>
      Buffer.from([0x20, ...u16(8), ...a, ...u32(port)]);
    expect(findMetaIpv4(announce([192, 168, 1, 110], 5000))).toEqual({
      host: "192.168.1.110",
      port: 5000,
    });
    expect(findMetaIpv4(announce([192, 168, 1, 110], 0))).toBeNull();
    expect(findMetaIpv4(announce([192, 168, 1, 110], 70000))).toBeNull();
    expect(findMetaIpv4(announce([0, 0, 0, 0], 5000))).toBeNull();
  });
});

describe("TCP target switching", () => {
  it("abandons an in-flight connect to the old target", async () => {
    const oldTarget = await listen();
    const newTarget = await listen();
    const original = realConnect();
    // Holds the connect to the old target back, as a slow network would.
    const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      if (args[0] === oldTarget.port) {
        setTimeout(() => {
          if (!this.destroyed) original.apply(this, args);
        }, 150);
        return this;
      }
      return original.apply(this, args);
    });
    const { session, statuses } = track(new QuietSession());
    session.transport = "tcp";
    session.wantConnected = true;
    session.desiredTcpHost = "127.0.0.1";
    session.desiredTcpPort = oldTarget.port;

    // Stands in for the reconnect loop's attempt.
    const loopAttempt = session.tryConnectTcpOnce();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    const started = Date.now();
    await session.switchTransport("ethernet", { host: "127.0.0.1", port: newTarget.port });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await loopAttempt).toBe(false);
    expect(session.tcpConnected).toBe(true);
    expect(session.tcpSocket.remotePort).toBe(newTarget.port);

    await sleep(300);
    expect(oldTarget.accepted).toHaveLength(0);
    expect(session.tcpSocket.remotePort).toBe(newTarget.port);
    expect(
      statuses().filter((s) => s.includes(`:${oldTarget.port}`) && s.includes("failed")),
    ).toEqual([]);
  });

  it("never adopts the old target when it answers just as the user switches", async () => {
    const oldTarget = await listen();
    const newTarget = await listen();
    const original = realConnect();
    const { session } = track(new QuietSession());
    let switched: Promise<void> | null = null;
    // The old connect completes and the switch lands before the socket is adopted.
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const [port, host, done] = args as [number, string, () => void];
      if (port !== oldTarget.port) return original.apply(this, args);
      return original.call(this, port, host, () => {
        done();
        switched = session.openTcp({ host: "127.0.0.1", port: newTarget.port });
      });
    });
    session.transport = "tcp";
    session.wantConnected = true;
    session.desiredTcpHost = "127.0.0.1";
    session.desiredTcpPort = oldTarget.port;

    const loopAttempt = session.tryConnectTcpOnce();
    expect(await loopAttempt).toBe(false);
    await vi.waitFor(() => expect(switched).not.toBeNull());
    await switched;

    expect(oldTarget.accepted).toHaveLength(1);
    expect(session.tcpSocket.remotePort).toBe(newTarget.port);
    await sleep(100);
    for (const socket of oldTarget.accepted) {
      await vi.waitFor(() => expect(socket.readableEnded || socket.destroyed).toBe(true));
    }
    expect(session.tcpSocket.remotePort).toBe(newTarget.port);
  });
});

describe("TCP liveness", () => {
  it("reconnects when a link that carried video goes silent", async () => {
    const server = await listen((socket) => socket.write(vendorFrame(1, [], JPEG)));
    const { session, statuses, logs } = track(new LoopingSession());
    session.tcpStaleAfterMs = 300;

    await session.openTcp({ host: "127.0.0.1", port: server.port });
    await vi.waitFor(() => expect(server.accepted.length).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
      interval: 50,
    });

    expect(logs().some((l) => l.startsWith("TCP silent for"))).toBe(true);
    expect(statuses()).toContain("TCP disconnected");
  });

  it("sends clear_caches once when the board drops the link, and reconnects", async () => {
    const server = await listen();
    const { session, events } = track(new LoopingSession());
    const clears = () => events.filter((e) => e.t === "clear_caches").length;

    await session.openTcp({ host: "127.0.0.1", port: server.port });
    expect(session.tcpConnected).toBe(true);
    // The client can be connected before the server has seen the connection.
    await vi.waitFor(() => expect(server.accepted).toHaveLength(1));
    const before = clears();

    // The board resets: its end of the connection goes away.
    server.accepted[0].destroy();
    await vi.waitFor(
      () => {
        expect(server.accepted.length).toBeGreaterThanOrEqual(2);
        expect(session.tcpConnected).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    expect(clears()).toBe(before + 1);
  });

  it("sends no more clear_caches while reconnecting fails after a lost link", async () => {
    const server = net.createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const accepted: net.Socket[] = [];
    server.on("connection", (socket) => accepted.push(socket));
    const { session, events, statuses } = track(new LoopingSession());
    const clears = () => events.filter((e) => e.t === "clear_caches").length;
    session.tcpConnectTimeoutMs = 200;

    await session.openTcp({ host: "127.0.0.1", port });
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    const before = clears();

    // The board goes away for good: the link drops and nothing listens any more.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of accepted) socket.destroy();
    });
    await vi.waitFor(
      () =>
        expect(
          statuses().filter((s) => s.startsWith("TCP connect failed")).length,
        ).toBeGreaterThanOrEqual(3),
      { timeout: 8000, interval: 50 },
    );

    expect(clears()).toBe(before + 1);
  });

  it("leaves a quiet link without video alone", async () => {
    // One camera-less beacon, then nothing: a sensor or event sketch at rest.
    const server = await listen((socket) => socket.write(vendorFrame(1, tlv(0x17, 4))));
    const { session, logs } = track(new LoopingSession());
    session.tcpStaleAfterMs = 100;

    await session.openTcp({ host: "127.0.0.1", port: server.port });
    await sleep(800);

    expect(server.accepted).toHaveLength(1);
    expect(session.tcpConnected).toBe(true);
    expect(logs().some((l) => l.startsWith("TCP silent for"))).toBe(false);
  });
});

describe("vision TLVs are per-packet", () => {
  const VISION = [0x60, 0x61, 0x62, 0x63, 0x66, 0x70];

  it("marks every vision record", () => {
    for (const type of VISION) expect(metaHasPerPacketTlv(Buffer.from(tlv(type, 1)))).toBe(true);
    // Camera controls and tuning stay control-only.
    expect(metaHasPerPacketTlv(Buffer.from(tlv(0x64, 1)))).toBe(false);
    expect(metaHasPerPacketTlv(Buffer.from(tlv(0x65, 1)))).toBe(false);
  });

  function ingest(...frames: Buffer[]): Emitted[] {
    const { session, events } = track(new QuietSession());
    session.ingestBytes(Buffer.concat(frames));
    return events.filter((e) => e.t === "meta" || e.t === "frame");
  }

  it("forwards a camera-less vision frame", () => {
    const out = ingest(vendorFrame(1, tlv(0x61, 1)));
    expect(out).toEqual([expect.objectContaining({ t: "meta", id: 1 })]);
  });

  it("keeps a clear riding a coalesced frame, once per frame and in order", () => {
    const clear = tlv(0x61, 1); // count = 0
    const out = ingest(
      vendorFrame(10, clear, JPEG),
      vendorFrame(11, [...tlv(0x02, 1)], JPEG),
      vendorFrame(12, clear, JPEG),
    );
    expect(out.map((e) => `${e.t}${e.id ?? ""}`)).toEqual(["meta10", "meta12", "frame"]);
  });
});
