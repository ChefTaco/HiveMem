import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyAgentRename, planAgentRename, queueOperationReceiptKey } from "../src/agent-rename.js";
import { toHiveAuditRecord } from "../src/audit-export.js";
import { InMemoryHiveMemStore } from "../src/store.js";
import type { AuthPrincipal } from "../src/types.js";

const OLD = "hive-router";
const NEW = "emberpath";
const NOW = "2026-11-17T12:00:00.000Z";

// The old static fallback token: an admin token for the subject.
const admin = (agentId: string): AuthPrincipal => ({ agentId, scopes: ["admin:all"], rawClaims: { sub: agentId, role: "admin", scope: "admin:all" } });
const agent = (agentId: string): AuthPrincipal => ({ agentId, scopes: ["*"], rawClaims: { sub: agentId } });

/** A store where OLD owns one of everything, and another agent endorses and works alongside. */
function populated() {
  const store = new InMemoryHiveMemStore();
  const router = admin(OLD), other = agent("hermes");
  store.createWorkspace(router, { workspace_id: "ops", title: "Ops", policy: { agent_overrides: { [OLD]: { reasoning_provider: "none" } } } });
  const privateMemory = store.createMemory(router, { content: "router private note", type: "semantic", scope: "private", workspace_id: "default" });
  const sharedMemory = store.createMemory(router, { content: "router shared note", type: "episodic", scope: "shared", workspace_id: "default" });
  const procedural = store.createMemory(router, { content: "router procedure", type: "procedural", scope: "private", workspace_id: "default" });
  const othersMemory = store.createMemory(other, { content: "hermes shared fact", type: "semantic", scope: "shared", workspace_id: "default" });
  store.endorseMemory(router, othersMemory.id, { endorse: true });
  const session = store.createSession(router, { title: "router session", scope: "private" });
  const episode = store.createEpisode(router, { title: "router episode", peer_id: OLD });
  store.appendEpisodeMessage(router, episode.episode_id, { role: "assistant", content: "hello", speaker_id: OLD });
  const conclusion = store.createConclusion(router, "user-1", { content: "user prefers short answers", workspace_id: "default" });
  const webhook = store.createWebhook(router, { url: "https://hooks.example.com/hivemem", event_types: ["memory.created"] });
  return { store, privateMemory, sharedMemory, procedural, othersMemory, session, episode, conclusion, webhook };
}

