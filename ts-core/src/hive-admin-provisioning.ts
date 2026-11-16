// The installer may create one distinct human principal through the running writer. This
// credential never authorizes memory access, token issuance or changes to existing principals.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { timingSafeEqualString } from "@hivemagnus/hive-common/secrets";

export const HIVE_ADMIN_PROVISIONING_PATH = "/internal/hive/admin-accounts/";
export const HIVE_ADMIN_PROVISIONING_MAX_BYTES = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
// Oathweave also accepts a leading underscore or hyphen. This value is a receipt label,
// never a shell argument or a native password-login name.
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;

export class HiveAdminProvisioningError extends Error {
  constructor(readonly status: number, message: string) {
    super(message); this.name = "HiveAdminProvisioningError";
  }
}

export interface HiveAdminProvisioningConfig { secret: string; issuer: string }
export interface HiveAdminProvisioningRequest {
  version: 1;
  issuer: string;
  subject: string;
  local_id: string;
  username: string;
  display_name: string;
  operation_id: string;
}
export interface HiveAdminProvisioningReceipt {
  schema: 1;
  operation_id: string;
  issuer: string;
  subject: string;
  local_id: string;
  username: string;
  display_name: string;
  credential_generation: 0;
  active: true;
  status: "committed";
  request_sha256: string;
  created_at: string;
}

function validIssuer(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function hiveAdminProvisioningConfig(secret: string | undefined, issuer: string | undefined): HiveAdminProvisioningConfig | undefined {
  if (secret === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("HIVE_ADMIN_PROVISIONING_SECRET must be 64 lowercase hexadecimal characters");
  if (!validIssuer(issuer)) {
    throw new Error("Administrator provisioning requires the exact configured HTTPS Oathweave issuer");
  }
  return { secret, issuer };
}

export function isHiveAdminProvisioningOperationId(value: string): boolean { return UUID.test(value); }

/** Socket provenance is authoritative; forwarded headers and browser credentials cannot grant access. */
export function authorizeHiveAdminProvisioning(request: IncomingMessage, config: HiveAdminProvisioningConfig | undefined): void {
  if (!config) throw new HiveAdminProvisioningError(404, "Not found");
  const address = request.socket.remoteAddress;
  const normalized = address?.startsWith("::ffff:") ? address.slice(7) : address;
  const loopback = normalized === "::1" || (typeof normalized === "string" && isIP(normalized) === 4 && normalized.startsWith("127."));
  const supplied = request.headers["x-hive-admin-provisioning-secret"];
  if (!loopback || typeof supplied !== "string" || !timingSafeEqualString(supplied, config.secret)
    || ["origin", "referer", "cookie", "authorization", "forwarded", "x-forwarded-for", "x-real-ip"].some(key => request.headers[key] !== undefined)) {
    throw new HiveAdminProvisioningError(403, "Administrator provisioning is limited to the installation owner on this server");
  }
}

export function parseHiveAdminProvisioningRequest(operationId: string, value: unknown, issuer: string): HiveAdminProvisioningRequest {
  const invalid = () => new HiveAdminProvisioningError(422, "Invalid administrator provisioning request");
  if (!validIssuer(issuer) || !UUID.test(operationId) || !value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["version", "issuer", "subject", "local_id", "username", "display_name"].includes(key))
    || raw.version !== 1 || raw.issuer !== issuer || typeof raw.subject !== "string" || !SUBJECT.test(raw.subject)
    || typeof raw.local_id !== "string" || !LOCAL_ID.test(raw.local_id)
    || typeof raw.username !== "string" || !USERNAME.test(raw.username)) throw invalid();
  const displayName = raw.display_name === undefined ? raw.username : raw.display_name;
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 200 || /[\x00-\x1f\x7f]/.test(displayName)) throw invalid();
  return { version: 1, issuer, subject: raw.subject, local_id: raw.local_id, username: raw.username, display_name: displayName, operation_id: operationId };
}

export function hiveAdminProvisioningDigest(request: HiveAdminProvisioningRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
