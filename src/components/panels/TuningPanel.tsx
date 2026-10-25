import { useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState, Slider, Switch } from "../controls";
import { Icon } from "../Icon";
import { useObservable } from "../../state/observable";
import { tuneParams } from "../../state/device";
import { setTuneValue, tuneValues } from "../../state/controls";
import { appendTerminal } from "../../state/terminal";
import {
  buildTunePacket,
  kTuneFloatScale,
  kTuneHintHue,
  kTuneTypeBool,
  kTuneTypeFloat,
  tuneLiteral,
  type TuneParam,
} from "../../device/packets";

/** Fully saturated colour for a hue in degrees. */
function hueColor(deg: number): string {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const sector = Math.floor(h);
  const [r, g, b] =
    sector === 0
      ? [1, x, 0]
      : sector === 1
        ? [x, 1, 0]
        : sector === 2
          ? [0, 1, x]
          : sector === 3
            ? [0, x, 1]
            : sector === 4
              ? [x, 0, 1]
              : [1, 0, x];
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** Step in wire units: a power of ten near a hundredth of the range, so values stay round. */
export function floatStep(p: Pick<TuneParam, "lo" | "hi">): number {
  const span = p.hi - p.lo;
  return span > 0 ? Math.max(1, 10 ** Math.round(Math.log10(span / 100))) : 1;
}

/** Changes apply on the board at once and are not saved there. */
export function TuningPanel({ controls }: { controls: SlotControls }) {
  const params = useObservable(tuneParams);
  const values = useObservable(tuneValues);
  const [copied, setCopied] = useState(false);

  const commit = (p: TuneParam, wire: number) => {
    setTuneValue(p.id, wire);
    window.neuro.write(buildTunePacket(p.id, p.type, wire));
  };

  const display = (p: TuneParam, wire: number): string => {
    if (p.type === kTuneTypeBool) return wire !== 0 ? "on" : "off";
    if (p.type === kTuneTypeFloat) return (wire / kTuneFloatScale).toFixed(3);
    if (p.hint === kTuneHintHue) return `${wire}°`;
    return `${wire}`;
  };

  const copyAsCode = async () => {
    const body = params
      .map((p) => {
        const wire = values[p.id] ?? p.current;
        // Names are truncated to 15 chars and may hold spaces, so they go in a comment.
        return `/* ${p.name} */ ${tuneLiteral(p, wire)}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(`${body}\n`);
      setCopied(true);
      appendTerminal("[ui] Tuned values copied\n");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      appendTerminal("[ui] Copy failed: clipboard unavailable\n");
    }
  };

  const control = (p: TuneParam) => {
    const wire = values[p.id] ?? p.current;

    if (p.type === kTuneTypeBool) {
      return (
        <div className="field-row" key={p.id}>
          <span className="field-label">{p.name}</span>
          <Switch label={p.name} checked={wire !== 0} onChange={(on) => commit(p, on ? 1 : 0)} />
        </div>
      );
    }

    if (p.hi <= p.lo) {
      return (
        <div className="field-row" key={p.id}>
          <span className="field-label">{p.name}</span>
          <span className="field-value">{display(p, wire)}</span>
        </div>
      );
    }

    const isHue = p.hint === kTuneHintHue;

    return (
      <div key={p.id}>
        <div className="field-row">
          <span className="field-label">{p.name}</span>
          <span className="row" style={{ gap: 6 }}>
            {isHue ? (
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: hueColor(wire),
                  border: "1px solid rgba(255,255,255,0.25)",
                }}
              />
            ) : null}
            <span className="field-value">{display(p, wire)}</span>
          </span>
        </div>
        <Slider
          value={Math.min(p.hi, Math.max(p.lo, wire))}
          min={p.lo}
          max={p.hi}
          // Whole wire units, as the device truncates fractions.
          step={p.type === kTuneTypeFloat ? floatStep(p) : 1}
          className={isHue ? "hue" : undefined}
          onChange={(v) => setTuneValue(p.id, Math.round(v))}
          // Sent on release, not per drag frame.
          onCommit={(v) => commit(p, Math.round(v))}
        />
      </div>
    );
  };

  return (
    <PanelFrame
      title="TUNING"
      controls={controls}
      headerExtra={
        params.length ? (
          <button
            type="button"
            className="slot-button"
            title={copied ? "Copied" : "Copy tuned values as code"}
            aria-label="Copy tuned values as code"
            onClick={() => void copyAsCode()}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        ) : undefined
      }
    >
      <div className="panel-body">
        {params.length === 0 ? (
          <EmptyState>This sketch exposes no tunable parameters</EmptyState>
        ) : (
          <>
            <p className="panel-note">
              Changes apply on the board immediately and are not saved there. Copy as code to paste
              the values into the sketch.
            </p>
            {params.map(control)}
          </>
        )}
      </div>
    </PanelFrame>
  );
}
