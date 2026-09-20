import { DurableObject } from "cloudflare:workers";
import { ROOM_NONCE_TTL_MS, randomHex, verifyRoomRequest } from "./comment-room-protocol";

// One room per post: holds subscriber sockets and ephemeral typing state.
// Never stores comments, never touches D1. Browsers can only subscribe;
// event injection requires a worker-signed request (see protocol module).
// NOTE: this module imports "cloudflare:workers" and is therefore excluded
// from the node test graph. It is re-exported through src/entry.ts so the
// production bundle (validated by `npm run deploy:production:check`) sees it,
// while unit tests exercise the protocol module and the worker side instead.

type Env = { COMMENTS_ROOM_SECRET?: string };
type Attachment = { id: string; ts: number };

const MAX_SOCKETS = 2000; // abuse guard; the platform allows 32,768 per room
const PRESENCE_THROTTLE_MS = 5000;
const TYPING_TTL_MS = 10_000;
const TYPING_MIN_INTERVAL_MS = 5000;

export class CommentRoom extends DurableObject<Env> {
  private seenNonces = new Set<string>();
  private typing = new Map<string, number>(); // attachment id -> expiry ms
  private lastTypingAt = new Map<string, number>(); // attachment id -> last accepted typing ms
  private lastPresenceAt = 0;

  private attachmentOf(ws: WebSocket): Attachment | null {
    try {
      return (ws as any).deserializeAttachment() as Attachment | null;
    } catch {
      return null;
    }
  }

  private sockets(): WebSocket[] {
    try {
      return this.ctx.getWebSockets();
    } catch {
      return [];
    }
  }

  private sendAll(frame: string): void {
    for (const ws of this.sockets()) {
      try {
        ws.send(frame);
      } catch {
        // Dead sockets are reaped on close events; never fail a broadcast.
      }
    }
  }

  private pruneTyping(now: number): void {
    for (const [id, expiry] of this.typing) {
      if (expiry <= now) {
        this.typing.delete(id);
        this.lastTypingAt.delete(id);
      }
    }
  }

  private broadcastPresence(now: number, force = false): void {
    if (!force && now - this.lastPresenceAt < PRESENCE_THROTTLE_MS) return;
    this.lastPresenceAt = now;
    this.pruneTyping(now);
    this.sendAll(JSON.stringify({ type: "presence", viewers: this.sockets().length, writers: this.typing.size }));
  }

  private evictIfFull(): void {
    const sockets = this.sockets();
    if (sockets.length < MAX_SOCKETS) return;
    let oldest: WebSocket | null = null;
    let oldestTs = Infinity;
    for (const ws of sockets) {
      const ts = this.attachmentOf(ws)?.ts ?? Infinity;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldest = ws;
      }
    }
    try {
      oldest?.close(1013, "room full");
    } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/broadcast") {
      return this.handleBroadcast(request);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    try {
      (server as any).serializeAttachment({ id: randomHex(8), ts: Date.now() } satisfies Attachment);
    } catch {}
    this.evictIfFull();
    this.broadcastPresence(Date.now(), true);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const secret = this.env.COMMENTS_ROOM_SECRET;
    if (!secret) return new Response("Room not configured.", { status: 503 });
    const body = await request.text();
    const nonce = request.headers.get("x-bn-nonce");
    const mac = request.headers.get("x-bn-mac");
    const ok = await verifyRoomRequest(secret, "POST", "/internal/broadcast", body, nonce, mac, this.seenNonces, Date.now());
    if (!ok) return new Response("Invalid signature.", { status: 403 });
    // Bound the replay set; entries older than the nonce TTL are useless.
    if (this.seenNonces.size > 5000) this.seenNonces.clear();
    let event: { type?: string };
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Invalid event.", { status: 400 });
    }
    if (event.type !== "comment-approved" && event.type !== "comment-removed") {
      return new Response("Unknown event.", { status: 400 });
    }
    this.sendAll(JSON.stringify(event));
    return new Response("ok");
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.type !== "typing") return;
    const attach = this.attachmentOf(ws);
    if (!attach) return;
    const now = Date.now();
    if (now - (this.lastTypingAt.get(attach.id) ?? 0) < TYPING_MIN_INTERVAL_MS) return;
    this.lastTypingAt.set(attach.id, now);
    this.typing.set(attach.id, now + TYPING_TTL_MS);
    this.broadcastPresence(now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attach = this.attachmentOf(ws);
    if (attach) {
      this.typing.delete(attach.id);
      this.lastTypingAt.delete(attach.id);
    }
    this.broadcastPresence(Date.now(), true);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

export { ROOM_NONCE_TTL_MS };
