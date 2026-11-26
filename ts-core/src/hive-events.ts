// HiveEvent v1 feed (`GET /v1/hive/events`) for the HiveXUI inbox: memory conflicts, failed
// webhook deliveries, dead-lettered queue jobs and a stale queue worker.
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildFeedPage, HIVE_EVENTS_PATH, parseFeedQuery, requireFeedPosition, type HiveEvent, type HiveEventSeverity, type Page } from "@hivemagnus/hive-common/events";
import type { JsonObject, QueueJobRecord, WebhookDeliveryRecord } from "./types.js";

export { HIVE_EVENTS_PATH };

/** The events this feed serves, for the OpenAPI contract (HiveEvent v1 with HiveMem's fields). */
export const HiveEventSchema = z.strictObject({
  id: z.string().min(1).max(128),
  product: z.literal("hivemem"),
  type: z.enum(["memory.conflict.detected", "webhook.delivery.failed", "queue.job.dead_letter", "worker.stale"]),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  occurredAt: z.string(),
  subject: z.strictObject({ actorId: z.string() }).optional(),
  link: z.strictObject({ product: z.literal("hivemem"), path: z.string() }),
  sourceRef: z.string().max(256).optional(),
});
export const HiveEventPageSchema = z.strictObject({ data: z.array(HiveEventSchema), nextCursor: z.string().nullable() });

/** HiveMem's product ID in the Hive Registry. */
const PRODUCT = "hivemem";
/** Events older than this are not served. */
export const HIVE_EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Every event opens the HiveXUI memory screen. */
export const MEMORY_LINK_PATH = "/?page=memories";
const MAX_ID = 128;
const MAX_SOURCE_REF = 256;

/** The records events are derived from. Summaries never quote memory content or receiver URLs. */
export interface HiveEventSources {
  operations: Iterable<JsonObject>;
  webhookDeliveries: Iterable<WebhookDeliveryRecord>;
  queueJobs: Iterable<QueueJobRecord>;
  /** The worker's state, when it is stale: the last heartbeat it reported. */
  staleWorkerHeartbeat: string | null;
  /** Whether a record from this workspace may be shown to the caller. */
  includeWorkspace: (workspaceId: string) => boolean;
}

const iso = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** A stable event ID within the length limit: long record IDs are hashed. */
function eventId(kind: string, recordId: string, suffix = ""): string {
  const plain = `${PRODUCT}:${kind}:${recordId}${suffix ? ":" + suffix : ""}`;
  if (plain.length <= MAX_ID) return plain;
  return `${PRODUCT}:${kind}:${createHash("sha256").update(recordId).digest("hex").slice(0, 40)}${suffix ? ":" + suffix : ""}`;
}

function event(fields: { id: string; type: string; severity: HiveEventSeverity; title: string; summary: string; occurredAt: string; actorId?: string; sourceRef?: string }): HiveEvent {
  return {
    id: fields.id,
    product: PRODUCT,
    type: fields.type,
    severity: fields.severity,
    title: fields.title.slice(0, 200),
    summary: fields.summary.slice(0, 2000),
    occurredAt: fields.occurredAt,
    ...(fields.actorId ? { subject: { actorId: fields.actorId } } : {}),
    link: { product: PRODUCT, path: MEMORY_LINK_PATH },
    ...(fields.sourceRef && fields.sourceRef.length <= MAX_SOURCE_REF ? { sourceRef: fields.sourceRef } : {}),
  };
}

function conflictEvent(entry: JsonObject): HiveEvent | null {
  if (entry.kind !== "conflict" || typeof entry.id !== "string" || typeof entry.workspace_id !== "string") return null;
  const occurredAt = iso(entry.created_at);
  if (!occurredAt) return null;
  return event({
    id: eventId("conflict", entry.id),
    type: "memory.conflict.detected",
    severity: "warning",
    title: `Conflicting memories in workspace ${entry.workspace_id}`,
    summary: `Two memories in workspace ${entry.workspace_id} contradict each other. Review the conflict and keep one, merge them or dismiss it.`,
    occurredAt,
    sourceRef: entry.id,
  });
}

