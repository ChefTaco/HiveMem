// Public API baseline extracted from Hive; complete schema coverage remains pending.
import { z } from "zod";
import { actorCredentialSchema } from "./actor-credentials.js";
import { memoryBrowserSchemas } from "./browser-memory-contracts.js";

// Owned browser contracts. Native clients retain their existing compatibility APIs.
const jsonObject = z.record(z.string(), z.unknown());
const nullableText = z.string().nullable();
export const WorkspaceMemberSchema = z.object({
  agent_id: z.string(),
  role: z.enum(["viewer", "member", "admin", "owner"]),
  scopes: z.array(z.string()),
  added_by: nullableText,
  created_at: nullableText,
  updated_at: nullableText,
});
export const WorkspacePolicySchema = z.object({
  retention_days: z.number().nullable(),
  allowed_scopes: z.array(z.string()),
  reasoning_provider: nullableText,
  consolidation_cadence_seconds: z.number().nullable(),
  webhooks_enabled: z.boolean(),
  sanitization: z.object({
    mode: z.enum(["warn", "redact", "reject"]).nullable(),
    detect_pii: z.boolean().nullable(),
    detect_secrets: z.boolean().nullable(),
    deny_regexes: z.array(z.string()),
  }),
  agent_overrides: z.record(z.string(), jsonObject),
  session_overrides: z.record(z.string(), jsonObject),
});
export const WorkspaceSchema = z.object({
  workspace_id: z.string(),
  owner_agent_id: z.string(),
  title: nullableText,
  description: nullableText,
  metadata: jsonObject,
  policy: WorkspacePolicySchema,
  members: z.array(WorkspaceMemberSchema),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: nullableText,
});
export const WorkspaceUpdateSchema = z.object({
  title: nullableText.optional(),
  description: nullableText.optional(),
  metadata: jsonObject.optional(),
  policy: WorkspacePolicySchema.optional(),
});
export const WorkspaceCreateSchema = WorkspaceUpdateSchema.extend({
  workspace_id: z.string().trim().min(1),
  members: z
    .array(WorkspaceMemberSchema.partial().required({ agent_id: true }))
    .optional(),
});
export const WorkspaceMemberUpdateSchema = z.object({
  role: z.enum(["viewer", "member", "admin", "owner"]),
  scopes: z.array(z.string()),
});
export const MemoryProfileSchema = z.object({
  agent_id: z.string(),
  display_name: z.string(),
  role: z.enum(["admin", "agent"]),
  scopes: z.array(z.string()),
  workspace_ids: z.array(z.string()).nullable(),
});
// Product-owned contracts for the consolidated memory console.
export const SessionSchema = z.object({
  session_id: z.string(),
  owner_agent_id: z.string(),
  scope: z.enum(["private", "shared"]),
  title: nullableText,
  workspace_id: z.string(),
  metadata: jsonObject,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: nullableText,
});
export const SessionCreateSchema = z.object({
  session_id: z.string().min(1).optional(),
  title: nullableText.optional(),
  scope: z.enum(["private", "shared"]).optional(),
  workspace_id: z.string().min(1).optional(),
  metadata: jsonObject.optional(),
});
export const SessionUpdateSchema = SessionCreateSchema.omit({
  session_id: true,
  scope: true,
});
const webhookEvent = z.enum([
  "memory.created",
  "session.created",
  "queue.empty",
  "summary.updated",
  "peer_card.updated",
  "conflict.detected",
  "webhook.test",
]);
export const WebhookWriteSchema = z.object({
  url: z.string().url(),
  workspace_id: z.string().min(1),
  event_types: z.array(webhookEvent),
  enabled: z.boolean(),
  headers: z.record(z.string(), z.string()),
  metadata: jsonObject,
  secret: z.string().optional(),
});
export const WebhookSchema = WebhookWriteSchema.omit({ secret: true }).extend({
  id: z.string(),
  owner_agent_id: z.string(),
  has_secret: z.boolean(),
  last_status: z.enum(["queued", "delivered", "failed"]).nullable(),
  last_error: nullableText,
  last_delivered_at: nullableText,
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: nullableText,
});
export const WebhookTestSchema = z.object({
  workspace_id: z.string().min(1),
  event_type: webhookEvent,
  data: jsonObject,
});
export const WebhookTestResultSchema = z.object({
  event_id: z.string(),
  queued_deliveries: z.number().int().min(0),
  delivery_ids: z.array(z.string()),
});
export const WebhookDeliverySchema = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  owner_agent_id: z.string(),
  workspace_id: z.string(),
  event_id: z.string(),
  event_type: webhookEvent,
  nonce: z.string(),
  status: z.enum(["queued", "delivered", "failed"]),
  attempts: z.number().int().min(0),
  url: z.string(),
  response_status: z.number().nullable(),
  error: nullableText,
  created_at: z.string(),
  updated_at: z.string(),
  delivered_at: nullableText,
});
export const WebhookDeliveriesSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
});
export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  record_type: z.enum(["entity", "memory", "conclusion"]),
  metadata: jsonObject,
});
export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.string(),
  confidence: z.number(),
  valid_from: nullableText,
  valid_to: nullableText,
  observed_at: nullableText,
  superseded_by: nullableText,
  metadata: jsonObject,
});
export const GraphSchema = z.object({
  anchor_id: nullableText,
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
// Durable operation details evolve independently; the owning API validates their payloads.
export const MemoryOperationSchema = jsonObject;
export const ConflictResolveSchema = z.object({
  action: z.enum(["acknowledge", "dismiss"]),
});
export const ConsolidationRequestSchema = z.object({
  workspace_id: z.string().min(1),
  memory_ids: z.array(z.string().min(1)).max(256),
  strategy: z.string().min(1),
  operation_id: z.string().min(1),
  priority: z.number().optional(),
});
const browserSchemas = {
  ...memoryBrowserSchemas,
  ActorCredentialRequest: actorCredentialSchema,
  ActorCredentialResult: z.object({
    ok: z.boolean(),
    agent_id: z.string(),
    operation_id: z.string(),
    expires_at: z.string().nullable().optional(),
    token: z.string().optional(),
  }),
  Session: SessionSchema,
  SessionCreate: SessionCreateSchema,
  SessionUpdate: SessionUpdateSchema,
  Webhook: WebhookSchema,
  WebhookWrite: WebhookWriteSchema,
  WebhookTest: WebhookTestSchema,
  WebhookTestResult: WebhookTestResultSchema,
  WebhookDelivery: WebhookDeliverySchema,
  WebhookDeliveries: WebhookDeliveriesSchema,
  GraphNode: GraphNodeSchema,
  GraphEdge: GraphEdgeSchema,
  Graph: GraphSchema,
  MemoryOperation: MemoryOperationSchema,
  ConflictResolve: ConflictResolveSchema,
  ConsolidationRequest: ConsolidationRequestSchema,
  WorkspaceMember: WorkspaceMemberSchema,
  WorkspacePolicy: WorkspacePolicySchema,
  Workspace: WorkspaceSchema,
  WorkspaceUpdate: WorkspaceUpdateSchema,
  WorkspaceCreate: WorkspaceCreateSchema,
  WorkspaceMemberUpdate: WorkspaceMemberUpdateSchema,
  MemoryProfile: MemoryProfileSchema,
};
function browserOperation(
  summary: string,
  response: string,
  request?: string,
  status = "200",
) {
  return {
    summary,
    security: [{ bearerAuth: [] }],
    ...(request
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + request },
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: "Success",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/" + response },
          },
        },
      },
      "401": { description: "Authentication required" },
      "403": { description: "Permission or workspace membership required" },
      "409": { description: "Archived workspace IDs are reserved" },
    },
  };
}
function browserArrayOperation(summary: string, response: string) {
  return {
    ...browserOperation(summary, response),
    responses: {
      "200": {
        description: "Success",
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: { $ref: "#/components/schemas/" + response },
            },
          },
        },
      },
    },
  };
}
function operation(summary: string): Record<string, unknown> {
  return {
    summary,
    responses: {
      "200": {
        description: "Success",
      },
    },
  };
}

