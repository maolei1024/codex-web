/** Wall-clock deadlines survive background timer throttling and page freezing. */
export class ConnectionWatchdog {
  private deadline: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private pingId: string | null = null;

  constructor(
    private readonly onTimeout: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.arm(10_000);
  }

  opened(): void {
    this.stop();
  }

  probe(id: string, send: () => void): void {
    if (!this.check() || this.deadline !== null) return;
    this.pingId = id;
    this.arm(5_000);
    send();
  }

  pong(id: string): void {
    if (id === this.pingId) this.stop();
  }

  check(): boolean {
    if (this.deadline !== null && this.now() >= this.deadline) {
      this.stop();
      this.onTimeout();
      return false;
    }
    return true;
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = null;
    this.pingId = null;
  }

  private arm(timeout: number): void {
    this.deadline = this.now() + timeout;
    this.timer = setTimeout(() => this.check(), timeout);
  }
}
