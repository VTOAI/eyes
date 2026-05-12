export class AlertDedup {
  private recent = new Map<string, number>();
  private cooldownMs: number;

  constructor(cooldownMs = 5 * 60 * 1000) {
    this.cooldownMs = cooldownMs;
  }

  shouldProcess(alertKey: string): boolean {
    const lastSeen = this.recent.get(alertKey);
    const now = Date.now();
    if (lastSeen !== undefined && (now - lastSeen) < this.cooldownMs) {
      return false;
    }
    this.recent.set(alertKey, now);
    this.prune();
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.cooldownMs * 2;
    for (const [key, ts] of this.recent) {
      if (ts < cutoff) this.recent.delete(key);
    }
  }

  reset(): void {
    this.recent.clear();
  }
}

export class ConcurrencyLimiter {
  private running = 0;

  constructor(private maxConcurrent = 3) {}

  async acquire(): Promise<() => void> {
    while (this.running >= this.maxConcurrent) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.running++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.running--;
      }
    };
  }

  get active(): number {
    return this.running;
  }
}
