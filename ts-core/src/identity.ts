// Oathweave identities for HiveMem, built on the shared @hivemagnus/hive-common verifier.
import {
  OATHWEAVE_NATIVE_ISSUER_PATTERN,
  OathweaveError,
  createOathweaveVerifier as createSharedVerifier,
  type OathweaveServicePrincipal,
  type OathweaveUserPrincipal,
} from "@hivemagnus/hive-common/oathweave";
import type { JWTVerifyGetKey } from "jose";

/** HiveMem's resource audience. */
export const HIVEMEM_OATHWEAVE_AUDIENCE = "hivemem";

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience: string;
}
/** The parts of a verified user principal HiveMem uses. */
export type OathweaveIdentity = Pick<
  OathweaveUserPrincipal,
  "subject" | "issuer" | "sessionId" | "tokenId" | "roles" | "permissions" | "displayName"
>;
/** The parts of a verified service principal HiveMem uses. */
export type OathweaveServiceIdentity = Pick<
  OathweaveServicePrincipal,
  "clientId" | "issuer" | "tokenId" | "permissions" | "expiresAt"
>;

interface Overrides {
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  /** Clock in epoch milliseconds. */
  now?: () => number;
  /**
   * Userinfo reuse window in milliseconds, at most 5000. Defaults to
   * `HIVEMEM_OATHWEAVE_SESSION_CACHE_DEFAULT_MS`; 0 checks the session on every call.
   */
  sessionCacheMs?: number;
  /** Seconds of clock skew tolerated on `exp`, `nbf` and `iat`, 0 to 60. Defaults to 5. */
  clockToleranceSec?: number;
}

/** Longest userinfo reuse window an operator may set, so sign-out still takes effect within seconds. */
export const HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS = 5000;
/** Userinfo reuse window when `HIVEMEM_OATHWEAVE_SESSION_CACHE_MS` is unset: sign-out applies within 3 s. */
export const HIVEMEM_OATHWEAVE_SESSION_CACHE_DEFAULT_MS = 3000;
/** Largest clock skew an operator may allow on Oathweave tokens. */
export const HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_MAX_SEC = 60;
/** Clock skew tolerated when `HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC` is unset. */
export const HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_DEFAULT_SEC = 5;

function boundedInteger(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return value;
}

/**
 * `HIVEMEM_OATHWEAVE_SESSION_CACHE_MS`: how long a userinfo answer is reused, 0 to 5000 ms.
 * Unset means 3000; 0 checks the session online on every request.
 */
export function oathweaveSessionCacheMs(raw: string | undefined): number {
  return boundedInteger("HIVEMEM_OATHWEAVE_SESSION_CACHE_MS", raw, HIVEMEM_OATHWEAVE_SESSION_CACHE_DEFAULT_MS, HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS);
}

/**
 * `HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC`: clock skew tolerated on `exp`, `nbf` and `iat`, 0 to
 * 60 seconds. Unset means 5; 0 restores exact checks.
 */
export function oathweaveClockToleranceSec(raw: string | undefined): number {
  return boundedInteger("HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC", raw, HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_DEFAULT_SEC, HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_MAX_SEC);
}

const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max);

/**
 * Browser (user) tokens through the shared verifier, with HiveMem's rules: a small clock tolerance
 * (5 s by default, at most 60), an online session check whose answer is reused for at most five
 * seconds (3 s by default, 0 checks every call), a required `roles` array and the `clientId`
 * claim. The signature, audience and expiry are checked on every call; only the userinfo answer
 * is reused. Failure is closed.
 */
