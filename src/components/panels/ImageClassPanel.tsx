import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState } from "../controls";
import { useObservable } from "../../state/observable";
import { imageClass } from "../../state/device";
import type { ImageClassEntry } from "../../device/tlv";
import { ScoreRow } from "./AudioPanel";

export function imageClassName(entry: ImageClassEntry): string {
  return entry.name || `class ${entry.index}`;
}

/** One decimal when needed: the threshold travels x1000, so 0.125 is 12.5%. */
export function thresholdPercent(threshold: number): string {
  return `${Math.round(threshold * 1000) / 10}%`;
}

export function ImageClassPanel({ controls }: { controls: SlotControls }) {
  const frame = useObservable(imageClass);
  const top = frame?.entries[0];

  return (
    <PanelFrame title="IMAGE CLASSIFIER" controls={controls}>
      <div className="panel-body">
        {!frame ? (
          <EmptyState>Waiting for a classification…</EmptyState>
        ) : (
          <>
            <div className={top ? "audio-top win" : "audio-top"}>
              <span className="audio-top-name">
                {top ? imageClassName(top) : `Nothing above ${thresholdPercent(frame.threshold)}`}
              </span>
              {top ? <span className="audio-top-score">{Math.round(top.score * 100)}%</span> : null}
            </div>
            {frame.entries.length > 0 ? (
              <div className="audio-scores image-class-scores">
                {frame.entries.map((entry, i) => (
                  <ScoreRow
                    key={i}
                    name={imageClassName(entry)}
                    score={entry.score}
                    threshold={frame.threshold}
                    win={i === 0}
                  />
                ))}
              </div>
            ) : null}
            <div className="audio-meta">
              <span>{frame.numClasses > 0 ? `${frame.numClasses} classes` : null}</span>
              <span>threshold {thresholdPercent(frame.threshold)}</span>
            </div>
          </>
        )}
      </div>
    </PanelFrame>
  );
}
