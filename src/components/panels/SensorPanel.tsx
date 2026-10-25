import { useEffect, useRef, useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState, PillToggle, Segmented } from "../controls";
import { useObservable } from "../../state/observable";
import { imuReading, magReading } from "../../state/device";
import type { Observable } from "../../state/observable";
import type { SensorReading } from "../../device/tlv";

/** Series, by index into the panel's labels, sharing one y-axis. */
interface GraphGroup {
  title: string;
  indices: number[];
  yUnit: string;
}

interface SensorConfig {
  title: string;
  source: Observable<SensorReading | null>;
  labels: string[];
  units: string[];
  /** How many leading values to plot; the rest are shown as numbers only. */
  plotCount: number;
  seriesColors: string[];
  groups: GraphGroup[];
}

const SERIES = ["#a89ab9", "#77d6a0", "#d9c07a"];
const SERIES_DIM = ["#6f6580", "#4e8c69", "#8f7f4f"];

const MAG_CONFIG: SensorConfig = {
  title: "Magnetometer",
  source: magReading,
  labels: ["X", "Y", "Z", "Temp"],
  units: ["", "", "", "°C"],
  plotCount: 3,
  seriesColors: SERIES,
  groups: [{ title: "Magnetic field", indices: [0, 1, 2], yUnit: "" }],
};

const IMU_CONFIG: SensorConfig = {
  title: "IMU",
  source: imuReading,
  labels: ["aX", "aY", "aZ", "gX", "gY", "gZ", "Temp"],
  units: ["g", "g", "g", "dps", "dps", "dps", "°C"],
  plotCount: 6,
  seriesColors: [...SERIES, ...SERIES_DIM],
  groups: [
    { title: "Acceleration", indices: [0, 1, 2], yUnit: "g" },
    { title: "Gyroscope", indices: [3, 4, 5], yUnit: "dps" },
  ],
};

const MAX_HISTORY = 240;

function formatTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

