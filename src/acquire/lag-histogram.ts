// O(1)-memory histogram of tick lag in microseconds: 64 power-of-two buckets, never grows.
// Quantiles are reported as the bucket's upper bound ("p99 <= 64 us") — honest about resolution.

export class LagHistogram {
  #buckets = new Float64Array(64); // bucket i covers [2^(i-1), 2^i) microseconds
  #n = 0;
  #sum = 0;
  #max = 0;

  add(us: number): void {
    this.#n++;
    this.#sum += us;
    if (us > this.#max) this.#max = us;
    this.#buckets[us < 1 ? 0 : Math.min(63, 32 - Math.clz32(Math.floor(us)))]++;
  }

  quantile(q: number): number {
    const target = this.#n * q;
    let acc = 0;
    for (let i = 0; i < 64; i++) {
      acc += this.#buckets[i];
      if (acc >= target) return i === 0 ? 1 : 2 ** i;
    }
    return this.#max;
  }

  toJSON() {
    return {
      samples: this.#n,
      meanUs: this.#n ? +(this.#sum / this.#n).toFixed(1) : 0,
      p50UsAtMost: this.quantile(0.5),
      p99UsAtMost: this.quantile(0.99),
      maxUs: +this.#max.toFixed(1),
    };
  }
}
