import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REVOCATION_RETAIN_AFTER_EXPIRY_SEC, TokenRevocationStore } from "../src/revocation-store.js";

describe("TokenRevocationStore", () => {
  it("persists active revocations across instances without exposing permissive file modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemem-revocations-"));
    const path = join(directory, "revoked.json");
    try {
      new TokenRevocationStore(path).add("persisted-jti", Math.floor(Date.now() / 1000) + 3600);
      assert.equal(new TokenRevocationStore(path).has("persisted-jti"), true);
      assert.match(await readFile(path, "utf8"), /persisted-jti/);
      const mode = (await import("node:fs/promises").then(({ stat }) => stat(path))).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a revocation through the clock tolerance after its token expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemem-revocations-"));
    const path = join(directory, "revoked.json");
    const now = Math.floor(Date.now() / 1000);
    try {
      const store = new TokenRevocationStore(path);
      store.add("just-expired-jti", now - 5);
      store.add("long-expired-jti", now - REVOCATION_RETAIN_AFTER_EXPIRY_SEC - 5);
      assert.equal(store.has("just-expired-jti"), true, "a token inside the tolerance window stays revoked");
      assert.equal(store.has("long-expired-jti"), false);
      assert.equal(new TokenRevocationStore(path).has("just-expired-jti"), true);
      assert.doesNotMatch(await readFile(path, "utf8"), /long-expired-jti/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