// The delivery's `error` is a fixed reason code (for example `timeout` or `dns`), never receiver output.
function deliveryEvent(delivery: WebhookDeliveryRecord): HiveEvent | null {
  if (delivery.status !== "failed") return null;
  const occurredAt = iso(delivery.updated_at);
  if (!occurredAt) return null;
  const reason = typeof delivery.error === "string" && /^[a-z0-9_.-]{1,64}$/u.test(delivery.error) ? delivery.error : null;
  const status = typeof delivery.response_status === "number" ? ` (HTTP ${delivery.response_status})` : "";
  return event({
    id: eventId("webhook-delivery", delivery.id, "failed"),
    type: "webhook.delivery.failed",
    severity: "warning",
    title: `Webhook delivery of ${delivery.event_type} failed`,
    summary: `A ${delivery.event_type} delivery to webhook ${delivery.endpoint_id} in workspace ${delivery.workspace_id} failed${reason ? ` with ${reason}` : ""}${status} after ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}. The queue retries it until it is dead-lettered.`,
    occurredAt,
    actorId: delivery.owner_agent_id,
    sourceRef: delivery.id,
  });
}

// A job's error text can echo memory content, so it is left out.
function deadLetterEvent(job: QueueJobRecord): HiveEvent | null {
  if (job.status !== "dead_letter") return null;
  const occurredAt = iso(job.finished_at) ?? iso(job.created_at);
  if (!occurredAt) return null;
  return event({
    id: eventId("queue-job", job.id, "dead-letter"),
    type: "queue.job.dead_letter",
    severity: "critical",
    title: `Memory ${job.task_type.replaceAll("_", " ")} job dead-lettered`,
    summary: `Queue job ${job.id} (${job.task_type}) in workspace ${job.workspace_id} failed ${job.retry_count} times and stopped retrying. Inspect it and retry or cancel it.`,
    occurredAt,
    actorId: job.owner_agent_id,
    sourceRef: job.id,
  });
}

/** The worker counts as stale a minute after its last heartbeat (see `workerHealth()`). */
const STALE_AFTER_MS = 60_000;

function staleWorkerEvent(heartbeat: string | null): HiveEvent | null {
  const last = iso(heartbeat);
  if (!last) return null;
  const occurredAt = new Date(Date.parse(last) + STALE_AFTER_MS).toISOString();
  return event({
    id: eventId("worker", "stale", String(Date.parse(last))),
    type: "worker.stale",
    severity: "critical",
    title: "HiveMem queue worker stopped reporting",
    summary: `The background queue worker has not reported since ${last}. Consolidation, extraction and webhook delivery wait until it runs again; check the HiveMem service.`,
    occurredAt,
    sourceRef: "worker",
  });
}

/** One page of the feed, oldest first by (occurredAt, id). Invalid events are dropped and reported. */
export function hiveEventPage(sources: HiveEventSources, query: URLSearchParams, now = Date.now(), onDropped: (count: number) => void = () => {}): Page<HiveEvent> {
  const { after, limit } = parseFeedQuery(query, { defaultLimit: 100, maxLimit: 200 });
  const position = after === undefined ? undefined : requireFeedPosition(after);
  const candidates: Array<HiveEvent | null> = [];
  for (const entry of sources.operations) if (entry.kind === "conflict" && typeof entry.workspace_id === "string" && sources.includeWorkspace(entry.workspace_id)) candidates.push(conflictEvent(entry));
  for (const delivery of sources.webhookDeliveries) if (sources.includeWorkspace(delivery.workspace_id)) candidates.push(deliveryEvent(delivery));
  for (const job of sources.queueJobs) if (sources.includeWorkspace(job.workspace_id)) candidates.push(deadLetterEvent(job));
  candidates.push(staleWorkerEvent(sources.staleWorkerHeartbeat));
  return buildFeedPage(candidates, { after: position, retentionMs: HIVE_EVENT_RETENTION_MS, now, limit, onDropped: (count) => onDropped(count) });
}
