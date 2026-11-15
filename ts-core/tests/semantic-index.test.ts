import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticConfig, SemanticIndex } from '../src/semantic-index.js';
test('requires explicit model identity and refuses malformed embedding vectors', async () => {
  assert.equal(semanticConfig({}), null);
  assert.throws(() => semanticConfig({ HIVEMEM_EMBEDDING_ENDPOINT: 'http://localhost:1' }), /Explicit/);
  const config = { endpoint: 'http://localhost/embeddings', model: 'fixture', revision: '1', dimensions: 2, collection: 'hivemem_shadow_fixture', qdrantUrl: 'http://localhost:6333' };
  const wrong = new SemanticIndex(config, async () => Response.json({ model: 'fixture', data: [{ embedding: [1] }] }));
  await assert.rejects(wrong.embed(['fixture']), /dimension/);
  const index = new SemanticIndex(config, async () => Response.json({ model: 'fixture', data: [{ embedding: [0, 1] }] }));
  assert.deepEqual(await index.embed(['fixture']), [[0, 1]]);
  assert.notEqual(index.identity, new SemanticIndex({ ...config, revision: '2' }).identity);
});
test('semantic responses are bounded at 8 MiB, streamed or declared', async () => {
  const config = { endpoint: 'http://localhost/embeddings', model: 'fixture', revision: '1', dimensions: 2, collection: 'hivemem_shadow_fixture', qdrantUrl: 'http://localhost:6333' };
  const limit = 8 * 1024 * 1024;
  let cancelled = false;
  const streamed = new SemanticIndex(config, async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(streamed.embed(['fixture']), /larger than the limit/);
  assert.equal(cancelled, true);
  let read = false;
  const declared = new SemanticIndex(config, async () => new Response(new ReadableStream<Uint8Array>({ pull() { read = true; } }, { highWaterMark: 0 }), { headers: { 'content-length': String(limit + 1) } }));
  await assert.rejects(declared.embed(['fixture']), /larger than the limit/);
  assert.equal(read, false);
  const exact = JSON.stringify({ model: 'fixture', data: [{ embedding: [0, 1] }] });
  const padded = exact + ' '.repeat(limit - Buffer.byteLength(exact));
  const atLimit = new SemanticIndex(config, async () => new Response(padded));
  assert.deepEqual(await atLimit.embed(['fixture']), [[0, 1]]);
  await assert.rejects(new SemanticIndex(config, async () => new Response(null)).embed(['fixture']), /no body/);
});
