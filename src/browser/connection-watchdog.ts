/** Foreground deadlines with explicit suspension for browser lifecycle changes. */
export class ConnectionWatchdog {
  private deadline: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private pingId: string | null = null;
  private isOpen = false;
  private suspended = false;
  private timerGeneration = 0;

  constructor(
    private readonly onTimeout: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.arm(10_000);
  }

  opened(): void {
    this.isOpen = true;
    this.stop();
  }

  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.stop();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    // An established connection gets a fresh ping from the caller. Do not let
    // an unanswered ping queued before a phone slept expire on its wakeup.
    if (!this.isOpen) this.arm(10_000);
  }

  probe(id: string, send: () => void): void {
    if (this.suspended || !this.check() || this.deadline !== null) return;
    this.pingId = id;
    this.arm(5_000);
    send();
  }

  pong(id: string): void {
    if (id === this.pingId) this.stop();
  }

  check(): boolean {
    if (this.suspended) return true;
    if (this.deadline !== null && this.now() >= this.deadline) {
      this.stop();
      this.onTimeout();
      return false;
    }
    return true;
  }

  stop(): void {
    this.timerGeneration++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = null;
    this.pingId = null;
  }

  private arm(timeout: number): void {
    const generation = ++this.timerGeneration;
    this.deadline = this.now() + timeout;
    this.timer = setTimeout(() => {
      if (generation === this.timerGeneration) this.check();
    }, timeout);
  }
}
