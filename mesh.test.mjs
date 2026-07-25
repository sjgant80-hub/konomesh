#!/usr/bin/env node
// End-to-end: the whole tract (route → work → gate → sign) over the vendored engines and real Ed25519.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from './mesh.mjs';
import { generateIdentity } from './lineage.mjs';

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
