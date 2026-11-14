/** One foreground allowance; established pages share it across transport and AppHost. */
export class TransportRecoveryWindow {
  private running = false;
  private exhausted = false;
  private suspended = false;
  private remainingMs: number;
  private deadline: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private timerGeneration = 0;

  constructor(
    private readonly onTimeout: () => void,
    private readonly now: () => number = Date.now,
    private budgetMs = 60_000,
  ) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0)
      throw new RangeError(
        "Transport recovery budget must be positive and finite",
      );
    this.remainingMs = budgetMs;
  }

  get failed(): boolean {
    return this.exhausted;
  }

  get active(): boolean {
    return this.running;
  }

  start(budgetMs = this.budgetMs): void {
    if (this.running || this.exhausted) return;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0)
      throw new RangeError("Recovery budget must be positive and finite");
    this.budgetMs = budgetMs;
    this.running = true;
    this.remainingMs = this.budgetMs;
    if (!this.suspended) this.arm();
  }

  connected(): void {
    // A late open callback cannot turn an expired attempt into a success.
    if (!this.check()) return;
    this.stop();
    this.remainingMs = this.budgetMs;
  }

  reset(budgetMs = this.budgetMs): void {
    this.stop();
    this.exhausted = false;
    this.start(budgetMs);
  }

  suspend(): void {
    if (this.suspended) return;
    this.remainingMs = this.remaining();
    this.suspended = true;
    this.deadline = null;
    this.clearTimer();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.running && !this.exhausted) this.arm();
  }

  check(): boolean {
    if (
      this.running &&
      !this.suspended &&
      this.deadline !== null &&
      this.now() >= this.deadline
    ) {
      this.running = false;
      this.exhausted = true;
      this.remainingMs = 0;
      this.deadline = null;
      this.clearTimer();
      this.onTimeout();
      // The callback may explicitly start a new recovery window.
      return false;
    }
    return !this.exhausted;
  }

  diagnostics() {
    return {
      budgetMs: this.budgetMs,
      elapsedMs: this.budgetMs - this.remaining(),
      remainingMs: this.remaining(),
      failed: this.exhausted,
      suspended: this.suspended,
    };
  }

  /** Cancel pending timers without granting a new attempt after failure. */
  stop(): void {
    this.remainingMs = this.remaining();
    this.running = false;
    this.deadline = null;
    this.clearTimer();
  }

  private remaining(): number {
    return Math.max(
      0,
      Math.min(
        this.budgetMs,
        this.deadline === null ? this.remainingMs : this.deadline - this.now(),
      ),
    );
  }

  private clearTimer(): void {
    this.timerGeneration++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.deadline = this.now() + this.remainingMs;
    if (this.check()) this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    const generation = this.timerGeneration;
    this.timer = setTimeout(() => {
      if (generation !== this.timerGeneration) return;
      this.timer = undefined;
      // Recheck wall time; a delayed callback expires once, an early one waits.
      if (this.check() && this.running && !this.suspended) this.schedule();
    }, this.remaining());
  }
}
