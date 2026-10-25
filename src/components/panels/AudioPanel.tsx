import { useEffect, useRef } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState, PanelSection } from "../controls";
import { useObservable } from "../../state/observable";
import { audioClass, audioLabels, audioMel } from "../../state/device";
import { audioMelAt, type AudioClassFrame, type AudioMelFrame } from "../../device/tlv";

/** The labels beacon can be missing or shorter than the score list. */
export function audioClassName(labels: readonly string[], i: number): string {
  return i < labels.length ? labels[i] : `class ${i}`;
}

/** Null when top is -1 or has no score. */
export function audioWinner(
  f: AudioClassFrame,
  labels: readonly string[],
): { name: string; score: number } | null {
  if (f.top < 0 || f.top >= f.scores.length) return null;
  return { name: audioClassName(labels, f.top), score: f.scores[f.top] };
}

/** As on the on-device display. */
export function audioBarTone(
  score: number,
  threshold: number,
  win: boolean,
): "win" | "over" | "under" {
  if (win) return "win";
  return score >= threshold ? "over" : "under";
}

/** The on-device waterfall's ramp. */
const MEL_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00],
  [0x14, 0x00, 0x50],
  [0x78, 0x00, 0x8c],
  [0xdc, 0x1e, 0x28],
  [0xff, 0x8c, 0x00],
  [0xff, 0xf0, 0x3c],
  [0xff, 0xff, 0xff],
];

const MEL_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const f = (v / 255) * (MEL_RAMP.length - 1);
    const i = Math.min(MEL_RAMP.length - 2, Math.floor(f));
    const t = f - i;
    for (let c = 0; c < 3; c++) {
      const a = MEL_RAMP[i][c];
      lut[v * 3 + c] = Math.round(a + (MEL_RAMP[i + 1][c] - a) * t);
    }
  }
  return lut;
})();

/** One pixel per (frame, mel bin), newest frame on the right, lowest band at the bottom. */
export function audioMelToRgba(mel: AudioMelFrame): Uint8ClampedArray<ArrayBuffer> {
  const w = mel.nFrames;
  const h = mel.nMel;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let m = 0; m < h; m++) {
    const row = h - 1 - m;
    for (let f = 0; f < w; f++) {
      const v = audioMelAt(mel, m, f) * 3;
      const o = (row * w + f) * 4;
      out[o] = MEL_LUT[v];
      out[o + 1] = MEL_LUT[v + 1];
      out[o + 2] = MEL_LUT[v + 2];
      out[o + 3] = 0xff;
    }
  }
  return out;
}

function MelCanvas({ mel }: { mel: AudioMelFrame }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (canvas.width !== mel.nFrames || canvas.height !== mel.nMel) {
      canvas.width = mel.nFrames;
      canvas.height = mel.nMel;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(audioMelToRgba(mel), mel.nFrames, mel.nMel), 0, 0);
  }, [mel]);

  return (
    <canvas
      ref={ref}
      className="audio-mel"
      style={{ aspectRatio: `${mel.nFrames} / ${mel.nMel}` }}
    />
  );
}

const unit = (v: number) => `${Math.min(1, Math.max(0, v)) * 100}%`;

export function ScoreRow({
  name,
  score,
  threshold,
  win,
}: {
  name: string;
  score: number;
  threshold: number;
  win: boolean;
}) {
  return (
    <div className="audio-score">
      <span className={win ? "audio-score-name win" : "audio-score-name"} title={name}>
        {name}
      </span>
      <span className="audio-bar">
        <span
          className={`audio-bar-fill ${audioBarTone(score, threshold, win)}`}
          style={{ width: unit(score) }}
        />
        <span className="audio-bar-threshold" style={{ left: unit(threshold) }} />
      </span>
      <span className="audio-score-value">{Math.round(score * 100)}</span>
    </div>
  );
}

export function AudioPanel({ controls }: { controls: SlotControls }) {
  const labels = useObservable(audioLabels);
  const frame = useObservable(audioClass);
  const mel = useObservable(audioMel);
  const winner = frame ? audioWinner(frame, labels) : null;
  const melSize = mel ? `${mel.nMel}x${mel.nFrames}` : "none";

  return (
    <PanelFrame title="AUDIO" controls={controls}>
      <div className="panel-body">
        {!frame ? (
          <EmptyState>
            {/* One grid item, so the empty state's grid does not pull the lines apart. */}
            <span>
              Waiting for a classification…
              <span className="audio-arrived">
                {`labels ${labels.length}   spectrogram ${melSize}`}
              </span>
            </span>
          </EmptyState>
        ) : (
          <>
            <div className={winner ? "audio-top win" : "audio-top"}>
              <span className="audio-top-name">
                {winner ? winner.name : "nothing above threshold"}
              </span>
              {winner ? (
                <span className="audio-top-score">{Math.round(winner.score * 100)}%</span>
              ) : null}
            </div>
            <div className="audio-scores">
              {frame.scores.map((score, i) => (
                <ScoreRow
                  key={i}
                  name={audioClassName(labels, i)}
                  score={score}
                  threshold={frame.threshold}
                  win={i === frame.top}
                />
              ))}
            </div>
            <div className="audio-meta">
              <span>level {frame.level}</span>
              <span>threshold {frame.threshold.toFixed(2)}</span>
            </div>
          </>
        )}
        {mel ? (
          <>
            <PanelSection>Model input (log-mel)</PanelSection>
            <MelCanvas mel={mel} />
            <p className="panel-note audio-note">
              {`${mel.nMel} mel x ${mel.nFrames} frames, ` +
                `${mel.layout === 0 ? "frame-major" : "mel-major"}  ` +
                "(low frequencies at the bottom, newest on the right)"}
            </p>
          </>
        ) : null}
      </div>
    </PanelFrame>
  );
}