export function buildHiveMemOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "HiveMem TypeScript Core API",
      version: "1.0.0",
      description:
        "Core HiveMem REST surface. See HIVEMEM_API.md for the full reference.",
    },
    servers: [{ url: "http://127.0.0.1:18790" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: Object.fromEntries(
        Object.entries(browserSchemas).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema),
        ]),
      ),
    },
    paths: {
      "/v1/actor-credentials/{operationId}": {
        parameters: [
          {
            name: "operationId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        ],
        post: {
          ...browserOperation(
            "Durable agent credential operation; explicit admin:agents, workspace authorization and scope subset required; encrypted receipt replay expires after fifteen minutes",
            "ActorCredentialResult",
            "ActorCredentialRequest",
          ),
          responses: {
            ...browserOperation("Credential operation", "ActorCredentialResult")
              .responses,
            "410": {
              description:
                "Receipt acknowledged or expired; reconcile the original outcome",
            },
          },
        },
      },
      "/v1/actor-credentials/{operationId}/receipt": {
        parameters: [
          {
            name: "operationId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        ],
        delete: {
          ...operation(
            "Acknowledge exact credential receipt; owner and admin:agents required",
          ),
          security: [{ bearerAuth: [] }],
        },
      },
      "/v1/profile": {
        get: browserOperation(
          "Current product identity without bearer claims",
          "MemoryProfile",
        ),
      },
      "/v1/health": { get: operation("Health") },
      "/v1/health/live": { get: operation("Liveness") },
      "/v1/health/ready": { get: operation("Readiness") },
      "/v1/stats": { get: browserOperation("Read memory statistics", "MemoryStats") },
      "/v1/auth/login": { post: operation("Token compatibility login") },
      "/v1/memories": {
        post: browserOperation("Create memory", "MemoryRecord", "MemoryWrite", "201"),
      },
      "/v1/memories/browse": {
        get: { ...browserOperation("Browse readable memories with native query filters", "MemoryBrowseResponse"), parameters: [
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
          { name: "workspace_id", in: "query", schema: { type: "string" } },
          { name: "scope", in: "query", schema: { enum: ["private", "shared"] } },
        ] },
      },
      "/v1/memories/{id}": {
        get: browserOperation("Get memory", "MemoryRecord"),
        put: browserOperation("Update memory", "MemoryRecord", "MemoryUpdate"),
        delete: { summary: "Delete memory", security: [{ bearerAuth: [] }], responses: { "204": { description: "Deleted" } } },
      },
      "/v1/memories/search": { post: browserOperation("Search memories", "MemorySearchResponse", "MemorySearchRequest") },
      "/v1/memories/{id}/graph": { get: browserOperation("Read permitted memory graph", "Graph") },
      "/v1/memories/conflicts": {
        post: {
          ...browserOperation(
            "Read-only conflict detection requires memories:read; workspace access is enforced",
            "MemorySearchResponse", "MemoryConflictQuery",
          ),
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string", minLength: 1 },
                    workspace_id: { type: "string" },
                    scope: { enum: ["private", "shared"] },
                    type: { enum: ["episodic", "semantic", "procedural"] },
                    limit: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/sessions": {
        get: browserArrayOperation("List visible sessions", "Session"),
        post: browserOperation(
          "Create session; IDs remain reserved",
          "Session",
          "SessionCreate",
          "201",
        ),
      },
      "/v1/sessions/{sessionId}": {
        get: browserOperation("Get session", "Session"),
        put: browserOperation(
          "Update owned session",
          "Session",
          "SessionUpdate",
        ),
        delete: {
          ...operation("Archive owned session"),
          responses: { "204": { description: "Archived" } },
        },
      },
      "/v1/sessions/{sessionId}/memories": {
        get: browserArrayOperation("List readable session memories", "MemoryRecord"),
      },
      "/v1/sessions/{sessionId}/context": {
        post: browserOperation("Build context for a readable session", "SessionContextResult", "SessionContextRequest"),
      },
      "/v1/sessions/{sessionId}/chat": {
        post: browserOperation("Source-cited session chat; native clients may additionally request SSE", "SessionChatResult", "SessionChatRequest"),
      },
      "/v1/webhooks": {
        get: browserArrayOperation(
          "List permitted webhook endpoints",
          "Webhook",
        ),
        post: browserOperation(
          "Create webhook",
          "Webhook",
          "WebhookWrite",
          "201",
        ),
      },
      "/v1/webhooks/{webhookId}": {
        get: browserOperation("Get permitted webhook", "Webhook"),
        put: browserOperation("Update webhook", "Webhook", "WebhookWrite"),
        delete: browserOperation("Disable and archive webhook", "Webhook"),
      },
      "/v1/webhooks/test": {
        post: browserOperation(
          "Queue a workspace-wide test for all enabled owned endpoints",
          "WebhookTestResult",
          "WebhookTest",
          "202",
        ),
      },
      "/v1/webhooks/deliveries": {
        get: browserOperation(
          "List permitted webhook delivery history",
          "WebhookDeliveries",
        ),
      },
      "/v1/webhooks/deliveries/{deliveryId}": {
        get: browserOperation(
          "Get permitted webhook delivery",
          "WebhookDelivery",
        ),
      },
      "/v1/graph/entities": {
        get: browserArrayOperation("List readable entities", "GraphNode"),
      },
      "/v1/graph/relations": {
        get: browserArrayOperation("List readable relations", "GraphEdge"),
      },
      "/v1/graph/neighborhood": {
        get: browserOperation("Read bounded graph neighborhood", "Graph"),
      },
      "/v1/graph/entities/{entityId}": {
        get: browserOperation("Read entity evidence", "MemoryOperation"),
      },
      "/v1/conflicts": {
        get: browserOperation(
          "List readable unresolved conflicts",
          "MemoryOperation",
        ),
      },
      "/v1/conflicts/{memoryId}/resolve": {
        post: browserOperation(
          "Acknowledge or dismiss readable owned-memory conflicts",
          "MemoryOperation",
          "ConflictResolve",
        ),
      },
      "/v1/consolidation/status": {
        get: browserOperation(
          "Read workspace consolidation status",
          "MemoryOperation",
        ),
      },
      "/v1/consolidation/logs": {
        get: browserOperation(
          "Read workspace consolidation history",
          "MemoryOperation",
        ),
      },
      "/v1/consolidation/logs/{runId}": {
        get: browserOperation(
          "Read permitted consolidation result",
          "MemoryOperation",
        ),
      },
      "/v1/memories/consolidate": {
        post: browserOperation(
          "Enqueue a durable consolidation operation",
          "MemoryOperation",
          "ConsolidationRequest",
        ),
      },
      "/v1/queue/status": {
        get: browserOperation(
          "Read permitted queue status and jobs",
          "MemoryQueueStatus",
        ),
      },
      "/v1/queue/jobs/{id}": {
        get: browserOperation("Read permitted job detail", "MemoryQueueJob"),
        delete: browserOperation(
          "Cancel work before execution",
          "MemoryQueueJob",
        ),
      },
      "/v1/queue/jobs/{id}/retry": {
        post: browserOperation(
          "Retry failed work after inspection",
          "MemoryQueueJob",
        ),
      },
      "/v1/queue/run-next": {
        post: browserOperation("Run next pending job", "MemoryQueueJob"),
      },
      "/v1/context": { post: operation("Build context pack") },
      "/v1/queue/jobs": {
        get: operation("List queue jobs"),
        post: operation("Create queue job"),
      },
      "/v1/queue/jobs/{id}/run": { post: browserOperation("Run queue job", "MemoryQueueJob") },
      "/v1/queue/operations/{id}": {
        get: browserOperation("Get queue operation receipt", "MemoryQueueJob"),
      },
      "/v1/peers/{peerId}/conclusions": {
        get: operation("List peer conclusions (supports paginate and cursor)"),
      },
      "/v1/conclusions/{id}": {
        get: operation("Get conclusion (supports include_history)"),
        delete: operation("Delete conclusion"),
      },
      "/v1/agents": {
        get: browserArrayOperation("List agents", "MemoryAgent"),
        post: operation("Register agent"),
      },
      "/v1/workspaces": {
        get: {
          ...browserOperation(
            "List permitted workspaces, optionally including archived records",
            "Workspace",
          ),
          parameters: [
            {
              name: "include_deleted",
              in: "query",
              schema: { type: "boolean" },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0 },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
          ],
          responses: {
            "200": {
              description: "Permitted workspaces",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Workspace" },
                  },
                },
              },
            },
          },
        },
        post: browserOperation(
          "Create workspace; an archived ID cannot be reused",
          "Workspace",
          "WorkspaceCreate",
          "201",
        ),
      },
      "/v1/workspaces/{workspaceId}": {
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: browserOperation("Read workspace", "Workspace"),
        put: browserOperation(
          "Update workspace as owner or administrator",
          "Workspace",
          "WorkspaceUpdate",
        ),
        delete: {
          summary:
            "Archive workspace as owner; memories and membership are retained",
          responses: { "204": { description: "Archived" } },
        },
      },
      "/v1/workspaces/{workspaceId}/restore": {
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        post: browserOperation(
          "Restore archived workspace as owner without replacing its identity or membership",
          "Workspace",
        ),
      },
      "/v1/workspaces/{workspaceId}/members/{agentId}": {
        parameters: ["workspaceId", "agentId"].map((name) => ({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        put: browserOperation(
          "Update workspace membership",
          "Workspace",
          "WorkspaceMemberUpdate",
        ),
        delete: browserOperation(
          "Remove workspace member; the owner cannot be removed",
          "Workspace",
        ),
      },
      "/v1/workspaces/{workspaceId}/members": {
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: {
          summary: "List workspace members",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Workspace members",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/WorkspaceMember" },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/workspaces/{workspaceId}/settings": {
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: browserOperation(
          "Resolve workspace policy and optional agent/session overrides",
          "WorkspaceSettings",
        ),
      },
      "/v1/workspaces/{workspaceId}/schedule-dream": {
        parameters: [
          {
            name: "workspaceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        post: browserOperation("Schedule workspace consolidation", "DreamSchedule", undefined, "202"),
      },
      "/dashboard-data": { get: operation("Dashboard data") },
      "/dashboard/memories": { get: operation("Dashboard memory list") },
      "/dashboard/queue": { get: operation("Dashboard queue") },
      "/metrics": { get: operation("Prometheus metrics") },
    },
  };
}
