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
  "subject" | "issuer" | "sessionId" | "roles" | "permissions" | "displayName"
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
  /** Userinfo reuse window in milliseconds; 0 (the default) checks the session on every call. */
  sessionCacheMs?: number;
}

/** Longest userinfo reuse window an operator may opt into, so sign-out still takes effect within seconds. */
export const HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS = 5000;

/**
 * `HIVEMEM_OATHWEAVE_SESSION_CACHE_MS`: an opt-in userinfo reuse window, 0 to 5000 ms. Unset or 0
 * keeps the online session check on every request.
 */
export function oathweaveSessionCacheMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS)
    throw new Error(`HIVEMEM_OATHWEAVE_SESSION_CACHE_MS must be an integer from 0 to ${HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS}`);
  return value;
}

/**
 * Browser (user) tokens through the shared verifier, with HiveMem's established rules: no clock
 * tolerance, an online session check on every call (unless the operator opts into a reuse window
 * of at most five seconds), a required `roles` array and the `clientId` claim. Failure is closed.
 */
export function createOathweaveVerifier(options: OathweaveOptions, overrides: Overrides = {}) {
  const verifier = createSharedVerifier({
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: "user",
    clockToleranceSec: 0,
    sessionCacheTtlMs: Math.min(Math.max(0, overrides.sessionCacheMs ?? 0), HIVEMEM_OATHWEAVE_SESSION_CACHE_MAX_MS),
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
  overrides: Pick<Overrides, "now" | "fetch"> = {},
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
    clockToleranceSec: 0,
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
      { sessionCacheMs: oathweaveSessionCacheMs(process.env.HIVEMEM_OATHWEAVE_SESSION_CACHE_MS) },
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
  );
  return serviceVerifier;
}
