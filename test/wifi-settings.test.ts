// WiFi settings stored on the board: the record WiFi.begin() reads, its transfer, the dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildRecordCommands,
  buildWifiRecord,
  checkWifiSettings,
  kAssetRecordWifi,
  kWifiWpa2,
  kWifiWpa2Wpa3,
  kWifiWpa3,
  type WifiSettings,
} from "../src/device/packets";
import { sendRecord, WifiSettingsCard } from "../src/components/WifiSettingsDialog";
import { connection, transportState } from "../src/state/device";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const joining: WifiSettings = {
  mode: "join",
  ssid: "OhmLab",
  passphrase: "passphrase123",
  security: kWifiWpa2,
  channel: 6,
  hostname: "neuron6-lab",
  linkKey: "link key 1234",
};

describe("the WiFi record", () => {
  it("joins a network as the bench tool writes it", () => {
    expect(hex(buildWifiRecord(joining))).toBe(
      "01010102064f686d4c6162030d70617373706872617365313233040103060b6e6575726f6e362d6c6162" +
        "070d6c696e6b206b65792031323334",
    );
  });

  it("hosts on its channel with the board's own password, leaving tag 3 out", () => {
    const hosting: WifiSettings = {
      ...joining,
      mode: "host",
      ssid: "Neuro-Lab",
      passphrase: "",
      security: kWifiWpa2Wpa3,
      hostname: "",
      linkKey: "",
    };
    expect(hex(buildWifiRecord(hosting))).toBe("01010202094e6575726f2d4c6162040106050106");
  });
});

describe("the record transfer", () => {
  it("is ASR0, the AST1 chunks and AST2, as the bench tool sends it", () => {
    expect(buildRecordCommands(kAssetRecordWifi, buildWifiRecord(joining)).map(hex)).toEqual([
      "415352303900000085efe64302000000",
      "4153543100003001010102064f686d4c6162030d70617373706872617365313233040103060b6e6575726f6e362d6c6162070d6c696e6b",
      "41535431300009206b65792031323334",
      "41535432",
    ]);
  });

  it("chunks a long record 48 bytes at a time", () => {
    const long = buildWifiRecord({
      mode: "join",
      ssid: "x".repeat(32),
      passphrase: "y".repeat(63),
      security: kWifiWpa2Wpa3,
      channel: 6,
      hostname: "h".repeat(32),
      linkKey: "k".repeat(64),
    });
    expect(long.length).toBe(205);
    const commands = buildRecordCommands(kAssetRecordWifi, long);
    expect(commands.map((c) => c.length)).toEqual([16, 55, 55, 55, 55, 20, 4]);
    expect(hex(commands[0])).toBe("41535230cd000000998b916e02000000");
  });

  it("removes the record with an empty transfer", () => {
    expect(buildRecordCommands(kAssetRecordWifi, new Uint8Array(0)).map(hex)).toEqual([
      "41535230000000000000000002000000",
      "41535432",
    ]);
  });

  it("goes out one command every 20 ms", async () => {
    vi.useFakeTimers();
    const written: Uint8Array[] = [];
    vi.stubGlobal("window", { neuro: { write: (b: Uint8Array) => written.push(b) } });
    try {
      const done = sendRecord(kAssetRecordWifi, buildWifiRecord(joining));
      expect(written).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(written).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60);
      await done;
      expect(written.map(hex)).toEqual(
        buildRecordCommands(kAssetRecordWifi, buildWifiRecord(joining)).map(hex),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("checkWifiSettings", () => {
  const hosting: WifiSettings = {
    ...joining,
    mode: "host",
    passphrase: "",
    security: kWifiWpa2Wpa3,
  };
  const hexKey = "0123456789abcdef".repeat(4);

  it("takes good settings", () => {
    expect(checkWifiSettings(joining)).toBeNull();
    expect(checkWifiSettings(hosting)).toBeNull();
    expect(
      checkWifiSettings({ ...hosting, passphrase: "passphrase123", security: kWifiWpa3 }),
    ).toBeNull();
    expect(checkWifiSettings({ ...joining, passphrase: "x".repeat(63) })).toBeNull();
    expect(checkWifiSettings({ ...joining, passphrase: hexKey })).toBeNull();
  });

  it("takes only WPA2 and WPA3, all core 0.1.3 stores", () => {
    for (const security of [0, 1, 2, 4, 7]) {
      expect(checkWifiSettings({ ...joining, security })).toMatch(/Only WPA2 and WPA3/);
      expect(checkWifiSettings({ ...hosting, security })).toMatch(/Only WPA2 and WPA3/);
    }
  });

  it("says what is wrong", () => {
    expect(checkWifiSettings({ ...joining, ssid: "" })).toMatch(/network name/);
    expect(checkWifiSettings({ ...joining, ssid: "é".repeat(17) })).toMatch(/1 to 32 bytes/);
    expect(checkWifiSettings({ ...joining, passphrase: "" })).toMatch(/needs its password/);
    expect(checkWifiSettings({ ...joining, passphrase: "short" })).toMatch(/8 to 63/);
    expect(checkWifiSettings({ ...hosting, passphrase: "short" })).toMatch(/8 to 63/);
    expect(checkWifiSettings({ ...joining, passphrase: "x".repeat(64) })).toMatch(/64 hex/);
    for (const security of [kWifiWpa3, kWifiWpa2Wpa3]) {
      expect(checkWifiSettings({ ...joining, passphrase: hexKey, security })).toMatch(/WPA2 only/);
    }
    expect(checkWifiSettings({ ...joining, passphrase: "pässphrase" })).toMatch(/plain ASCII/);
    expect(checkWifiSettings({ ...joining, hostname: "my board" })).toMatch(/hostname/);
    expect(checkWifiSettings({ ...joining, linkKey: "tiny" })).toMatch(/link key/);
  });
});

describe("the WiFi settings dialog", () => {
  beforeEach(() => {
    transportState.set({ mode: "usb", pinnedBoard: null, autoRecover: true });
  });

  afterEach(() => {
    connection.set({ status: null, connecting: false, connected: false, hasRecentFrame: false });
  });

  const render = () =>
    renderToStaticMarkup(createElement(WifiSettingsCard, { onClose: () => undefined }));

  it("asks for the USB cable when there is no USB link", () => {
    connection.set({ status: null, connecting: false, connected: false, hasRecentFrame: false });
    const html = render();
    expect(html).toContain("Connect the board with its USB cable");
    expect(html).not.toContain("Store on board");
  });

  it("offers the form over a USB link", () => {
    connection.set({
      status: "Connected over USB",
      connecting: false,
      connected: true,
      hasRecentFrame: true,
    });
    const html = render();
    expect(html).toContain("Joins a network");
    expect(html).toContain("Password");
    expect(html).toContain("Link key");
    expect(html).toContain("Store on board");
    expect(html).toContain("streams over USB only");
  });

  it("offers WPA2 and WPA3 only", () => {
    connection.set({
      status: "Connected over USB",
      connecting: false,
      connected: true,
      hasRecentFrame: true,
    });
    const html = render();
    const start = html.indexOf('id="wifi-security"');
    const list = html.slice(start, html.indexOf("</select>", start));
    const options = [...list.matchAll(/<option value="([0-9]+)"[^>]*>([^<]*)</g)].map(
      ([, value, name]) => [Number(value), name],
    );
    expect(options).toEqual([
      [kWifiWpa2, "WPA2"],
      [kWifiWpa2Wpa3, "WPA2 / WPA3"],
      [kWifiWpa3, "WPA3"],
    ]);
  });
});
