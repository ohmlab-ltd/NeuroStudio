import { Icon } from "./Icon";

export function CameraTools({
  fillViewport,
  canToggleAspect,
  isRecording,
  canRecord,
  recordTitle,
  canSnapshot,
  snapshotTitle,
  onToggleFit,
  onToggleAspect,
  onToggleRecord,
  onSnapshot,
}: {
  fillViewport: boolean;
  canToggleAspect: boolean;
  isRecording: boolean;
  canRecord: boolean;
  recordTitle: string;
  canSnapshot: boolean;
  snapshotTitle: string;
  onToggleFit(): void;
  onToggleAspect(): void;
  onToggleRecord(): void;
  onSnapshot(): void;
}) {
  return (
    <div className={isRecording ? "camera-tools pinned" : "camera-tools"}>
      <button type="button" className="tool-button" title="Fullscreen" onClick={onToggleFit}>
        <Icon name="fullscreen" size={16} />
      </button>
      <button
        type="button"
        className={fillViewport ? "tool-button active" : "tool-button"}
        title={
          !canToggleAspect
            ? "Fill viewport: off (fullscreen is always letterboxed)"
            : fillViewport
              ? "Fill viewport: on"
              : "Fill viewport: off (letterboxed)"
        }
        disabled={!canToggleAspect}
        onClick={onToggleAspect}
      >
        <Icon name="aspect" size={16} />
      </button>
      <button
        type="button"
        className={isRecording ? "tool-button recording" : "tool-button"}
        title={recordTitle}
        disabled={!canRecord}
        onClick={onToggleRecord}
      >
        <Icon name={isRecording ? "stop" : "record"} size={16} />
      </button>
      <button
        type="button"
        className="tool-button"
        title={snapshotTitle}
        disabled={!canSnapshot}
        onClick={onSnapshot}
      >
        <Icon name="snapshot" size={16} />
      </button>
    </div>
  );
}
