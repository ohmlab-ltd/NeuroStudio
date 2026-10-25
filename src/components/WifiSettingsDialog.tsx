import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useObservableSelector } from "../state/observable";
import { connection, transportState } from "../state/device";
import {
  buildRecordCommands,
  buildWifiRecord,
  checkWifiSettings,
  kAssetRecordWifi,
  kWifiSecurities,
  kWifiWpa2,
  kWifiWpa2Wpa3,
  kWifiWpa3,
  type WifiSettings,
} from "../device/packets";

type Action = "join" | "host" | "remove";

const SECURITY_NAMES: Record<number, string> = {
  [kWifiWpa2]: "WPA2",
  [kWifiWpa2Wpa3]: "WPA2 / WPA3",
  [kWifiWpa3]: "WPA3",
};

/** One command every 20 ms: each is one bulk transfer, and the board reads them one at a time. */
export async function sendRecord(type: number, payload: Uint8Array): Promise<void> {
  for (const command of buildRecordCommands(type, payload)) {
    window.neuro.write(command);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Settings WiFi.begin() reads with no arguments. The board accepts them over USB only. */
export function WifiSettingsCard({ onClose }: { onClose(): void }) {
  const onUsb = useObservableSelector(transportState, (t) => t.mode === "usb");
  const connected = useObservableSelector(connection, (c) => c.connected);
  const [action, setAction] = useState<Action>("join");
  const [ssid, setSsid] = useState("");
  /** null until picked: WPA2 suits most routers, and a hosted network takes WPA3 too. */
  const [chosenSecurity, setChosenSecurity] = useState<number | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [channel, setChannel] = useState(6);
  const [hostname, setHostname] = useState("");
  const [linkKey, setLinkKey] = useState("");
  const [show, setShow] = useState(false);
  const [stage, setStage] = useState<"editing" | "sending" | "sent">("editing");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stage !== "sending") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, stage]);

  const hosting = action === "host";
  const security = chosenSecurity ?? (hosting ? kWifiWpa2Wpa3 : kWifiWpa2);
  const settings: WifiSettings = {
    mode: hosting ? "host" : "join",
    ssid,
    passphrase,
    security,
    channel,
    hostname: hostname.trim(),
    linkKey,
  };
  const problem = action === "remove" ? null : checkWifiSettings(settings);
  const typed = ssid !== "" || passphrase !== "" || hostname !== "" || linkKey !== "";
  const usable = onUsb && connected;
  const editable = stage === "editing";

  const store = async () => {
    setStage("sending");
    const payload = action === "remove" ? new Uint8Array(0) : buildWifiRecord(settings);
    await sendRecord(kAssetRecordWifi, payload);
    setStage("sent");
  };

  return (
    <div
      className="dialog-card wide"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wifi-settings-title"
    >
      <header id="wifi-settings-title">
        <Icon name="wifi" size={16} />
        WiFi settings
        <span className="dialog-subtitle">stored on the board</span>
      </header>

      {!usable ? (
        <p>
          Connect the board with its USB cable to change these. It ignores them over a network, so
          nobody else on the network can change them.
        </p>
      ) : stage === "sent" ? (
        <p className="dialog-ok">
          Sent. The board is restarting to store them, and the stream comes back in a few seconds. A
          board whose sketch has no WiFi does not restart, and keeps nothing.
        </p>
      ) : (
        <>
          <div className="dialog-form">
            <label htmlFor="wifi-action">Board</label>
            <select
              id="wifi-action"
              className="select-input"
              disabled={!editable}
              value={action}
              onChange={(event) => setAction(event.target.value as Action)}
            >
              <option value="join">Joins a network</option>
              <option value="host">Hosts a network</option>
              <option value="remove">Has no stored settings</option>
            </select>

            {action !== "remove" ? (
              <>
                <label htmlFor="wifi-ssid">Network</label>
                <input
                  id="wifi-ssid"
                  className="text-input"
                  placeholder="network name (SSID)"
                  disabled={!editable}
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                />

                <label htmlFor="wifi-security">Security</label>
                <select
                  id="wifi-security"
                  className="select-input"
                  disabled={!editable}
                  value={security}
                  onChange={(event) => setChosenSecurity(Number(event.target.value))}
                >
                  {kWifiSecurities.map((value) => (
                    <option key={value} value={value}>
                      {SECURITY_NAMES[value]}
                    </option>
                  ))}
                </select>

                <label htmlFor="wifi-password">Password</label>
                <div className="dialog-field">
                  <input
                    id="wifi-password"
                    className="text-input"
                    type={show ? "text" : "password"}
                    placeholder={
                      hosting
                        ? "leave empty to use the board's own password"
                        : "the network's password"
                    }
                    disabled={!editable}
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button quiet small"
                    onClick={() => setShow((v) => !v)}
                  >
                    {show ? "Hide" : "Show"}
                  </button>
                </div>

                {hosting ? (
                  <>
                    <label htmlFor="wifi-channel">Channel</label>
                    <select
                      id="wifi-channel"
                      className="select-input"
                      disabled={!editable}
                      value={channel}
                      onChange={(event) => setChannel(Number(event.target.value))}
                    >
                      {Array.from({ length: 11 }, (_, i) => i + 1).map((c) => (
                        <option key={c} value={c}>
                          {c === 6 ? "6 (default)" : c}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}

                <label htmlFor="wifi-hostname">Hostname</label>
                <input
                  id="wifi-hostname"
                  className="text-input"
                  placeholder="optional: the board's own name, e.g. neuron6-lab"
                  disabled={!editable}
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                />

                <label htmlFor="wifi-link-key">Link key</label>
                <input
                  id="wifi-link-key"
                  className="text-input"
                  type={show ? "text" : "password"}
                  placeholder="optional: only hosts that know it get the stream"
                  disabled={!editable}
                  value={linkKey}
                  onChange={(event) => setLinkKey(event.target.value)}
                />
              </>
            ) : null}
          </div>

          <p className="dialog-note">
            A sketch uses these when it calls WiFi.begin() with no arguments, or streams over WiFi
            without starting WiFi itself. The board restarts to store them.
          </p>
          {action === "join" ? (
            <p className="dialog-note">A board that joins a network streams over USB only.</p>
          ) : null}
          {hosting ? (
            <p className="dialog-note">
              With no password, the board uses its own. Neuro Studio shows it when you pick WiFi
              with the board on USB.
            </p>
          ) : null}
          {problem && typed ? <p className="dialog-error">{problem}</p> : null}
        </>
      )}

      <div className="dialog-actions">
        <span className="spacer" />
        <button
          type="button"
          className="button quiet"
          disabled={stage === "sending"}
          onClick={onClose}
        >
          {stage === "sent" || !usable ? "Close" : "Cancel"}
        </button>
        {usable && stage !== "sent" ? (
          <button
            type="button"
            className="button primary"
            disabled={problem !== null || stage === "sending"}
            onClick={() => void store()}
          >
            {action === "remove" ? "Remove from board" : "Store on board"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** No cancel on a click outside, which would discard what was typed. */
export function WifiSettingsDialog({ onClose }: { onClose(): void }) {
  return createPortal(
    <div className="dialog-backdrop">
      <WifiSettingsCard onClose={onClose} />
    </div>,
    document.body,
  );
}
