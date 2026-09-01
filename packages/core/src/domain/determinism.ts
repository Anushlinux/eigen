export interface Clock {
  now(): string;
}

export interface MonotonicTimer {
  now(): number;
}

export class SystemMonotonicTimer implements MonotonicTimer {
  now(): number {
    return performance.now();
  }
}

export class DeterministicClock implements Clock {
  private tick = 0;
  private readonly baseTime: number;

  constructor(seed: number) {
    this.baseTime = Date.UTC(2026, 0, 1) + seed * 1_000;
  }

  now(): string {
    const value = new Date(this.baseTime + this.tick).toISOString();
    this.tick += 1;
    return value;
  }
}

export class DeterministicIdGenerator {
  private readonly counters = new Map<string, number>();

  constructor(private readonly seed: number) {}

  next(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    return `${prefix}_${this.seed.toString(36)}_${count.toString().padStart(3, "0")}`;
  }
}
