import { existsSync, readFileSync } from "node:fs";
import { durableJson, removeDurableFile } from "./durable-file.js";
import { createHash } from "node:crypto";
import { readJsonBounded } from "@hivemagnus/hive-common/fetch";
import { agentIdFromCollectionName as agentIdFromCollection, isMemoryCollectionName as isMemoryCollection, memoryCollectionName as memoryCollection } from "./collection-names.js";
import type {
  AgentInfo,
  ConclusionRecord,
  EpisodeRecord,
  JsonObject,
  JsonValue,
  MemoryRecord,
  MessageRecord,
  QueueJobRecord,
  SessionRecord,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  WorkspaceRecord,
} from "./types.js";

export interface PersistedAgentRecord extends AgentInfo {
  metadata: JsonObject;
}

export interface HiveMemSnapshot {
  operations?: JsonObject[];
  memories: MemoryRecord[];
  agents: PersistedAgentRecord[];
  conclusions: ConclusionRecord[];
  episodes: EpisodeRecord[];
  messages: MessageRecord[];
  sessions: SessionRecord[];
  workspaces: WorkspaceRecord[];
  queueJobs: QueueJobRecord[];
  webhooks: WebhookEndpointRecord[];
  webhookDeliveries: WebhookDeliveryRecord[];
}

/** What one incremental checkpoint changes in one snapshot collection. */
export interface HiveMemDeltaPart<T> {
  /** Records written or changed, as they now are. */
  upserts: T[];
  /** IDs of records removed (the store's key: `id`, `agent_id`, `session_id` or `workspace_id`). */
  deletes: string[];
}

/** The records changed since the previous checkpoint, per snapshot collection. */
export type HiveMemDelta = { [K in keyof HiveMemSnapshot]-?: HiveMemDeltaPart<NonNullable<HiveMemSnapshot[K]>[number]> };

export interface HiveMemPersistence {
  readonly kind: "qdrant";
  load(): Promise<HiveMemSnapshot>;
  /** Make storage hold exactly `snapshot`. */
  save(snapshot: HiveMemSnapshot): Promise<void>;
  /**
   * Apply only the changed records. Optional: a store without it saves the whole snapshot each
   * time. A store calls it only after a full `save` succeeded in this process, and goes back to
   * a full `save` after any failure.
   */
  saveDelta?(delta: HiveMemDelta): Promise<void>;
  probe?(): Promise<void>;
}

const snapshotKeys = ["operations", "memories", "agents", "conclusions", "episodes", "messages", "sessions", "workspaces", "queueJobs", "webhooks", "webhookDeliveries"] as const satisfies ReadonlyArray<keyof HiveMemSnapshot>;

/** The ID a snapshot record is stored under. */
export function snapshotRecordKey(key: keyof HiveMemSnapshot, record: unknown): unknown {
  const raw = record as Record<string, unknown>;
  if (key === "agents") return raw.agent_id;
  if (key === "sessions") return raw.session_id;
  if (key === "workspaces") return raw.workspace_id;
  return raw.id;
}

export function isEmptyDelta(delta: HiveMemDelta): boolean {
  return snapshotKeys.every((key) => delta[key].upserts.length === 0 && delta[key].deletes.length === 0);
}

/** A delta journal written by this or a later release (format 2), checked before it is replayed. */
function parseDeltaJournal(journal: Record<string, unknown>): { delta: HiveMemDelta; vectors: Array<[string, number[]]> } {
  const delta = journal.delta as Record<string, unknown> | undefined;
  if (!isRecord(delta)) throw new Error("Invalid pending HiveMem journal");
  for (const key of snapshotKeys) {
    const part = delta[key];
    if (!isRecord(part) || !Array.isArray(part.upserts) || !Array.isArray(part.deletes) || !part.deletes.every((id) => typeof id === "string"))
      throw new Error("Invalid pending HiveMem journal");
    for (const record of part.upserts) if (!isRecord(record) || typeof snapshotRecordKey(key, record) !== "string") throw new Error("Invalid pending HiveMem journal");
  }
  const vectors = Array.isArray(journal.vectors) ? journal.vectors as Array<[string, number[]]> : [];
  return { delta: delta as unknown as HiveMemDelta, vectors };
}

export interface QdrantHiveMemPersistenceOptions {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  journalPath?: string;
}

