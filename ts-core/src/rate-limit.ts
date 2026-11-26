import { createRateLimiter, rateLimitError, type RateLimiter } from "@hivemagnus/hive-common/rate-limit";

/**
 * Per-principal limits on the routes that scan memory in process: search, context, chat and
 * conflict detection are O(N) over the store, so one principal must not be able to keep the
 * server busy. A token bucket per principal: `perMinute` requests of burst, refilled evenly.
 */

/** `HIVEMEM_SEARCH_RATE_LIMIT_PER_MINUTE` when unset. */
export const DEFAULT_SEARCH_RATE_LIMIT_PER_MINUTE = 600;
/** Largest accepted setting; larger values would make the limit meaningless anyway. */
const MAX_SEARCH_RATE_LIMIT_PER_MINUTE = 1_000_000;
/** Principals tracked at once. */
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

/**
 * One token bucket per principal, from HiveCommon `/rate-limit`: `perMinute` requests of burst,
 * refilled evenly, at most 10 000 principals held (least recently used dropped first).
 */
export class PrincipalRateLimiter {
  private readonly limiter: RateLimiter | null;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.limiter = perMinute > 0 ? createRateLimiter({ limit: perMinute, windowMs: 60_000, maxKeys: MAX_TRACKED_PRINCIPALS, now }) : null;
  }

  get enabled(): boolean { return this.limiter !== null; }

  /** Take one request for `principal`, or throw the suite 429 (`rate_limited`, with `Retry-After`). */
  take(principal: string): void {
    if (!this.limiter) return;
    const result = this.limiter.consume(principal);
    if (!result.allowed) throw rateLimitError(result);
  }
}
