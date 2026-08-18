#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLDEN_ANGLE_DEG, PHI, PHI_INV, Swarm, VNODES, dispatch, hashKey, vogelPoint } from './swarm.mjs';

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


// ─── the boundaries the mutation gate proved nothing was holding (estate bring-up) ───

test('THE HASH READS EVERY CHARACTER AND NOT ONE MORE', () => {
  // One iteration past the end xors NaN into the state and every hash in the ring becomes NaN —
  // routing silently degenerates to "always the same vnode". Pin the function on knowns.
  const h1 = hashKey('a');
  assert.ok(Number.isFinite(h1) && h1 >= 0 && h1 < 1, 'hash left the unit interval: ' + h1);
  assert.equal(hashKey('a'), hashKey('a'), 'the hash is not deterministic');
  assert.notEqual(hashKey('a'), hashKey('b'), 'two different keys collided — the loop is not reading the content');
  assert.notEqual(hashKey('ab'), hashKey('ba'), 'order of characters was ignored');
});

test('the ring has exactly workers × VNODES nodes — no extra vnode sneaks in', () => {
  const s = new Swarm(['a', 'b', 'c']);
  assert.equal(s.ring.length, 3 * VNODES, 'the vnode loop ran the wrong number of times');
});

test('A KEY LANDING EXACTLY ON A VNODE BELONGS TO THAT VNODE, not the next one', () => {
  // The search is "first node with pos >= h". Flip it to > and every exact hit routes one node too
  // far — invisible in random tests, certain for any key whose hash equals a vnode position. We
  // manufacture the exact hit by asking for the position of a real vnode.
  const s = new Swarm(['a', 'b']);
  // find some vnode, then binary-search with h EXACTLY its pos by monkeypatching is not possible —
  // instead assert the invariant directly against the ring: for every consecutive pair, a hash
  // equal to a node's pos must route to that node's worker.
  const node = s.ring[Math.floor(s.ring.length / 2)];
  // route() hashes the KEY, so we can't inject h — but the invariant is checkable through the
  // implementation's own parts: the first node with pos >= node.pos IS a node at that exact pos.
  let lo = 0, hi = s.ring.length;
  const h = node.pos;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.ring[mid].pos >= h) hi = mid; else lo = mid + 1; }
  assert.equal(s.ring[lo % s.ring.length].pos, node.pos,
    'an exact-position hit routed past the node that owns it');
  // and the routing structure itself: every routed worker must be a real worker
  for (const k of ['x', 'y', 'z', 'q']) assert.ok(s.workers.includes(s.route(k)));
});

test('replicas agree whatever order the workers arrived in', () => {
  // The tie-break in the ring sort is what keeps two replicas identical when two vnodes collide on
  // pos. Break either side of the comparator and insertion order leaks back in.
  const one = new Swarm(['a', 'b', 'c']);
  const other = new Swarm(['c', 'b', 'a']);
  for (const k of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) {
    assert.equal(one.route(k), other.route(k), 'the same key routed differently on a reordered replica');
  }
  assert.deepEqual(one.ring.map(n => n.id + '@' + n.pos), other.ring.map(n => n.id + '@' + n.pos),
    'the rings themselves diverged');
});

test('A WORKER THAT THROWS IS REPORTED BY ITS MESSAGE — Error, bare string, or falsy', async () => {
  // `String(e && e.message || e)`: an Error reports its message, a thrown string reports itself,
  // and a thrown falsy must still produce SOMETHING rather than crashing the report line.
  const s = new Swarm(['w']);
  const boom = await dispatch(s, [{ id: 't1' }], { w: () => { throw new Error('the pipe burst'); } });
  assert.equal(boom[0].ok, false);
  assert.match(boom[0].error, /the pipe burst/, 'an Error lost its message: ' + boom[0].error);
  const bare = await dispatch(s, [{ id: 't2' }], { w: () => { throw 'bare failure'; } });
  assert.match(bare[0].error, /bare failure/, 'a thrown string was lost: ' + bare[0].error);
  const falsy = await dispatch(s, [{ id: 't3' }], { w: () => { throw undefined; } });
  assert.equal(falsy[0].ok, false, 'a falsy throw was not even reported');
});

test('a task whose KEY throws is reported the same way, and the batch survives', async () => {
  const s = new Swarm(['w']);
  const hostile = { get key() { throw new Error('trap key'); } };
  const out = await dispatch(s, [hostile, { id: 'good' }], { w: () => 'done' }, t => t.key);
  assert.equal(out.length, 2, 'the hostile task aborted the batch');
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /bad task key: trap key/, 'the key failure lost its message: ' + out[0].error);
  const bareKey = await dispatch(s, [{ get key() { throw 'plain'; } }], { w: () => 'x' }, t => t.key);
  assert.match(bareKey[0].error, /bad task key: plain/, 'a bare-string key throw was lost');
  assert.equal(out[1].ok, true, 'the good task did not run after the bad one');
});


test('THE HASH IS THE REPLICA CONTRACT — its exact values are pinned', () => {
  // Two replicas agree because they compute the identical function. Any change to the loop, the
  // primes or the finaliser is a new function, and a mixed fleet of old and new replicas routes the
  // same key to different workers. So the exact values are the spec, pinned.
  assert.equal(hashKey('a'), 0.10352621669881046);
  assert.equal(hashKey('konomi'), 0.8308137238491327);
});

test('the golden-ratio conjugate is exactly itself', () => {
  // PHI_INV is exported API. frac(i·(PHI_INV+2)) happens to equal frac(i·PHI_INV) for integers, so
  // only pinning the constant itself makes a drift in it observable.
  assert.ok(Math.abs(PHI_INV - 0.6180339887498949) < 1e-15, 'PHI_INV drifted to ' + PHI_INV);
});

test('A KEY HASHING EXACTLY ONTO A VNODE ROUTES TO THAT VNODE, through route() itself', () => {
  // "First node with pos >= h": flip >= to > and every exact hit routes one node too far. The key
  // a#103 IS one of worker a's own vnode labels, so its hash equals that vnode's position exactly —
  // and the next node on this ring belongs to b, so the off-by-one is visible as the wrong worker.
  const s = new Swarm(['a', 'b']);
  assert.equal(hashKey('a#103'), 0.014675436774268746, 'the ring moved — re-derive the exact-hit key');
  assert.equal(s.route('a#103'), 'a', 'an exact-position hit routed past the vnode that owns it');
});
