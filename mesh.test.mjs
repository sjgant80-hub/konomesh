#!/usr/bin/env node
// End-to-end: the whole tract (route → work → gate → sign) over the vendored engines and real Ed25519.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from './mesh.mjs';
import { generateIdentity, sha256Hex } from './lineage.mjs';
import { Vault, memoryAdapter } from './vault.mjs';

// quality = fraction of non-TODO lines (same simple benchmark the sieve demo uses)
const assess = c => { const L = String(c.content).split('\n').filter(Boolean); const bad = L.filter(l => /TODO|FIXME/.test(l)).length; return { score: L.length ? 1 - bad / L.length : 0 }; };

const tasks = n => Array.from({ length: n }, (_, i) => ({ key: `job-${i}` }));

async function mkMesh(handlers, extra = {}) {
  const identity = await generateIdentity();
  return new Mesh({ workers: ['w0', 'w1', 'w2'], handlers, assess, identity, minScore: 0.7, ...extra });
}

test('Mesh requires a signing identity', () => {
  assert.throws(() => new Mesh({ workers: ['w0'], handlers: {}, assess }), /signing identity/);
});

test('good work flows all the way through and is signed onto the ledger', async () => {
  const handlers = {
    w0: t => ({ content: `clean output for ${t.key}\nmore`, licence: 'MIT' }),
    w1: t => ({ content: `clean output for ${t.key}\nmore`, licence: 'MIT' }),
    w2: t => ({ content: `clean output for ${t.key}\nmore`, licence: 'MIT' }),
  };
  const mesh = await mkMesh(handlers);
  const r = await mesh.metabolize(tasks(12));
  assert.equal(r.summary.kept, 12, 'all clean, permissive outputs kept');
  assert.equal(r.summary.ledgerDepth, 12);
  assert.equal((await mesh.verify()).valid, true, 'the whole output ledger verifies');
});

test('low-quality output is rejected and never signed', async () => {
  const handlers = {
    w0: () => ({ content: 'TODO\nTODO\nFIXME', licence: 'MIT' }),
    w1: () => ({ content: 'TODO\nTODO\nFIXME', licence: 'MIT' }),
    w2: () => ({ content: 'TODO\nTODO\nFIXME', licence: 'MIT' }),
  };
  const mesh = await mkMesh(handlers);
  const r = await mesh.metabolize(tasks(9));
  assert.equal(r.summary.kept, 0);
  assert.ok(r.summary.rejected > 0);
  assert.equal(mesh.ledger.length, 0, 'nothing junk reached the signed ledger');
});

test('a bad-licence output is flagged, not signed — even if high quality', async () => {
  const handlers = {
    w0: t => ({ content: `great code ${t.key}\nsolid`, licence: 'GPL-3.0' }),
    w1: t => ({ content: `great code ${t.key}\nsolid`, licence: 'GPL-3.0' }),
    w2: t => ({ content: `great code ${t.key}\nsolid`, licence: 'GPL-3.0' }),
  };
  const mesh = await mkMesh(handlers);
  const r = await mesh.metabolize(tasks(6));
  assert.equal(r.summary.kept, 0);
  assert.ok(r.summary.flagged > 0, 'copyleft flagged for a human');
  assert.equal(mesh.ledger.length, 0);
});

test('the ledger binds the REAL produced content — payloadHash EQUALS sha256(content)', async () => {
  // one worker, one task, known content — assert the exact binding, so mis-binding (e.g. hashing the
  // artifact id, or the constant sha256("null")) fails rather than merely "varying".
  const CONTENT = 'the exact produced bytes for this artifact';
  const mesh = new Mesh({ workers: ['w0'], handlers: { w0: () => ({ content: CONTENT, licence: 'MIT' }) }, assess: () => ({ score: 1 }), identity: await generateIdentity(), minScore: 0.5 });
  await mesh.metabolize([{ key: 'only' }]);
  assert.equal(mesh.ledger.length, 1);
  assert.equal(mesh.ledger[0].payloadHash, await sha256Hex(CONTENT), 'payloadHash is exactly the SHA-256 of the produced content');
  assert.equal((await mesh.verify()).valid, true);
});

