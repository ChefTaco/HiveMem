// Public API baseline extracted from Hive; complete schema coverage remains pending.
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
    paths: {
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
        get: operation("List workspaces"),
        post: operation("Create workspace"),
      },
      "/dashboard-data": { get: operation("Dashboard data") },
      "/dashboard/memories": { get: operation("Dashboard memory list") },
      "/dashboard/queue": { get: operation("Dashboard queue") },
      "/metrics": { get: operation("Prometheus metrics") },
    },
  };
}
