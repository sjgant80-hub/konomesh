#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Swarm, dispatch, vogelPoint, hashKey, PHI, GOLDEN_ANGLE_DEG } from './swarm.mjs';

const keys = n => Array.from({ length: n }, (_, i) => `task-${i}`);

test('the golden constants are correct', () => {
  assert.ok(Math.abs(PHI - 1.6180339887) < 1e-6);
  assert.ok(Math.abs(GOLDEN_ANGLE_DEG - 137.50776) < 1e-3);
});

test('vogelPoint is a well-spread VISUALISATION layout (not the routing mechanism)', () => {
  // NOTE: vogelPoint drives only the sunflower demo visual. Routing is the identity-hashed vnode ring
  // (see the DECENTRALISED + balance tests). This test guards the viz layout, nothing about routing.
  const n = 50;
  const positions = Array.from({ length: n }, (_, i) => vogelPoint(i).ring).sort((a, b) => a - b);
  let minGap = 1;
  for (let i = 1; i < positions.length; i++) minGap = Math.min(minGap, positions[i] - positions[i - 1]);
  assert.ok(minGap > 0.5 / n, `min gap ${minGap} is well-spread (no clumping)`);
});

test('dispatch with no handlers argument reports per-task, does not throw', async () => {
  const s = new Swarm(['w0', 'w1']);
  const out = await dispatch(s, [{ key: 'a' }, { key: 'b' }]);   // handlers omitted
  assert.equal(out.length, 2);
  assert.ok(out.every(r => !r.ok && /no handler/.test(r.error)));
});

test('dispatch handles a null/undefined task — reported, not batch-aborting', async () => {
  const s = new Swarm(['w0', 'w1']);
  const out = await dispatch(s, [{ key: 'a' }, null, { key: 'b' }], { w0: t => t.key, w1: t => t.key });
  assert.equal(out.length, 3, 'every entry accounted for, none dropped');
  assert.ok(out.some(r => !r.ok && /bad task key/.test(r.error)), 'the null task is reported');
  assert.equal(out.filter(r => r.ok).length, 2, 'the two real tasks still ran');
});

test('hashKey is deterministic and lands in [0,1)', () => {
  assert.equal(hashKey('abc'), hashKey('abc'));
  assert.notEqual(hashKey('abc'), hashKey('abd'));
  for (const k of ['', 'x', 'task-999', 'a-very-long-key-value']) {
    const h = hashKey(k);
    assert.ok(h >= 0 && h < 1, `${k} -> ${h} in [0,1)`);
  }
});

test('routing is deterministic — same key, same worker', () => {
  const s = new Swarm(['w0', 'w1', 'w2', 'w3']);
  assert.equal(s.route('task-42'), s.route('task-42'));
});

test('STRUCTURAL load balance holds across small AND large worker counts', () => {
  // Keys are scaled with N (~2500 per worker) to isolate the ring's STRUCTURAL balance from the
  // sampling noise that dominates when there are only a handful of keys per worker (that noise is
  // inherent to any consistent-hash ring, not a property of this one).
  for (const nWorkers of [3, 8, 23, 64, 128, 300]) {
    const s = new Swarm(Array.from({ length: nWorkers }, (_, i) => `w${i}`));
    const nKeys = nWorkers * 2500;
    const counts = Object.values(s.distribution(keys(nKeys)));
    const max = Math.max(...counts), min = Math.min(...counts);
    assert.ok(max / min < 1.8, `N=${nWorkers}: structural max/min ${(max / min).toFixed(2)} should stay < 1.8`);
    assert.equal(counts.reduce((a, b) => a + b, 0), nKeys, 'every key routed exactly once');
  }
});

test('DECENTRALISED: same membership routes identically regardless of order or history', () => {
  const ks = keys(5000);
  const a = new Swarm(['w0', 'w1', 'w2', 'w3', 'w4']);
  const b = new Swarm(['w4', 'w3', 'w2', 'w1', 'w0']);           // different construction order
  assert.equal(ks.filter(k => a.route(k) !== b.route(k)).length, 0, 'construction order must not change routing');
  const c = new Swarm(['w0', 'w1']).add('w2').add('w3');
  const d = new Swarm(['w3', 'w2', 'w1', 'w0', 'wX']).remove('wX'); // different history, same members
  assert.equal(ks.filter(k => c.route(k) !== d.route(k)).length, 0, 'position is a function of identity only');
});

test('worker ids are type-normalised — number 1 and string "1" are one worker, order-independent', () => {
  const a = new Swarm([1, '1']);           // same id in two types
  assert.equal(a.size, 1, 'deduped to a single worker');
  const b = new Swarm(['1', 1]);           // reversed order
  const ks = keys(2000);
  assert.equal(ks.filter(k => a.route(k) !== b.route(k)).length, 0, 'no order-dependence from type-coerced ids');
});

test('consistent hashing — adding a worker only reshuffles a small share of keys', () => {
  const before = new Swarm(Array.from({ length: 10 }, (_, i) => `w${i}`));
  const ks = keys(5000);
  const assignedBefore = ks.map(k => before.route(k));
  const after = new Swarm(before.workers).add('w10');
  let moved = 0;
  ks.forEach((k, i) => { if (after.route(k) !== assignedBefore[i]) moved++; });
  // ideal ≈ 1/11 ≈ 9%; allow generous headroom but far below a naive re-hash (~91%)
  assert.ok(moved / ks.length < 0.25, `only ${(moved / ks.length * 100).toFixed(1)}% of keys moved (consistent)`);
});

test('removing a worker reassigns only that worker’s keys', () => {
  const s = new Swarm(Array.from({ length: 6 }, (_, i) => `w${i}`));
  const ks = keys(3000);
  const before = ks.map(k => s.route(k));
  s.remove('w3');
  ks.forEach((k, i) => {
    const now = s.route(k);
    if (before[i] !== 'w3') assert.equal(now, before[i], 'keys not on w3 are undisturbed');
    assert.notEqual(now, 'w3', 'no key still routes to the removed worker');
  });
});

test('empty swarm routes to null, and dispatch reports it (never throws)', async () => {
  const s = new Swarm([]);
  assert.equal(s.route('x'), null);
  const out = await dispatch(s, [{ key: 'a' }], {});
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /no workers/);
});

test('dispatch metabolises a queue — routes each task to its handler and collects results', async () => {
  const s = new Swarm(['w0', 'w1', 'w2']);
  const handlers = { w0: t => `0:${t.key}`, w1: async t => `1:${t.key}`, w2: t => `2:${t.key}` };
  const tasks = keys(30).map(k => ({ key: k }));
  const out = await dispatch(s, tasks, handlers);
  assert.equal(out.length, 30);
  assert.ok(out.every(r => r.ok), 'all handled');
  for (const r of out) assert.ok(r.result.startsWith(r.worker.slice(1) + ':'), 'result came from the routed worker');
});

test('dispatch reports a missing handler rather than dropping the task', async () => {
  const s = new Swarm(['w0', 'w1']);
  const out = await dispatch(s, keys(20).map(k => ({ key: k })), { w0: t => t.key }); // no w1 handler
  const failures = out.filter(r => !r.ok);
  assert.ok(failures.length > 0 && failures.every(f => /no handler/.test(f.error)));
  assert.equal(out.length, 20, 'nothing silently dropped');
});