interface QdrantCollectionListResponse {
  result?: { collections?: Array<{ name?: unknown }> };
}

interface QdrantScrollResponse {
  result?: {
    points?: Array<{ id?: unknown; payload?: unknown; vector?: unknown }>;
    next_page_offset?: JsonValue | { [key: string]: JsonValue };
  };
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: JsonObject;
}

/**
 * Largest Qdrant answer read. A scroll page holds 256 points, each a 768-float vector plus its
 * payload (bounded by the request body limit when it was written), so 256 MiB leaves room.
 */
const QDRANT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

const vectorDimensions = {
  memory: 768,
  metadata: 4,
} as const;

/**
 * The format of an incremental checkpoint journal, `{ version: 2, delta, vectors }`. A full
 * checkpoint keeps the original `{ snapshot, vectors }` shape, which earlier releases replay.
 */
const DELTA_JOURNAL_VERSION = 2;

const metadataCollections = {
  agents: "_agents",
  conclusions: "_conclusions",
  episodes: "_episodes",
  queue: "_queue",
  sessions: "_sessions",
  webhooks: "_webhooks",
  webhookDeliveries: "_webhook_deliveries",
  workspaces: "_workspaces",
  operations: "_operations",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  const output: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) output[key] = isJsonValue(nested) ? nested : null;
  return output;
}

function metadataVector(): number[] {
  return Array.from({ length: vectorDimensions.metadata }, () => 0);
}

export function deterministicEmbedding(text: string): number[] {
  const vector = Array.from({ length: vectorDimensions.memory }, () => 0);
  const terms = text.toLowerCase().split(/[^a-z0-9_]+/u).filter(Boolean);
  for (const term of terms.length ? terms : [text]) {
    let hash = 2166136261;
    for (const char of term) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const index = Math.abs(hash) % vector.length;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function stablePointId(collection: string, recordId: string): string {
  const hex = createHash("sha256").update(collection + ":" + recordId).digest("hex").slice(0, 32);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-" + ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hex.slice(18, 20) + "-" + hex.slice(20, 32);
}

function point(collection: string, recordId: string, payload: JsonObject, vector: number[]): QdrantPoint {
  return { id: stablePointId(collection, recordId), vector, payload };
}

function recordPayload(record: object, recordType?: string): JsonObject {
  return asJsonObject(recordType ? { ...record, record_type: recordType } : { ...record });
}

function payloadRecord<T>(payload: unknown): T | null {
  return isRecord(payload) ? (asJsonObject(payload) as T) : null;
}

function memoryTypeFromCollection(collection: string): MemoryRecord["type"] {
  if (collection.endsWith("_semantic")) return "semantic";
  if (collection.endsWith("_procedural")) return "procedural";
  return "episodic";
}

function memoryScopeFromCollection(collection: string): MemoryRecord["scope"] {
  return collection.startsWith("shared_") ? "shared" : "private";
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function relationships(value: JsonValue | undefined): MemoryRecord["relationships"] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set(["supports", "contradicts", "updates", "duplicates", "causes", "part_of", "derived_from", "about_entity"]);
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.target_id !== "string" || typeof item.type !== "string" || !allowedTypes.has(item.type)) return [];
    return [{
      target_id: item.target_id,
      type: item.type as MemoryRecord["relationships"][number]["type"],
      confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
      metadata: isRecord(item.metadata) ? asJsonObject(item.metadata) : {},
    }];
  });
}

