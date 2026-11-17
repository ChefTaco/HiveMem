import { createHash } from "node:crypto";
import type { HiveMemSnapshot, PersistedAgentRecord } from "./persistence.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * Moves everything one agent ID owns to another ID: the operator side of renaming a
 * token subject (for example `hive-router` to `emberpath`). HiveMem keys ownership on the
 * subject with no admin bypass, so a renamed principal must take its data with it.
 *
 * The functions here are pure: they read a loaded snapshot and return a new one. The CLI
 * (`hivemem-server rename-agent`) loads the snapshot, saves the result through the normal
 * journaled Qdrant save (which moves private memories to the new owner's collections and
 * keeps their vectors) and verifies the outcome by loading it again.
 *
 * What moves: memory ownership and endorsements, sessions, episodes and their messages,
 * conclusions, queue jobs (with their work-unit and scheduler keys), webhooks and their
 * deliveries, workspace ownership, membership and per-agent overrides, the agent record
 * with its credential state, and the operation receipts that bind replays to an owner
 * (queue operations, credential operations, consolidation runs, multimodal references).
 * Audit records keep the ID that acted at the time; a new `agent.rename` audit record joins them.
 *
 * The old ID keeps a disabled agent record (a tombstone, `metadata.renamed_to`), so a
 * stale credential for it is refused instead of silently starting a new, empty owner.
 */

export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export type AgentRenameArea =
  | "memories"
  | "endorsements"
  | "sessions"
  | "episodes"
  | "messages"
  | "conclusions"
  | "queueJobs"
  | "webhooks"
  | "webhookDeliveries"
  | "workspaces"
  | "agents"
  | "operations";

export type AgentRenameCounts = Record<AgentRenameArea, number>;

export interface AgentRenamePlan {
  from: string;
  to: string;
  /** Records that name the source and would change. */
  source: AgentRenameCounts;
  /** Records the target already owns. */
  target: AgentRenameCounts;
  /** The source's agent record is the tombstone of an earlier rename to this target. */
  tombstoned: boolean;
  /** The target's agent record exists (with or without owned data). */
  targetAgentExists: boolean;
  /** The target's agent record is disabled. */
  targetAgentDisabled: boolean;
  /** Nothing names the source any more, except its tombstone and audit history. */
  done: boolean;
  /** The target owns data or is disabled, so a merge needs explicit approval. */
  conflict: boolean;
}

const AREAS: readonly AgentRenameArea[] = ["memories", "endorsements", "sessions", "episodes", "messages", "conclusions", "queueJobs", "webhooks", "webhookDeliveries", "workspaces", "agents", "operations"];

function zeroCounts(): AgentRenameCounts {
  return Object.fromEntries(AREAS.map((area) => [area, 0])) as AgentRenameCounts;
}

/** Operation kinds whose owner field controls who may read or replay them. */
const OWNED_OPERATION_KINDS = new Set(["queue-operation", "consolidation-run", "multimodal-reference"]);

