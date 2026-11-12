export type MemoryScope = "private" | "shared";
export type MemoryType = "episodic" | "semantic" | "procedural";
export type WebhookEventType =
  | "memory.created"
  | "session.created"
  | "queue.empty"
  | "summary.updated"
  | "peer_card.updated"
  | "conflict.detected"
  | "webhook.test";

export interface HiveMemOptions {
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  requestIdProvider?: () => string;
  authRefresh?: () => string | undefined | Promise<string | undefined>;
  /**
   * Supplies the bearer token, for example a short-lived Oathweave service token. Called before
   * each request with `forceRefresh: false`; after a 401 it is called again with
   * `forceRefresh: true` and the request is retried once with the token it returns. Returning
   * `undefined` falls back to `token`.
   */
  tokenProvider?: TokenProvider;
  /**
   * Extra headers sent on every request, such as `x-request-id` or `traceparent` taken from the
   * caller's request context. A function is called once per request. They never replace the
   * client's own `Accept` or `Content-Type` headers, and `Authorization` comes only from `token`,
   * `tokenProvider` or `authRefresh`.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  onRequest?: (method: string, url: string, init: RequestInit) => void;
  onResponse?: (response: Response) => void;
}

export interface TokenProviderContext {
  /** True after the server answered 401: the cached token must not be reused. */
  forceRefresh: boolean;
}

export type TokenProvider = (context: TokenProviderContext) => string | undefined | Promise<string | undefined>;

export type WorkspaceRole = "viewer" | "member" | "admin" | "owner";

export interface WorkspaceMember {
  agent_id: string;
  role: WorkspaceRole;
  scopes: string[];
  added_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceSanitizationPolicy {
  mode: "warn" | "redact" | "reject" | null;
  detect_pii: boolean | null;
  detect_secrets: boolean | null;
  deny_regexes: string[];
}

export interface WorkspacePolicy {
  retention_days: number | null;
  allowed_scopes: string[];
  reasoning_provider: string | null;
  consolidation_cadence_seconds: number | null;
  webhooks_enabled: boolean;
  sanitization: WorkspaceSanitizationPolicy;
  agent_overrides: Record<string, Record<string, unknown>>;
  session_overrides: Record<string, Record<string, unknown>>;
}

export interface WorkspaceRecord {
  workspace_id: string;
  owner_agent_id: string;
  title: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  policy: WorkspacePolicy;
  members: WorkspaceMember[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Optional fields of `POST /v1/workspaces`; `workspace_id` is the method's first argument. */
export interface WorkspaceCreateOptions {
  title?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  policy?: Partial<Omit<WorkspacePolicy, "sanitization">> & { sanitization?: Partial<WorkspaceSanitizationPolicy> };
  members?: Array<Pick<WorkspaceMember, "agent_id"> & Partial<Pick<WorkspaceMember, "role" | "scopes">>>;
}

export interface MemoryRecord {
  id: string;
  agent_id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  source?: string;
  confidence?: number;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workspace_id?: string;
  session_id?: string | null;
  created_at?: string;
  updated_at?: string;
  observed_at?: string | null;
  expires_at?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  superseded_at?: string | null;
  [key: string]: unknown;
}

export interface SearchResponse {
  results: Array<{
    memory: MemoryRecord;
    score: number;
    collection: string;
    is_own: boolean;
    explanation?: {
      vector_score: number;
      importance_boost: number;
      text_match: boolean;
      final_score: number;
    } | null;
    citation?: {
      memory_id: string;
      publisher: string;
      source_ref: string | null;
      revision: string | null;
      observed_at: string | null;
      valid_from: string | null;
      valid_to: string | null;
      expires_at: string | null;
      freshness: "current" | "live_recheck" | "historical";
      relationship_path: string[];
    };
    score_components?: Record<string, number | null>;
    selection_reason?: "query" | "relationship" | "entity";
  }>;
  total_searched: number;
  collections_searched: string[];
}

export interface SessionRecord {
  session_id: string;
  owner_agent_id: string;
  scope: MemoryScope;
  title?: string | null;
  workspace_id: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface QueueStatusResponse {
  jobs: unknown[];
  total: number;
  pending_count: number;
  in_progress_count: number;
  failed_count: number;
  dead_letter_count: number;
  offset: number;
  limit: number;
}

export interface QueueJobRecord {
  id: string;
  task_type: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "dead_letter" | "cancelled";
  work_unit_key: string;
  payload: Record<string, unknown>;
  owner_agent_id: string;
  workspace_id: string;
  session_id: string | null;
  peer_id: string | null;
  observer_peer_id: string | null;
  observed_peer_id: string | null;
  idempotency_key: string;
  priority: number;
  retry_count: number;
  created_at: string;
  not_before: string | null;
  started_at: string | null;
  finished_at: string | null;
  locked_at: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

export type ConclusionKind = "explicit" | "deductive" | "inductive" | "abductive" | "summary" | "peer_card" | "manual";

export interface ConclusionRecord {
  id: string;
  owner_agent_id: string;
  observer_peer_id: string;
  observed_peer_id: string;
  session_id: string | null;
  workspace_id: string;
  source_memory_ids: string[];
  content: string;
  kind: ConclusionKind;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  deleted_at: string | null;
}

export interface ConclusionPage {
  results: ConclusionRecord[];
  next_cursor: string | null;
}

/** HiveAuditRecord v1, the suite audit export record. */
export interface HiveAuditRecord {
  id: string;
  product: "hivemem" | "hiveskills" | "ardentstudio" | "embermend";
  occurredAt: string;
  action: string;
  outcome: "success" | "failure";
  actor: { type: "user" | "service" | "agent" | "system"; id: string; issuer?: string; displayName?: string };
  target?: { type?: string; id?: string };
  subject?: { actorId?: string; agentRef?: string; nodeId?: string };
  details: Record<string, string | number | boolean | null>;
}

export interface HiveAuditPage {
  data: HiveAuditRecord[];
  nextCursor: string | null;
}

export interface WebhookEndpoint {
  id: string;
  owner_agent_id: string;
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  has_secret: boolean;
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface ContextMemory {
  memory: MemoryRecord;
  collection: string;
  score: number | null;
  tokens_used: number;
  citation?: SearchResponse["results"][number]["citation"];
  score_components?: Record<string, number | null>;
  selection_reason?: "query" | "relationship" | "entity";
}

export interface ContextResponse {
  summary?: unknown;
  memories?: Array<ContextMemory | MemoryRecord>;
  representation?: unknown;
  formatted_context?: unknown;
  [key: string]: unknown;
}

export interface PeerCardResponse {
  peer_id: string;
  observer_peer_id: string;
  workspace_id: string;
  cards: unknown[];
  generated_at: string;
}

export interface KnowledgeSourceSyncResponse {
  mode: "preview" | "apply";
  workspace_id: string;
  project_id: string;
  source_id: string;
  revision: string;
  created: number;
  superseded: number;
  retired: number;
  unchanged: number;
  created_ids: string[];
  superseded_ids: string[];
  retired_ids: string[];
}