function normalizeMemoryRecord(collection: string, pointId: unknown, payload: JsonObject): MemoryRecord | null {
  if (typeof payload.content !== "string" || !payload.content.trim()) return null;
  const timestamp = typeof payload.created_at === "string" ? payload.created_at : new Date(0).toISOString();
  return {
    id: typeof payload.id === "string" && payload.id ? payload.id : collection + ":" + String(pointId || stablePointId(collection, payload.content)),
    content: payload.content,
    type: payload.type === "semantic" || payload.type === "procedural" || payload.type === "episodic" ? payload.type : memoryTypeFromCollection(collection),
    scope: payload.scope === "shared" || payload.scope === "private" ? payload.scope : memoryScopeFromCollection(collection),
    agent_id: typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : agentIdFromCollection(collection),
    source: payload.source === "conversation" || payload.source === "research" || payload.source === "observation" || payload.source === "consolidation" || payload.source === "user_feedback" || payload.source === "skill" || payload.source === "system" ? payload.source : "observation",
    confidence: typeof payload.confidence === "number" ? payload.confidence : 0.75,
    importance: typeof payload.importance === "number" ? payload.importance : 0.5,
    tags: stringArray(payload.tags),
    metadata: isRecord(payload.metadata) ? asJsonObject(payload.metadata) : {},
    sensitivity: payload.sensitivity === "public" || payload.sensitivity === "sensitive" || payload.sensitivity === "restricted" || payload.sensitivity === "internal" ? payload.sensitivity : "internal",
    retention_class: typeof payload.retention_class === "string" ? payload.retention_class : "standard",
    redaction_policy: payload.redaction_policy === "redact" || payload.redaction_policy === "exclude" || payload.redaction_policy === "none" ? payload.redaction_policy : "none",
    workspace_id: typeof payload.workspace_id === "string" && payload.workspace_id ? payload.workspace_id : "default",
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    created_at: timestamp,
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : timestamp,
    expires_at: typeof payload.expires_at === "string" ? payload.expires_at : null,
    valid_from: typeof payload.valid_from === "string" ? payload.valid_from : null,
    valid_to: typeof payload.valid_to === "string" ? payload.valid_to : null,
    observed_at: typeof payload.observed_at === "string" ? payload.observed_at : null,
    relationships: relationships(payload.relationships),
    confidence_provenance: Array.isArray(payload.confidence_provenance) ? payload.confidence_provenance.filter(isRecord).map(asJsonObject) : [],
    supersedes: typeof payload.supersedes === "string" ? payload.supersedes : null,
    superseded_by: typeof payload.superseded_by === "string" ? payload.superseded_by : null,
    superseded_at: typeof payload.superseded_at === "string" ? payload.superseded_at : (typeof payload.superseded_by === "string" ? (typeof payload.updated_at === "string" ? payload.updated_at : timestamp) : null),
    corroborated_by: stringArray(payload.corroborated_by),
    endorsements: typeof payload.endorsements === "number" ? payload.endorsements : 0,
    endorsed_by: stringArray(payload.endorsed_by),
    opposed_by: stringArray(payload.opposed_by),
    deleted_at: typeof payload.deleted_at === "string" ? payload.deleted_at : null,
    effective_confidence: typeof payload.effective_confidence === "number" ? payload.effective_confidence : null,
    sanitization_warnings: Array.isArray(payload.sanitization_warnings) ? stringArray(payload.sanitization_warnings) : null,
  };
}

function emptySnapshot(): HiveMemSnapshot {
  return {
    memories: [],
    agents: [],
    conclusions: [],
    episodes: [],
    messages: [],
    sessions: [],
    workspaces: [],
    queueJobs: [],
    webhooks: [],
    webhookDeliveries: [],
  };
}

export class QdrantHiveMemPersistence implements HiveMemPersistence {
  readonly kind = "qdrant" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly journalPath: string | undefined;
  private readonly persisted = new Map<string, Map<string, QdrantPoint>>();
  /** Where each memory ID has a point: collection name to point ID (legacy points keep their own IDs). */
  private readonly memoryLocations = new Map<string, Map<string, string>>();
  private readonly knownCollections = new Set<string>();
  private recovering = false;
  private recoveredVectors = new Map<string, number[]>();

  duplicateReport(): Array<{ id: string; copies: number }> {
    const counts = new Map<string, number>();
    for (const [collection, points] of this.persisted) if (isMemoryCollection(collection)) for (const item of points.values()) { const id = String(item.payload.id); counts.set(id, (counts.get(id) ?? 0) + 1); }
    return [...counts].filter(([, copies]) => copies > 1).map(([id, copies]) => ({ id, copies }));
  }

  async probe(): Promise<void> { await this.listCollections(); }

  /** Every collection name in this Qdrant. */
  async collectionNames(): Promise<string[]> { return this.listCollections(); }

  /** Exact number of points in a collection. */
  async pointCount(collection: string, filter?: JsonObject): Promise<number> {
    const response = await this.request<{ result?: { count?: unknown } }>("POST", "/collections/" + encodeURIComponent(collection) + "/points/count", { exact: true, ...(filter ? { filter } : {}) });
    const count = response.result?.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Qdrant point count for " + collection);
    return count;
  }

