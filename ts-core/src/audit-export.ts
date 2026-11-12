// Suite audit export (HiveAuditRecord v1): GET /v1/audit/export, oldest first, keyset-paged
// on (created_at, id) over the stored operation records (phase 6 spec with amendment 1). Browser-safe contract plus a pure
// mapping; the store supplies the records and the server authorizes the caller.
import { z } from "zod";
import { HiveError } from "@hivemagnus/hive-common/errors";
import { decodeCursor, encodeCursor, parseFeedQuery } from "@hivemagnus/hive-common/events";
import { redact } from "@hivemagnus/hive-common/log";

export const HIVEMEM_AUDIT_EXPORT_PATH = "/v1/audit/export";
/** The Oathweave permission a service token needs; HiveMem sees it as the `audit:read` scope. */
export const HIVEMEM_AUDIT_READ_PERMISSION = "hivemem:audit:read";
export const HIVEMEM_AUDIT_READ_SCOPE = "audit:read";
export const HIVE_AUDIT_DETAILS_MAX_BYTES = 4096;

const auditScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** HiveAuditRecord v1, shared unchanged across the suite products. */
export const HiveAuditRecordSchema = z.strictObject({
  id: z.string().regex(/^(hivemem|hiveskills|ardentstudio|embermend):audit:[A-Za-z0-9._:-]{1,200}$/),
  product: z.enum(["hivemem", "hiveskills", "ardentstudio", "embermend"]),
  occurredAt: z.iso.datetime(),
  action: z.string().max(128).regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  outcome: z.enum(["success", "failure"]),
  actor: z.strictObject({
    type: z.enum(["user", "service", "agent", "system"]),
    id: z.string().min(1).max(512),
    issuer: z.string().min(1).max(512).optional(),
    displayName: z.string().min(1).max(256).optional(),
  }),
  target: z.strictObject({
    type: z.string().min(1).max(64).optional(),
    id: z.string().min(1).max(512).optional(),
  }).optional(),
  subject: z.strictObject({
    actorId: z.string().min(1).max(256).optional(),
    agentRef: z.string().min(1).max(512).optional(),
    nodeId: z.string().min(1).max(256).optional(),
  }).optional(),
  details: z.record(z.string(), auditScalar).refine(
    (details) => Buffer.byteLength(JSON.stringify(details)) <= HIVE_AUDIT_DETAILS_MAX_BYTES,
    { message: `details must serialize to at most ${HIVE_AUDIT_DETAILS_MAX_BYTES} bytes` },
  ),
});
export type HiveAuditRecord = z.infer<typeof HiveAuditRecordSchema>;
export const HiveAuditPageSchema = z.strictObject({
  data: z.array(HiveAuditRecordSchema),
  nextCursor: z.string().nullable(),
});

/** Stored operation kinds that are audit records. */
export const HIVEMEM_AUDIT_KINDS: ReadonlySet<string> = new Set([
  "api.mutation", "conflict.resolve", "retention", "tombstone", "auth.renew",
  "actor-credential.enroll", "actor-credential.rotate", "actor-credential.renew", "actor-credential.disable",
]);

type Operation = Readonly<Record<string, unknown>>;
type Mapped = { action: string; target: NonNullable<HiveAuditRecord["target"]> };

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length ? value : undefined);

