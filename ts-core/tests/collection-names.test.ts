import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { agentIdFromCollectionName, isMemoryCollectionName, memoryCollectionName, privateCollectionName, privateCollectionNames, privateCollectionOwner } from "../src/collection-names.js";

/** What Qdrant 1.18.3 accepts as a collection name, plus the 197-byte ceiling of a collection snapshot. */
function qdrantCanStore(name: string): boolean {
  return name.length > 0 && !/[\u0000\u001f"*/:<>?\\|]/u.test(name) && Buffer.byteLength(name, "utf8") <= 197;
}

describe("memory collection names", () => {
  it("keeps the exact historical name for every agent ID Qdrant can store", () => {
    for (const id of ["table-runtime", "agent_a", "a1", "hive-router", "svc.router", "bot@host", "AgentX", "agentx", "agënt", "x".repeat(128)]) {
      assert.equal(privateCollectionOwner(id), id);
      for (const type of ["episodic", "semantic", "procedural"] as const) assert.equal(privateCollectionName(id, type), id + "_private_" + type);
    }
    assert.equal(memoryCollectionName({ scope: "shared", type: "semantic", agent_id: "svc:router" }), "shared_semantic");
    assert.equal(memoryCollectionName({ scope: "private", type: "episodic", agent_id: "table-runtime" }), "table-runtime_private_episodic");
  });

  it("gives an agent ID Qdrant refuses a deterministic name it can store", () => {
    const hash = createHash("sha256").update("svc:router").digest("hex").slice(0, 32);
    assert.equal(privateCollectionName("svc:router", "semantic"), "enc-svc-router-" + hash + "_private_semantic");
    assert.deepEqual(privateCollectionNames("svc:router"), ["episodic", "semantic", "procedural"].map((type) => "enc-svc-router-" + hash + "_private_" + type));
    for (const char of ['"', "*", "/", ":", "<", ">", "?", "\\", "|", "\u0000", "\u001f", "\n", "\u007f"]) {
      const name = privateCollectionName("a" + char + "b", "procedural");
      assert.match(name, /^enc-a-b-[0-9a-f]{32}_private_procedural$/u);
      assert.ok(qdrantCanStore(name));
    }
  });

  it("stays storable and distinct for long, colliding and malformed IDs", () => {
    const ids = ["svc:router", "svc/router", "SVC:router", "svc:Router", "svc::router", ":", "::", "a".repeat(179), "a".repeat(179) + "b", "a".repeat(5000), "記".repeat(60), "\ud800", "\udfff", "x".repeat(200) + ":y", "enc-svc-router-" + "0".repeat(32)];
    const names = ids.map((id) => privateCollectionName(id, "procedural"));
    for (const name of names) assert.ok(qdrantCanStore(name), name);
    assert.equal(new Set(names).size, ids.length);
    assert.doesNotThrow(() => encodeURIComponent(privateCollectionName("\ud800", "semantic")));
    // 178 bytes is the longest verbatim owner: its longest collection name is exactly the snapshot ceiling.
    assert.equal(privateCollectionOwner("a".repeat(178)), "a".repeat(178));
    assert.equal(Buffer.byteLength(privateCollectionName("a".repeat(178), "procedural")), 197);
    assert.match(privateCollectionOwner("記".repeat(60)), /^enc--[0-9a-f]{32}$/u);
  });

  it("never lets a verbatim ID take the name of an encoded one", () => {
    const encoded = privateCollectionOwner("svc:router");
    assert.notEqual(privateCollectionOwner(encoded), encoded);
    assert.match(privateCollectionOwner(encoded), /^enc-enc-svc-router-/u);
  });

  it("recognises both forms as memory collections and reads owners back only when exact", () => {
    assert.equal(isMemoryCollectionName("shared_semantic"), true);
    assert.equal(isMemoryCollectionName("table-runtime_private_episodic"), true);
    assert.equal(isMemoryCollectionName(privateCollectionName("svc:router", "semantic")), true);
    assert.equal(isMemoryCollectionName("_agents"), false);
    assert.equal(agentIdFromCollectionName("table-runtime_private_episodic"), "table-runtime");
    assert.equal(agentIdFromCollectionName("shared_procedural"), "shared");
    assert.equal(agentIdFromCollectionName(privateCollectionName("svc:router", "semantic")), "unknown");
    assert.equal(agentIdFromCollectionName("_private_semantic"), "unknown");
  });
});
