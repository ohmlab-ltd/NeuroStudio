// The main-process recorder, the Linux udev rule and the USB connect help.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Recorder } from "../electron/recorder.cjs";
import builderConfig from "../electron-builder.cjs";
import { ConnectOverlay } from "../src/components/ConnectOverlay";

const frame = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

describe("Recorder", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "neuro-recorder-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes every frame and reports the path once the file is closed", async () => {
    const file = path.join(dir, "ok.mjpeg");
    const errors: Error[] = [];
    const recorder = await Recorder.open(file, { onError: (e) => errors.push(e) });
    recorder.append(frame(1));
    recorder.append(frame(2));

    const result = await recorder.stop();
    expect(result).toEqual({ path: file, frames: 2, droppedFrames: 0 });
    expect(errors).toEqual([]);
    const written = await readFile(file);
    expect(written.length).toBe(128);
    expect(written[0]).toBe(1);
    expect(written[127]).toBe(2);
  });

  it("rejects at open when the file cannot be created", async () => {
    const file = path.join(dir, "missing-dir", "x.mjpeg");
    await expect(Recorder.open(file)).rejects.toThrow(/ENOENT/);
  });

  it("truncates an existing file instead of appending to it", async () => {
    const file = path.join(dir, "again.mjpeg");
    const first = await Recorder.open(file);
    first.append(frame(7, 100));
    await first.stop();

    const second = await Recorder.open(file);
    second.append(frame(8, 10));
    await second.stop();
    expect(await readFile(file)).toEqual(Buffer.from(frame(8, 10)));
  });

  it("drops and counts frames until the stream drains", async () => {
    const file = path.join(dir, "slow.mjpeg");
    // A 1-byte high-water mark makes every write report backpressure.
    const recorder = await Recorder.open(file, { highWaterMark: 1 });
    recorder.append(frame(1));
    recorder.append(frame(2));
    recorder.append(frame(3));
    await new Promise((resolve) => recorder.stream.once("drain", resolve));
    recorder.append(frame(4));

    const result = await recorder.stop();
    expect(result.frames).toBe(2);
    expect(result.droppedFrames).toBe(2);
    expect(result.error).toBeUndefined();
    const written = await readFile(file);
    expect([...new Set(written)]).toEqual([1, 4]);
  });

  it("reports a write error once, stops writing, and returns it from stop()", async () => {
    let writes = 0;
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        callback(
          Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }),
        );
      },
    });
    const errors: Error[] = [];
    const recorder = new Recorder("/rec/partial.mjpeg", failing, (e: Error) => errors.push(e));

    recorder.append(frame(1));
    await new Promise((resolve) => failing.once("close", resolve));
    recorder.append(frame(2));
    recorder.append(frame(3));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/ENOSPC/);
    expect(writes).toBe(1);

    const result = await recorder.stop();
    expect(result).toEqual({
      path: "/rec/partial.mjpeg",
      error: "ENOSPC: no space left on device, write",
      frames: 1,
      droppedFrames: 0,
    });
  });

  it("returns a flush error from stop() without also raising onError", async () => {
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback(new Error("EIO: i/o error, close"));
      },
    });
    const errors: Error[] = [];
    const recorder = new Recorder("/rec/flush.mjpeg", failing, (e: Error) => errors.push(e));
    recorder.append(frame(1));

    const result = await recorder.stop();
    expect(result.error).toMatch(/EIO/);
    expect(errors).toEqual([]);
    // A second stop returns the same result.
    expect(await recorder.stop()).toBe(result);
  });
});

