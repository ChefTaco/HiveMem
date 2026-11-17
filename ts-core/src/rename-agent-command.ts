import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyAgentRename, assertRenameIds, planAgentRename, type AgentRenameCounts, type AgentRenamePlan } from "./agent-rename.js";
import { privateCollectionNames } from "./collection-names.js";
import { probeQdrant, redactUrl, resolveConfig } from "./config.js";
import { QdrantHiveMemPersistence, type HiveMemSnapshot } from "./persistence.js";
import { acquireWriterLock } from "./writer-lock.js";

/**
 * `hivemem-server rename-agent --from OLD --to NEW`: re-owns everything an agent ID owns.
 *
 *   (default)   apply: needs the writer lock (HiveMem stopped), finishes any interrupted
 *               write first, saves through the journaled Qdrant save, drops the old ID's
 *               emptied private collections, updates semantic shadow collections, verifies
 *   --dry-run   read-only plan with counts; safe while HiveMem runs
 *   --verify    read-only check: exit 0 when nothing names OLD any more, 2 while a rename
 *               is pending; safe while HiveMem runs
 *
 * Exit codes: 0 done, 1 error, 2 pending (--verify), 3 the target already owns data and
 * --allow-existing-target was not given (nothing was written).
 */

export type RenameAgentMode = "apply" | "dry-run" | "verify";

export interface RenameAgentOptions {
  from: string;
  to: string;
  mode: RenameAgentMode;
  allowExistingTarget: boolean;
  json: boolean;
}

export class RenameAgentError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

const SHADOW_PREFIX = "hivemem_shadow_";

interface CollectionState { name: string; points: number }

interface Report {
  command: "rename-agent";
  mode: RenameAgentMode;
  from: string;
  to: string;
  status: "nothing-to-do" | "already-renamed" | "pending" | "conflict" | "renamed" | "would-rename";
  plan: Omit<AgentRenamePlan, "from" | "to">;
  sourceCollections: CollectionState[];
  targetCollections: CollectionState[];
  shadowPayloadsUpdated?: Record<string, number>;
  verified?: boolean;
  warnings: string[];
}

async function collectionStates(persistence: QdrantHiveMemPersistence, names: readonly string[], existing: ReadonlySet<string>): Promise<CollectionState[]> {
  const states: CollectionState[] = [];
  for (const name of names) if (existing.has(name)) states.push({ name, points: await persistence.pointCount(name) });
  return states;
}

function summary(counts: AgentRenameCounts): string {
  const parts = Object.entries(counts).filter(([, value]) => value > 0).map(([area, value]) => `${area} ${value}`);
  return parts.length ? parts.join(", ") : "none";
}

function privateMemoryCount(snapshot: HiveMemSnapshot, agentId: string): number {
  return snapshot.memories.filter((memory) => memory.agent_id === agentId && memory.scope === "private").length;
}

/** The plan plus what Qdrant holds for both IDs. Leftover emptied collections keep a rename pending. */
async function inspect(persistence: QdrantHiveMemPersistence, snapshot: HiveMemSnapshot, from: string, to: string) {
  const plan = planAgentRename(snapshot, from, to);
  const existing = new Set(await persistence.collectionNames());
  const sourceCollections = await collectionStates(persistence, privateCollectionNames(from), existing);
  const targetCollections = await collectionStates(persistence, privateCollectionNames(to), existing);
  const warnings: string[] = [];
  // Points HiveMem cannot read (no content) never load, so they never move. They are kept.
  const unreadable = sourceCollections.reduce((sum, state) => sum + state.points, 0) - privateMemoryCount(snapshot, from);
  if (plan.done && unreadable > 0) warnings.push(`${unreadable} unreadable point(s) remain in ${sourceCollections.filter((state) => state.points > 0).map((state) => state.name).join(", ")}; they were kept`);
  const cleanupPending = sourceCollections.some((state) => state.points === 0);
  return { plan, existing, sourceCollections, targetCollections, warnings, cleanupPending };
}

