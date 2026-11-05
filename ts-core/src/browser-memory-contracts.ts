// Browser-safe public contracts. No datastore, authentication implementation or secrets.
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const nullableText = z.string().nullable();
const scope = z.enum(["private", "shared"]);
const type = z.enum(["episodic", "semantic", "procedural"]);
export const MemorySourceSchema = z.enum([
  "conversation", "research", "observation", "consolidation", "user_feedback", "skill", "system",
]);
const relationship = z.object({
  target_id: z.string(),
  type: z.enum(["supports", "contradicts", "updates", "duplicates", "causes", "part_of", "derived_from", "about_entity"]),
  confidence: z.number(), metadata: object,
});
export const MemoryUpdateSchema = z.object({
  content: z.string().optional(), confidence: z.number().optional(), importance: z.number().optional(),
  tags: z.array(z.string()).optional(), metadata: object.optional(),
  sensitivity: z.enum(["public", "internal", "sensitive", "restricted"]).optional(),
  retention_class: z.string().optional(), redaction_policy: z.enum(["none", "redact", "exclude"]).optional(),
  workspace_id: z.string().min(1).optional(), session_id: nullableText.optional(),
  expires_at: nullableText.optional(), valid_from: nullableText.optional(), valid_to: nullableText.optional(),
  observed_at: nullableText.optional(), relationships: z.array(relationship).optional(),
});
export const MemoryWriteSchema = MemoryUpdateSchema.extend({
  content: z.string().trim().min(1), type, scope,
  source: MemorySourceSchema.optional(), confidence_reason: nullableText.optional(), supersedes: nullableText.optional(),
});
export const MemoryRecordSchema = MemoryWriteSchema.required().omit({ confidence_reason: true }).extend({
  // Reads preserve historical/native bytes; create constraints must not transform recovery data.
  content: z.string(),
  id: z.string(), agent_id: z.string(), workspace_id: z.string(),
  source: MemorySourceSchema, confidence: z.number(), importance: z.number(),
  created_at: z.string(), updated_at: z.string(), session_id: nullableText,
  expires_at: nullableText, valid_from: nullableText, valid_to: nullableText, observed_at: nullableText,
  relationships: z.array(relationship), confidence_provenance: z.array(object), supersedes: nullableText,
  superseded_by: nullableText, superseded_at: nullableText, corroborated_by: z.array(z.string()),
  endorsements: z.number(), endorsed_by: z.array(z.string()), opposed_by: z.array(z.string()),
  deleted_at: nullableText, effective_confidence: z.number().nullable(), sanitization_warnings: z.array(z.string()).nullable(),
});
export const MemorySearchRequestSchema = z.object({
  query: z.string().optional(), workspace_id: z.string().optional(), scope: scope.optional(), type: type.optional(),
  limit: z.number().optional(), offset: z.number().optional(), tags: z.array(z.string()).optional(),
  session_id: z.string().optional(), agent_filter: z.string().optional(), from_self: z.boolean().optional(),
  min_confidence: z.number().optional(), min_importance: z.number().optional(),
  include_deleted: z.boolean().optional(), include_sensitive: z.boolean().optional(),
  filters: object.optional(), graph: object.optional(), diversity: object.optional(), as_of: z.string().optional(),
});
export const MemorySearchResultSchema = z.object({
  memory: MemoryRecordSchema, score: z.number(), collection: z.string(), is_own: z.boolean(),
  citation: z.object({
    memory_id: z.string(), publisher: z.string(), source_ref: nullableText, revision: nullableText,
    observed_at: nullableText, valid_from: nullableText, valid_to: nullableText, expires_at: nullableText,
    freshness: z.enum(["current", "live_recheck", "historical"]), relationship_path: z.array(z.string()),
  }).optional(),
  score_components: z.object({
    lexical_rank: z.number().nullable(), graph_rank: z.number().nullable(), confidence_rank: z.number(),
    importance_rank: z.number(), freshness_rank: z.number(), rrf_score: z.number(), mmr_score: z.number(),
  }).optional(),
  selection_reason: z.enum(["query", "relationship", "entity"]).optional(),
  explanation: z.object({ vector_score: z.number(), importance_boost: z.number(), text_match: z.boolean(), final_score: z.number() }).nullable().optional(),
});
export const MemorySearchResponseSchema = z.object({
  results: z.array(MemorySearchResultSchema), total_searched: z.number(), collections_searched: z.array(z.string()),
});
export const MemoryBrowseResponseSchema = z.object({
  memories: z.array(MemoryRecordSchema), results: z.array(MemoryRecordSchema), total: z.number(),
  offset: z.number(), limit: z.number(), next_cursor: nullableText,
});
export const MemoryConflictQuerySchema = z.object({
  content: z.string().min(1), workspace_id: z.string().optional(), scope: scope.optional(), type: type.optional(), limit: z.number().optional(),
});
export const MemoryStatsSchema = z.object({
  agents: z.number(), memories: z.number(), sessions: z.number(), workspaces: z.number(), queue_jobs: z.number(),
  webhooks: z.number(), webhook_deliveries: z.number(), conclusions: z.number(), episodes: z.number(), messages: z.number(),
});
export const MemoryAgentSchema = z.object({
  agent_id: z.string(), display_name: z.string(), description: nullableText, created_at: z.string(),
  updated_at: z.string().optional(), active: z.boolean().optional(), memory_counts: z.record(z.string(), z.number()),
});
const status = z.enum(["pending", "in_progress", "completed", "failed", "dead_letter", "cancelled"]);
export const MemoryQueueJobSummarySchema = z.object({
  id: z.string(), task_type: z.enum(["representation", "summary", "consolidation", "dream", "decay_recalc", "conflict_scan", "peer_card", "embedding_reconcile", "webhook_delivery", "message_extract", "sleep", "forgetting_review"]),
  status, work_unit_key: z.string(), owner_agent_id: z.string(), workspace_id: z.string(), session_id: nullableText,
  peer_id: nullableText, priority: z.number(), retry_count: z.number(), created_at: z.string(), not_before: nullableText,
  started_at: nullableText, finished_at: nullableText, error: nullableText,
});
export const MemoryQueueJobSchema = MemoryQueueJobSummarySchema.extend({
  payload: object, observer_peer_id: nullableText, observed_peer_id: nullableText,
  idempotency_key: z.string(), locked_at: nullableText, result: object.nullable(),
});
export const MemoryQueueStatusSchema = z.object({
  worker: z.object({
    ready: z.boolean(), state: z.enum(["manual", "disabled", "stale", "degraded", "running", "idle", "starting"]),
    managed: z.boolean(), enabled: z.boolean(), running: z.boolean(), heartbeat: nullableText,
    last_success: nullableText, error: nullableText, recovered_on_startup: z.number(), pending_jobs: z.number(), oldest_pending_seconds: z.number().nullable(),
  }),
  jobs: z.array(MemoryQueueJobSummarySchema), total: z.number(), pending_count: z.number(), in_progress_count: z.number(),
  failed_count: z.number(), dead_letter_count: z.number(), offset: z.number(), limit: z.number(),
});
export const WorkspaceSettingsSchema = z.object({ workspace_id: z.string(), policy: object, source_order: z.array(z.string()) });
export const DreamScheduleSchema = z.object({
  job_id: z.string(), task_type: z.literal("dream"), workspace_id: z.string(), peer_id: z.string(),
  observer_peer_id: z.string(), session_id: nullableText, status,
});
export const SessionContextRequestSchema = MemorySearchRequestSchema.omit({ limit: true, offset: true }).extend({
  search_query: z.string().optional(), max_memories: z.number().optional(), token_budget: z.number().optional(),
  include_session_memories: z.boolean().optional(),
});
export const SessionChatRequestSchema = z.object({
  workspace_id: nullableText.optional(), query: z.string().min(1), stream: z.boolean().optional(),
  session_id: nullableText.optional(), reasoning_level: z.enum(["minimal", "low", "medium", "high", "max"]).optional(),
  max_sources: z.number().optional(), include_citations: z.boolean().optional(), scope: scope.optional(),
  type: type.optional(), tags: z.array(z.string()).optional(), min_confidence: z.number().optional(),
});
export const SessionContextResultSchema = z.object({
  memories: z.array(z.object({
    memory: MemoryRecordSchema, collection: z.string(), score: z.number().nullable(), tokens_used: z.number(),
    citation: MemorySearchResultSchema.shape.citation, score_components: MemorySearchResultSchema.shape.score_components,
    selection_reason: MemorySearchResultSchema.shape.selection_reason,
  })),
  summary: z.object({ content: z.string(), memory_count: z.number() }), representation: object,
  formatted_context: z.object({ format: z.literal("markdown"), content: z.string() }),
  metadata: z.object({
    generated_at: z.string(), token_budget: z.number(), tokens_used: z.number(), truncated: z.boolean(),
    retrieval_mode: z.literal("lexical_graph_rrf_v1").optional(), candidate_count: z.number().optional(),
    stale_suppressed: z.number().optional(), graph_expansions: z.number().optional(),
  }),
});
export const SessionChatResultSchema = z.object({
  answer: z.string(), reasoning_level: z.enum(["minimal", "low", "medium", "high", "max"]),
  sources: z.array(z.object({
    memory_id: z.string(), collection: z.string(), content: z.string(), score: z.number(), confidence: z.number(),
    effective_confidence: z.number(), importance: z.number(), tags: z.array(z.string()), agent_id: z.string(), created_at: z.string(), is_own: z.boolean(),
  })),
  usage: z.object({ query_tokens: z.number(), answer_tokens: z.number(), source_tokens: z.number(), total_tokens: z.number() }),
  session_id: nullableText, workspace_id: z.string(), requested_at: z.string(), processed_at: z.string(),
});
export const memoryBrowserSchemas = {
  MemorySource: MemorySourceSchema, MemoryWrite: MemoryWriteSchema, MemoryUpdate: MemoryUpdateSchema,
  MemoryRecord: MemoryRecordSchema, MemorySearchRequest: MemorySearchRequestSchema, MemorySearchResult: MemorySearchResultSchema,
  MemorySearchResponse: MemorySearchResponseSchema, MemoryBrowseResponse: MemoryBrowseResponseSchema,
  MemoryConflictQuery: MemoryConflictQuerySchema, MemoryStats: MemoryStatsSchema, MemoryAgent: MemoryAgentSchema,
  MemoryQueueJobSummary: MemoryQueueJobSummarySchema, MemoryQueueJob: MemoryQueueJobSchema,
  MemoryQueueStatus: MemoryQueueStatusSchema, WorkspaceSettings: WorkspaceSettingsSchema, DreamSchedule: DreamScheduleSchema,
  SessionContextRequest: SessionContextRequestSchema, SessionChatRequest: SessionChatRequestSchema,
  SessionContextResult: SessionContextResultSchema, SessionChatResult: SessionChatResultSchema,
};
