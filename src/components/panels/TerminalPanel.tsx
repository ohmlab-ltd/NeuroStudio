import { memo, useEffect, useRef, useState } from "react";
import { PanelFrame, type SlotControls } from "../PanelFrame";
import { useObservable } from "../../state/observable";
import {
  appendTerminal,
  clearTerminal,
  terminalChunks,
  terminalFullText,
  terminalLength,
  terminalVersion,
} from "../../state/terminal";

/** `count` changes only while the chunk fills, so memo skips every full chunk. */
const TerminalChunkLines = memo(function TerminalChunkLines({
  lines,
}: {
  lines: readonly string[];
  count: number;
}) {
  return (
    <>
      {lines.map((line, index) => (
        // A chunk only grows at the end and is dropped whole, so the index is a stable key.
        <div className="terminal-line" key={index}>
          {line}
        </div>
      ))}
    </>
  );
});

function timestamp(): string {
  const d = new Date();
  const two = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}_` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

export function TerminalPanel({ controls }: { controls: SlotControls }) {
  useObservable(terminalVersion); // re-renders when lines are added
  const chunks = terminalChunks();
  const lineCount = terminalLength();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!autoScroll) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  });

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  const save = async () => {
    const result = await window.neuro.saveLog(
      `neurostudio_log_${timestamp()}.txt`,
      terminalFullText(),
    );
    if (result.canceled) return;
    appendTerminal(
      result.error
        ? `[ui] Failed to save log: ${result.error}\n`
        : `[ui] Saved log to ${result.path}\n`,
    );
  };

  return (
    <PanelFrame
      title="TERMINAL"
      note={autoScroll ? undefined : "paused"}
      controls={controls}
      headerExtra={
        <>
          <button
            type="button"
            className="button small quiet"
            disabled={lineCount === 0}
            onClick={() => void save()}
          >
            Save
          </button>
          <button
            type="button"
            className="button small quiet"
            disabled={lineCount === 0}
            onClick={clearTerminal}
          >
            Clear
          </button>
        </>
      }
    >
      <div className="panel-body">
        <div className="terminal-body" ref={bodyRef} onScroll={onScroll}>
          {lineCount === 0 ? (
            <div className="panel-empty" style={{ minHeight: 0, padding: 0 }}>
              No output yet
            </div>
          ) : (
            chunks.map((chunk) => (
              <TerminalChunkLines key={chunk.id} lines={chunk.lines} count={chunk.lines.length} />
            ))
          )}
        </div>
      </div>
    </PanelFrame>
  );
}
