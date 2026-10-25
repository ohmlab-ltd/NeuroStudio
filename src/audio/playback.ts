// Live playback of the board's microphone, TLV 0x50, at the rate the board reports.

import { Observable } from "../state/observable";

const JITTER_SECONDS = 0.15;

/** Most audio queued ahead of the play head; a chunk arriving past this is dropped. */
export const MAX_LEAD_SECONDS = JITTER_SECONDS + 0.1;

class AudioPlayback {
  readonly listening = new Observable<boolean>(false);

  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private rate = 0;
  private channels = 0;
  private nextStartTime = 0;

  async setListening(on: boolean): Promise<void> {
    this.listening.set(on);
    if (!on) {
      // Closing the context discards the queued audio, so unmuting starts empty.
      this.teardown();
      return;
    }
    if (this.context && this.context.state === "suspended") {
      try {
        await this.context.resume();
      } catch {
        /* non-fatal */
      }
    }
  }

  toggle(): void {
    void this.setListening(!this.listening.get());
  }

  private ensureContext(sampleRate: number, channels: number): AudioContext | null {
    if (this.context && this.rate === sampleRate && this.channels === channels) {
      return this.context;
    }
    this.teardown();
    try {
      const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(context.destination);
      this.context = context;
      this.gain = gain;
      this.rate = sampleRate;
      this.channels = channels;
      this.nextStartTime = 0;
      return context;
    } catch {
      // A rate the platform refuses, or no output device.
      this.context = null;
      this.gain = null;
      return null;
    }
  }

  /** Queues one int16 LE PCM chunk; a no-op unless listening. */
  feed(pcm: Uint8Array, sampleRate: number, channels: number): void {
    if (!this.listening.get() || sampleRate <= 0 || pcm.length === 0) return;

    const channelCount = channels >= 2 ? 2 : 1;
    const context = this.ensureContext(sampleRate, channelCount);
    if (!context || !this.gain) return;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    const samples = Math.floor(pcm.length / 2);
    const frames = Math.floor(samples / channelCount);
    if (frames <= 0) return;

    const now = context.currentTime;
    if (this.nextStartTime < now + 0.001) {
      // Underrun or first chunk: rebuild the jitter buffer.
      this.nextStartTime = now + JITTER_SECONDS;
    } else if (this.nextStartTime - now > MAX_LEAD_SECONDS) {
      return;
    }

    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let buffer: AudioBuffer;
    try {
      buffer = context.createBuffer(channelCount, frames, sampleRate);
    } catch {
      return;
    }

    for (let ch = 0; ch < channelCount; ch++) {
      const target = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        target[i] = view.getInt16((i * channelCount + ch) * 2, true) / 32768;
      }
    }

    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
    } catch {
      /* transient: drop this chunk */
    }
  }

  private teardown(): void {
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.rate = 0;
    this.channels = 0;
    this.nextStartTime = 0;
    if (context) {
      void context.close().catch(() => undefined);
    }
  }

  /** Called on disconnect. */
  async reset(): Promise<void> {
    this.teardown();
  }
}

export const audioPlayback = new AudioPlayback();