// POST routes whose last path segment names the action rather than a resource ID.
const NAMED_ROUTES: Readonly<Record<string, string>> = {
  "/v1/memories/batch": "memory.batch_create",
  "/v1/memories/promote": "memory.promote",
  "/v1/memories/privatize": "memory.privatize",
  "/v1/memories/consolidate": "memory.consolidate",
  "/v1/memories/compactions": "memory.compact",
  "/v1/memories/multimodal": "memory.multimodal_create",
  "/v1/memories/negotiations": "memory.negotiate",
  "/v1/memories/critic/review": "memory.critic_review",
  "/v1/memories/forgetting/review": "memory.forgetting_review",
  "/v1/lifecycle/forget-me": "lifecycle.forget_me",
  "/v1/lifecycle/retention/apply": "lifecycle.retention_apply",
  "/v1/admin/prune": "admin.prune",
  "/v1/admin/purge": "admin.purge",
  "/v1/admin/test-data/cleanup": "admin.test_data_cleanup",
  "/v1/backup": "admin.backup",
  "/v1/restore": "admin.restore",
  "/v1/auth/tokens": "auth.token_issue",
  "/v1/auth/revoke": "auth.revoke",
  "/v1/auth/refresh": "auth.refresh",
  "/v1/auth/renewal-grants": "auth.renewal_grant_issue",
  "/v1/agents/register": "agent.register",
  "/v1/knowledge/sources/sync": "knowledge.source_sync",
  "/v1/webhooks/test": "webhook.test",
  "/v1/queue/run-next": "queue.run_next",
};
const RESOURCES: Readonly<Record<string, string>> = {
  memories: "memory", workspaces: "workspace", agents: "agent", sessions: "session", webhooks: "webhook",
  peers: "peer", conclusions: "conclusion", queue: "queue_job", episodes: "episode", graph: "graph",
  conflicts: "conflict", consolidation: "consolidation", archive: "archive", knowledge: "knowledge",
  lifecycle: "lifecycle", reasoning: "reasoning", admin: "admin", auth: "auth", "actor-credentials": "actor_credential",
};
const VERBS: Readonly<Record<string, string>> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

function word(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(normalized) ? normalized : "x" + (normalized || "unknown");
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** `<resource>.<verb>` for a successful API mutation, from its method and path (never its body). */
function mutationAction(method: string, path: string): Mapped {
  const named = NAMED_ROUTES[path];
  if (named) return { action: named, target: { type: named.split(".")[0] } };
  const parts = path.replace(/^\/v1\/?/, "").split("/").filter(Boolean);
  const resource = RESOURCES[parts[0] ?? ""] ?? word(parts[0] ?? "api");
  const verb = VERBS[method.toUpperCase()] ?? word(method);
  const id = parts[1] ? decodeSegment(parts[1]) : undefined;
  if (resource === "actor_credential")
    return { action: path.endsWith("/receipt") ? "actor_credential.receipt_ack" : "actor_credential.request", target: { type: resource, ...(id ? { id } : {}) } };
  if (resource === "queue_job" && parts[1] === "jobs" && parts[2]) return { action: `queue_job.${verb === "delete" ? "cancel" : word(parts[3] ?? verb)}`, target: { type: resource, id: decodeSegment(parts[2]) } };
  // Sub-resources: /v1/workspaces/<id>/members/<agent>, /v1/peers/<id>/card, ...
  if (parts.length >= 3 && parts[2]) {
    const sub = word(parts[2]).replace(/s$/, "");
    return { action: `${resource}.${sub}_${verb}`, target: { type: resource, ...(id ? { id } : {}) } };
  }
  return { action: `${resource}.${verb}`, target: { type: resource, ...(id ? { id } : {}) } };
}

function mapKind(record: Operation): Mapped {
  const kind = String(record.kind);
  const memory = text(record.memory_id), workspace = text(record.workspace_id), agent = text(record.agent_id);
  switch (kind) {
    case "api.mutation": return mutationAction(String(record.method ?? "POST"), String(record.path ?? "/v1"));
    case "conflict.resolve": return { action: "conflict.resolve", target: { type: "memory", ...(memory ? { id: memory } : {}) } };
    case "tombstone": return { action: "memory.tombstone", target: { type: "memory", ...(memory ? { id: memory } : {}) } };
    case "retention": return { action: "lifecycle.retention_archive", target: { type: "workspace", ...(workspace ? { id: workspace } : {}) } };
    case "auth.renew": return { action: "auth.renew", target: { type: "agent", ...(text(record.actor) ? { id: String(record.actor) } : {}) } };
    default: return { action: kind.replace(/-/g, "_"), target: { type: "agent", ...(agent ? { id: agent } : {}) } };
  }
}

// Scalar fields that may appear in details; anything else (bodies, receipts, content) is dropped.
const DETAIL_FIELDS: Readonly<Record<string, string>> = {
  workspace_id: "workspace_id", method: "method", path: "path", status: "status", request_id: "request_id",
  resolved: "resolved", action: "resolution", archived: "archived", operation_id: "operation_id",
  token_generation: "token_generation", expires_at: "expires_at", previous_credential_valid_until: "previous_credential_valid_until",
};

function auditDetails(record: Operation): Record<string, string | number | boolean | null> {
  const details: Record<string, string | number | boolean | null> = { native_kind: String(record.kind) };
  for (const [from, to] of Object.entries(DETAIL_FIELDS)) {
    const value = record[from];
    if (typeof value === "string") details[to] = value.slice(0, 256);
    else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) details[to] = value as number | boolean | null;
  }
  if (record.kind === "auth.renew") details.principal = text(record.actor) ?? null;
  const safe = redact(details);
  // Bounded by construction (13 fields of at most 256 characters); trim defensively anyway.
  while (Buffer.byteLength(JSON.stringify(safe)) > HIVE_AUDIT_DETAILS_MAX_BYTES && "path" in safe) delete safe.path;
  return safe;
}

