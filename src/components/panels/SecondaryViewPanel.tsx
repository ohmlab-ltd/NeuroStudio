import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { Icon } from "../Icon";
import { ThermalProbeLayer } from "../ThermalProbeLayer";
import { useObservable } from "../../state/observable";
import {
  currentWarning,
  live,
  streamInfo,
  thermalFrame,
  thermalStale,
  tofFrame,
} from "../../state/device";
import { overlayOptions, swapMainThermal, tofDisplayOptions } from "../../state/options";
import { createRepaintGate, drawOverlay, fitRect, type Rect } from "../../render/overlay";

/** Thermal when the board sends it, the camera otherwise. */
export function SecondaryViewPanel({ controls }: { controls: SlotControls }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const thermal = useObservable(thermalFrame);
  const stale = useObservable(thermalStale);
  const swapped = useObservable(swapMainThermal);
  const options = useObservable(overlayOptions);
  const info = useObservable(streamInfo);
  const tof = useObservable(tofFrame);
  const tofDisplay = useObservable(tofDisplayOptions);

  // A callback ref: expanding the slot creates a new viewport to observe.
  const observeViewport = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const thermalAvailable = thermal !== null;
  /** The swap is global, since slots may repeat. */
  const showingThermal = !thermalAvailable && !live.thermalExpected ? false : !swapped;

  const streamW = info.width > 0 ? info.width : 640;
  const streamH = info.height > 0 ? info.height : 480;

  const contentRect = useMemo<Rect>(() => {
    if (size.width <= 0 || size.height <= 0) return { x: 0, y: 0, w: 0, h: 0 };
    if (showingThermal && thermal) {
      return fitRect(thermal.width, thermal.height, size.width, size.height, "contain");
    }
    return fitRect(streamW, streamH, size.width, size.height, "contain");
  }, [size, showingThermal, thermal, streamW, streamH]);

  const drawState = useRef({
    contentRect,
    showingThermal,
    options,
    tof,
    tofDisplay,
    streamW,
    size,
  });
  drawState.current = { contentRect, showingThermal, options, tof, tofDisplay, streamW, size };

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
      // Everything the paint below reads; when none of it changed, the last paint stays.
      if (
        !shouldPaint([
          canvas,
          pixelW,
          pixelH,
          dpr,
          // By value: the memo hands out a new rect with every thermal frame.
          state.contentRect.x,
          state.contentRect.y,
          state.contentRect.w,
          state.contentRect.h,
          state.showingThermal,
          state.options,
          state.tofDisplay,
          state.streamW,
          state.showingThermal ? live.thermalBitmap : live.cameraBitmap,
          state.showingThermal ? null : live.overlay,
          state.showingThermal ? "" : warning,
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
        x: state.contentRect.x * dpr,
        y: state.contentRect.y * dpr,
        w: state.contentRect.w * dpr,
        h: state.contentRect.h * dpr,
      };
      if (dest.w <= 0 || dest.h <= 0) return;

      if (state.showingThermal) {
        if (live.thermalBitmap && !stale) {
          ctx.drawImage(live.thermalBitmap, dest.x, dest.y, dest.w, dest.h);
        }
        return;
      }

      if (live.cameraBitmap) {
        ctx.drawImage(live.cameraBitmap, dest.x, dest.y, dest.w, dest.h);
        drawOverlay(ctx, {
          data: live.overlay,
          dest,
          dpr,
          showInferenceText: false,
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
          showDebugTofOverlay: false,
          tofDisplay: state.tofDisplay,
          warning,
        });
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  const hasContent = showingThermal ? live.thermalBitmap !== null : live.cameraBitmap !== null;
  const thermalStalled = showingThermal && stale;

  return (
    <PanelFrame
      title={showingThermal ? "THERMAL" : "CAMERA"}
      controls={controls}
      headerExtra={
        thermalAvailable || live.thermalExpected ? (
          <button
            type="button"
            className="slot-button"
            title={showingThermal ? "Swap: thermal to main view" : "Swap: camera back to main view"}
            aria-label="Swap main and secondary view"
            onClick={() => swapMainThermal.set(!swapMainThermal.get())}
          >
            <Icon name="swap" size={13} />
          </button>
        ) : undefined
      }
    >
      <div className="panel-body">
        {/* 4:3, the Lepton's shape; the content letterboxes inside it. */}
        <div className="secondary-viewport" ref={observeViewport}>
          <canvas ref={canvasRef} />
          {showingThermal && !stale ? (
            <ThermalProbeLayer frame={thermal} rect={contentRect} />
          ) : null}
          {thermalStalled ? (
            <div className="stage-placeholder">
              <span>Thermal stream stalled</span>
            </div>
          ) : !hasContent ? (
            <div className="stage-placeholder">
              <span className="breathe">
                {showingThermal ? "Waiting for thermal…" : "Waiting for camera…"}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </PanelFrame>
  );
}
