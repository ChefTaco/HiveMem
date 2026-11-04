// Public API baseline extracted from Hive; complete schema coverage remains pending.
import { z } from "zod";

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
const browserSchemas = {
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
      "/v1/profile": {
        get: browserOperation(
          "Current product identity without bearer claims",
          "MemoryProfile",
        ),
      },
      "/v1/health": { get: operation("Health") },
      "/v1/health/live": { get: operation("Liveness") },
      "/v1/health/ready": { get: operation("Readiness") },
      "/v1/auth/login": { post: operation("Token compatibility login") },
      "/v1/memories": {
        get: operation("List memories"),
        post: operation("Create memory"),
      },
      "/v1/memories/{id}": {
        get: operation("Get memory"),
        patch: operation("Update memory"),
        delete: operation("Delete memory"),
      },
      "/v1/memories/search": { post: operation("Search memories") },
      "/v1/context": { post: operation("Build context pack") },
      "/v1/queue/jobs": {
        get: operation("List queue jobs"),
        post: operation("Create queue job"),
      },
      "/v1/queue/jobs/{id}/run": { post: operation("Run queue job") },
      "/v1/queue/operations/{id}": {
        get: operation("Get queue operation receipt"),
      },
      "/v1/peers/{peerId}/conclusions": {
        get: operation("List peer conclusions (supports paginate and cursor)"),
      },
      "/v1/conclusions/{id}": {
        get: operation("Get conclusion (supports include_history)"),
        delete: operation("Delete conclusion"),
      },
      "/v1/agents": {
        get: operation("List agents"),
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
        get: operation(
          "Resolve workspace policy and optional agent/session overrides",
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
        post: operation("Schedule workspace consolidation"),
      },
      "/dashboard-data": { get: operation("Dashboard data") },
      "/dashboard/memories": { get: operation("Dashboard memory list") },
      "/dashboard/queue": { get: operation("Dashboard queue") },
      "/metrics": { get: operation("Prometheus metrics") },
    },
  };
}
