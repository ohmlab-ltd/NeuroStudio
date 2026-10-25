import { useEffect, useRef, useState } from "react";
import { BootloaderDialog } from "./BootloaderDialog";
import { WifiSettingsDialog } from "./WifiSettingsDialog";
import { Icon } from "./Icon";
import { useObservable, useObservableSelector } from "../state/observable";
import {
  boardWifiAddress,
  boardWifiNetwork,
  connection,
  ETHERNET_DEFAULT,
  NETWORK_ONLY,
  streamInfo,
  transportState,
  wifiTarget,
} from "../state/device";
import { appendTerminal } from "../state/terminal";
import { forgetDeclinedLinkKeys } from "../state/linkKey";
import { audioPlayback } from "../audio/playback";
import type { TransportMode, UsbBoardInfo } from "../vite-env";

const CONNECTED_NAME = "Neuro N6";

function transportLabel(mode: TransportMode, pinned: UsbBoardInfo | null): string {
  switch (mode) {
    case "usb":
      return pinned ? `USB · ${pinned.portPath}` : "USB";
    case "wifi":
      return "WiFi";
    case "ethernet":
      return "Ethernet";
  }
}

/** Port path of the only attached board no other window owns; null when ambiguous. */
export function autoBoardPath(boards: readonly UsbBoardInfo[]): string | null {
  const free = boards.filter((board) => !board.inUse);
  return free.length === 1 ? free[0].portPath : null;
}

