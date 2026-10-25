// The bootloader tool. The flash runs in the main process, which keeps its state and log, so
// a dialog reopened after a reload shows the flash in progress.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import {
  DEFAULT_CUSTOM_ADDRESS,
  DFU_STALL_MS,
  DFU_TARGETS,
  FLASH_BASE,
  addressError,
  canFlash,
  dfuTarget,
  filterAddressInput,
  fitsInFlash,
  flashRate,
  flashWarning,
  formatAddress,
  formatBytes,
  formatCrc,
  portLabel,
  stopWarning,
  targetOffset,
  type DfuTargetId,
} from "../device/dfu";
import type { DfuFirmware, DfuPort, DfuResult } from "../vite-env";

interface FlashProgress {
  label: string;
  written: number;
  total: number;
}

export function BootloaderDialog({ onClose }: { onClose(): void }) {
  const [targetId, setTargetId] = useState<DfuTargetId>("application");
  const [customAddress, setCustomAddress] = useState(DEFAULT_CUSTOM_ADDRESS);
  const [file, setFile] = useState<DfuFirmware | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // null = auto-detect.
  const [port, setPort] = useState<string | null>(null);
  const [ports, setPorts] = useState<DfuPort[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DfuResult | null>(null);
  const [progress, setProgress] = useState<FlashProgress>({ label: "", written: 0, total: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [flashOffset, setFlashOffset] = useState<number | null>(null);
  const [critical, setCritical] = useState(false);
  const [lastActivity, setLastActivity] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const target = dfuTarget(targetId);
  const offset = targetOffset(target, customAddress);
  const warning = flashWarning(target, offset);
  const flashable = canFlash({ busy, size: file?.size ?? null, offset });
  const outcome = busy ? null : result;
  const quietMs = now - lastActivity;
  const stalled = busy && critical && quietMs >= DFU_STALL_MS;

  const refreshPorts = useCallback(async () => {
    let list: DfuPort[] = [];
    try {
      list = await window.neuro.bootloader.listPorts();
    } catch {
      /* Auto-detect remains, and its log says what it saw. */
    }
    setPorts(list);
    // Main only accepts a port from the latest list, so a vanished one resets.
    setPort((current) =>
      current !== null && list.some((p) => p.name === current) ? current : null,
    );
  }, []);

  useEffect(() => {
    void refreshPorts();
  }, [refreshPorts]);

  // Modal for the keyboard too: the fit toggle behind would unmount this dialog mid-flash.
  useEffect(() => {
    const app = document.getElementById("root");
    if (!app) return;
    app.inert = true;
    return () => {
      app.inert = false;
    };
  }, []);

  const finish = useCallback((finished: DfuResult) => {
    setBusy(false);
    setResult(finished);
    setCritical(false);
    setStopping(false);
    setConfirmingStop(false);
  }, []);

  useEffect(
    () =>
      window.neuro.bootloader.onEvent((event) => {
        setLastActivity(Date.now());
        if (event.t === "log") {
          setLog((lines) => [...lines, event.text]);
        } else if (event.t === "progress") {
          setProgress({ label: event.label, written: event.written, total: event.total });
        } else if (event.t === "stage") {
          setCritical(event.critical);
        } else {
          finish({ ok: event.ok, message: event.message });
        }
      }),
    [finish],
  );

  // Picks up a flash started in this window before a reload.
  useEffect(() => {
    let live = true;
    window.neuro.bootloader
      .state()
      .then((state) => {
        if (!live || !state) return;
        const known = DFU_TARGETS.find((t) => t.offset === state.offset);
        setTargetId(known ? known.id : "custom");
        if (!known) setCustomAddress(formatAddress(FLASH_BASE + state.offset));
        setFile(state.file);
        setFileError(null);
        setPort(state.port);
        setBusy(true);
        setResult(null);
        setLog(state.log);
        setProgress(
          state.progress
            ? {
                label: state.progress.label,
                written: state.progress.written,
                total: state.progress.total,
              }
            : { label: "preparing", written: 0, total: state.file.size },
        );
        setStartedAt(state.startedAt);
        setFlashOffset(state.offset);
        setCritical(state.critical);
        setLastActivity(state.lastActivityAt);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Ticks while the board is being written, to notice a stall.
  useEffect(() => {
    if (!busy || !critical) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, critical]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Escape backs out of a confirmation, then the dialog, never a flash.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirming) setConfirming(false);
      else if (confirmingStop) setConfirmingStop(false);
      else if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, confirming, confirmingStop, onClose]);

  const pickFile = async () => {
    try {
      const picked = await window.neuro.bootloader.pickFile();
      if (picked.canceled) return;
      if ("error" in picked) {
        setFile(null);
        setFileError(picked.error);
        return;
      }
      setFile({ path: picked.path, name: picked.name, size: picked.size, crc: picked.crc });
      setFileError(null);
    } catch (error) {
      setFile(null);
      setFileError(`Could not read the file: ${String(error)}`);
    }
  };

  /** `confirmed`: the warning was accepted; main requires it for the FSBL region. */
  const startFlash = async (confirmed: boolean) => {
    setConfirming(false);
    if (!file || offset === null) return;
    setBusy(true);
    setResult(null);
    setProgress({ label: "preparing", written: 0, total: file.size });
    setStartedAt(Date.now());
    setFlashOffset(offset);
    setCritical(false);
    setLastActivity(Date.now());
    let finished: DfuResult;
    try {
      finished = await window.neuro.bootloader.flash({
        path: file.path,
        offset,
        port,
        confirmFsbl: confirmed,
      });
    } catch (error) {
      finished = { ok: false, message: `could not start: ${String(error)}` };
    }
    finish(finished);
  };

  const requestFlash = () => {
    if (!flashable) return;
    if (warning) setConfirming(true);
    else void startFlash(false);
  };

  const cancelFlash = async (force: boolean) => {
    setConfirmingStop(false);
    setStopping(true);
    try {
      const reply = await window.neuro.bootloader.cancel(force);
      if (!reply.ok) {
        setStopping(false);
        setLog((lines) => [...lines, reply.message]);
      }
    } catch {
      setStopping(false);
    }
  };

  const customError = target.offset === null ? addressError(customAddress) : null;
  const fraction = progress.total === 0 ? 0 : progress.written / progress.total;
  const rate = flashRate(progress.written, startedAt, Date.now());
  const barClass =
    "dfu-bar" +
    (busy && fraction === 0 ? " indeterminate" : "") +
    (outcome ? (outcome.ok ? " ok" : " failed") : "");
  const statusText = outcome
    ? outcome.ok
      ? "Flash complete."
      : outcome.message
    : `${progress.label}  ${formatBytes(progress.written)} / ${formatBytes(progress.total)}` +
      (rate ? `  ·  ${rate}` : "");

  return createPortal(
    <div className="dfu-overlay">
      <div
        className="dfu-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dfu-title"
        inert={confirming || confirmingStop}
      >
        <header className="dfu-header">
          <Icon name="chip" size={16} />
          <span id="dfu-title">Bootloader</span>
          <span className="dfu-subtitle">flash a .bin over USB</span>
        </header>

        <div className="dfu-group">
          <div className="dfu-file">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void pickFile()}
            >
              <Icon name="folder" size={13} />
              Choose .bin
            </button>
            <span className={file ? "dfu-file-name" : "dfu-file-name empty"}>
              {file ? file.name : "no file selected"}
            </span>
          </div>
          {file ? (
            <p className="dfu-meta">{`${formatBytes(file.size)}  ·  crc32 ${formatCrc(file.crc)}`}</p>
          ) : null}
          {fileError ? <p className="dfu-error">{fileError}</p> : null}
        </div>

        <div className="dfu-group">
          <div className="dfu-row">
            <span className="dfu-row-label">Write to</span>
            <select
              className="select-input"
              value={targetId}
              disabled={busy}
              onChange={(event) => setTargetId(event.target.value as DfuTargetId)}
            >
              {DFU_TARGETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.offset === null
                    ? t.label
                    : `${t.label} (${formatAddress(FLASH_BASE + t.offset)})`}
                </option>
              ))}
            </select>
          </div>
          {target.offset === null ? (
            <div className="dfu-indent">
              <label className="labelled-field">
                <span>Flash address</span>
                <input
                  className={customError ? "text-input mono invalid" : "text-input mono"}
                  value={customAddress}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={customError !== null}
                  onChange={(event) => setCustomAddress(filterAddressInput(event.target.value))}
                />
              </label>
              {customError ? (
                <p className="dfu-error">{customError}</p>
              ) : offset !== null ? (
                <p className="dfu-meta">
                  {`writes at ${formatAddress(FLASH_BASE + offset)}  ·  offset ${formatAddress(offset)}`}
                </p>
              ) : null}
            </div>
          ) : null}
          {warning ? (
            <p className="dfu-warning">
              <Icon name="warning" size={14} />
              <span>{warning}</span>
            </p>
          ) : null}
          {file && !fitsInFlash(file.size, offset) ? (
            <p className="dfu-error">This image does not fit at that address.</p>
          ) : null}
        </div>

        <div className="dfu-row">
          <span className="dfu-row-label">Port</span>
          <select
            className="select-input"
            value={port ?? ""}
            disabled={busy}
            onChange={(event) => setPort(event.target.value || null)}
          >
            <option value="">Auto-detect</option>
            {ports.map((p) => (
              <option key={p.name} value={p.name} title={p.description ?? undefined}>
                {portLabel(p)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dfu-icon-button"
            title="Rescan ports"
            disabled={busy}
            onClick={() => void refreshPorts()}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>

        {busy || log.length > 0 || result !== null ? (
          <div className="dfu-group">
            <div className={barClass}>
              <span style={{ width: `${fraction * 100}%` }} />
            </div>
            <p
              className={
                outcome ? (outcome.ok ? "dfu-status ok" : "dfu-status failed") : "dfu-status"
              }
            >
              {statusText}
            </p>
          </div>
        ) : null}

        {log.length > 0 ? (
          <div className="terminal-body dfu-log" ref={logRef}>
            {log.map((line, index) => (
              <div key={index} className="terminal-line">
                {line}
              </div>
            ))}
          </div>
        ) : null}

        <div className="dfu-actions">
          {busy ? (
            <span className="dfu-busy">
              <span className="spinner" />
              {stalled ? "The board has stopped responding" : "Do not unplug the board"}
            </span>
          ) : null}
          <span className="spacer" />
          {/* Stopping mid-write leaves a partial image, so it is offered only after a stall. */}
          {!busy ? (
            <button type="button" className="button quiet" onClick={onClose}>
              {result === null ? "Cancel" : "Close"}
            </button>
          ) : !critical ? (
            <button
              type="button"
              className="button quiet"
              disabled={stopping}
              onClick={() => void cancelFlash(false)}
            >
              {stopping ? "Cancelling…" : "Cancel"}
            </button>
          ) : stalled ? (
            <button
              type="button"
              className="button danger"
              disabled={stopping}
              onClick={() => setConfirmingStop(true)}
            >
              {stopping ? "Stopping…" : "Stop…"}
            </button>
          ) : null}
          <button
            type="button"
            className="button primary"
            disabled={!flashable}
            onClick={requestFlash}
          >
            {busy ? "Flashing…" : "Flash"}
          </button>
        </div>
      </div>

      {confirming && warning ? (
        <div
          className="dfu-confirm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirming(false);
          }}
        >
          <div
            className="dfu-confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dfu-confirm-title"
          >
            <header id="dfu-confirm-title">Confirm flash</header>
            <p>{warning}</p>
            <div className="dfu-actions">
              <span className="spacer" />
              <button
                type="button"
                className="button quiet"
                autoFocus
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button type="button" className="button danger" onClick={() => void startFlash(true)}>
                Flash
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmingStop && stalled ? (
        <div
          className="dfu-confirm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmingStop(false);
          }}
        >
          <div
            className="dfu-confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dfu-stop-title"
          >
            <header id="dfu-stop-title">Stop the flash?</header>
            <p>{stopWarning(flashOffset, quietMs)}</p>
            <div className="dfu-actions">
              <span className="spacer" />
              <button
                type="button"
                className="button quiet"
                autoFocus
                onClick={() => setConfirmingStop(false)}
              >
                Keep waiting
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => void cancelFlash(true)}
              >
                Stop anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