test('duplicate task keys do NOT cross-bind content — each kept artifact binds its OWN bytes', async () => {
  const A = 'GOOD clean content alpha', B = 'GOOD clean content bravo';
  let n = 0;
  const mesh = new Mesh({
    workers: ['w0'],
    handlers: { w0: () => ({ content: (n++ === 0 ? A : B), licence: 'MIT' }) },
    assess: () => ({ score: 1 }), identity: await generateIdentity(), minScore: 0.5,
  });
  await mesh.metabolize([{ key: 'dup' }, { key: 'dup' }]);   // SAME key twice, different content
  assert.equal(mesh.ledger.length, 2);
  const hashes = new Set(mesh.ledger.map(e => e.payloadHash));
  assert.equal(hashes.size, 2, 'the two entries bind DISTINCT content, not the last-write-wins collapse');
  assert.ok(hashes.has(await sha256Hex(A)) && hashes.has(await sha256Hex(B)), 'both real payloads are bound');
});

test('an empty ledger verifies as valid (nothing kept ≠ tampered)', async () => {
  const mesh = new Mesh({ workers: ['w0'], handlers: { w0: () => ({ content: 'TODO\nTODO', licence: 'MIT' }) }, assess: () => ({ score: 0 }), identity: await generateIdentity(), minScore: 0.7 });
  await mesh.metabolize([{ key: 'x' }]);   // everything rejected → nothing signed
  assert.equal(mesh.ledger.length, 0);
  assert.equal((await mesh.verify()).valid, true, 'an empty ledger is valid, not "tampered"');
});

test('concurrent metabolize() calls serialise — the chain is not corrupted', async () => {
  const handlers = { w0: t => ({ content: `c ${t.key}\ny`, licence: 'MIT' }), w1: t => ({ content: `c ${t.key}\ny`, licence: 'MIT' }), w2: t => ({ content: `c ${t.key}\ny`, licence: 'MIT' }) };
  const mesh = await mkMesh(handlers);
  // fire two rounds WITHOUT awaiting between them
  const [a, b] = await Promise.all([mesh.metabolize(tasks(5)), mesh.metabolize(tasks(5).map(t => ({ key: t.key + '-b' })))]);
  assert.equal(mesh.ledger.length, a.summary.kept + b.summary.kept, 'both rounds appended without interleaving');
  assert.equal((await mesh.verify()).valid, true, 'the chain is intact despite concurrency');
});

test('ATTRIBUTION is signed — forging worker/artifact now breaks verification', async () => {
  const handlers = { w0: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }), w1: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }), w2: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }) };
  const mesh = await mkMesh(handlers);
  await mesh.metabolize(tasks(8));
  assert.equal((await mesh.verify()).valid, true);
  // re-attribute every unit to a forged worker (the old bug: this passed verify + fabricated contribution)
  for (const e of mesh.ledger) { e.worker = 'w0'; e.artifact = 'w0:forged'; }
  const v = await mesh.verify();
  assert.equal(v.valid, false, 'the forged attribution no longer verifies');
  assert.ok(v.breaks.some(b => /attribution/.test(b.reason)));
});

test('the signed ledger is tamper-evident — altering an entry breaks verification', async () => {
  const handlers = { w0: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }), w1: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }), w2: t => ({ content: `ok ${t.key}\nx`, licence: 'MIT' }) };
  const mesh = await mkMesh(handlers);
  await mesh.metabolize(tasks(5));
  assert.equal((await mesh.verify()).valid, true);
  mesh.ledger[2] = { ...mesh.ledger[2], contentHash: '00'.repeat(32) }; // tamper
  assert.equal((await mesh.verify()).valid, false, 'the chain no longer verifies');
});