/** The receipt key HiveMem stores a queue operation under (InMemoryHiveMemStore.operationReceiptKey). */
export function queueOperationReceiptKey(owner: string, workspace: string, task: string, id: string): string {
  return "queue-operation:" + createHash("sha256").update(canonicalJson([owner, workspace, task, id])).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTombstoneFor(agent: PersistedAgentRecord | undefined, to: string): boolean {
  return agent !== undefined && agent.active === false && isObject(agent.metadata) && agent.metadata.renamed_to === to;
}

/** Replaces `from` by `to` in the listed string fields of a record. Returns the record and whether it changed. */
function swap<T extends object>(record: T, fields: readonly string[], from: string, to: string): [T, boolean] {
  let changed = false;
  const next = { ...record } as Record<string, unknown>;
  for (const field of fields) {
    if (next[field] === from) { next[field] = to; changed = true; }
  }
  return [next as T, changed];
}

function swapList(values: readonly string[], from: string, to: string): [string[], boolean] {
  if (!values.includes(from)) return [[...values], false];
  const next: string[] = [];
  for (const value of values) {
    const mapped = value === from ? to : value;
    if (!next.includes(mapped)) next.push(mapped);
  }
  return [next, true];
}

function swapPrefix(value: string, prefixes: readonly string[], from: string, to: string): string {
  for (const prefix of prefixes) if (value.startsWith(prefix + from + ":")) return prefix + to + ":" + value.slice(prefix.length + from.length + 1);
  return value;
}

function owns(snapshot: HiveMemSnapshot, id: string): AgentRenameCounts {
  const counts = zeroCounts();
  counts.memories = snapshot.memories.filter((memory) => memory.agent_id === id).length;
  counts.endorsements = snapshot.memories.filter((memory) => (memory.endorsed_by ?? []).includes(id) || (memory.opposed_by ?? []).includes(id)).length;
  counts.sessions = snapshot.sessions.filter((session) => session.owner_agent_id === id).length;
  counts.episodes = snapshot.episodes.filter((episode) => episode.owner_agent_id === id || episode.peer_id === id).length;
  counts.messages = snapshot.messages.filter((message) => message.owner_agent_id === id || message.speaker_id === id).length;
  counts.conclusions = snapshot.conclusions.filter((conclusion) => conclusion.owner_agent_id === id || conclusion.observer_peer_id === id || conclusion.observed_peer_id === id).length;
  counts.queueJobs = snapshot.queueJobs.filter((job) => job.owner_agent_id === id || job.peer_id === id || job.observer_peer_id === id || job.observed_peer_id === id).length;
  counts.webhooks = snapshot.webhooks.filter((endpoint) => endpoint.owner_agent_id === id).length;
  counts.webhookDeliveries = snapshot.webhookDeliveries.filter((delivery) => delivery.owner_agent_id === id).length;
  counts.workspaces = snapshot.workspaces.filter((workspace) => workspace.owner_agent_id === id || (workspace.members ?? []).some((member) => member.agent_id === id || member.added_by === id) || Object.hasOwn(workspace.policy?.agent_overrides ?? {}, id)).length;
  counts.agents = snapshot.agents.filter((agent) => agent.agent_id === id).length;
  counts.operations = (snapshot.operations ?? []).filter((operation) => ownedOperation(operation, id) || schedulerCursorOf(operation, id)).length;
  return counts;
}

function ownedOperation(operation: JsonObject, id: string): boolean {
  if (typeof operation.kind !== "string") return false;
  if (OWNED_OPERATION_KINDS.has(operation.kind)) return operation.actor === id;
  if (operation.kind === "actor-credential") return operation.agent_id === id || (typeof operation.owner === "string" && operation.owner.endsWith(":" + id));
  return false;
}

function schedulerCursorOf(operation: JsonObject, id: string): boolean {
  return operation.kind === "scheduler-cursor" && typeof operation.id === "string" && operation.id.startsWith("scheduler:" + id + ":");
}

function total(counts: AgentRenameCounts, exclude: readonly AgentRenameArea[] = []): number {
  return AREAS.filter((area) => !exclude.includes(area)).reduce((sum, area) => sum + counts[area], 0);
}

export function assertRenameIds(from: string, to: string): void {
  for (const [name, id] of [["--from", from], ["--to", to]] as const) {
    if (!AGENT_ID_PATTERN.test(id)) throw new Error(`${name} must be an agent ID: 1-128 letters, digits, '.', '_', ':', '@' or '-', starting with a letter or digit`);
  }
  if (from === to) throw new Error("--from and --to must differ");
  if (from === "shared" || to === "shared") throw new Error("'shared' is reserved for shared memory collections");
}

export function planAgentRename(snapshot: HiveMemSnapshot, from: string, to: string): AgentRenamePlan {
  assertRenameIds(from, to);
  const sourceAgent = snapshot.agents.find((agent) => agent.agent_id === from);
  const targetAgent = snapshot.agents.find((agent) => agent.agent_id === to);
  const tombstoned = isTombstoneFor(sourceAgent, to);
  const source = owns(snapshot, from);
  if (tombstoned) source.agents = 0;
  const target = owns(snapshot, to);
  const targetAgentDisabled = targetAgent !== undefined && targetAgent.active === false;
  const done = total(source) === 0;
  // An agent record alone is not data: a token for the target may have created it.
  const conflict = !done && (total(target, ["agents"]) > 0 || targetAgentDisabled);
  return { from, to, source, target, tombstoned, targetAgentExists: targetAgent !== undefined, targetAgentDisabled, done, conflict };
}

function renameJob<T extends { owner_agent_id: string; peer_id: string | null; observer_peer_id: string | null; observed_peer_id: string | null; work_unit_key: string; idempotency_key: string }>(job: T, from: string, to: string): [T, boolean] {
  let [next, changed] = swap(job, ["owner_agent_id", "peer_id", "observer_peer_id", "observed_peer_id"], from, to);
  if (changed) {
    const work = swapPrefix(next.work_unit_key, [""], from, to);
    const idempotency = swapPrefix(next.idempotency_key, ["scheduled:", "consolidation:"], from, to);
    next = { ...next, work_unit_key: work, idempotency_key: idempotency };
  }
  return [next, changed];
}

/**
 * The snapshot with every record of `from` owned by `to`. `now` stamps the tombstone and
 * the rename record. Call only after planAgentRename reports no unapproved conflict.
 */
export function applyAgentRename(snapshot: HiveMemSnapshot, from: string, to: string, now: string): { snapshot: HiveMemSnapshot; changed: AgentRenameCounts } {
  assertRenameIds(from, to);
  const changed = zeroCounts();
  const count = (area: AgentRenameArea, did: boolean) => { if (did) changed[area] += 1; };

  const memories = snapshot.memories.map((memory) => {
    let [next, did] = swap(memory, ["agent_id"], from, to);
    count("memories", did);
    const [endorsed, endorsedChanged] = swapList(next.endorsed_by ?? [], from, to);
    const [opposed, opposedChanged] = swapList(next.opposed_by ?? [], from, to);
    if (endorsedChanged || opposedChanged) {
      next = { ...next, endorsed_by: endorsed, opposed_by: opposed };
      count("endorsements", true);
    }
    return next;
  });
  const sessions = snapshot.sessions.map((session) => { const [next, did] = swap(session, ["owner_agent_id"], from, to); count("sessions", did); return next; });
  const episodes = snapshot.episodes.map((episode) => { const [next, did] = swap(episode, ["owner_agent_id", "peer_id"], from, to); count("episodes", did); return next; });
  const messages = snapshot.messages.map((message) => { const [next, did] = swap(message, ["owner_agent_id", "speaker_id"], from, to); count("messages", did); return next; });
  const conclusions = snapshot.conclusions.map((conclusion) => { const [next, did] = swap(conclusion, ["owner_agent_id", "observer_peer_id", "observed_peer_id"], from, to); count("conclusions", did); return next; });
  const queueJobs = snapshot.queueJobs.map((job) => { const [next, did] = renameJob(job, from, to); count("queueJobs", did); return next; });
  const webhooks = snapshot.webhooks.map((endpoint) => { const [next, did] = swap(endpoint, ["owner_agent_id"], from, to); count("webhooks", did); return next; });
  const webhookDeliveries = snapshot.webhookDeliveries.map((delivery) => { const [next, did] = swap(delivery, ["owner_agent_id"], from, to); count("webhookDeliveries", did); return next; });
  const workspaces = snapshot.workspaces.map((workspace) => {
    let [next, did] = swap(workspace, ["owner_agent_id"], from, to);
    const members = (next.members ?? []).map((member) => {
      const [renamed, memberChanged] = swap(member, ["agent_id", "added_by"], from, to);
      if (memberChanged) did = true;
      return renamed;
    });
    // One membership per agent: when both IDs were members, the higher role and every scope survive.
    const rank = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
    const merged: typeof members = [];
    for (const member of members) {
      const existing = merged.find((entry) => entry.agent_id === member.agent_id);
      if (!existing) { merged.push(member); continue; }
      did = true;
      const best = rank[member.role] > rank[existing.role] ? member : existing;
      merged[merged.indexOf(existing)] = { ...best, scopes: [...new Set([...existing.scopes, ...member.scopes])] };
    }
    const overrides = next.policy?.agent_overrides ?? {};
    let policy = next.policy;
    if (Object.hasOwn(overrides, from)) {
      const { [from]: moved, ...rest } = overrides;
      policy = { ...next.policy, agent_overrides: { ...rest, [to]: { ...(moved ?? {}), ...(rest[to] ?? {}) } } };
      did = true;
    }
    next = { ...next, members: merged, ...(policy ? { policy } : {}) };
    count("workspaces", did);
    return next;
  });

  // The agent record carries the identity's credential state (generation, renewal grace,
  // credential deadline and scopes, disabled flag), so it moves as a whole.
  const source = snapshot.agents.find((agent) => agent.agent_id === from);
  const target = snapshot.agents.find((agent) => agent.agent_id === to);
  let agents = snapshot.agents;
  if (source && !isTombstoneFor(source, to)) {
    changed.agents = 1;
    const createdAt = target && target.created_at < source.created_at ? target.created_at : source.created_at;
    const moved: PersistedAgentRecord = {
      ...source,
      agent_id: to,
      display_name: source.display_name === from ? to : source.display_name,
      created_at: createdAt,
      updated_at: now,
      metadata: { ...source.metadata, renamed_from: from, renamed_at: now },
    };
    const generation = typeof source.metadata?.token_generation === "number" ? source.metadata.token_generation : 0;
    // Disabling bumps the generation, as HiveMem's own disable does, so no token of the old ID outlives it.
    const tombstone: PersistedAgentRecord = {
      agent_id: from,
      display_name: from,
      description: `Renamed to ${to}`,
      created_at: source.created_at,
      updated_at: now,
      active: false,
      memory_counts: {},
      metadata: { token_generation: generation + 1, renamed_to: to, renamed_at: now },
    };
    agents = [...snapshot.agents.filter((agent) => agent.agent_id !== from && agent.agent_id !== to), moved, tombstone];
  }

  const operations: JsonObject[] = [];
  for (const operation of snapshot.operations ?? []) {
    let next = operation;
    let did = false;
    if (ownedOperation(operation, from)) {
      did = true;
      if (operation.kind === "actor-credential") {
        next = { ...next, ...(operation.agent_id === from ? { agent_id: to } : {}), ...(typeof operation.owner === "string" && operation.owner.endsWith(":" + from) ? { owner: operation.owner.slice(0, -from.length) + to } : {}) };
      } else {
        next = { ...next, actor: to };
      }
      if (operation.kind === "queue-operation" && typeof operation.workspace_id === "string" && typeof operation.task_type === "string" && typeof operation.operation_id === "string") {
        const id = queueOperationReceiptKey(to, operation.workspace_id, operation.task_type, operation.operation_id);
        next = { ...next, id };
        if (isObject(operation.job)) next = { ...next, job: renameJob(operation.job as never, from, to)[0] as unknown as JsonObject };
      }
    } else if (schedulerCursorOf(operation, from)) {
      did = true;
      next = { ...next, id: "scheduler:" + to + ":" + String(operation.id).slice(("scheduler:" + from + ":").length) };
    }
    count("operations", did);
    operations.push(next);
  }
  // Rekeyed receipts replace any record already stored under their new ID.
  const byId = new Map<string, JsonObject>();
  for (const operation of operations) byId.set(String(operation.id), operation);
  const counts = { ...changed };
  // An audit record (kind agent.rename, exported as a system action on the new ID).
  const record: JsonObject = { id: `agent-rename:${from}:${to}`, kind: "agent.rename", agent_id: to, renamed_from: from, created_at: now, counts: counts as unknown as JsonObject };
  byId.set(String(record.id), record);

  return {
    snapshot: { ...snapshot, memories, sessions, episodes, messages, conclusions, queueJobs, webhooks, webhookDeliveries, workspaces, agents, operations: [...byId.values()] },
    changed,
  };
}