  /** Drops a collection this instance no longer writes. */
  async deleteCollection(collection: string): Promise<void> {
    await this.request("DELETE", "/collections/" + encodeURIComponent(collection) + "?timeout=60", undefined, [200, 404]);
    this.knownCollections.delete(collection);
    for (const pointId of [...(this.persisted.get(collection)?.keys() ?? [])]) this.untrackPoint(collection, pointId);
    this.persisted.delete(collection);
  }

  /** Sets payload `key` to `to` on every point whose `key` equals `from`; returns how many matched. */
  async replacePayloadValue(collection: string, key: string, from: string, to: string): Promise<number> {
    const filter: JsonObject = { must: [{ key, match: { value: from } }] };
    const matched = await this.pointCount(collection, filter);
    if (matched > 0) await this.request("POST", "/collections/" + encodeURIComponent(collection) + "/points/payload?wait=true", { payload: { [key]: to }, filter });
    return matched;
  }


  constructor(options: QdrantHiveMemPersistenceOptions) {
    let end = options.url.length;
    while (end > 0 && options.url[end - 1] === "/") end -= 1;
    this.baseUrl = options.url.slice(0, end);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.journalPath = options.journalPath;
  }

  async load(): Promise<HiveMemSnapshot> {
    this.persisted.clear();
    this.memoryLocations.clear();
    const snapshot = emptySnapshot();
    const collections = await this.listCollections();
    const existingCollections = new Set(collections);
    for (const name of collections) this.knownCollections.add(name);
    for (const collection of collections.filter(isMemoryCollection)) {
      const records = await this.scrollMemoryCollection(collection);
      snapshot.memories.push(...records);
    }

    if (existingCollections.has(metadataCollections.agents)) {
      for (const payload of await this.scrollCollection(metadataCollections.agents)) {
        const record = payloadRecord<PersistedAgentRecord>(payload);
        if (record) snapshot.agents.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.conclusions)) {
      for (const payload of await this.scrollCollection(metadataCollections.conclusions)) {
        const record = payloadRecord<ConclusionRecord>(payload);
        if (record) snapshot.conclusions.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.episodes)) {
      for (const payload of await this.scrollCollection(metadataCollections.episodes)) {
        const raw = payloadRecord<JsonObject>(payload);
        if (!raw) continue;
        if (raw.record_type === "message") snapshot.messages.push(raw as unknown as MessageRecord);
        else snapshot.episodes.push(raw as unknown as EpisodeRecord);
      }
    }
    if (existingCollections.has(metadataCollections.queue)) {
      for (const payload of await this.scrollCollection(metadataCollections.queue)) {
        const record = payloadRecord<QueueJobRecord>(payload);
        if (record) snapshot.queueJobs.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.sessions)) {
      for (const payload of await this.scrollCollection(metadataCollections.sessions)) {
        const record = payloadRecord<SessionRecord>(payload);
        if (record) snapshot.sessions.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.webhooks)) {
      for (const payload of await this.scrollCollection(metadataCollections.webhooks)) {
        const record = payloadRecord<WebhookEndpointRecord>(payload);
        if (record) snapshot.webhooks.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.webhookDeliveries)) {
      for (const payload of await this.scrollCollection(metadataCollections.webhookDeliveries)) {
        const record = payloadRecord<WebhookDeliveryRecord>(payload);
        if (record) snapshot.webhookDeliveries.push(record);
      }
    }
    if (existingCollections.has(metadataCollections.workspaces)) {
      for (const payload of await this.scrollCollection(metadataCollections.workspaces)) {
        const record = payloadRecord<WorkspaceRecord>(payload);
        if (record) snapshot.workspaces.push(record);
      }
    }
    // Restrictive tie-break prevents a stale shared copy winning a restart.
    const canonical = new Map<string, MemoryRecord>();
    for (const memory of snapshot.memories) {
      const old = canonical.get(memory.id);
      if (!old || memory.updated_at > old.updated_at || (memory.updated_at === old.updated_at && memory.scope === "private")) canonical.set(memory.id, memory);
    }
    snapshot.memories = [...canonical.values()];
    snapshot.operations = existingCollections.has(metadataCollections.operations) ? await this.scrollCollection(metadataCollections.operations) : [];
    if (this.journalPath && existsSync(this.journalPath) && !this.recovering) {
      const journal = JSON.parse(readFileSync(this.journalPath, "utf8")) as { version?: unknown; snapshot?: HiveMemSnapshot; vectors?: Array<[string, number[]]> };
      if (isRecord(journal) && journal.version === DELTA_JOURNAL_VERSION) {
        // An interrupted incremental checkpoint: Qdrant holds the state before it, possibly with
        // part of it applied. Replaying the delta is idempotent.
        const { delta, vectors } = parseDeltaJournal(journal);
        this.recoveredVectors = new Map(vectors);
        this.recovering = true;
        try { await this.saveDelta(delta); return await this.load(); } finally { this.recovering = false; }
      }
      if (isRecord(journal) && journal.version !== undefined) throw new Error("Unsupported pending HiveMem journal format " + String(journal.version) + "; start the release that wrote it");
      const pending = journal.snapshot ?? journal as unknown as HiveMemSnapshot;
      this.recoveredVectors = new Map(journal.vectors ?? []);
      for (const key of Object.keys(snapshot) as Array<keyof HiveMemSnapshot>) {
        if (key === "operations" && pending[key] === undefined) continue;
        if (!Array.isArray(pending[key])) throw new Error("Invalid pending HiveMem journal");
      }
      this.recovering = true;
      try { await this.save(pending); return await this.load(); } finally { this.recovering = false; }
    }
    return snapshot;
  }

