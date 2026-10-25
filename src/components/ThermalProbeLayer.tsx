import { useState } from "react";
import { Icon } from "./Icon";
import { probeLabel } from "../device/thermal";
import type { ThermalFrame } from "../device/tlv";
import { addThermalProbe, removeThermalProbe, thermalProbes } from "../state/probes";
import { useObservable } from "../state/observable";
import type { Rect } from "../render/overlay";

/** `rect` is where the image sits inside the parent. */
export function ThermalProbeLayer({ frame, rect }: { frame: ThermalFrame | null; rect: Rect }) {
  const probes = useObservable(thermalProbes);
  const [leaving, setLeaving] = useState<number | null>(null);

  if (!frame || rect.w <= 0 || rect.h <= 0) return null;

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    if (
      localX < rect.x ||
      localY < rect.y ||
      localX > rect.x + rect.w ||
      localY > rect.y + rect.h
    ) {
      return;
    }
    addThermalProbe(
      Math.min(1, Math.max(0, (localX - rect.x) / rect.w)),
      Math.min(1, Math.max(0, (localY - rect.y) / rect.h)),
    );
  };

  const remove = (id: number) => {
    setLeaving(id);
    window.setTimeout(() => {
      removeThermalProbe(id);
      setLeaving((current) => (current === id ? null : current));
    }, 140);
  };

  return (
    <div className="probe-layer" onClick={onClick}>
      {probes.map((probe) => (
        <div
          key={probe.id}
          className={leaving === probe.id ? "probe-marker leaving" : "probe-marker"}
          style={{
            left: `${rect.x + probe.u * rect.w}px`,
            top: `${rect.y + probe.v * rect.h}px`,
          }}
        >
          <span className="probe-ring" />
          <button
            type="button"
            className="probe-chip"
            title="Remove tracking point"
            onClick={(event) => {
              event.stopPropagation();
              remove(probe.id);
            }}
          >
            {probeLabel(frame, probe.u, probe.v)}
            <span className="probe-cross">
              <Icon name="plus" size={13} />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
