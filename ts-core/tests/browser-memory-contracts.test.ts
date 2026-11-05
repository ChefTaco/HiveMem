import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryHiveMemStore } from "../src/store.js";
import {
  MemoryRecordSchema, MemoryWriteSchema, MemoryUpdateSchema, MemorySearchResponseSchema,
  MemoryBrowseResponseSchema, MemoryQueueStatusSchema, MemoryQueueJobSchema, MemoryStatsSchema,
  MemoryAgentSchema, WorkspaceSettingsSchema, DreamScheduleSchema, SessionContextResultSchema, SessionChatResultSchema,
} from "../src/browser-memory-contracts.js";
import type { AuthPrincipal } from "../src/types.js";
const admin: AuthPrincipal = { agentId: "synthetic-owner", scopes: ["*"], rawClaims: { role: "admin" } };

test("owned browser contracts accept real store CRUD, pagination, retrieval, worker and workspace results", async () => {
  const store = new InMemoryHiveMemStore();
  store.registerAgent(admin, { agent_id: admin.agentId, display_name: "Synthetic operator" }, "obviously-fake-token");
  store.createWorkspace(admin, { workspace_id: "default" });
  const first = store.createMemory(admin, MemoryWriteSchema.parse({
    content: "First synthetic memory", type: "semantic", scope: "private", workspace_id: "default",
    tags: ["fixture"], metadata: { original: true }, confidence: 0, importance: 0,
  }));
  const second = store.createMemory(admin, { content: "Second synthetic memory", type: "semantic", scope: "private" });
  assert.equal(MemoryRecordSchema.parse(first).confidence, 0);
  assert.deepEqual(MemoryRecordSchema.parse(first).metadata, { original: true });
  const edited = store.updateMemory(admin, first.id, MemoryUpdateSchema.parse({ content: "Updated synthetic memory", tags: [] }));
  assert.equal(MemoryRecordSchema.parse(edited).content, "Updated synthetic memory");
  const page = MemoryBrowseResponseSchema.parse(store.browse(admin, new URLSearchParams({ offset: "1", limit: "1" })));
  assert.equal(page.offset, 1);
  assert.equal(page.memories.length, 1);
  const full = MemoryBrowseResponseSchema.parse(store.browse(admin, new URLSearchParams({ limit: "2" })));
  assert.notEqual(page.memories[0]!.id, full.memories[0]!.id);
  assert.equal(full.total, 2);
  MemorySearchResponseSchema.parse(store.search(admin, { query: "synthetic", workspace_id: "default" }, true));
  MemorySearchResponseSchema.parse(store.detectConflicts(admin, { content: "synthetic", workspace_id: "default" }));
  MemoryStatsSchema.parse(store.stats());
  store.listAgents(admin).forEach(value => MemoryAgentSchema.parse(value));
  MemoryQueueStatusSchema.parse(store.queueStatus(admin, new URLSearchParams()));
  WorkspaceSettingsSchema.parse(store.workspaceSettings(admin, "default", new URLSearchParams()));
  const scheduled = DreamScheduleSchema.parse(store.scheduleWorkspaceDream(admin, "default", {}));
  MemoryQueueJobSchema.parse(store.getQueueJob(admin, scheduled.job_id));
  MemoryQueueJobSchema.parse(store.cancelQueueJob(admin, scheduled.job_id));
  const session = store.createSession(admin, { session_id: "synthetic-session", workspace_id: "default" });
  SessionContextResultSchema.parse(store.context(admin, { search_query: "synthetic", workspace_id: "default" }, session.session_id));
  SessionChatResultSchema.parse(store.chat(admin, { query: "synthetic", workspace_id: "default" }, session.session_id));
  assert(store.getMemory(admin, second.id));
});

test("browser contract boundaries reject malformed data and strip undeclared top-level credentials", () => {
  const store = new InMemoryHiveMemStore();
  const memory = store.createMemory(admin, { content: "Synthetic", type: "semantic", scope: "private" });
  assert.throws(() => MemoryRecordSchema.parse({ ...memory, content: 42 }));
  assert.throws(() => MemorySearchResponseSchema.parse({ results: [memory], total_searched: 1, collections_searched: [] }));
  assert.throws(() => MemoryWriteSchema.parse({ content: " ", type: "semantic", scope: "private" }));
  assert.equal('signing_secret' in MemoryRecordSchema.parse({ ...memory, signing_secret: 'obviously-fake-secret' }), false);
  for (const content of ["", "  retained native content  "])
    assert.equal(MemoryRecordSchema.parse({ ...memory, content }).content, content);
  assert.deepEqual(MemoryUpdateSchema.parse({ content: "", tags: [], confidence: 0, metadata: {} }), { content: "", confidence: 0, tags: [], metadata: {} });
});