/** yMin and yMax set a manual scale; null auto-scales. */
function PlotCanvas({
  history,
  group,
  colors,
  yMin,
  yMax,
}: {
  history: number[][];
  group: GraphGroup;
  colors: string[];
  yMin: number | null;
  yMax: number | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const gutter = 40 * dpr;
    const plot = {
      left: gutter,
      top: 2 * dpr,
      right: w - 4 * dpr,
      bottom: h - 4 * dpr,
    };
    const plotW = plot.right - plot.left;
    const plotH = plot.bottom - plot.top;
    if (history.length === 0 || plotW <= 1 || plotH <= 1) return;

    let mn: number;
    let mx: number;
    if (yMin !== null && yMax !== null) {
      mn = yMin;
      mx = yMax;
    } else {
      mn = Number.POSITIVE_INFINITY;
      mx = Number.NEGATIVE_INFINITY;
      for (const sample of history) {
        for (const s of group.indices) {
          if (s >= sample.length) continue;
          const v = sample[s];
          if (!Number.isFinite(v)) continue;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
        mn = -1;
        mx = 1;
      }
      if (Math.abs(mx - mn) < 1e-6) {
        mn -= 1;
        mx += 1;
      }
      const pad = (mx - mn) * 0.08;
      mn -= pad;
      mx += pad;
    }
    if (Math.abs(mx - mn) < 1e-9) mx = mn + 1;

    const yOf = (v: number) =>
      Math.min(plot.bottom, Math.max(plot.top, plot.bottom - ((v - mn) / (mx - mn)) * plotH));
    const xOf = (t: number) =>
      history.length <= 1 ? plot.right : plot.left + (t / (history.length - 1)) * plotW;

    ctx.font = `${10 * dpr}px Inter, sans-serif`;
    ctx.textBaseline = "middle";

    const drawLabel = (v: number, grid: boolean) => {
      const y = yOf(v);
      if (grid) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
      }
      const text = formatTick(v);
      ctx.fillStyle = "#6d6e75";
      ctx.textAlign = "right";
      ctx.fillText(text, gutter - 4 * dpr, Math.min(h - 6 * dpr, Math.max(6 * dpr, y)));
    };

    drawLabel(mx, true);
    drawLabel(mn, true);
    if (mn < 0 && mx > 0) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(plot.left, yOf(0));
      ctx.lineTo(plot.right, yOf(0));
      ctx.stroke();
      drawLabel(0, false);
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "#6d6e75";
    if (group.yUnit) ctx.fillText(group.yUnit, 2 * dpr, 7 * dpr);
    ctx.textAlign = "right";
    ctx.fillText("time →", plot.right, h - 7 * dpr);

    for (const s of group.indices) {
      if (s >= colors.length) continue;
      ctx.strokeStyle = colors[s];
      ctx.lineWidth = 1.5 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (let t = 0; t < history.length; t++) {
        if (s >= history[t].length) continue;
        const v = history[t][s];
        if (!Number.isFinite(v)) continue;
        const x = xOf(t);
        const y = yOf(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }, [history, group, colors, yMin, yMax]);

  return <canvas className="plot-canvas" ref={ref} />;
}

function SensorGraph({
  history,
  group,
  labels,
  colors,
}: {
  history: number[][];
  group: GraphGroup;
  labels: string[];
  colors: string[];
}) {
  const [auto, setAuto] = useState(true);
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    // The first switch to manual seeds the fields with the data range.
    if (!next && !minText && !maxText) {
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (const sample of history) {
        for (const s of group.indices) {
          if (s >= sample.length) continue;
          const v = sample[s];
          if (!Number.isFinite(v)) continue;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      if (Number.isFinite(mn) && Number.isFinite(mx)) {
        setMinText(mn.toFixed(2));
        setMaxText(mx.toFixed(2));
      }
    }
  };

  let yMin: number | null = null;
  let yMax: number | null = null;
  if (!auto) {
    const lo = Number.parseFloat(minText.trim());
    const hi = Number.parseFloat(maxText.trim());
    // Invalid or inverted bounds auto-scale.
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      yMin = lo;
      yMax = hi;
    }
  }

  return (
    <div className="plot-group">
      <div className="plot-header">
        <div className="plot-legend">
          <strong>{group.title}</strong>
          {group.indices.map((i) =>
            i < labels.length && i < colors.length ? (
              <span key={i}>
                <span className="plot-swatch" style={{ background: colors[i] }} />
                {labels[i]}
              </span>
            ) : null,
          )}
        </div>
        <div className="plot-scale">
          <PillToggle label="AUTO" on={auto} onClick={toggleAuto} />
          <input
            className="text-input tiny"
            placeholder="min"
            aria-label={`${group.title} minimum`}
            value={minText}
            disabled={auto}
            onChange={(event) => setMinText(event.target.value)}
          />
          <input
            className="text-input tiny"
            placeholder="max"
            aria-label={`${group.title} maximum`}
            value={maxText}
            disabled={auto}
            onChange={(event) => setMaxText(event.target.value)}
          />
        </div>
      </div>
      <PlotCanvas history={history} group={group} colors={colors} yMin={yMin} yMax={yMax} />
    </div>
  );
}

function SensorPanelBody({ config, controls }: { config: SensorConfig; controls: SlotControls }) {
  const reading = useObservable(config.source);
  const [page, setPage] = useState<"numbers" | "graph">("numbers");
  const historyRef = useRef<number[][]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!reading) {
      // Cleared on disconnect: the history goes too.
      if (historyRef.current.length) {
        historyRef.current = [];
        bump((v) => v + 1);
      }
      return;
    }
    historyRef.current.push(reading.values);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY);
    }
    bump((v) => v + 1);
  }, [reading]);

  // A fresh copy per render, as each reading re-renders.
  const snapshot = historyRef.current.slice();

  const empty = <EmptyState>No {config.title} data</EmptyState>;

  return (
    <PanelFrame
      title={config.title.toUpperCase()}
      controls={controls}
      headerExtra={
        <div style={{ width: 152 }}>
          <Segmented<"numbers" | "graph">
            value={page}
            onChange={setPage}
            options={[
              { value: "numbers", label: "Numbers" },
              { value: "graph", label: "Graph" },
            ]}
          />
        </div>
      }
    >
      <div className="panel-body">
        {page === "numbers" ? (
          !reading ? (
            empty
          ) : (
            <div className="sensor-readout">
              {config.labels.map((label, i) => {
                if (i >= reading.values.length) return null;
                const plotted = i < config.plotCount;
                return (
                  <div className="sensor-row" key={label}>
                    <span
                      className="sensor-dot"
                      style={{
                        background: plotted ? config.seriesColors[i] : "rgba(255,255,255,0.15)",
                      }}
                    />
                    <span className="sensor-name">{label}</span>
                    <span className="sensor-value">{reading.values[i].toFixed(3)}</span>
                    <span className="sensor-unit">{config.units[i]}</span>
                  </div>
                );
              })}
            </div>
          )
        ) : snapshot.length === 0 ? (
          empty
        ) : (
          config.groups.map((group) => (
            <SensorGraph
              key={group.title}
              history={snapshot}
              group={group}
              labels={config.labels}
              colors={config.seriesColors}
            />
          ))
        )}
      </div>
    </PanelFrame>
  );
}

export function MagnetometerPanel({ controls }: { controls: SlotControls }) {
  return <SensorPanelBody config={MAG_CONFIG} controls={controls} />;
}

export function ImuPanel({ controls }: { controls: SlotControls }) {
  return <SensorPanelBody config={IMU_CONFIG} controls={controls} />;
}
