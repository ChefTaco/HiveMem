import { createHash } from "node:crypto";
import type { MemoryRecord } from "./types.js";

/**
 * The one place Qdrant memory collection names are built and read back.
 *
 * Shared memories live in `shared_<type>`. Private memories live in
 * `<owner>_private_<type>`, where `<owner>` is the agent ID itself whenever
 * Qdrant can store it, so collections of existing installations keep their
 * names. Agent IDs Qdrant cannot store (a subject such as `svc:router` is a
 * valid token subject, but `:` is refused in a collection name) get a
 * deterministic owner segment instead: `enc-<readable slug>-<sha256 prefix>`.
 * The agent ID itself is always carried in each point's payload, so the
 * segment never has to be decoded.
 */

type MemoryType = MemoryRecord["type"];

export const sharedMemoryCollections = ["shared_episodic", "shared_semantic", "shared_procedural"] as const;

const PRIVATE_SUFFIX = /_private_(episodic|semantic|procedural)$/u;

/**
 * Qdrant refuses these in a collection name (verified against 1.18.3: `" * / : < > ? \ |`, NUL and
 * U+001F). The other control characters are encoded as well, as a precaution.
 */
const UNSTORABLE = /[\u0000-\u001f\u007f"*/:<>?\\|]/u;

/**
 * Longest agent ID, in UTF-8 bytes, stored verbatim. Qdrant creates collections up to 255
 * bytes, but a collection snapshot (the backup path) fails above 197 bytes because the
 * snapshot file name adds to it. 178 leaves room for the longest suffix, `_private_procedural`.
 */
const MAX_VERBATIM_OWNER_BYTES = 178;

/** Shape of an encoded owner segment. A verbatim ID of this shape is encoded too, so the two forms never meet. */
const ENCODED_OWNER = /^enc-[a-z0-9._-]*-[0-9a-f]{32}$/u;
const SLUG_LENGTH = 40;

/** False for a string with a lone surrogate, which has no UTF-8 form and cannot be put in a request path. */
function wellFormed(value: string): boolean {
  try { encodeURIComponent(value); return true; } catch { return false; }
}

function storableVerbatim(agentId: string): boolean {
  return agentId.length > 0 && !UNSTORABLE.test(agentId) && !ENCODED_OWNER.test(agentId) && wellFormed(agentId) && Buffer.byteLength(agentId, "utf8") <= MAX_VERBATIM_OWNER_BYTES;
}

/** The `<owner>` segment of an agent's private collections. */
export function privateCollectionOwner(agentId: string): string {
  if (storableVerbatim(agentId)) return agentId;
  // The slug is only a hint for someone reading a collection list. Uniqueness comes from the
  // hash of the exact ID, which also keeps IDs that differ only by case apart.
  const slug = agentId.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").slice(0, SLUG_LENGTH).replace(/^-+|-+$/gu, "");
  // sha256 of the ID's UTF-8 bytes; an ill-formed string is hashed in its JSON-escaped form.
  const hashed = wellFormed(agentId) ? agentId : JSON.stringify(agentId);
  return "enc-" + slug + "-" + createHash("sha256").update(hashed, "utf8").digest("hex").slice(0, 32);
}

export function privateCollectionName(agentId: string, type: MemoryType): string {
  return privateCollectionOwner(agentId) + "_private_" + type;
}

export function privateCollectionNames(agentId: string): string[] {
  const owner = privateCollectionOwner(agentId);
  return [owner + "_private_episodic", owner + "_private_semantic", owner + "_private_procedural"];
}

export function memoryCollectionName(memory: Pick<MemoryRecord, "scope" | "type" | "agent_id">): string {
  return memory.scope === "shared" ? "shared_" + memory.type : privateCollectionName(memory.agent_id, memory.type);
}

export function isMemoryCollectionName(collection: string): boolean {
  return (sharedMemoryCollections as readonly string[]).includes(collection) || PRIVATE_SUFFIX.test(collection);
}

/**
 * Owner of a collection, for legacy points whose payload carries no `agent_id`. An encoded
 * owner segment cannot be turned back into an ID; every point HiveMem writes there has one.
 */
export function agentIdFromCollectionName(collection: string): string {
  if (collection.startsWith("shared_")) return "shared";
  const owner = collection.replace(PRIVATE_SUFFIX, "");
  return owner && !ENCODED_OWNER.test(owner) ? owner : "unknown";
}
