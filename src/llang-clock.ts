export interface EffectsClock {
  monotonicMs(): number;
  wallClockMs(): number;
  waitUntil(deadlineMs: number, signal?: AbortSignal): Promise<void>;
}

export class SystemEffectsClock implements EffectsClock {
  monotonicMs(): number {
    return performance.now();
  }

  wallClockMs(): number {
    return Date.now();
  }

  waitUntil(deadlineMs: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.max(0, deadlineMs - this.monotonicMs());
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("CANCELLED"));
        return;
      }
      const timer = setTimeout(done, delay),
        abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new Error("CANCELLED"));
        };
      function done() {
        signal?.removeEventListener("abort", abort);
        resolve();
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

type Waiter = {
  deadline: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class VirtualEffectsClock implements EffectsClock {
  readonly #waiters: Waiter[] = [];
  #monotonic: number;
  #wallClock: number;

  constructor(monotonic: number, wallClock: number) {
    this.#monotonic = monotonic;
    this.#wallClock = wallClock;
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  wallClockMs(): number {
    return this.#wallClock;
  }

  waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(deadline))
      return Promise.reject(new Error("INVALID_DEADLINE"));
    if (deadline <= this.#monotonic) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error("CANCELLED"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        deadline,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.abort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("CANCELLED"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#waiters.push(waiter);
      this.#waiters.sort((a, b) => a.deadline - b.deadline);
    });
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("INVALID_CLOCK_ADVANCE");
    this.#monotonic += milliseconds;
    this.#wallClock += milliseconds;
    while (this.#waiters[0] && this.#waiters[0].deadline <= this.#monotonic) {
      const waiter = this.#waiters.shift();
      if (!waiter) break;
      if (waiter.abort)
        waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    }
  }
}
