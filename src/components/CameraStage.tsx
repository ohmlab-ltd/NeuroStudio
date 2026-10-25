import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraTools } from "./CameraTools";
import { ConnectOverlay } from "./ConnectOverlay";
import { ThermalProbeLayer } from "./ThermalProbeLayer";
import { Icon } from "./Icon";
import { useObservable } from "../state/observable";
import {
  boardWifiAddress,
  boardWifiNetwork,
  connection,
  currentWarning,
  ETHERNET_DEFAULT,
  live,
  recordingState,
  streamInfo,
  thermalFrame,
  thermalStale,
  tofFrame,
  transportState,
  wifiTarget,
} from "../state/device";
import { fillViewport, overlayOptions, swapMainThermal, tofDisplayOptions } from "../state/options";
import { appendTerminal } from "../state/terminal";
import { centreTempCelsius, thermalFrameToRgba } from "../device/thermal";
import type { RecordingResult } from "../vite-env";
import {
  createRepaintGate,
  drawOverlay,
  fitRect,
  intersectRect,
  type Rect,
} from "../render/overlay";
import { ThermalAligner } from "../render/align";

const AUTO_ALIGN_PERIOD_MS = 400;

/** The live thermal frame as a JPEG in the stage's colormap, or null. */
async function thermalSnapshotJpeg(): Promise<Uint8Array | null> {
  const frame = thermalFrame.get();
  if (!frame || thermalStale.get()) return null;
  const image = thermalFrameToRgba(frame, overlayOptions.get().thermalColormap);
  if (!image) return null;
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 1 });
  return new Uint8Array(await blob.arrayBuffer());
}

export function recordingStopNotice(result: RecordingResult): string {
  const dropped = result.droppedFrames ?? 0;
  if (result.error) {
    return result.path
      ? `Recording failed: ${result.error}. Partial file: ${result.path}`
      : `Recording failed: ${result.error}`;
  }
  if (!result.path) return "Recording stopped.";
  if ((result.frames ?? 0) <= 0) {
    return `Recording stopped with no frames captured: ${result.path} is empty.`;
  }
  if (dropped > 0) {
    const noun = dropped === 1 ? "frame" : "frames";
    return `Recording saved: ${result.path} (${dropped} ${noun} dropped while the disk caught up)`;
  }
  return `Recording saved: ${result.path}`;
}