/** Enumerates attached boards when the menu opens. */
function TransportPicker() {
  const transport = useObservable(transportState);
  const connected = useObservableSelector(connection, (c) => c.connected);
  const wifiAddress = useObservable(boardWifiAddress);
  const wifiNetwork = useObservable(boardWifiNetwork);
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<UsbBoardInfo[]>([]);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // A network-only run never enumerates USB.
    if (!NETWORK_ONLY) {
      void window.neuro.listBoards().then((list) => {
        if (!cancelled) setBoards(list);
      });
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (mode: TransportMode, board: UsbBoardInfo | null) => {
    setOpen(false);
    const sameBoard = mode !== "usb" || board?.portPath === transport.pinnedBoard?.portPath;
    if (mode === transport.mode && sameBoard) return;
    forgetDeclinedLinkKeys();

    const options: { host?: string; port?: number; board?: UsbBoardInfo | null } = {};
    if (mode === "wifi") {
      const target = wifiTarget();
      options.host = target.host;
      options.port = target.port;
    } else if (mode === "ethernet") {
      options.host = ETHERNET_DEFAULT.host;
      options.port = ETHERNET_DEFAULT.port;
    } else {
      options.board = board;
    }

    // Pinned before switching, so the connect loop and recovery return to this board.
    const current = transportState.get();
    transportState.set({
      ...current,
      mode,
      pinnedBoard: mode === "usb" ? board : current.pinnedBoard,
    });

    window.neuro.switchTransport(mode, options).catch((error: unknown) => {
      appendTerminal(`[host] switchTransport failed: ${String(error)}\n`);
    });
  };

  const onUsb = transport.mode === "usb";
  const autoUsb = onUsb && !transport.pinnedBoard;
  const livePath = autoUsb && connected ? autoBoardPath(boards) : null;
  const wifi = wifiTarget(wifiAddress);

  return (
    <div className="transport-picker" ref={root}>
      <button
        type="button"
        title="Switch transport / pick board"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {transportLabel(transport.mode, transport.pinnedBoard)}
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div className="menu up" role="menu">
          {NETWORK_ONLY ? (
            <button
              type="button"
              role="menuitem"
              disabled
              title="Neuro Studio was started with --network-only, so it does not use USB"
            >
              <span className="menu-mark" />
              USB is off (network only)
            </button>
          ) : (
            /* Always offered, so a pin can be cleared. */
            <button
              type="button"
              role="menuitem"
              className={autoUsb ? "selected" : undefined}
              title="Connect to the first Neuro N6 found on USB"
              onClick={() => void choose("usb", null)}
            >
              <span className="menu-mark">{autoUsb ? <Icon name="check" size={12} /> : null}</span>
              USB (any board)
            </button>
          )}
          {boards.map((board) => {
            const selected = onUsb && transport.pinnedBoard?.portPath === board.portPath;
            const live = board.portPath === livePath;
            return (
              <button
                key={board.portPath}
                type="button"
                role="menuitem"
                className={selected ? "selected" : undefined}
                disabled={board.inUse && !selected}
                title={
                  `VID 0x${board.vid.toString(16).toUpperCase()} / ` +
                  `PID 0x${board.pid.toString(16).toUpperCase()} at USB port ${board.portPath}` +
                  (board.serial ? `, serial ${board.serial}` : "") +
                  (live ? " (streaming in this window)" : "") +
                  (board.inUse ? " (open in another window)" : "")
                }
                onClick={() => void choose("usb", board)}
              >
                <span className="menu-mark">
                  {selected ? (
                    <Icon name="check" size={12} />
                  ) : live ? (
                    <span className="menu-live-dot" />
                  ) : null}
                </span>
                {boards.length === 1 ? `USB (${board.label})` : `USB: ${board.label}`}
                {board.inUse ? <span className="menu-note">in use</span> : null}
              </button>
            );
          })}

          <div className="menu-separator" />

          {/* Boards stream over WiFi only from the network they host themselves. */}
          <button
            type="button"
            role="menuitem"
            className={transport.mode === "wifi" ? "selected" : undefined}
            title={
              `Join ${wifiNetwork ? wifiNetwork.ssid : "the board's own WiFi network"} on this ` +
              `computer first; the board is at ${wifi.host}:${wifi.port}`
            }
            onClick={() => void choose("wifi", null)}
          >
            <span className="menu-mark">
              {transport.mode === "wifi" ? <Icon name="check" size={12} /> : null}
            </span>
            WiFi (the board's network)
          </button>

          {/* The same TCP path as WiFi, at the board's static address. */}
          <button
            type="button"
            role="menuitem"
            className={transport.mode === "ethernet" ? "selected" : undefined}
            onClick={() => void choose("ethernet", null)}
          >
            <span className="menu-mark">
              {transport.mode === "ethernet" ? <Icon name="check" size={12} /> : null}
            </span>
            Ethernet
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function StatusBar() {
  const conn = useObservable(connection);
  const info = useObservable(streamInfo);
  const transport = useObservable(transportState);
  const listening = useObservable(audioPlayback.listening);
  const [bootloaderOpen, setBootloaderOpen] = useState(false);
  const [wifiOpen, setWifiOpen] = useState(false);

  // The session outlives a page reload and keeps its own flag.
  useEffect(() => {
    window.neuro.setAutoRecover(transportState.get().autoRecover);
  }, []);

  // "Connected" here means data is flowing, not only that a handle is open.
  const live = conn.hasRecentFrame;
  const resText = live && info.width > 0 && info.height > 0 ? `${info.width}×${info.height}` : "--";
  const fpsText = live && info.fps > 0 ? `${info.fps.toFixed(1)} FPS` : "--";

  return (
    <footer className="statusbar">
      <div>
        <span className="status-device">
          <span className={live ? "status-dot live" : "status-dot down"} />
          <span>{live ? `Connected: ${CONNECTED_NAME}` : "Not connected"}</span>
        </span>
        <span className="status-metric">{resText}</span>
        <span className="status-metric">{fpsText}</span>
        <TransportPicker />
        {/* Each window owns its own transport session. */}
        <button
          type="button"
          className="status-button"
          title="Open a new window for a second board"
          onClick={() => {
            window.neuro.newWindow().catch((error: unknown) => {
              appendTerminal(`[host] new window failed: ${String(error)}\n`);
            });
          }}
        >
          <Icon name="external" size={13} />
        </button>
        <button
          type="button"
          className="status-button"
          title={
            NETWORK_ONLY
              ? "Bootloader: needs USB, which is off in this network-only run"
              : "Bootloader: flash firmware (.bin) over USB"
          }
          disabled={NETWORK_ONLY}
          onClick={() => setBootloaderOpen(true)}
        >
          <Icon name="chip" size={14} />
        </button>
        {/* The network a sketch joins or hosts when it names none. */}
        <button
          type="button"
          className="status-button"
          title={
            NETWORK_ONLY
              ? "WiFi settings: need USB, which is off in this network-only run"
              : "WiFi settings: store a network on the board over USB"
          }
          disabled={NETWORK_ONLY}
          onClick={() => setWifiOpen(true)}
        >
          <Icon name="wifi" size={14} />
        </button>
      </div>

      <div>
        {/* Recovery resets a board whose USB goes quiet, as it does mid-switch to a network. */}
        <button
          type="button"
          className={transport.autoRecover ? "status-button on" : "status-button"}
          title={
            transport.autoRecover
              ? "Auto USB recovery is on. Click to turn it off."
              : "Auto USB recovery is off. Click to turn it on."
          }
          onClick={() => {
            const next = !transportState.get().autoRecover;
            transportState.set({ ...transportState.get(), autoRecover: next });
            window.neuro.setAutoRecover(next);
          }}
        >
          <Icon name={transport.autoRecover ? "refresh" : "refresh-off"} size={14} />
        </button>

        <button
          type="button"
          className={listening ? "status-button on" : "status-button"}
          title={listening ? "Mute microphone" : "Listen to microphone"}
          onClick={() => audioPlayback.toggle()}
        >
          <Icon name={listening ? "volume" : "volume-off"} size={14} />
        </button>

        <span className="statusbar-version" title={`Neuro Studio ${__APP_VERSION__}`}>
          v{__APP_VERSION__}
        </span>
        <img className="statusbar-logo" src="./ohmlab.svg" alt="Ohm Lab" />
      </div>

      {bootloaderOpen ? <BootloaderDialog onClose={() => setBootloaderOpen(false)} /> : null}
      {wifiOpen ? <WifiSettingsDialog onClose={() => setWifiOpen(false)} /> : null}
    </footer>
  );
}
