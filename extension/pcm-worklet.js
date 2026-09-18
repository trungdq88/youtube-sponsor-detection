// AudioWorklet: resamples whatever the page's audio context runs at (44.1 or
// 48 kHz) down to 16 kHz mono 16-bit PCM in chunks of about 100 ms, which is
// what the streaming speech API wants on its socket.

const TARGET_RATE = 16000;
const CHUNK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK);
    this.filled = 0;
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position into the pending input
    this.pending = new Float32Array(0);
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    // Mix to mono.
    const n = channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;

    // Append to what is left from the last block and resample by linear interpolation.
    const input = new Float32Array(this.pending.length + n);
    input.set(this.pending);
    input.set(mono, this.pending.length);
    let pos = this.pos;
    while (pos + 1 < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s = input[i] * (1 - frac) + input[i + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(CHUNK);
        this.filled = 0;
      }
      pos += this.step;
    }
    const keepFrom = Math.floor(pos);
    this.pending = input.slice(keepFrom);
    this.pos = pos - keepFrom;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
