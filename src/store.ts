// In-memory state that drives the live dashboard, plus an event bus for SSE.
// ClickHouse holds the durable rows; this is the fast read model.
import { EventEmitter } from "node:events";
import type { ServerRecord, WatchEvent } from "./types";

class Store {
  private servers = new Map<string, ServerRecord>();
  private ring: WatchEvent[] = [];
  readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(100);
  }

  upsert(rec: ServerRecord) {
    this.servers.set(rec.id, rec);
  }

  patch(id: string, p: Partial<ServerRecord>) {
    const cur = this.servers.get(id);
    if (cur) this.servers.set(id, { ...cur, ...p });
  }

  get(id: string) {
    return this.servers.get(id);
  }

  all(): ServerRecord[] {
    return [...this.servers.values()].sort((a, b) => b.score - a.score);
  }

  emit(ev: WatchEvent) {
    this.ring.push(ev);
    if (this.ring.length > 300) this.ring.shift();
    this.bus.emit("event", ev);
  }

  recent(n = 60): WatchEvent[] {
    return this.ring.slice(-n);
  }

  stats() {
    const all = [...this.servers.values()];
    const by = (s: string) => all.filter((r) => r.status === s).length;
    const withAuth = all.filter((r) => r.authPosture !== "unknown");
    const noAuth = withAuth.filter((r) => r.authPosture === "none").length;
    return {
      total: all.length,
      clean: by("clean"),
      rug_pull: by("rug_pull"),
      quarantined: by("quarantined"),
      blocked: by("blocked"),
      pctNoAuth: withAuth.length
        ? Math.round((1000 * noAuth) / withAuth.length) / 10
        : 0,
    };
  }
}

export const store = new Store();

export function mkEvent(
  serverId: string,
  type: WatchEvent["type"],
  detail: string,
): WatchEvent {
  return { ts: Date.now(), serverId, type, detail };
}