  async save(snapshot: HiveMemSnapshot): Promise<void> {
        const memoryCollections = new Map<string, QdrantPoint[]>();
    const priorMemories = new Map([...this.persisted].filter(([collection]) => isMemoryCollection(collection)).flatMap(([, items]) => [...items.values()]).filter((item) => typeof item.payload.id === "string").map((item) => [item.payload.id, item]));
    for (const memory of snapshot.memories) {
      const collection = memoryCollection(memory);
      const points = memoryCollections.get(collection) ?? [];
      const previous = priorMemories.get(memory.id);
      const vector = this.recoveredVectors.get(memory.id) ?? (previous?.vector.length ? previous.vector : deterministicEmbedding(memory.content));
      points.push(point(collection, memory.id, recordPayload(memory), vector));
      memoryCollections.set(collection, points);
    }

    if (this.journalPath) durableJson(this.journalPath, { snapshot, vectors: [...memoryCollections.values()].flat().map((item) => [item.payload.id, item.vector]) });

    // Remove stale visible copies before adding the new collection. The fsynced
    // journal resumes an interrupted move; no new duplicate is exposed.
    for (const collection of this.persisted.keys()) {
      if (isMemoryCollection(collection)) await this.removeMissing(collection, memoryCollections.get(collection) ?? []);
    }
    for (const [collection, points] of memoryCollections) await this.ensureAndUpsert(collection, vectorDimensions.memory, points);
    await this.ensureAndUpsert(metadataCollections.agents, vectorDimensions.metadata, snapshot.agents.map((record) => point(metadataCollections.agents, record.agent_id, recordPayload(record), metadataVector())));
    // Historical _conclusions collections use the memory vector schema. Keep
    // their existing 768-dimensional layout so checkpoint writes remain valid.
    await this.ensureAndUpsert(metadataCollections.conclusions, vectorDimensions.memory, snapshot.conclusions.map((record) => point(metadataCollections.conclusions, record.id, recordPayload(record), Array.from({ length: vectorDimensions.memory }, () => 0))));
    await this.ensureAndUpsert(metadataCollections.episodes, vectorDimensions.metadata, [
      ...snapshot.episodes.map((record) => point(metadataCollections.episodes, record.id, recordPayload(record, "episode"), metadataVector())),
      ...snapshot.messages.map((record) => point(metadataCollections.episodes, record.id, recordPayload(record, "message"), metadataVector())),
    ]);
    await this.ensureAndUpsert(metadataCollections.queue, vectorDimensions.metadata, snapshot.queueJobs.map((record) => point(metadataCollections.queue, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.sessions, vectorDimensions.metadata, snapshot.sessions.map((record) => point(metadataCollections.sessions, record.session_id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.webhooks, vectorDimensions.metadata, snapshot.webhooks.map((record) => point(metadataCollections.webhooks, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.webhookDeliveries, vectorDimensions.metadata, snapshot.webhookDeliveries.map((record) => point(metadataCollections.webhookDeliveries, record.id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.workspaces, vectorDimensions.metadata, snapshot.workspaces.map((record) => point(metadataCollections.workspaces, record.workspace_id, recordPayload(record), metadataVector())));
    await this.ensureAndUpsert(metadataCollections.operations, vectorDimensions.metadata, (snapshot.operations ?? []).map((record) => point(metadataCollections.operations, String(record.id), record, metadataVector())));
    if (this.journalPath) removeDurableFile(this.journalPath);
    this.recoveredVectors.clear();
  }

  /**
   * Write only what changed. The delta, with the vectors of its memories, is fsynced to the
   * journal first, so an interruption replays it on the next start. Stale copies of moved or
   * deleted memories go before the new copies are written, as in a full save.
   */
  async saveDelta(delta: HiveMemDelta): Promise<void> {
    const memoryPoints = new Map<string, QdrantPoint[]>();
    const targets = new Map<string, { collection: string; pointId: string }>();
    const vectors: Array<[string, number[]]> = [];
    for (const memory of delta.memories.upserts) {
      const collection = memoryCollection(memory);
      const vector = this.recoveredVectors.get(memory.id) ?? this.priorVector(memory.id) ?? deterministicEmbedding(memory.content);
      const entry = point(collection, memory.id, recordPayload(memory), vector);
      memoryPoints.set(collection, [...(memoryPoints.get(collection) ?? []), entry]);
      targets.set(memory.id, { collection, pointId: entry.id });
      vectors.push([memory.id, vector]);
    }

    if (this.journalPath) durableJson(this.journalPath, { version: DELTA_JOURNAL_VERSION, delta, vectors });

    // Every copy of a deleted memory, and every copy of a written one except its new point.
    const stale = new Map<string, string[]>();
    const markStale = (memoryId: string, keep?: { collection: string; pointId: string }) => {
      for (const [collection, pointId] of this.memoryLocations.get(memoryId) ?? []) {
        if (keep && keep.collection === collection && keep.pointId === pointId) continue;
        stale.set(collection, [...(stale.get(collection) ?? []), pointId]);
      }
    };
    for (const id of delta.memories.deletes) markStale(id);
    for (const [id, target] of targets) markStale(id, target);
    for (const [collection, pointIds] of stale) await this.deletePoints(collection, pointIds);
    for (const [collection, points] of memoryPoints) await this.ensureAndUpsert(collection, vectorDimensions.memory, points, false);

    const metadata = (collection: string, dimensions: number, records: Array<{ id: string; payload: JsonObject }>, deletes: readonly string[]) =>
      this.applyMetadata(collection, dimensions, records.map((record) => point(collection, record.id, record.payload, dimensions === vectorDimensions.memory ? Array.from({ length: vectorDimensions.memory }, () => 0) : metadataVector())), deletes);
    await metadata(metadataCollections.agents, vectorDimensions.metadata, delta.agents.upserts.map((record) => ({ id: record.agent_id, payload: recordPayload(record) })), delta.agents.deletes);
    await metadata(metadataCollections.conclusions, vectorDimensions.memory, delta.conclusions.upserts.map((record) => ({ id: record.id, payload: recordPayload(record) })), delta.conclusions.deletes);
    await metadata(metadataCollections.episodes, vectorDimensions.metadata, [
      ...delta.episodes.upserts.map((record) => ({ id: record.id, payload: recordPayload(record, "episode") })),
      ...delta.messages.upserts.map((record) => ({ id: record.id, payload: recordPayload(record, "message") })),
    ], [...delta.episodes.deletes, ...delta.messages.deletes]);
    await metadata(metadataCollections.queue, vectorDimensions.metadata, delta.queueJobs.upserts.map((record) => ({ id: record.id, payload: recordPayload(record) })), delta.queueJobs.deletes);
    await metadata(metadataCollections.sessions, vectorDimensions.metadata, delta.sessions.upserts.map((record) => ({ id: record.session_id, payload: recordPayload(record) })), delta.sessions.deletes);
    await metadata(metadataCollections.webhooks, vectorDimensions.metadata, delta.webhooks.upserts.map((record) => ({ id: record.id, payload: recordPayload(record) })), delta.webhooks.deletes);
    await metadata(metadataCollections.webhookDeliveries, vectorDimensions.metadata, delta.webhookDeliveries.upserts.map((record) => ({ id: record.id, payload: recordPayload(record) })), delta.webhookDeliveries.deletes);
    await metadata(metadataCollections.workspaces, vectorDimensions.metadata, delta.workspaces.upserts.map((record) => ({ id: record.workspace_id, payload: recordPayload(record) })), delta.workspaces.deletes);
    await metadata(metadataCollections.operations, vectorDimensions.metadata, delta.operations.upserts.map((record) => ({ id: String(record.id), payload: record })), delta.operations.deletes);
    if (this.journalPath) removeDurableFile(this.journalPath);
    this.recoveredVectors.clear();
  }

  /** The vector of any stored copy of a memory, so a change or a move keeps it. */
  private priorVector(memoryId: string): number[] | undefined {
    for (const [collection, pointId] of this.memoryLocations.get(memoryId) ?? []) {
      const vector = this.persisted.get(collection)?.get(pointId)?.vector;
      if (vector?.length) return vector;
    }
    return undefined;
  }

  private async applyMetadata(collection: string, dimensions: number, points: QdrantPoint[], deletes: readonly string[]): Promise<void> {
    const removed = deletes.map((id) => stablePointId(collection, id)).filter((pointId) => this.persisted.get(collection)?.has(pointId) && !points.some((entry) => entry.id === pointId));
    if (removed.length) await this.deletePoints(collection, removed);
    if (points.length) await this.ensureAndUpsert(collection, dimensions, points, false);
  }

  private async listCollections(): Promise<string[]> {
    const response = await this.request<QdrantCollectionListResponse>("GET", "/collections");
    return (response.result?.collections ?? []).map((collection) => (typeof collection.name === "string" ? collection.name : "")).filter(Boolean);
  }

  private async scrollCollection(collection: string): Promise<JsonObject[]> {
    const payloads: JsonObject[] = [];
    let offset: JsonValue | { [key: string]: JsonValue } | undefined;
    do {
      const response = await this.request<QdrantScrollResponse>("POST", "/collections/" + encodeURIComponent(collection) + "/points/scroll", {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: true,
      });
      const points = response.result?.points ?? [];
      for (const item of points) {
        const payload = asJsonObject(item.payload);
        if (Object.keys(payload).length === 0 || !(payload.id || payload.agent_id || payload.session_id || payload.workspace_id)) throw new Error("Invalid HiveMem metadata in " + collection);
        payloads.push(payload);
        this.rememberPoint(collection, item, payload);
      }
      offset = response.result?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return payloads;
  }

  private async scrollMemoryCollection(collection: string): Promise<MemoryRecord[]> {
    const records: MemoryRecord[] = [];
    let offset: JsonValue | { [key: string]: JsonValue } | undefined;
    do {
      const response = await this.request<QdrantScrollResponse>("POST", "/collections/" + encodeURIComponent(collection) + "/points/scroll", {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: true,
      });
      const points = response.result?.points ?? [];
      for (const item of points) {
        const record = normalizeMemoryRecord(collection, item.id, asJsonObject(item.payload));
        if (record) { records.push(record); this.rememberPoint(collection, item, recordPayload(record)); }
      }
      offset = response.result?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return records;
  }

  private rememberPoint(collection: string, item: { id?: unknown; vector?: unknown }, payload: JsonObject): void {
    if (typeof item.id !== "string" && typeof item.id !== "number") throw new Error("Invalid Qdrant point ID");
    if (isMemoryCollection(collection) && item.vector !== undefined && (!Array.isArray(item.vector) || item.vector.length !== vectorDimensions.memory || item.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("Unsupported vector schema in " + collection + "; migrate explicitly");
    this.trackPoint(collection, { id: String(item.id), payload, vector: Array.isArray(item.vector) ? item.vector as number[] : [] });
  }

  /** Record a point as stored, keeping the memory location index in step. */
  private trackPoint(collection: string, entry: QdrantPoint): void {
    const records = this.persisted.get(collection) ?? new Map<string, QdrantPoint>();
    const previous = records.get(entry.id);
    if (previous) this.untrackLocation(collection, previous);
    records.set(entry.id, entry);
    this.persisted.set(collection, records);
    if (isMemoryCollection(collection) && typeof entry.payload.id === "string") {
      const locations = this.memoryLocations.get(entry.payload.id) ?? new Map<string, string>();
      locations.set(collection, entry.id);
      this.memoryLocations.set(entry.payload.id, locations);
    }
  }

  private untrackPoint(collection: string, pointId: string): void {
    const records = this.persisted.get(collection);
    const previous = records?.get(pointId);
    if (!records || !previous) return;
    records.delete(pointId);
    this.untrackLocation(collection, previous);
  }

  private untrackLocation(collection: string, entry: QdrantPoint): void {
    if (!isMemoryCollection(collection) || typeof entry.payload.id !== "string") return;
    const locations = this.memoryLocations.get(entry.payload.id);
    if (locations?.get(collection) !== entry.id) return;
    locations.delete(collection);
    if (!locations.size) this.memoryLocations.delete(entry.payload.id);
  }

  private async deletePoints(collection: string, pointIds: readonly string[]): Promise<void> {
    for (let offset = 0; offset < pointIds.length; offset += 128) {
      const batch = pointIds.slice(offset, offset + 128);
      await this.request("POST", "/collections/" + encodeURIComponent(collection) + "/points/delete?wait=true", { points: batch });
      for (const id of batch) this.untrackPoint(collection, id);
    }
  }

  private async removeMissing(collection: string, points: QdrantPoint[]): Promise<void> {
    const prior = this.persisted.get(collection);
    if (!prior) return;
    const wanted = new Set(points.map((entry) => entry.id));
    await this.deletePoints(collection, [...prior.keys()].filter((id) => !wanted.has(id)));
  }

  /** Upsert the points whose payload changed; `exhaustive` also removes every other point. */
  private async ensureAndUpsert(collection: string, dimensions: number, points: QdrantPoint[], exhaustive = true): Promise<void> {
    if (!this.knownCollections.has(collection)) {
      await this.request("PUT", "/collections/" + encodeURIComponent(collection), { vectors: { size: dimensions, distance: "Cosine" } }, [200, 409]);
      this.knownCollections.add(collection);
    }
    const prior = this.persisted.get(collection) ?? new Map<string, QdrantPoint>();
    this.persisted.set(collection, prior);
    const changed = points.filter((entry) => JSON.stringify(prior.get(entry.id)?.payload) !== JSON.stringify(entry.payload));
    for (let offset = 0; offset < changed.length; offset += 128) {
      const batch = changed.slice(offset, offset + 128);
      await this.request("PUT", "/collections/" + encodeURIComponent(collection) + "/points?wait=true", { points: batch });
      for (const entry of batch) this.trackPoint(collection, entry);
    }
    if (exhaustive) await this.removeMissing(collection, points);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, okStatuses: readonly number[] = [200]): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(this.baseUrl + path, init);
    if (!okStatuses.includes(response.status)) {
      // The body stays out of the message: it can echo payload content, and messages reach logs.
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Qdrant " + method + " " + path + " failed with " + response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await readJsonBounded(response, QDRANT_MAX_RESPONSE_BYTES)) as T;
  }
}

/** Qdrant REST base URL from HIVEMEM_QDRANT_URL, QDRANT_URL, or the host/port pair (default http://127.0.0.1:6333). */
export function qdrantUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.HIVEMEM_QDRANT_URL ?? env.QDRANT_URL ?? "http://" + (env.HIVEMEM_QDRANT_HOST ?? env.QDRANT_HOST ?? "127.0.0.1") + ":" + (env.HIVEMEM_QDRANT_PORT ?? env.QDRANT_PORT ?? "6333");
}

export function qdrantPersistenceFromEnv(env: NodeJS.ProcessEnv = process.env): QdrantHiveMemPersistence | null {
  if (env.HIVEMEM_TS_PERSISTENCE !== "qdrant") return null;
  const host = qdrantUrlFromEnv(env);
  return new QdrantHiveMemPersistence({ url: host, ...(env.HIVEMEM_STORAGE_PATH ? { journalPath: env.HIVEMEM_STORAGE_PATH + "/pending-write.json" } : {}), ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}) });
}
