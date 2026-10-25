const fsp = require("node:fs/promises");

/** Bytes a recording may queue in memory before frames are dropped. */
const RECORDER_HIGH_WATER_MARK = 8 * 1024 * 1024;

const errorText = (error) => String((error && error.message) || error);

/**
 * One MJPEG recording: JPEG frames back to back in one file. After open() nothing throws;
 * a write error ends it, goes once to onError and is returned by stop().
 */
class Recorder {
  constructor(filePath, stream, onError) {
    this.path = filePath;
    this.stream = stream;
    this.onError = onError;
    this.error = null;
    this.frames = 0;
    this.droppedFrames = 0;
    this.waitingForDrain = false;
    this.stopped = false;
    this.stopping = null;
    stream.on("error", (error) => this.fail(error));
    stream.on("drain", () => {
      this.waitingForDrain = false;
    });
  }

  // Creates or truncates the file before resolving, so an unwritable path rejects here.
  /** @param {string} filePath
   *  @param {{ onError?: (error: Error) => void, highWaterMark?: number }} [options] */
  static async open(
    filePath,
    { onError = () => {}, highWaterMark = RECORDER_HIGH_WATER_MARK } = {},
  ) {
    const handle = await fsp.open(filePath, "w");
    return new Recorder(filePath, handle.createWriteStream({ highWaterMark }), onError);
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.stream.destroy();
    // After stop(), its result reports the error.
    if (this.stopped) return;
    try {
      this.onError(error);
    } catch {
      // stop() still returns the error.
    }
  }

  /** Queues one frame. While the file is behind, frames are dropped and counted. */
  append(bytes) {
    if (this.error || this.stopped) return;
    if (this.waitingForDrain) {
      this.droppedFrames += 1;
      return;
    }
    this.frames += 1;
    if (!this.stream.write(bytes)) this.waitingForDrain = true;
  }

  // Flushes and closes the file. Safe to call more than once.
  /** @returns {Promise<{ path: string, error?: string, frames: number, droppedFrames: number }>} */
  stop() {
    if (!this.stopping) {
      this.stopped = true;
      this.stopping = this.finish();
    }
    return this.stopping;
  }

  async finish() {
    const closed = this.stream.closed
      ? Promise.resolve()
      : new Promise((resolve) => this.stream.once("close", resolve));
    if (!this.error) this.stream.end();
    await closed;
    const result = { path: this.path, frames: this.frames, droppedFrames: this.droppedFrames };
    return this.error ? { ...result, error: errorText(this.error) } : result;
  }
}

module.exports = { Recorder, RECORDER_HIGH_WATER_MARK };