describe("Linux udev rule", () => {
  const rulesPath = fileURLToPath(new URL("../packaging/linux/60-neuro-n6.rules", import.meta.url));
  const rules = readFileSync(rulesPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const identities = [
    ["1209", "8008"],
    ["cafe", "4013"],
    ["1209", "8009"],
    ["cafe", "4014"],
  ];

  it.each(identities)("grants the desktop user %s:%s and its serial port", (vid, pid) => {
    const usb = rules.filter(
      (r) =>
        r.includes('SUBSYSTEM=="usb"') &&
        r.includes(`ATTR{idVendor}=="${vid}"`) &&
        r.includes(`ATTR{idProduct}=="${pid}"`),
    );
    const tty = rules.filter(
      (r) =>
        r.includes('SUBSYSTEM=="tty"') &&
        r.includes(`ATTRS{idVendor}=="${vid}"`) &&
        r.includes(`ATTRS{idProduct}=="${pid}"`),
    );
    expect(usb).toHaveLength(1);
    expect(tty).toHaveLength(1);
    for (const rule of [...usb, ...tty]) expect(rule).toContain('TAG+="uaccess"');
  });

  it("sorts before systemd's 73-seat-late.rules, which applies uaccess", () => {
    expect(Number(path.basename(rulesPath).split("-")[0])).toBeLessThan(73);
  });
});

describe("USB connect help", () => {
  const help = renderToStaticMarkup(
    createElement(ConnectOverlay, {
      title: "Connect to device",
      connecting: false,
      connected: false,
      transport: "usb",
      wifiTarget: "192.168.10.1:5000",
      wifiNetwork: null,
      ethernetTarget: "192.168.20.1:5000",
      onConnect: () => undefined,
      onDisconnect: () => undefined,
      onRetry: () => undefined,
    }),
  );

  it("does not ask anyone to install libusb, which the usb module bundles", () => {
    expect(help).not.toMatch(/brew install|install libusb/i);
  });

  it("points Linux users at the udev rule and Windows users at the WinUSB driver", () => {
    expect(help).toMatch(/Linux: install the Neuro N6 udev rule/);
    expect(help).toMatch(/older firmware need the WinUSB driver/);
  });
});

describe("WiFi SoftAP connect help", () => {
  const PASSWORD = "s3cret-Pass";
  const render = (options: {
    title?: string;
    connecting?: boolean;
    transport?: "usb" | "wifi";
    wifiNetwork?: { ssid: string; password: string } | null;
  }) =>
    renderToStaticMarkup(
      createElement(ConnectOverlay, {
        title: options.title ?? "Connect to device",
        connecting: options.connecting ?? false,
        connected: false,
        transport: options.transport ?? "wifi",
        wifiTarget: "192.168.23.1:5000",
        wifiNetwork: options.wifiNetwork ?? null,
        ethernetTarget: "192.168.20.1:5000",
        onConnect: () => undefined,
        onDisconnect: () => undefined,
        onRetry: () => undefined,
      }),
    );

  it("names no fixed network, since each sketch sets its own", () => {
    const help = render({});
    expect(help).not.toMatch(/Neuro-?N6-(AP|Cam)/);
    expect(help).toMatch(/Serial Monitor/);
    expect(help).toMatch(/connect the board over USB first/);
  });

  it("names the network the board sent over USB, with its password hidden", () => {
    const help = render({ wifiNetwork: { ssid: "Bench-AP", password: PASSWORD } });
    expect(help).toContain("Bench-AP");
    expect(help).toContain("192.168.23.1:5000");
    expect(help).not.toContain(PASSWORD);
    expect(help).toContain(">Show</button>");
    expect(help).toContain(">Copy</button>");
  });

  it("stays up while a network connect is retrying", () => {
    const help = render({
      title: "Connecting TCP 192.168.23.1:5000…",
      connecting: true,
      wifiNetwork: { ssid: "Bench-AP", password: PASSWORD },
    });
    expect(help).toContain("Bench-AP");
    expect(help).toContain(">Copy</button>");
  });

  it("still hides the USB help while a USB connect is under way", () => {
    const help = render({ title: "Connecting over USB…", connecting: true, transport: "usb" });
    expect(help).not.toContain("connect-help");
  });
});

describe("the macOS Info.plist text", () => {
  const info = (builderConfig.mac?.extendInfo ?? {}) as Record<string, string>;

  it("replaces Electron's wording for the two BLE usage keys", () => {
    expect(info.NSBluetoothAlwaysUsageDescription).toBe("Neuro Studio does not use BLE.");
    expect(info.NSBluetoothPeripheralUsageDescription).toBe("Neuro Studio does not use BLE.");
  });

  it("names BLE only by its key names, which macOS fixes", () => {
    expect(Object.values(info).join(" ")).not.toMatch(/bluetooth/i);
  });
});

describe("the Linux package's dependencies", () => {
  const depends = (builderConfig.deb?.depends ?? []) as string[];

  it("keeps electron-builder's defaults", () => {
    for (const name of [
      "libgtk-3-0",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libsecret-1-0",
    ]) {
      expect(depends).toContain(name);
    }
  });

  it("adds ALSA, which Electron loads at start, under its old and new names", () => {
    expect(depends).toContain("libasound2t64 | libasound2");
  });
});
