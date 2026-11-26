/**
 * Per-principal limits on the routes that scan memory in process: search, context, chat and
 * conflict detection are O(N) over the store, so one principal must not be able to keep the
 * server busy. A token bucket per principal: `perMinute` requests of burst, refilled evenly.
 */

/** `HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE` when unset. */
export const DEFAULT_SEARCH_RATE_LIMIT_PER_MINUTE = 600;
/** Largest accepted setting; larger values would make the limit meaningless anyway. */
const MAX_SEARCH_RATE_LIMIT_PER_MINUTE = 1_000_000;
/** Principals tracked at once. Full buckets are dropped first, so idle principals cost nothing. */
const MAX_TRACKED_PRINCIPALS = 10_000;

/** `HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE`: a positive integer, or 0 to turn the limit off. */
export function searchRateLimitFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SEARCH_RATE_LIMIT_PER_MINUTE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SEARCH_RATE_LIMIT_PER_MINUTE)
    throw new Error(`HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE must be an integer from 0 (off) to ${MAX_SEARCH_RATE_LIMIT_PER_MINUTE}`);
  return value;
}

const scanningPaths = new Set([
  "/v1/memories/search",
  "/v1/memories/search/text",
  "/v1/memories/search/hybrid",
  "/v1/memories/conflicts",
  "/v1/context",
  "/v1/chat",
  "/v1/archive/search",
  "/dashboard/api/context/preview",
  "/dashboard/api/search/explain",
  "/dashboard/api/archive/search",
]);

/** The POST routes this limit covers, including the session chat and context routes. */
export function rateLimitedPath(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  if (scanningPaths.has(pathname)) return true;
  return /^\/v1\/sessions\/[^/]+\/(?:chat|context)$/u.test(pathname);
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(readonly retryAfterSeconds: number) {
    super("Too many search, context or chat requests; retry later");
  }
}

interface Bucket { tokens: number; updatedAt: number }

export class PrincipalRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {
    this.perMs = perMinute / 60_000;
  }

  get enabled(): boolean { return this.perMinute > 0; }

  /** Take one request for `principal`, or throw a RateLimitError with the wait in seconds. */
  take(principal: string): void {
    if (!this.enabled) return;
    const now = this.now();
    const bucket = this.refill(this.buckets.get(principal), now);
    if (bucket.tokens < 1) {
      this.buckets.set(principal, bucket);
      throw new RateLimitError(Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000)));
    }
    bucket.tokens -= 1;
    // Re-insert so the map's order is least recently used first.
    this.buckets.delete(principal);
    this.buckets.set(principal, bucket);
    if (this.buckets.size > MAX_TRACKED_PRINCIPALS) this.evict(now);
  }

  private refill(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket) return { tokens: this.perMinute, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    return { tokens: Math.min(this.perMinute, bucket.tokens + elapsed * this.perMs), updatedAt: now };
  }

  /** Drop principals whose bucket has refilled, then the least recently used. */
  private evict(now: number): void {
    for (const [principal, bucket] of this.buckets) {
      if (this.refill(bucket, now).tokens >= this.perMinute) this.buckets.delete(principal);
    }
    for (const principal of this.buckets.keys()) {
      if (this.buckets.size <= MAX_TRACKED_PRINCIPALS) break;
      this.buckets.delete(principal);
    }
  }
}
