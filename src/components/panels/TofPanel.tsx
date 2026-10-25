import { useMemo, useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState } from "../controls";
import { useObservable } from "../../state/observable";
import { tofFrame } from "../../state/device";
import { patchTofDisplayOptions, tofDisplayOptions } from "../../state/options";
import { kTofEmptyColor, tofDistanceColor } from "../../device/thermal";
import type { TofFrame } from "../../device/tlv";

/** 16x16 SPAD grid of average distance and coverage count; index = sy*16 + sx. */
function buildSpadGrid(f: TofFrame): { avg: Float64Array; cov: Int32Array } {
  const sums = new Float64Array(256);
  const counts = new Int32Array(256);

  for (let z = 0; z < f.distancesMm.length; z++) {
    const d = f.distancesMm[z];
    if (d <= 0) continue;
    const gridRow = Math.floor(z / f.cols);
    const gridCol = z % f.cols;
    const tlX = gridCol * f.roiStep;
    const tlY = 15 - gridRow * f.roiStep;
    for (let sy = tlY - f.roiSize + 1; sy <= tlY; sy++) {
      if (sy < 0 || sy > 15) continue;
      for (let sx = tlX; sx <= tlX + f.roiSize - 1; sx++) {
        if (sx < 0 || sx > 15) continue;
        const idx = sy * 16 + sx;
        sums[idx] += d;
        counts[idx] += 1;
      }
    }
  }

  const avg = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    if (counts[i] > 0) avg[i] = sums[i] / counts[i];
  }
  return { avg, cov: counts };
}

/** Display only: the sketch sets the sensor's profile, ROI and timing. */
export function TofPanel({ controls }: { controls: SlotControls }) {
  const frame = useObservable(tofFrame);
  const display = useObservable(tofDisplayOptions);

  const [minMmText, setMinMmText] = useState(display.minMm.toFixed(0));
  const [maxMmText, setMaxMmText] = useState(display.maxMm.toFixed(0));

  const [hovered, setHovered] = useState<number | null>(null);

  const grid = useMemo(() => (frame && !frame.legacy ? buildSpadGrid(frame) : null), [frame]);

  let hoverText = "";
  if (hovered !== null && grid) {
    const sx = hovered % 16;
    const sy = Math.floor(hovered / 16);
    const mm = grid.avg[hovered];
    hoverText =
      grid.cov[hovered] > 0 && mm > 0
        ? `(${sx}, ${sy}) ${mm.toFixed(0)} mm`
        : `(${sx}, ${sy}) no reading`;
  }

  return (
    <PanelFrame
      title="TIME OF FLIGHT"
      controls={controls}
      headerExtra={hoverText ? <span className="tof-hover">{hoverText}</span> : undefined}
    >
      <div className="panel-body">
        {!frame || frame.distancesMm.length === 0 ? (
          <EmptyState>No ToF data</EmptyState>
        ) : (
          <div className="tof-body">
            <div className="tof-viewer">
              {frame.legacy ? (
                // The 4x4 grid in mm, flipped like the 16x16 view: display row 0 is zone row 3.
                <div className="spad-grid legacy">
                  {Array.from({ length: 16 }, (_, cell) => {
                    const row = Math.floor(cell / 4);
                    const col = cell % 4;
                    const zoneIdx = (3 - row) * 4 + col;
                    const mm = frame.distancesMm[zoneIdx] ?? 0;
                    return (
                      <div
                        key={cell}
                        className="spad-cell"
                        style={{ background: tofDistanceColor(mm, display.minMm, display.maxMm) }}
                      >
                        {mm <= 0 ? "--" : Math.round(mm)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="spad-grid" onMouseLeave={() => setHovered(null)}>
                  {Array.from({ length: 256 }, (_, cell) => {
                    // Display row 0, the top, is SPAD y = 0.
                    const mm = grid ? grid.avg[cell] : 0;
                    const covered = grid ? grid.cov[cell] > 0 && mm > 0 : false;
                    return (
                      <div
                        key={cell}
                        className={hovered === cell ? "spad-cell hover" : "spad-cell"}
                        style={{
                          background: covered
                            ? tofDistanceColor(mm, display.minMm, display.maxMm)
                            : kTofEmptyColor,
                        }}
                        onMouseEnter={() => setHovered(cell)}
                      />
                    );
                  })}
                </div>
              )}

              {/* Colour key: min, near and bright, at the top; max at the bottom. */}
              <div className="tof-key">
                <input
                  className="text-input tiny"
                  value={minMmText}
                  aria-label="Minimum distance, millimetres"
                  onChange={(event) => {
                    setMinMmText(event.target.value);
                    const value = Number.parseFloat(event.target.value.trim());
                    if (!Number.isNaN(value)) patchTofDisplayOptions({ minMm: value });
                  }}
                />
                <div className="tof-key-bar" />
                <input
                  className="text-input tiny"
                  value={maxMmText}
                  aria-label="Maximum distance, millimetres"
                  onChange={(event) => {
                    setMaxMmText(event.target.value);
                    const value = Number.parseFloat(event.target.value.trim());
                    if (!Number.isNaN(value)) patchTofDisplayOptions({ maxMm: value });
                  }}
                />
                <span className="tof-key-unit">mm</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </PanelFrame>
  );
}
