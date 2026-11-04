import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountLinks, linkedLocalId, linkedAccount } from "../src/account-links.js";
test("product account links preserve exact IDs without email or cross-issuer matching", () => {
  const identity = {
    issuer: "https://identity.example.com",
    subject: "fake-user",
  };
  const row = { ...identity, localId: "existing-product-id" };
  const links = parseAccountLinks(JSON.stringify([row]));
  assert.equal(linkedLocalId(links, identity), "existing-product-id");
  assert.throws(() =>
    linkedLocalId(links, { ...identity, subject: "other-user" }),
  );
  assert.throws(() =>
    linkedLocalId(links, { ...identity, issuer: "https://other.example.com" }),
  );
  assert.throws(() => linkedLocalId([], identity));
  assert.throws(() =>
    parseAccountLinks(JSON.stringify([row, { ...row, localId: "another-id" }])),
  );
  assert.throws(() =>
    parseAccountLinks(JSON.stringify([{ ...row, email: "alice@example.com" }])),
  );
  assert.equal(linkedAccount(parseAccountLinks(JSON.stringify([{...row,credentialGeneration:7}])),identity).credentialGeneration,7);
  for (const credentialGeneration of [-1, 0.5, '7', null]) {
    assert.throws(()=>parseAccountLinks(JSON.stringify([{...row,credentialGeneration}])));
  }
});
