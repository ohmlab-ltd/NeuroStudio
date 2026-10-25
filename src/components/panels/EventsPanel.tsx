import { useEffect, useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState } from "../controls";
import { useObservable } from "../../state/observable";
import { boardEvents } from "../../state/device";
import { boardEventSourcesLabel, boardEventStateLabel, type BoardEvent } from "../../device/tlv";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "12s ago", "3m 4s ago", "1h 2m ago"; clamped at zero, as the panel clock can trail by a tick. */
export function eventAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

/** The board's clock: time since boot. */
export function eventDeviceClock(tMs: number): string {
  const s = Math.floor(tMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `device +${pad2(h)}:${pad2(m)}:${pad2(s % 60)}`;
}

/** A clip with no frames yet is still being gathered. */
export function eventSummary(e: BoardEvent): string {
  const frames = e.preFrames + e.postFrames;
  const kept =
    frames > 0
      ? `${frames} frames  (${e.preFrames} before / ${e.postFrames} after)`
      : "clip pending";
  // Idle or refractory: the write is done, so sinksOk is final.
  const done = e.state === 0 || e.state === 3;
  const sinks = done ? (e.sinksOk !== 0 ? "saved" : frames > 0 ? "not saved" : "") : "";
  const parts = [boardEventStateLabel(e), `score ${e.score}`, kept];
  if (sinks) parts.push(sinks);
  return parts.join("  ·  ");
}

export function EventsPanel({ controls }: { controls: SlotControls }) {
  const events = useObservable(boardEvents);

  // Ticks the "n s ago" column.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <PanelFrame title="EVENTS" controls={controls}>
      <div className="panel-body">
        {events.length === 0 ? (
          <EmptyState>No events yet</EmptyState>
        ) : (
          events.map((e) => (
            <div key={e.id}>
              <div className="event-head">
                <span className="event-id">#{e.id}</span>
                <span className="event-sources">{boardEventSourcesLabel(e)}</span>
                <span className="event-age">{eventAge((now - e.receivedAt) / 1000)}</span>
              </div>
              <div className="event-summary">{eventSummary(e)}</div>
              <div className="event-clock">{eventDeviceClock(e.tMs)}</div>
            </div>
          ))
        )}
      </div>
    </PanelFrame>
  );
}