function render(report: Report, json: boolean): void {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const { plan } = report;
  console.log(`rename-agent ${report.from} -> ${report.to} (${report.mode}): ${report.status}`);
  console.log(`  records naming ${report.from}: ${summary(plan.source)}`);
  console.log(`  records ${report.to} already owns: ${summary(plan.target)}${plan.targetAgentExists ? " (agent record exists" + (plan.targetAgentDisabled ? ", disabled)" : ")") : ""}`);
  if (report.sourceCollections.length) console.log(`  ${report.from} private collections: ${report.sourceCollections.map((state) => `${state.name} (${state.points})`).join(", ")}`);
  if (report.targetCollections.length) console.log(`  ${report.to} private collections: ${report.targetCollections.map((state) => `${state.name} (${state.points})`).join(", ")}`);
  if (report.shadowPayloadsUpdated && Object.keys(report.shadowPayloadsUpdated).length) console.log(`  semantic shadow points re-owned: ${Object.entries(report.shadowPayloadsUpdated).map(([name, count]) => `${name} ${count}`).join(", ")}`);
  if (report.verified !== undefined) console.log(`  verified: ${report.verified ? "yes" : "no"}`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
}

function stripIds(plan: AgentRenamePlan): Report["plan"] {
  const { from: _from, to: _to, ...rest } = plan;
  return rest;
}

export async function runRenameAgent(options: RenameAgentOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  assertRenameIds(options.from, options.to);
  const { from, to, mode } = options;
  const { config } = resolveConfig(env);
  if (config.persistence !== "qdrant") throw new RenameAgentError("rename-agent works on Qdrant persistence; HIVEMEM_TS_PERSISTENCE=memory keeps no data to rename");
  const probe = await probeQdrant(config.qdrantUrl, config.qdrantApiKey);
  if (!probe.ok) throw new RenameAgentError(probe.detail);
  const connection = { url: config.qdrantUrl, ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}) };
  const journalPath = join(config.storagePath, "pending-write.json");

  if (mode !== "apply") {
    // Read-only: no lock, and an interrupted write's journal is left for its owner to finish.
    const persistence = new QdrantHiveMemPersistence(connection);
    const snapshot = await loadSnapshot(persistence, config.qdrantUrl);
    const state = await inspect(persistence, snapshot, from, to);
    if (existsSync(journalPath)) state.warnings.push("an interrupted HiveMem write is journaled; it completes when HiveMem or rename-agent next starts");
    const pending = !state.plan.done || state.cleanupPending;
    const status: Report["status"] = !pending ? (state.plan.tombstoned ? "already-renamed" : "nothing-to-do") : state.plan.conflict && !options.allowExistingTarget ? "conflict" : mode === "dry-run" ? "would-rename" : "pending";
    render({ command: "rename-agent", mode, from, to, status, plan: stripIds(state.plan), sourceCollections: state.sourceCollections, targetCollections: state.targetCollections, warnings: state.warnings }, options.json);
    if (mode === "verify") return pending ? 2 : 0;
    return status === "conflict" ? 3 : 0;
  }

  try {
    mkdirSync(config.storagePath, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new RenameAgentError(`cannot create storage directory ${config.storagePath} (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let release: () => void;
  try {
    release = await acquireWriterLock(join(config.storagePath, "writer.lock"));
  } catch (error) {
    throw new RenameAgentError(`${(error as Error).message}: stop HiveMem before renaming an agent (--dry-run and --verify are read-only and work while it runs)`);
  }
  try {
    // With the journal: an interrupted write (HiveMem's or an earlier rename's) completes first.
    const persistence = new QdrantHiveMemPersistence({ ...connection, journalPath });
    const snapshot = await loadSnapshot(persistence, config.qdrantUrl);
    const before = await inspect(persistence, snapshot, from, to);
    if (before.plan.conflict && !options.allowExistingTarget) {
      render({ command: "rename-agent", mode, from, to, status: "conflict", plan: stripIds(before.plan), sourceCollections: before.sourceCollections, targetCollections: before.targetCollections, warnings: [...before.warnings, `${to} already owns data${before.plan.targetAgentDisabled ? " or is disabled" : ""}; nothing was written. Merge both owners with --allow-existing-target`] }, options.json);
      return 3;
    }
    const warnings = [...before.warnings];
    if (!before.plan.done) {
      const { snapshot: renamed } = applyAgentRename(snapshot, from, to, new Date().toISOString());
      await persistence.save(renamed);
    }
    // The save moved every readable private memory; the emptied collections go.
    for (const name of privateCollectionNames(from)) {
      if (!(await persistence.collectionNames()).includes(name)) continue;
      if (await persistence.pointCount(name) === 0) await persistence.deleteCollection(name);
    }
    const shadowPayloadsUpdated: Record<string, number> = {};
    for (const name of (await persistence.collectionNames()).filter((collection) => collection.startsWith(SHADOW_PREFIX))) {
      const updated = await persistence.replacePayloadValue(name, "agent_id", from, to);
      if (updated > 0) shadowPayloadsUpdated[name] = updated;
    }

    // Verify from a fresh read of Qdrant, not from what was written.
    const reader = new QdrantHiveMemPersistence(connection);
    const afterSnapshot = await loadSnapshot(reader, config.qdrantUrl);
    const after = await inspect(reader, afterSnapshot, from, to);
    const problems: string[] = [];
    if (!after.plan.done) problems.push(`records still name ${from}: ${summary(after.plan.source)}`);
    if (after.cleanupPending) problems.push(`emptied collections of ${from} remain`);
    for (const area of ["memories", "sessions", "webhooks", "webhookDeliveries"] as const) {
      const expected = before.plan.target[area] + before.plan.source[area];
      if (after.plan.target[area] !== expected) problems.push(`${to} owns ${after.plan.target[area]} ${area}, expected ${expected}`);
    }
    const stored = after.targetCollections.reduce((sum, state) => sum + state.points, 0);
    const loadedPrivate = privateMemoryCount(afterSnapshot, to);
    if (stored < loadedPrivate) problems.push(`${to} private collections hold ${stored} points for ${loadedPrivate} private memories`);
    for (const name of Object.keys(shadowPayloadsUpdated)) {
      const left = await reader.pointCount(name, { must: [{ key: "agent_id", match: { value: from } }] });
      if (left > 0) problems.push(`${left} shadow point(s) in ${name} still name ${from}`);
    }
    const report: Report = { command: "rename-agent", mode, from, to, status: before.plan.done ? (before.plan.tombstoned ? "already-renamed" : "nothing-to-do") : "renamed", plan: stripIds(before.plan), sourceCollections: after.sourceCollections, targetCollections: after.targetCollections, shadowPayloadsUpdated, verified: problems.length === 0, warnings: [...warnings, ...after.warnings.filter((warning) => !warnings.includes(warning)), ...problems] };
    render(report, options.json);
    if (problems.length) throw new RenameAgentError(`verification failed: ${problems.join("; ")}. The journaled write is complete; rerun rename-agent to retry the remaining steps`);
    return 0;
  } finally {
    release();
  }
}

async function loadSnapshot(persistence: QdrantHiveMemPersistence, url: string): Promise<HiveMemSnapshot> {
  try {
    return await persistence.load();
  } catch (error) {
    throw new RenameAgentError(`cannot load data from Qdrant at ${redactUrl(url)}: ${(error as Error).message}`);
  }
}