test('multiple rounds keep extending ONE verifiable chain', async () => {
  const handlers = { w0: t => ({ content: `r ${t.key}\nx`, licence: 'MIT' }), w1: t => ({ content: `r ${t.key}\nx`, licence: 'MIT' }), w2: t => ({ content: `r ${t.key}\nx`, licence: 'MIT' }) };
  const mesh = await mkMesh(handlers);
  await mesh.metabolize(tasks(4));
  await mesh.metabolize(tasks(4).map(t => ({ key: t.key + '-b' })));
  assert.equal(mesh.ledger.length, 8);
  assert.equal((await mesh.verify()).valid, true, 'the ledger stays one valid chain across rounds');
});

test('contribution reports each worker’s KEPT share, and work is spread', async () => {
  const handlers = { w0: t => ({ content: `a ${t.key}\nx`, licence: 'MIT' }), w1: t => ({ content: `a ${t.key}\nx`, licence: 'MIT' }), w2: t => ({ content: `a ${t.key}\nx`, licence: 'MIT' }) };
  const mesh = await mkMesh(handlers);
  await mesh.metabolize(tasks(60));
  const c = mesh.contribution();
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 60);
  assert.equal(Object.keys(c).length, 3, 'all three workers contributed (load spread)');
});

test('a task routed to a worker with no handler is reported, not silently lost', async () => {
  const mesh = await mkMesh({ w0: t => ({ content: `x\ny`, licence: 'MIT' }) }); // only w0 has a handler
  const r = await mesh.metabolize(tasks(30));
  const missing = r.produced.filter(p => !p.ok);
  assert.ok(missing.length > 0 && missing.every(m => /no handler/.test(m.error)));
  assert.equal(r.produced.length, 30, 'every task accounted for');
});

test('PERSISTENCE: the signed ledger survives a restart via the encrypted store', async () => {
  const SEED = 'mesh master seed 123';
  const adapter = memoryAdapter();                       // shared "disk" across two mesh instances
  const handlers = { w0: t => ({ content: `ok ${t.key}\ny`, licence: 'MIT' }), w1: t => ({ content: `ok ${t.key}\ny`, licence: 'MIT' }), w2: t => ({ content: `ok ${t.key}\ny`, licence: 'MIT' }) };
  const identity = await generateIdentity();

  // run 1 — persist to the vault
  const vault1 = await new Vault({ adapter }).open(SEED);
  const mesh1 = new Mesh({ workers: ['w0', 'w1', 'w2'], handlers, assess, identity, minScore: 0.7, store: vault1 });
  await mesh1.metabolize(tasks(6));
  assert.equal(mesh1.ledger.length, 6);

  // run 2 — a fresh mesh on the same "disk" reloads the ledger and it still verifies
  const vault2 = await new Vault({ adapter }).open(SEED);
  const mesh2 = new Mesh({ workers: ['w0', 'w1', 'w2'], handlers, assess, identity, minScore: 0.7, store: vault2 });
  await mesh2.loadLedger();
  assert.equal(mesh2.ledger.length, 6, 'ledger restored across the restart');
  assert.equal((await mesh2.verify()).valid, true, 'the restored chain still verifies');

  // and a further round extends the SAME chain
  await mesh2.metabolize(tasks(4).map(t => ({ key: t.key + '-b' })));
  assert.equal(mesh2.ledger.length, 10);
  assert.equal((await mesh2.verify()).valid, true);
});

test('the persisted ledger is ciphertext at rest — its fields do not leak', async () => {
  const adapter = memoryAdapter();
  const vault = await new Vault({ adapter }).open('seed for encryption check');
  const mesh = new Mesh({ workers: ['w0'], handlers: { w0: t => ({ content: `payload-${t.key}`, licence: 'MIT' }) }, assess: () => ({ score: 1 }), identity: await generateIdentity(), store: vault });
  await mesh.metabolize([{ key: 'x' }]);
  const stored = JSON.stringify(await adapter.get('konomesh-ledger'));
  // if unencrypted, the raw ledger array's field names would be visible
  assert.ok(!stored.includes('"contentHash"') && !stored.includes('"sig"') && !stored.includes('"author"'),
    'ledger provenance fields are not stored in plaintext');
  assert.match(stored, /"iv":|"ct":/, 'stored as an AES-GCM envelope');
});
