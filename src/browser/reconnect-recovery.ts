type HostEvent = Record<string, unknown> & { type: string; hostId: string };

/** Initial snapshots describe state; only non-snapshots trigger Desktop recovery. */
export class ReconnectRecovery {
  private initialized = new Map<string, HostEvent>();
  private connections = new Map<string, HostEvent>();
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
      this.connections.set(event.hostId, event);
      if (event.state === "connected") this.disconnected.delete(event.hostId);
      else this.disconnected.add(event.hostId);
      if (
        !event.isSnapshot &&
        event.state === "connected" &&
        event.transport === "websocket"
      )
        this.recovered.add(event.hostId);
    }
  }

  pending(): HostEvent[] {
    const events: HostEvent[] = [];
    for (const [hostId, event] of this.initialized) {
      if (this.disconnected.has(hostId) || this.recovered.has(hostId)) continue;
      if (event.transport === "websocket") {
        // Desktop restores websocket-backed SSH streams on a connected event.
        // Its initialized handler only refreshes metadata for that transport.
        // Replay the real connected snapshot, never infer a connection from an
        // old initialization after an unsuccessful remote reconnect.
        const connection = this.connections.get(hostId);
        if (connection?.state !== "connected") continue;
        events.push({ ...connection, isSnapshot: false });
      }
      this.recovered.add(hostId);
      events.push({ ...event, isSnapshot: false });
    }
    return events;
  }
}
