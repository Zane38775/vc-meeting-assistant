export class StreamingPcmEncoder {
  private filled = 0;
  private weighted = 0;
  private offset = 0;
  private frame = new Uint8Array(6400);
  private view = new DataView(this.frame.buffer);

  constructor(private readonly rate: number, private readonly emit: (frame: Uint8Array) => void) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw new Error('Unsupported audio sample rate');
  }

  // Integrate source samples over each destination interval. Integer time units
  // retain fractional 44.1 kHz phases across render quanta without clock drift.
  push(samples: Float32Array): void {
    for (const input of samples) {
      const value = Number.isFinite(input) ? input : 0;
      let remaining = 16000;
      while (remaining > 0) {
        const weight = Math.min(remaining, this.rate - this.filled);
        this.weighted += value * weight;
        this.filled += weight;
        remaining -= weight;
        if (this.filled === this.rate) {
          this.append(this.weighted / this.rate);
          this.filled = this.weighted = 0;
        }
      }
    }
  }

  private append(sample: number): void {
    const clipped = Math.max(-1, Math.min(1, sample));
    this.view.setInt16(this.offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
    this.offset += 2;
    if (this.offset === this.frame.length) this.emitFrame();
  }

  private emitFrame(): void {
    const complete = this.frame;
    this.frame = new Uint8Array(6400);
    this.view = new DataView(this.frame.buffer);
    this.offset = 0;
    this.emit(complete);
  }

  flush(): void {
    if (this.filled) this.append(this.weighted / this.filled);
    if (this.offset) this.emitFrame(); // zero-pad only the last frame on stop
    this.filled = this.weighted = 0;
  }

  reset(): void {
    this.filled = this.weighted = this.offset = 0;
    this.frame.fill(0);
  }
}

export function mixAndMeasure(mic: Float32Array[], system: Float32Array[], size: number) {
  const samples = new Float32Array(size);
  let micPower = 0, systemPower = 0;
  for (let i = 0; i < size; i++) {
    let m = 0, s = 0;
    for (const channel of mic) m += (channel[i] || 0) / mic.length;
    for (const channel of system) s += (channel[i] || 0) / system.length;
    micPower += m * m;
    systemPower += s * s;
    samples[i] = Math.max(-1, Math.min(1, m + s));
  }
  return {samples, mic: Math.sqrt(micPower / (size || 1)), system: Math.sqrt(systemPower / (size || 1))};
}