function timestamp(): string {
  const d = new Date();
  const two = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** The thermal overlay in stream pixels: frame width x scale, 4:3, centred, then offset. */
function thermalOverlayRect(
  streamW: number,
  streamH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): Rect {
  const w = streamW * scale;
  const h = (w * 120) / 160;
  return {
    x: (streamW - w) / 2 + offsetX * streamW,
    y: (streamH - h) / 2 + offsetY * streamH,
    w,
    h,
  };
}

/** Opens the transport chosen in the status bar. */
async function openTransport(): Promise<void> {
  const mode = transportState.get().mode;
  if (mode === "wifi") {
    await window.neuro.openTcp(wifiTarget());
  } else if (mode === "ethernet") {
    await window.neuro.openTcp({
      host: ETHERNET_DEFAULT.host,
      port: ETHERNET_DEFAULT.port,
    });
  } else {
    const board = transportState.get().pinnedBoard;
    await window.neuro.open({
      itf: 0,
      epIn: 0x81,
      epOut: 0x01,
      bus: board?.bus ?? null,
      ports: board?.ports ?? null,
    });
  }
}

export function CameraStage({ fitMode, onToggleFit }: { fitMode: boolean; onToggleFit(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [notice, setNotice] = useState<string | null>(null);

  const conn = useObservable(connection);
  const info = useObservable(streamInfo);
  const options = useObservable(overlayOptions);
  const fill = useObservable(fillViewport);
  const swapped = useObservable(swapMainThermal);
  const thermal = useObservable(thermalFrame);
  const stale = useObservable(thermalStale);
  const tof = useObservable(tofFrame);
  const tofDisplay = useObservable(tofDisplayOptions);
  const transport = useObservable(transportState);
  const recording = useObservable(recordingState);
  const wifi = wifiTarget(useObservable(boardWifiAddress));
  const wifiNetwork = useObservable(boardWifiNetwork);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const streamW = info.width > 0 ? info.width : 640;
  const streamH = info.height > 0 ? info.height : 480;

  const thermalIsMain = swapped && thermal !== null;
  const cameraIsMain = !thermalIsMain && live.jpeg !== null;
  const thermalOnly = !thermalIsMain && !cameraIsMain && thermal !== null;
  const thermalStalled = (thermalIsMain || thermalOnly) && stale;

  // Fit mode always letterboxes.
  const fit: "contain" | "cover" | "fill" = fitMode || !fill ? "contain" : "cover";

  /** Where the video is drawn inside the stage, in CSS pixels. */
  const videoRect = useMemo<Rect>(() => {
    if (size.width <= 0 || size.height <= 0) return { x: 0, y: 0, w: 0, h: 0 };
    if (thermalIsMain && thermal) {
      return fitRect(thermal.width, thermal.height, size.width, size.height, fit);
    }
    if (thermalOnly) {
      // A thermal-only board's frame is stretched to fill the stage.
      return { x: 0, y: 0, w: size.width, h: size.height };
    }
    return fitRect(streamW, streamH, size.width, size.height, fit);
  }, [size, thermalIsMain, thermalOnly, thermal, streamW, streamH, fit]);

  const drawState = useRef({
    videoRect,
    fit,
    options,
    tofDisplay,
    tof,
    streamW,
    streamH,
    thermalIsMain,
    thermalOnly,
    size,
  });
  drawState.current = {
    videoRect,
    fit,
    options,
    tofDisplay,
    tof,
    streamW,
    streamH,
    thermalIsMain,
    thermalOnly,
    size,
  };

  useEffect(() => {
    let raf = 0;
    const shouldPaint = createRepaintGate();
    const render = () => {
      raf = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const state = drawState.current;
      if (!canvas || state.size.width <= 0 || state.size.height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      const pixelW = Math.round(state.size.width * dpr);
      const pixelH = Math.round(state.size.height * dpr);
      const warning = currentWarning();
      const stale = thermalStale.get();
      const thermalDrawn =
        state.thermalIsMain || state.thermalOnly || state.options.thermalOverlayOpacity > 0;
      const cameraDrawn = !state.thermalIsMain;
      const tofDrawn = cameraDrawn && live.overlay.debugTofPresent && live.overlay.debugTofEnabled;
      // Everything the paint below reads; when none of it changed, the last paint stays.
      if (
        !shouldPaint([
          canvas,
          pixelW,
          pixelH,
          dpr,
          // By value: the memo hands out a new rect with every thermal frame.
          state.videoRect.x,
          state.videoRect.y,
          state.videoRect.w,
          state.videoRect.h,
          state.thermalIsMain,
          state.thermalOnly,
          state.options,
          state.tofDisplay,
          tofDrawn ? state.tof : null,
          state.streamW,
          state.streamH,
          live.jpeg !== null,
          cameraDrawn ? live.cameraBitmap : null,
          thermalDrawn ? live.thermalBitmap : null,
          cameraDrawn ? live.overlay : null,
          cameraDrawn ? warning : "",
          stale,
        ])
      ) {
        return;
      }

      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.clearRect(0, 0, pixelW, pixelH);
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, pixelW, pixelH);

      const dest: Rect = {
        x: state.videoRect.x * dpr,
        y: state.videoRect.y * dpr,
        w: state.videoRect.w * dpr,
        h: state.videoRect.h * dpr,
      };
      if (dest.w <= 0 || dest.h <= 0) return;
      // In cover mode the video overflows the canvas; the HUD stays on screen.
      const hud = intersectRect(dest, { x: 0, y: 0, w: pixelW, h: pixelH });

      // Swapped: plain thermal, no overlays.
      if (state.thermalIsMain) {
        if (live.thermalBitmap && !stale) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, pixelW, pixelH);
          ctx.clip();
          ctx.drawImage(live.thermalBitmap, dest.x, dest.y, dest.w, dest.h);
          ctx.restore();
        }
        return;
      }

      if (live.jpeg && live.cameraBitmap) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, pixelW, pixelH);
        ctx.clip();
        ctx.drawImage(live.cameraBitmap, dest.x, dest.y, dest.w, dest.h);

        // Thermal over the camera, beneath the inference overlays.
        if (live.thermalBitmap && !stale && state.options.thermalOverlayOpacity > 0) {
          const r = thermalOverlayRect(
            state.streamW,
            state.streamH,
            state.options.thermalOverlayScale,
            state.options.thermalOverlayOffsetX,
            state.options.thermalOverlayOffsetY,
          );
          const sx = dest.w / state.streamW;
          const sy = dest.h / state.streamH;
          ctx.globalAlpha = state.options.thermalOverlayOpacity;
          ctx.drawImage(
            live.thermalBitmap,
            dest.x + r.x * sx,
            dest.y + r.y * sy,
            r.w * sx,
            r.h * sy,
          );
          ctx.globalAlpha = 1;
        }
        ctx.restore();

        drawOverlay(ctx, {
          data: live.overlay,
          dest,
          hud,
          dpr,
          showInferenceText: state.options.showInferenceText,
          showBoxes: state.options.showBoxes,
          showKeypoints: state.options.showKeypoints,
          showBindings: state.options.showBindings,
          showBoxLabels: state.options.showBoxLabels,
          showShading: state.options.showShading,
          maskFeather: state.options.maskFeather,
          streamWidth: state.streamW,
          kpConfMin: 30,
          lineW: 3,
          kpRadius: 4,
          boxW: 3,
          tofFrame: state.tof,
          showDebugTofOverlay: live.overlay.debugTofPresent && live.overlay.debugTofEnabled,
          tofDisplay: state.tofDisplay,
          warning,
        });
        return;
      }

      if (state.thermalOnly && live.thermalBitmap && !stale) {
        ctx.drawImage(live.thermalBitmap, dest.x, dest.y, dest.w, dest.h);
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const aligner = useRef(new ThermalAligner());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (swapMainThermal.get()) return;
      // A stalled thermal frame does not match the live camera.
      aligner.current.run(live.cameraBitmap, thermalStale.get() ? null : thermalFrame.get());
    }, AUTO_ALIGN_PERIOD_MS);
    return () => window.clearInterval(timer);
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    appendTerminal(`[ui] ${text}\n`);
    window.setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }, []);

  const takeSnapshot = useCallback(async () => {
    const { thermalIsMain: thermalMain, thermalOnly: thermalAlone } = drawState.current;
    const thermalShown = thermalMain || thermalAlone;
    let jpeg: Uint8Array | null;
    try {
      jpeg = thermalShown ? await thermalSnapshotJpeg() : live.jpeg;
    } catch {
      jpeg = null;
    }
    if (!jpeg || jpeg.length === 0) {
      showNotice(thermalShown ? "No live thermal frame to snapshot." : "No frame to snapshot yet.");
      return;
    }
    const name = `${thermalShown ? "thermal" : "snapshot"}_${timestamp()}.jpg`;
    const result = await window.neuro.saveSnapshot(name, jpeg);
    if (result.canceled) return;
    if (result.error) showNotice(`Snapshot save failed: ${result.error}`);
    else showNotice(`Saved snapshot: ${result.path}`);
  }, [showNotice]);

  const stopping = useRef(false);
  /** `failure` is a recorder error main reported before the stop. */
  const finishRecording = useCallback(
    async (failure?: string) => {
      if (stopping.current || !recordingState.get().active) return;
      stopping.current = true;
      recordingState.set({ active: false, path: null });
      try {
        const result = await window.neuro.stopRecording();
        showNotice(recordingStopNotice({ ...result, error: result.error ?? failure }));
      } catch (error) {
        showNotice(`Recording stop failed: ${String(error)}`);
      } finally {
        stopping.current = false;
      }
    },
    [showNotice],
  );

  const toggleRecording = useCallback(async () => {
    if (recordingState.get().active) {
      await finishRecording();
      return;
    }
    const result = await window.neuro.startRecording(`recording_${timestamp()}.mjpeg`);
    if (result.canceled) return;
    if (result.error) {
      showNotice(`Recording start failed: ${result.error}`);
      return;
    }
    recordingState.set({ active: true, path: result.path ?? null });
    showNotice(`Recording… ${result.path}`);
  }, [finishRecording, showNotice]);

  // Main ends the file on a write error and sends recorder_error.
  useEffect(
    () =>
      window.neuro.onEvent((event) => {
        if (event.t !== "recorder_error" || stopping.current) return;
        if (recordingState.get().active) void finishRecording(event.text);
        else showNotice(`Recording failed: ${event.text}`);
      }),
    [finishRecording, showNotice],
  );

  const connect = useCallback(async () => {
    const before = connection.get();
    connection.set({ ...before, connecting: true, status: "Connecting…" });
    try {
      await openTransport();
    } catch (error) {
      // The main process reports most failures as status; a rejected call ends the attempt here.
      const message = error instanceof Error ? error.message : String(error);
      connection.set({
        ...connection.get(),
        connecting: false,
        status: `Connect failed: ${message}`,
      });
    }
  }, []);

  const disconnect = useCallback(async () => {
    await finishRecording();
    await window.neuro.close();
  }, [finishRecording]);

  // Connects once per mount: under StrictMode the first timer is cleared and the second fires.
  useEffect(() => {
    const timer = window.setTimeout(() => void connect(), 150);
    return () => window.clearTimeout(timer);
  }, [connect]);

  const showConnectOverlay = !conn.hasRecentFrame;
  const thermalShown = (thermalOnly || thermalIsMain) && !stale;
  const centreTemp = thermalShown ? centreTempCelsius(thermal) : null;
  const probesVisible = thermalShown;

  // Recording needs the camera on the main stage; Stop stays available while recording.
  const canRecord = recording.active || (conn.connected && cameraIsMain);
  const recordTitle = recording.active
    ? "Stop recording"
    : thermalIsMain
      ? "Record: swap the camera back to the main view to record it"
      : thermalOnly
        ? "Record: this board sends no camera stream"
        : "Record";
  const canSnapshot = thermalIsMain || thermalOnly ? !stale : cameraIsMain;
  const snapshotTitle =
    thermalIsMain || thermalOnly
      ? stale
        ? "Snapshot: the thermal stream has stalled"
        : "Snapshot thermal image"
      : "Snapshot";

  const title =
    conn.status ??
    (conn.connecting
      ? "Connecting…"
      : conn.connected
        ? "Connected, but no stream"
        : "Connect to device");

  return (
    <div className="stage" ref={stageRef}>
      <canvas className="stage-canvas" ref={canvasRef} />

      {!cameraIsMain && !thermalIsMain && !thermalOnly ? (
        <div className="stage-placeholder">
          <span className="breathe">
            <Icon name="video" size={32} />
          </span>
          <span>{conn.connecting ? "Connecting…" : "Waiting for stream…"}</span>
        </div>
      ) : null}

      {thermalStalled ? (
        <div className="stage-placeholder">
          <span>Thermal stream stalled</span>
        </div>
      ) : null}

      {probesVisible ? <ThermalProbeLayer frame={thermal} rect={videoRect} /> : null}

      {centreTemp !== null ? <div className="temp-readout">{centreTemp.toFixed(1)} °C</div> : null}

      {notice ? <div className="stage-toast">{notice}</div> : null}

      <CameraTools
        fillViewport={fill && !fitMode}
        canToggleAspect={!fitMode}
        isRecording={recording.active}
        canRecord={canRecord}
        recordTitle={recordTitle}
        canSnapshot={canSnapshot}
        snapshotTitle={snapshotTitle}
        onToggleFit={onToggleFit}
        onToggleAspect={() => fillViewport.set(!fillViewport.get())}
        onToggleRecord={() => void toggleRecording()}
        onSnapshot={() => void takeSnapshot()}
      />

      {showConnectOverlay ? (
        <ConnectOverlay
          title={title}
          connecting={conn.connecting}
          connected={conn.connected}
          transport={transport.mode}
          wifiTarget={`${wifi.host}:${wifi.port}`}
          wifiNetwork={wifiNetwork}
          ethernetTarget={`${ETHERNET_DEFAULT.host}:${ETHERNET_DEFAULT.port}`}
          onConnect={() => void connect()}
          onDisconnect={() => void disconnect()}
          onRetry={() => void connect()}
        />
      ) : null}
    </div>
  );
}
