type Message = { type: string; channel?: string; args?: unknown[] };

export const SHARED_OBJECT_CHANNEL = "codex_desktop:message-from-view";

/** Desired subscriptions survive transport failure, including failed opens. */
export class SharedObjectSubscriptions {
  private counts = new Map<string, number>();
  private changes = new WeakMap<Message, { key: string; delta: number }>();

  track(message: Message): void {
    if (
      message.type !== "ipc-renderer-invoke" ||
      message.channel !== SHARED_OBJECT_CHANNEL
    )
      return;
    const event = message.args?.[0] as
      | { type?: string; key?: unknown }
      | undefined;
    if (typeof event?.key !== "string") return;
    const count = this.counts.get(event.key) ?? 0;
    const delta =
      event.type === "shared-object-subscribe"
        ? 1
        : event.type === "shared-object-unsubscribe" && count > 0
          ? -1
          : 0;
    if (!delta) return;
    if (count + delta > 0) this.counts.set(event.key, count + delta);
    else this.counts.delete(event.key);
    this.changes.set(message, { key: event.key, delta });
  }

  /** Replay existing subscriptions before queued calls, without doubling them. */
  beforeQueued(queue: readonly Message[]): Map<string, number> {
    const result = new Map(this.counts);
    for (const message of queue) {
      const change = this.changes.get(message);
      if (!change) continue;
      result.set(change.key, (result.get(change.key) ?? 0) - change.delta);
    }
    for (const [key, count] of result) if (count <= 0) result.delete(key);
    return result;
  }
}
