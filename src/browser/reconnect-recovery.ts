type HostEvent = Record<string, unknown> & { type: string; hostId: string };

/** Initial snapshots describe state; only non-snapshots trigger Desktop recovery. */
export class ReconnectRecovery {
  private initialized = new Map<string, HostEvent>();
  private disconnected = new Set<string>();
  private recovered = new Set<string>();

  begin(): void {
    this.recovered.clear();
  }

  observe(value: unknown): void {
    const event = value as HostEvent | null;
    if (!event || typeof event.hostId !== "string") return;
    if (event.type === "codex-app-server-initialized") {
      this.initialized.set(event.hostId, event);
      if (!event.isSnapshot) this.recovered.add(event.hostId);
    } else if (event.type === "codex-app-server-connection-changed") {
      if (event.state === "connected") this.disconnected.delete(event.hostId);
      else this.disconnected.add(event.hostId);
    }
  }

  pending(): HostEvent[] {
    const events: HostEvent[] = [];
    for (const [hostId, event] of this.initialized) {
      if (this.disconnected.has(hostId) || this.recovered.has(hostId)) continue;
      this.recovered.add(hostId);
      events.push({ ...event, isSnapshot: false });
    }
    return events;
  }
}