describe("agent rename (snapshot)", () => {
  it("plans with counts and moves every owned record to the new ID", () => {
    const { store, privateMemory, sharedMemory, procedural, othersMemory, session, episode, conclusion, webhook } = populated();
    const snapshot = structuredClone(store.snapshot());
    const plan = planAgentRename(snapshot, OLD, NEW);
    assert.equal(plan.done, false);
    assert.equal(plan.conflict, false);
    assert.equal(plan.source.memories, 3);
    assert.equal(plan.source.endorsements, 1);
    assert.equal(plan.source.sessions, 1);
    assert.equal(plan.source.episodes, 1);
    assert.equal(plan.source.messages, 1);
    assert.equal(plan.source.webhooks, 1);
    assert.ok(plan.source.conclusions >= 1);
    assert.ok(plan.source.workspaces >= 1);
    assert.equal(plan.source.agents, 1);

    const { snapshot: renamed, changed } = applyAgentRename(snapshot, OLD, NEW, NOW);
    assert.equal(changed.memories, 3);
    const after = planAgentRename(renamed, OLD, NEW);
    assert.equal(after.done, true, JSON.stringify(after.source));
    assert.equal(after.tombstoned, true);
    assert.equal(after.target.memories, 3);
    // Nothing else names the old ID, except its tombstone and the audit history.
    const remaining = JSON.stringify({ ...renamed, agents: renamed.agents.filter((record) => record.agent_id !== OLD).map(({ metadata: { renamed_from: _from, ...metadata }, ...record }) => ({ ...record, metadata })), operations: (renamed.operations ?? []).filter((operation) => operation.kind === "queue-operation" || operation.kind === "scheduler-cursor") });
    assert.equal(remaining.includes(`"${OLD}"`), false, "no record outside audit history names the old ID");
    assert.equal(snapshot.memories.find((memory) => memory.id === privateMemory.id)?.agent_id, OLD, "the input snapshot is not mutated");

    // The renamed principal can do everything the old one could; the old one is refused.
    const reloaded = new InMemoryHiveMemStore({ snapshot: renamed });
    const ember = admin(NEW);
    reloaded.assertCredentialActive(ember);
    assert.throws(() => reloaded.assertCredentialActive(admin(OLD)), /disabled/);
    assert.equal(reloaded.updateMemory(ember, privateMemory.id, { content: "edited by emberpath" }).content, "edited by emberpath");
    assert.equal(reloaded.updateMemory(ember, sharedMemory.id, { importance: 0.9 }).importance, 0.9);
    reloaded.deleteMemory(ember, procedural.id);
    assert.deepEqual(reloaded.listSessions(agent(NEW), new URLSearchParams()).map((entry) => entry.session_id), [session.session_id]);
    assert.equal(reloaded.getEpisode(ember, episode.episode_id).messages.length, 1);
    assert.equal(reloaded.getConclusion(agent(NEW), conclusion.id).owner_agent_id, NEW);
    assert.equal(reloaded.listWebhooks(agent(NEW), new URLSearchParams()).some((entry) => entry.id === webhook.id), true);
    const endorsed = renamed.memories.find((memory) => memory.id === othersMemory.id)!;
    assert.deepEqual(endorsed.endorsed_by, [NEW]);
    const workspace = renamed.workspaces.find((entry) => entry.workspace_id === "ops")!;
    assert.equal(workspace.owner_agent_id, NEW);
    assert.equal(workspace.members.some((member) => member.agent_id === NEW), true);
    assert.deepEqual(Object.keys(workspace.policy.agent_overrides), [NEW]);

    const record = (renamed.operations ?? []).find((operation) => operation.kind === "agent.rename")!;
    const audit = toHiveAuditRecord(record);
    assert.equal(audit?.action, "agent.rename");
    assert.equal(audit?.target?.id, NEW);
    assert.equal(audit?.details.renamed_from, OLD);
  });

  it("is idempotent: a second plan finds nothing to do and a reapply changes nothing", () => {
    const { store } = populated();
    const first = applyAgentRename(structuredClone(store.snapshot()), OLD, NEW, NOW).snapshot;
    assert.equal(planAgentRename(first, OLD, NEW).done, true);
    const second = applyAgentRename(first, OLD, NEW, NOW);
    assert.equal(Object.values(second.changed).reduce((sum, value) => sum + value, 0), 0);
    assert.deepEqual(second.snapshot.agents, first.agents);
  });

  it("finds nothing to do on an installation that never had the old ID", () => {
    const store = new InMemoryHiveMemStore();
    store.createMemory(agent(NEW), { content: "fresh install memory", type: "semantic", scope: "private" });
    const plan = planAgentRename(store.snapshot(), OLD, NEW);
    assert.equal(plan.done, true);
    assert.equal(plan.tombstoned, false);
    assert.equal(plan.conflict, false);
  });

  it("refuses a target that owns data or is disabled, and accepts a bare agent record", () => {
    const { store } = populated();
    store.authPrincipal(agent(NEW));
    assert.equal(planAgentRename(store.snapshot(), OLD, NEW).conflict, false, "an agent record alone is not data");
    store.createMemory(agent(NEW), { content: "already here", type: "semantic", scope: "private" });
    const plan = planAgentRename(store.snapshot(), OLD, NEW);
    assert.equal(plan.conflict, true);
    assert.equal(plan.target.memories, 1);
    // With approval, both owners merge.
    const merged = applyAgentRename(structuredClone(store.snapshot()), OLD, NEW, NOW).snapshot;
    assert.equal(planAgentRename(merged, OLD, NEW).target.memories, 4);

    const disabled = populated().store;
    disabled.authPrincipal(agent(NEW));
    disabled.updateAgent(admin("root"), NEW, { active: false });
    assert.equal(planAgentRename(disabled.snapshot(), OLD, NEW).conflict, true);
  });

  it("carries the credential state and disables every earlier token of the old ID", () => {
    const { store } = populated();
    const generation = store.rotateAgentCredentials(admin("root"), OLD);
    const renamed = applyAgentRename(structuredClone(store.snapshot()), OLD, NEW, NOW).snapshot;
    const moved = renamed.agents.find((record) => record.agent_id === NEW)!;
    const tombstone = renamed.agents.find((record) => record.agent_id === OLD)!;
    assert.equal(moved.metadata.token_generation, generation);
    assert.equal(tombstone.active, false);
    assert.equal(tombstone.metadata.renamed_to, NEW);
    assert.equal(tombstone.metadata.token_generation, generation + 1);
  });

  it("rekeys queue receipts and scheduler cursors so replays and watermarks still match", () => {
    const { store } = populated();
    const snapshot = structuredClone(store.snapshot());
    const job = { id: "job-1", task_type: "consolidation" as const, status: "pending" as const, work_unit_key: `${OLD}:default`, payload: {}, owner_agent_id: OLD, workspace_id: "default", session_id: null, peer_id: null, observer_peer_id: null, observed_peer_id: null, idempotency_key: `scheduled:${OLD}:default:0:x`, priority: 0, retry_count: 0, created_at: NOW, not_before: null, started_at: null, finished_at: null, locked_at: null, error: null, result: null };
    snapshot.queueJobs.push(job);
    const key = queueOperationReceiptKey(OLD, "default", "consolidation", "op-1");
    snapshot.operations = [...(snapshot.operations ?? []),
      { id: key, kind: "queue-operation", operation_id: "op-1", actor: OLD, workspace_id: "default", task_type: "consolidation", payload_hash: "x", job_id: "job-1", created_at: NOW, job: job as never },
      { id: `scheduler:${OLD}:default`, kind: "scheduler-cursor", watermark: "w" },
      { id: "run:job-0", kind: "consolidation-run", run_id: "job-0", actor: OLD, workspace_id: "default", status: "completed", created_at: NOW, finished_at: NOW },
      { id: "api-1", kind: "api.mutation", actor: OLD, actor_type: "agent", method: "POST", path: "/v1/memories", created_at: NOW },
    ];
    const renamed = applyAgentRename(snapshot, OLD, NEW, NOW).snapshot;
    const jobAfter = renamed.queueJobs.find((entry) => entry.id === "job-1")!;
    assert.equal(jobAfter.owner_agent_id, NEW);
    assert.equal(jobAfter.work_unit_key, `${NEW}:default`);
    assert.equal(jobAfter.idempotency_key, `scheduled:${NEW}:default:0:x`);
    const operations = new Map((renamed.operations ?? []).map((operation) => [String(operation.id), operation]));
    assert.equal(operations.has(key), false);
    assert.equal(operations.get(queueOperationReceiptKey(NEW, "default", "consolidation", "op-1"))?.actor, NEW);
    assert.equal(operations.get(`scheduler:${NEW}:default`)?.watermark, "w");
    assert.equal(operations.get("run:job-0")?.actor, NEW);
    assert.equal(operations.get("api-1")?.actor, OLD, "audit history keeps the ID that acted");
  });

  it("rejects unusable IDs", () => {
    const { store } = populated();
    assert.throws(() => planAgentRename(store.snapshot(), OLD, OLD), /must differ/);
    assert.throws(() => planAgentRename(store.snapshot(), OLD, "shared"), /reserved/);
    assert.throws(() => planAgentRename(store.snapshot(), "", NEW), /--from must be an agent ID/);
  });
});

describe("rename-agent command line", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });

  it("is documented in --help", () => {
    const result = run(["rename-agent", "--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /rename-agent --env-file hivemem.env --from old-subject --to new-subject --dry-run/);
  });

  it("needs both IDs, one mode and Qdrant persistence", () => {
    assert.match(run(["rename-agent", "--from", OLD]).stderr, /needs --from <id> and --to <id>/);
    assert.match(run(["rename-agent", "--from", OLD, "--to", NEW, "--dry-run", "--verify"]).stderr, /choose one of --dry-run and --verify/);
    assert.match(run(["rename-agent", "--from", OLD, "--to", NEW, "--bogus"]).stderr, /unknown rename-agent argument --bogus/);
    const memory = run(["rename-agent", "--from", OLD, "--to", NEW], { HIVEMEM_TS_PERSISTENCE: "memory" });
    assert.equal(memory.status, 1);
    assert.match(memory.stderr, /works on Qdrant persistence/);
  });
});
