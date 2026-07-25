#!/usr/bin/env node
// End-to-end: the whole tract (route → work → gate → sign) over the vendored engines and real Ed25519.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from './mesh.mjs';
import { generateIdentity } from './lineage.mjs';
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
