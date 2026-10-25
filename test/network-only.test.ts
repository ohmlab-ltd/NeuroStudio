// A network-only run never loads libusb, and its windows start on WiFi SoftAP.

import * as net from "node:net";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceSession,
  listUsbBoards,
  listUsbBoardsWithSerials,
  setUsbAllowed,
  USB_OFF_STATUS,
} from "../electron/device/session.cjs";
import { parseLaunchOptions, rendererArguments } from "../electron/launch.cjs";

const nodeRequire = createRequire(import.meta.url);

describe("launch options", () => {
  it("reads --network-only and the SoftAP address from the command line", () => {
    const options = parseLaunchOptions(
      ["electron", ".", "--network-only", "--wifi-host=127.0.0.1", "--wifi-port=5050"],
      {},
    );
    expect(options).toEqual({ networkOnly: true, wifiHost: "127.0.0.1", wifiPort: 5050 });
    expect(rendererArguments(options)).toEqual([
      "--neuro-network-only",
      "--neuro-wifi-host=127.0.0.1",
      "--neuro-wifi-port=5050",
    ]);
  });

  it("reads the environment, for npm run dev", () => {
    expect(
      parseLaunchOptions([], {
        NEURO_STUDIO_NETWORK_ONLY: "1",
        NEURO_STUDIO_WIFI_HOST: "192.168.10.2",
      }),
    ).toEqual({ networkOnly: true, wifiHost: "192.168.10.2", wifiPort: null });
    expect(parseLaunchOptions([], { NEURO_STUDIO_NETWORK_ONLY: "0" }).networkOnly).toBe(false);
  });

  it("ignores an address or port that could not be one", () => {
    const options = parseLaunchOptions(
      ["--wifi-host=1.2.3.4 --remote-debugging-port=9222", "--wifi-port=70000"],
      {},
    );
    expect(options).toEqual({ networkOnly: false, wifiHost: null, wifiPort: null });
    expect(rendererArguments(options)).toEqual([]);
  });
});

describe("DeviceSession with USB off", () => {
  let usbRequested = 0;
  const sessions: DeviceSession[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    // Any require("usb") from here on counts, cached or not.
    usbRequested = 0;
    nodeRequire.cache[nodeRequire.resolve("usb")] = {
      get exports() {
        usbRequested += 1;
        return { getDeviceList: () => [] };
      },
    } as never;
    setUsbAllowed(false);
  });

  afterEach(async () => {
    setUsbAllowed(true);
    delete nodeRequire.cache[nodeRequire.resolve("usb")];
    for (const session of sessions.splice(0)) await session.stop();
    for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
  });

  function track(session: DeviceSession) {
    sessions.push(session);
    const statuses: string[] = [];
    session.on("event", (e: { t: string; text?: string }) => {
      if (e.t === "status" && e.text) statuses.push(e.text);
    });
    return statuses;
  }

  it("refuses USB without loading libusb, and lists no boards", async () => {
    // The real loops run: the USB one must stay idle.
    const session = new DeviceSession();
    const statuses = track(session);

    await session.open({});
    expect(session.wantConnected).toBe(false);
    expect(statuses).toEqual([USB_OFF_STATUS]);
    expect(await session.tryConnectUsbOnce()).toBe(false);
    await new Promise((r) => setTimeout(r, 400)); // several loop turns

    expect(listUsbBoards()).toEqual([]);
    expect(await listUsbBoardsWithSerials()).toEqual([]);
    expect(usbRequested).toBe(0);
  });

  it("keeps a WiFi link up when something asks for USB", async () => {
    const server = net.createServer((socket) => socket.resume());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;

    const session = new DeviceSession();
    const statuses = track(session);
    await session.openTcp({ host: "127.0.0.1", port });
    expect(session.tcpConnected).toBe(true);

    await session.open({});
    expect(session.transport).toBe("tcp");
    expect(session.tcpConnected).toBe(true);
    expect(statuses.at(-1)).toBe(USB_OFF_STATUS);
    expect(usbRequested).toBe(0);
  });
});

describe("the window in a network-only run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("starts on WiFi SoftAP at the address it was given", async () => {
    vi.stubGlobal("window", {
      neuro: { launch: { networkOnly: true, wifiHost: "127.0.0.1", wifiPort: 5050 } },
    });
    vi.resetModules();
    const device = await import("../src/state/device");
    expect(device.NETWORK_ONLY).toBe(true);
    expect(device.transportState.get().mode).toBe("wifi");
    expect(device.WIFI_DEFAULT).toEqual({ host: "127.0.0.1", port: 5050 });
  });

  it("starts on USB at the usual SoftAP address otherwise", async () => {
    vi.resetModules();
    const device = await import("../src/state/device");
    expect(device.NETWORK_ONLY).toBe(false);
    expect(device.transportState.get().mode).toBe("usb");
    expect(device.WIFI_DEFAULT).toEqual({ host: "192.168.10.1", port: 5000 });
  });
});
