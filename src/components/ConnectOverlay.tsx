import { useEffect, useState } from "react";
import type { BoardWifiNetwork } from "../state/device";
import { appendTerminal } from "../state/terminal";
import type { TransportMode } from "../vite-env";

const transportLabel = (
  transport: TransportMode,
  wifiTarget: string,
  ethernetTarget: string,
): string => {
  switch (transport) {
    case "usb":
      return "Connection: USB";
    case "wifi":
      return `Connection: WiFi, on the board's own network (${wifiTarget})`;
    case "ethernet":
      return `Connection: Ethernet (${ethernetTarget})`;
  }
};

const transportHelp = (
  transport: TransportMode,
  ethernetTarget: string,
  wifiNetwork: BoardWifiNetwork | null,
): string[] => {
  switch (transport) {
    case "usb":
      return [
        "Use a data USB cable. Charge-only cables will not show the board.",
        "Windows: boards on older firmware need the WinUSB driver, installed once with Zadig.",
        "Linux: install the Neuro N6 udev rule (see the README), then replug the board.",
        "With several boards, pick one from the USB menu in the status bar and open a new window for each of the others.",
      ];
    case "wifi":
      // The board sent its network over USB before the switch.
      if (wifiNetwork) {
        return ["On this computer, join the board's WiFi network below, then press Connect."];
      }
      return [
        "On this computer, join the WiFi network the board hosts, then press Connect.",
        "To see its name and password here, connect the board over USB first, then pick WiFi. The example sketches also print both on the Serial Monitor.",
        "A board that joins another network instead streams over USB only.",
      ];
    case "ethernet":
      return [
        "Connect the board straight to this computer with an Ethernet cable.",
        `The board is at ${ethernetTarget}. Give this computer's Ethernet port the address 192.168.20.2, mask 255.255.255.0, with no gateway.`,
      ];
  }
};

/** The network the board hosts. The password shows only on request; Copy works either way. */
function WifiNetworkDetails({ network }: { network: BoardWifiNetwork }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(network.password);
      setCopied(true);
    } catch {
      appendTerminal("[ui] Copy failed: clipboard unavailable\n");
    }
  };

  return (
    <dl className="connect-network">
      <dt>Network</dt>
      <dd>{network.ssid}</dd>
      <dt>Password</dt>
      <dd>
        {/* A fixed mask, so the length stays hidden too. */}
        <span className="connect-password">{shown ? network.password : "••••••••"}</span>
        <button
          type="button"
          className="button quiet"
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? "Hide" : "Show"}
        </button>
        <button type="button" className="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </dd>
    </dl>
  );
}

export function ConnectOverlay({
  title,
  connecting,
  connected,
  transport,
  wifiTarget,
  wifiNetwork,
  ethernetTarget,
  onConnect,
  onDisconnect,
  onRetry,
}: {
  title: string;
  connecting: boolean;
  connected: boolean;
  transport: TransportMode;
  wifiTarget: string;
  wifiNetwork: BoardWifiNetwork | null;
  ethernetTarget: string;
  onConnect(): void;
  onDisconnect(): void;
  onRetry(): void;
}) {
  // A "Waiting" status means the session is retrying with no board present.
  const waiting = title.startsWith("Waiting");
  // Network connects retry every few seconds, so their help stays up between attempts.
  const showHelp = !connected && (!connecting || waiting || transport !== "usb");

  return (
    <div className="connect-overlay">
      <div className="connect-card">
        <header>
          {connecting ? <span className="spinner" /> : null}
          <span>{title}</span>
        </header>

        {!connected ? (
          <p className="connect-transport">
            {transportLabel(transport, wifiTarget, ethernetTarget)}
          </p>
        ) : null}

        {showHelp ? (
          <ul className="connect-help">
            {transportHelp(transport, ethernetTarget, wifiNetwork).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        {showHelp && transport === "wifi" && wifiNetwork ? (
          <WifiNetworkDetails network={wifiNetwork} />
        ) : null}

        <div className="connect-actions">
          {connected ? (
            <button type="button" className="button quiet" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : null}
          {connected ? (
            <button type="button" className="button" disabled={connecting} onClick={onRetry}>
              Retry
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={connecting}
              onClick={onConnect}
            >
              Connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
