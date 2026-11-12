// Oathweave identities for HiveMem, built on the shared @hivemagnus/hive-common verifier.
import {
  OATHWEAVE_NATIVE_ISSUER_PATTERN,
  OATHWEAVE_REQUEST_TIMEOUT_MS,
  OathweaveError,
  assertOathweaveEndpoint,
  createOathweaveVerifier as createSharedVerifier,
  type OathweaveServicePrincipal,
  type OathweaveUserPrincipal,
} from "@hivemagnus/hive-common/oathweave";
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from "jose";

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
}

/**
 * Browser (user) tokens through the shared verifier, with HiveMem's established rules: no clock
 * tolerance, an online session check on every call (no cache window), a required `roles` array
 * and the `clientId` claim. Failure is closed.
 */
export function createOathweaveVerifier(options: OathweaveOptions, overrides: Overrides = {}) {
  const verifier = createSharedVerifier({
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: "user",
    clockToleranceSec: 0,
    sessionCacheTtlMs: 0,
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
  keys: JWTVerifyGetKey,
  overrides: Pick<Overrides, "now"> = {},
) {
  if (!options.issuers.length) throw new Error("At least one service issuer is required");
  const { https, native } = serviceIssuers(options.issuers);
  const linked = new Set<string>([...https, ...native]);
  const verifier = createSharedVerifier({
    issuer: https.length ? https : NO_HTTPS_SERVICE_ISSUER,
    nativeIssuers: native,
    audience: options.audience,
    keys,
    accept: "service",
    clientIdClaim: "clientId",
    clockToleranceSec: 0,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return async (token: string): Promise<OathweaveServicePrincipal> => {
    const principal = await verifier.verifyService(token);
    // Only linked issuers count, never the placeholder.
    if (!linked.has(principal.issuer)) throw new OathweaveError("invalid_issuer");
    return principal;
  };
}

function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  assertOathweaveEndpoint(jwksUrl, "jwksUrl");
  return createRemoteJWKSet(new URL(jwksUrl), {
    [customFetch]: (target, init) =>
      fetch(target, { ...init, redirect: "error", signal: AbortSignal.timeout(OATHWEAVE_REQUEST_TIMEOUT_MS) }),
  });
}

let verifier: ReturnType<typeof createOathweaveVerifier> | undefined;
let serviceVerifier: ReturnType<typeof createOathweaveServiceVerifier> | undefined;
let sharedKeys: JWTVerifyGetKey | undefined;
/** One JWKS cache for user and service tokens. */
function configuredKeys(): JWTVerifyGetKey {
  if (!process.env.OATHWEAVE_JWKS_URL) throw new Error("OATHWEAVE_JWKS_URL is required for Oathweave tokens");
  sharedKeys ??= remoteKeys(process.env.OATHWEAVE_JWKS_URL);
  return sharedKeys;
}
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
      { keys: configuredKeys() },
    );
  }
  return verifier;
}
/** Service tokens are accepted only for issuers named in an explicit link. */
export function configuredOathweaveServiceVerifier(issuers: readonly string[]) {
  if (!issuers.length) return undefined;
  serviceVerifier ??= createOathweaveServiceVerifier(
    { issuers, audience: HIVEMEM_OATHWEAVE_AUDIENCE },
    configuredKeys(),
  );
  return serviceVerifier;
}