function auditActor(record: Operation): HiveAuditRecord["actor"] {
  const local = text(record.actor);
  if (!local) return { type: "system", id: "hivemem" };
  const issuer = text(record.actor_issuer);
  const type = record.actor_type === "service" || record.actor_type === "user" ? record.actor_type : "agent";
  if (type === "service") return { type, id: text(record.actor_client_id) ?? local, ...(issuer ? { issuer } : {}), displayName: local.slice(0, 256) };
  return { type, id: local, ...(issuer ? { issuer } : {}) };
}

/** Map one stored operation to HiveAuditRecord v1, or undefined when it is not exportable. */
export function toHiveAuditRecord(record: Operation): HiveAuditRecord | undefined {
  const id = text(record.id), created = text(record.created_at);
  if (!id || !/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !created || !HIVEMEM_AUDIT_KINDS.has(String(record.kind))) return undefined;
  const at = Date.parse(created);
  if (!Number.isFinite(at)) return undefined;
  const actor = auditActor(record);
  const { action, target } = mapKind(record);
  // The HiveMem agent the event concerns: the credential's agent, else an agent actor.
  const subjectAgent = String(record.kind).startsWith("actor-credential.") ? text(record.agent_id) : actor.type === "agent" ? actor.id : undefined;
  return {
    id: `hivemem:audit:${id}`,
    product: "hivemem",
    occurredAt: new Date(at).toISOString(),
    action,
    outcome: "success",
    actor,
    // Empty objects are omitted, never sent as {}.
    ...(Object.keys(target).length ? { target } : {}),
    ...(subjectAgent ? { subject: { actorId: subjectAgent.slice(0, 256) } } : {}),
    details: auditDetails(record),
  };
}

/** One export page: records strictly after the cursor, oldest first by (created_at, id). */
export function auditExportPage(
  operations: Iterable<Operation>,
  query: URLSearchParams,
  include: (record: Operation) => boolean = () => true,
): { data: HiveAuditRecord[]; nextCursor: string | null } {
  const { after, limit } = parseFeedQuery(query, { defaultLimit: 100, maxLimit: 200 });
  let position: { t: string; i: string } | undefined;
  if (after) {
    const decoded = decodeCursor(after);
    if (typeof decoded.t !== "string" || typeof decoded.i !== "string" || Object.keys(decoded).length !== 2)
      throw new HiveError("invalid_cursor", "The cursor is not valid", { status: 400 });
    position = { t: decoded.t, i: decoded.i };
  }
  const key = (record: Operation) => ({ t: String(record.created_at), i: String(record.id) });
  const compare = (left: { t: string; i: string }, right: { t: string; i: string }) =>
    left.t < right.t ? -1 : left.t > right.t ? 1 : left.i < right.i ? -1 : left.i > right.i ? 1 : 0;
  const candidates: Operation[] = [];
  for (const record of operations) {
    if (!HIVEMEM_AUDIT_KINDS.has(String(record.kind)) || typeof record.created_at !== "string" || typeof record.id !== "string") continue;
    if (position && compare(key(record), position) <= 0) continue;
    if (include(record)) candidates.push(record);
  }
  candidates.sort((left, right) => compare(key(left), key(right)));
  const data: HiveAuditRecord[] = [];
  let last: Operation | undefined;
  for (const source of candidates) {
    if (data.length >= limit) break;
    const record = toHiveAuditRecord(source);
    if (record) data.push(record);
    // Unexportable records are passed over by the cursor too, so they are not re-scanned.
    last = source;
  }
  // The suite rule: the last record's cursor on every page with records, even the final one;
  // null only when the page is empty (caught up). The caller keeps the last non-null cursor.
  return { data, nextCursor: data.length && last ? encodeCursor(key(last)) : null };
}
