/**
 * Exponential backoff with jitter for reconnects: 1s, 2s, 4s … capped at 30s.
 * `random` is injectable so tests are deterministic.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 30_000,
    private readonly random: () => number = Math.random,
  ) {}

  get attempts(): number {
    return this.attempt;
  }

  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    const jitter = raw * 0.2 * (this.random() * 2 - 1);
    return Math.max(this.baseMs / 2, Math.round(raw + jitter));
  }

  reset(): void {
    this.attempt = 0;
  }
}

/**
 * Detect that the machine slept: an interval that fires much later than
 * scheduled. After waking, ssh connections are usually dead but the master
 * process may not have noticed yet (ServerAlive needs another 30s).
 */
export function watchWake(onWake: (sleptMs: number) => void, intervalMs = 5000, thresholdMs = 20_000): () => void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last - intervalMs;
    last = now;
    if (gap > thresholdMs) onWake(gap);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
