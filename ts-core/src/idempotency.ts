import { createHash } from "node:crypto";

/**
 * Process-local `Idempotency-Key` replay for side-effecting POSTs.
 *
 * A key is scoped to the authenticated principal. The first request with a key runs; its 2xx
 * response is recorded before persistence is awaited, so a retry after an indeterminate 503 (or a
 * proxy 502) replays the original result instead of writing again. A repeat with a different
 * method, path, query or body is a 422; a repeat while the first is still running is a 409.
 * Records expire after the TTL and are forgotten on restart.
 */

export class IdempotencyError extends Error {
  constructor(readonly status: 409 | 422, message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export interface IdempotencyOptions {
  /** How long a completed result is replayed. Default 24 hours. */
  ttlMs?: number;
  /** Most records kept; the oldest completed records go first. Default 10,000. */
  maxEntries?: number;
  /** Total stored response bytes. Default 64 MiB. */
  maxBytes?: number;
  /** A larger response is not recorded, so its key gives no replay. Default 1 MiB. */
  maxEntryBytes?: number;
  now?: () => number;
}

interface PendingEntry { state: "pending"; fingerprint: string; expiresAt: number; owner: object }
interface DoneEntry { state: "done"; fingerprint: string; expiresAt: number; status: number; payload: string; bytes: number }
type Entry = PendingEntry | DoneEntry;

export interface IdempotentReplay { status: number; payload: string }

/** A stable JSON rendering: object keys sorted, so a re-serialized retry still matches. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestFingerprint(method: string, pathname: string, search: string, body: unknown): string {
  return createHash("sha256").update(`${method}\n${pathname}\n${search}\n${canonicalJson(body)}`).digest("hex");
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }

  private static id(principal: string, key: string): string {
    return `${principal}\u0000${key}`;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.state === "done") this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.remove(id);
    // Map order is insertion order: evict the oldest completed records first.
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (entry.state === "done") this.remove(id);
    }
  }

  /**
   * Claim a key for one request. Returns a replay when the key already completed with the same
   * request, or undefined when the caller should run the request (and later `complete` or
   * `release` it with the same owner).
   */
  begin(principal: string, key: string, fingerprint: string, owner: object): IdempotentReplay | undefined {
    this.prune();
    const id = IdempotencyCache.id(principal, key);
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyError(422, "Idempotency-Key was already used with a different request");
      if (existing.state === "pending") throw new IdempotencyError(409, "A request with this Idempotency-Key is still in progress");
      return { status: existing.status, payload: existing.payload };
    }
    this.entries.set(id, { state: "pending", fingerprint, expiresAt: this.now() + this.ttlMs, owner });
    return undefined;
  }

  /** Record the 2xx result of a claimed key. A result over the size limit releases the key instead. */
  complete(principal: string, key: string, owner: object, status: number, payload: string): void {
    const id = IdempotencyCache.id(principal, key);
    const entry = this.entries.get(id);
    if (!entry || entry.state !== "pending" || entry.owner !== owner) return;
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.maxEntryBytes) { this.remove(id); return; }
    // Re-insert so the completed record ages from now.
    this.entries.delete(id);
    this.entries.set(id, { state: "done", fingerprint: entry.fingerprint, expiresAt: this.now() + this.ttlMs, status, payload, bytes });
    this.bytes += bytes;
    this.prune();
  }

  /** Forget a claim that did not complete (an error, or a non-2xx answer): the key may be reused. */
  release(principal: string, key: string, owner: object): void {
    const id = IdempotencyCache.id(principal, key);
    const entry = this.entries.get(id);
    if (entry?.state === "pending" && entry.owner === owner) this.entries.delete(id);
  }
}