export function createOathweaveVerifier(options: OathweaveOptions, overrides: Overrides = {}) {
  const verifier = createSharedVerifier({
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: "user",
    clockToleranceSec: clamp(overrides.clockToleranceSec ?? HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_DEFAULT_SEC, HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_MAX_SEC),
    sessionCacheTtlMs: clamp(overrides.sessionCacheMs ?? HIVEMEM_OATHWEAVE_SESSION_CACHE_DEFAULT_MS, HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS),
    ...(overrides.keys ? { keys: overrides.keys } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return async (token: string): Promise<OathweaveUserPrincipal> => {
    const principal = await verifier.verifyUser(token);
    if (!Array.isArray(principal.claims.roles) || principal.claims.clientId !== principal.clientId)
      throw new OathweaveError("invalid_claims");
    return principal;
  };
}

export interface OathweaveServiceOptions {
  /**
   * Issuers whose client_credentials tokens may be accepted: Oathweave native identifiers such
   * as `hive-iam`, or https issuers. Each one comes from an explicit service link.
   */
  issuers: readonly string[];
  audience: string;
  /** The issuer's JWKS endpoint, used when no key resolver is passed. */
  jwksUrl?: string;
}

/** Fills the shared verifier's required https issuer when every link names a native issuer. */
const NO_HTTPS_SERVICE_ISSUER = "https://no-linked-issuer.invalid";

/** Split service-link issuers into the shared verifier's https and native issuers. */
function serviceIssuers(issuers: readonly string[]) {
  const https: string[] = [];
  const native: string[] = [];
  for (const issuer of new Set(issuers)) {
    if (OATHWEAVE_NATIVE_ISSUER_PATTERN.test(issuer)) native.push(issuer);
    else if (issuer.startsWith("https://")) https.push(issuer);
    else
      throw new Error(
        "Each Oathweave service link issuer must be an https URL or a lowercase native identifier such as hive-iam",
      );
  }
  return { https, native };
}

/**
 * Oathweave service-account (client_credentials) tokens through the shared verifier. Native
 * issuers (a name such as `hive-iam`) and https issuers share one key set. Accepted only when
 * short-lived, bound to this audience, issued by a linked issuer and issued to the client named
 * in their subject (`clientId` equals `sub`). Failure is closed.
 */
export function createOathweaveServiceVerifier(
  options: OathweaveServiceOptions,
  keys?: JWTVerifyGetKey,
  overrides: Pick<Overrides, "now" | "fetch" | "clockToleranceSec"> = {},
) {
  if (!options.issuers.length) throw new Error("At least one service issuer is required");
  if (!keys && !options.jwksUrl) throw new Error("OATHWEAVE_JWKS_URL is required for Oathweave tokens");
  const { https, native } = serviceIssuers(options.issuers);
  const linked = new Set<string>([...https, ...native]);
  const verifier = createSharedVerifier({
    issuer: https.length ? https : NO_HTTPS_SERVICE_ISSUER,
    nativeIssuers: native,
    audience: options.audience,
    ...(keys ? { keys } : { jwksUrl: options.jwksUrl as string }),
    accept: "service",
    clientIdClaim: "clientId",
    clockToleranceSec: clamp(overrides.clockToleranceSec ?? HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_DEFAULT_SEC, HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_MAX_SEC),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  return async (token: string): Promise<OathweaveServicePrincipal> => {
    const principal = await verifier.verifyService(token);
    // Only linked issuers count, never the placeholder.
    if (!linked.has(principal.issuer)) throw new OathweaveError("invalid_issuer");
    return principal;
  };
}

let verifier: ReturnType<typeof createOathweaveVerifier> | undefined;
let serviceVerifier: ReturnType<typeof createOathweaveServiceVerifier> | undefined;
/**
 * The shared verifier fetches and caches `OATHWEAVE_JWKS_URL` itself (bounded cache age, a
 * cooldown on unknown key IDs, no redirects, request timeouts). User and service tokens are
 * checked against that one endpoint.
 */
export function configuredOathweaveVerifier() {
  if (!process.env.OATHWEAVE_ISSUER && !process.env.OATHWEAVE_JWKS_URL && !process.env.OATHWEAVE_USERINFO_URL)
    return undefined;
  if (!verifier) {
    if (!process.env.OATHWEAVE_ISSUER || !process.env.OATHWEAVE_JWKS_URL || !process.env.OATHWEAVE_USERINFO_URL)
      throw new Error("Oathweave configuration is incomplete");
    verifier = createOathweaveVerifier(
      {
        issuer: process.env.OATHWEAVE_ISSUER,
        jwksUrl: process.env.OATHWEAVE_JWKS_URL,
        userinfoUrl: process.env.OATHWEAVE_USERINFO_URL,
        audience: HIVEMEM_OATHWEAVE_AUDIENCE,
      },
      {
        sessionCacheMs: oathweaveSessionCacheMs(process.env.HIVEMEM_OATHWEAVE_SESSION_CACHE_MS),
        clockToleranceSec: oathweaveClockToleranceSec(process.env.HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC),
      },
    );
  }
  return verifier;
}
/** Service tokens are accepted only for issuers named in an explicit link. */
export function configuredOathweaveServiceVerifier(issuers: readonly string[]) {
  if (!issuers.length) return undefined;
  if (!process.env.OATHWEAVE_JWKS_URL) throw new Error("OATHWEAVE_JWKS_URL is required for Oathweave tokens");
  serviceVerifier ??= createOathweaveServiceVerifier(
    { issuers, audience: HIVEMEM_OATHWEAVE_AUDIENCE, jwksUrl: process.env.OATHWEAVE_JWKS_URL },
    undefined,
    { clockToleranceSec: oathweaveClockToleranceSec(process.env.HIVEMEM_OATHWEAVE_CLOCK_TOLERANCE_SEC) },
  );
  return serviceVerifier;
}
