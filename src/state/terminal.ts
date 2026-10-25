import { Observable } from "./observable";

/** The oldest lines are dropped past this. A partial last line waits in `residual`. */
const MAX_LINES = 5000;

/** A full chunk never changes, and trimming drops whole chunks. */
const CHUNK_LINES = 250;

export interface TerminalChunk {
  /** Increases with every new chunk, so it is a stable React key. */
  readonly id: number;
  /** Append-only, and full once it holds CHUNK_LINES lines. */
  readonly lines: string[];
}

let chunks: TerminalChunk[] = [];
let lineCount = 0;
let nextChunkId = 0;
let residual = "";
let notifyScheduled = false;

/** A version counter, bumped at most once per animation frame. */
export const terminalVersion = new Observable<number>(0);

function bumpVersion(): void {
  notifyScheduled = false;
  terminalVersion.set(terminalVersion.get() + 1);
}

function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(bumpVersion);
  else setTimeout(bumpVersion, 16);
}

export function terminalChunks(): readonly TerminalChunk[] {
  return chunks;
}

/** Every complete line, oldest first. Builds a new array. */
export function terminalLines(): string[] {
  return chunks.flatMap((chunk) => chunk.lines);
}

export function terminalLength(): number {
  return lineCount;
}

function pushLine(text: string): void {
  let last = chunks[chunks.length - 1];
  if (!last || last.lines.length >= CHUNK_LINES) {
    last = { id: nextChunkId++, lines: [] };
    chunks.push(last);
  }
  last.lines.push(text);
  lineCount++;
}

export function appendTerminal(text: string): void {
  if (!text) return;
  const combined = residual + text;
  const parts = combined.split("\n");
  residual = parts.pop() ?? "";
  if (parts.length === 0) return;
  for (const part of parts) pushLine(part);
  while (lineCount > MAX_LINES && chunks.length > 1) {
    lineCount -= chunks.shift()!.lines.length;
  }
  scheduleNotify();
}

export function clearTerminal(): void {
  chunks = [];
  lineCount = 0;
  residual = "";
  bumpVersion();
}

/** Full text, including any trailing fragment. */
export function terminalFullText(): string {
  const text = terminalLines().join("\n");
  if (!residual) return text;
  return lineCount > 0 ? `${text}\n${residual}` : residual;
}
