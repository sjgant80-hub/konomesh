#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sieve, classifyLicence, contentHash, cluster } from './sieve.mjs';

// a deterministic injected assessor: score = fraction of lines that aren't 'TODO'
const assess = c => {
  const lines = String(c.content).split('\n').filter(Boolean);
  const bad = lines.filter(l => /TODO|FIXME/.test(l)).length;
  return { score: lines.length ? 1 - bad / lines.length : 0 };
};

test('classifyLicence buckets permissive / copyleft / unknown', () => {
  assert.equal(classifyLicence('MIT'), 'permissive');
  assert.equal(classifyLicence('apache-2.0'), 'permissive');
  assert.equal(classifyLicence('GPL-3.0'), 'copyleft');
  assert.equal(classifyLicence('AGPL-3.0'), 'copyleft');
  assert.equal(classifyLicence(''), 'unknown');
  assert.equal(classifyLicence('WeirdLicense'), 'unknown');
});

test('contentHash is deterministic and content-addressed', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
});

test('Sieve requires an injected assessor', () => {
  assert.throws(() => new Sieve({}), /requires an injected assess/);
});

test('a high-quality, permissively-licensed candidate is KEPT with full provenance', async () => {
  const s = new Sieve({ assess, minScore: 0.7 });
  const r = await s.sift([{ id: 'a', content: 'clean\ncode\nhere', licence: 'MIT', source: 'github.com/x/a' }]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].source, 'github.com/x/a');
  assert.equal(r.kept[0].licenceClass, 'permissive');
  assert.ok(r.kept[0].score >= 0.7 && r.kept[0].hash);
});

test('a low-quality candidate is REJECTED, not kept', async () => {
  const s = new Sieve({ assess, minScore: 0.7 });
  const r = await s.sift([{ content: 'TODO\nTODO\nok', licence: 'MIT' }]);
  assert.equal(r.kept.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /score/);
});

test('GPL and unknown-licence candidates are FLAGGED, never silently admitted', async () => {
  const s = new Sieve({ assess, minScore: 0.5 });
  const r = await s.sift([
    { content: 'good\ncode', licence: 'GPL-3.0', source: 'g' },
    { content: 'good\ncode2', licence: '', source: 'u' },
  ]);
  assert.equal(r.kept.length, 0, 'neither auto-admitted');
  assert.equal(r.flagged.length, 2);
  assert.ok(r.flagged.every(f => /human decision/.test(f.reason)));
});

test('copyleft CAN be admitted when the policy explicitly allows it', async () => {
  const s = new Sieve({ assess, minScore: 0.5, allow: ['permissive', 'copyleft'] });
  const r = await s.sift([{ content: 'good\ncode', licence: 'GPL-3.0' }]);
  assert.equal(r.kept.length, 1, 'admitted only because policy opted in');
});

test('identical content dedupes among survivors', async () => {
  const s = new Sieve({ assess, minScore: 0.5 });
  const r = await s.sift([
    { id: 'x', content: 'same\nbytes', licence: 'MIT' },
    { id: 'y', content: 'same\nbytes', licence: 'ISC' },
  ]);
  assert.equal(r.kept.length, 1, 'same content → one survivor');
});

test('summary counts reconcile to the input — including deduped survivors', async () => {
  const s = new Sieve({ assess, minScore: 0.7 });
  const r = await s.sift([
    { content: 'clean\ncode', licence: 'MIT' },      // kept
    { content: 'clean\ncode', licence: 'ISC' },      // dedup of the above (same content) → not counted again
    { content: 'TODO\nx', licence: 'MIT' },           // rejected
    { content: 'clean\ncode2', licence: 'GPL-3.0' },  // flagged
  ]);
  // deduped is now an INDEPENDENT count, not derived from the others — so the reconciliation can fail
  // if a candidate is ever silently lost (the collision blind spot the previous test hid).
  assert.equal(r.summary.deduped, 1, 'exactly one input collapsed as a duplicate');
  assert.equal(r.summary.kept, 1);
  assert.equal(r.summary.rejected, 1);
  assert.equal(r.summary.flagged, 1);
  assert.equal(r.summary.kept + r.summary.rejected + r.summary.flagged + r.summary.errored + r.summary.deduped, r.summary.in, 'every input is accounted for exactly once');
});

test('unserialisable content is isolated to `errored`, not aborting the batch', async () => {
  const circ = {}; circ.self = circ;
  const s = new Sieve({ assess: () => ({ score: 1 }), minScore: 0.5 });
  const r = await s.sift([
    { content: 'first good', licence: 'MIT', source: 'a' },
    { content: circ, licence: 'MIT', source: 'b' },          // circular → can't JSON-serialise
    { content: 'third good', licence: 'MIT', source: 'c' },
  ]);
  assert.equal(r.kept.length, 2, 'both good candidates survive the bad one');
  assert.equal(r.errored.length, 1, 'the unserialisable one is in the errored bucket');
  assert.equal(r.errored[0].source, 'b', 'the errored record carries its captured source');
  assert.equal(r.summary.kept + r.summary.rejected + r.summary.flagged + r.summary.errored + r.summary.deduped, 3, 'all three accounted for');
});

test('a non-finite minScore is rejected loudly — a null threshold must NOT disable the gate', () => {
  for (const bad of [null, NaN, '', 'high']) {
    assert.throws(() => new Sieve({ assess, minScore: bad }), /finite number/, `minScore ${JSON.stringify(bad)} rejected`);
  }
});

test('a throwing assessor drops only that candidate — the batch is not aborted', async () => {
  let n = 0;
  const flaky = () => { n++; if (n === 2) throw new Error('boom'); return { score: 1 }; };
  const s = new Sieve({ assess: flaky, minScore: 0.5 });
  const r = await s.sift([{ content: 'a', licence: 'MIT' }, { content: 'b', licence: 'MIT' }, { content: 'c', licence: 'MIT' }]);
  assert.equal(r.kept.length, 2, 'the two good candidates survive');
  assert.equal(r.errored.length, 1, 'the throwing one is reported, not silently lost');
  assert.match(r.errored[0].reason, /threw/);
});

test('distinct OBJECT contents get distinct addresses (no [object Object] collapse)', async () => {
  const s = new Sieve({ assess: () => ({ score: 1 }), minScore: 0.5 });
  const r = await s.sift([
    { content: { a: 1 }, licence: 'MIT' },
    { content: { a: 2 }, licence: 'MIT' },
  ]);
  assert.equal(r.kept.length, 2, 'two different objects are two different survivors');
  assert.notEqual(r.kept[0].hash, r.kept[1].hash);
});

test('cluster groups records that share content, LARGEST first (order-independent of input)', () => {
  // the smaller cluster ('bb') is inserted FIRST, so a passing test genuinely requires the sort
  const recs = [
    { hash: 'bb', id: '3' }, { hash: 'aa', id: '1' }, { hash: 'aa', id: '2' },
  ];
  const clusters = cluster(recs);
  assert.equal(clusters[0].hash, 'aa', 'the 2-member cluster is first despite being inserted second');
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[1].members.length, 1);
});

test('a candidate with a throwing id/source getter is isolated, not batch-aborting', async () => {
  const s = new Sieve({ assess: () => ({ score: 1 }), minScore: 0.5 });
  const poison = { content: 'p', licence: 'MIT', get id() { throw new Error('id getter blew up'); } };
  const r = await s.sift([{ content: 'good1', licence: 'MIT' }, poison, { content: 'good2', licence: 'MIT' }]);
  assert.equal(r.kept.length, 2, 'both good candidates survive the poison getter');
  assert.equal(r.errored.length, 1);
});

test('an async assessor is awaited', async () => {
  const s = new Sieve({ assess: async c => ({ score: 0.9 }), minScore: 0.7 });
  const r = await s.sift([{ content: 'x', licence: 'MIT' }]);
  assert.equal(r.kept.length, 1);
});


// ─── the boundaries the mutation gate proved nothing was holding ───
// (added at the estate bring-up: seven survivors, each a real untested behaviour of the intake)

test('A SCORE EXACTLY AT THE THRESHOLD IS ADMITTED — the line belongs to the pass side', async () => {
  // The rejection reads `score < minScore`. Off by one and a candidate the config says is good
  // enough gets binned with a reason that contradicts the config it quotes.
  const s = new Sieve({ assess: () => 0.7, minScore: 0.7, allow: ['permissive'] });
  const at = await s.sift([{ id: 'at', content: 'x', licence: 'MIT' }]);
  assert.equal(at.kept.length, 1, 'a candidate exactly at minScore was rejected');
  const under = new Sieve({ assess: () => 0.699, minScore: 0.7, allow: ['permissive'] });
  const u = await under.sift([{ id: 'under', content: 'x', licence: 'MIT' }]);
  assert.equal(u.rejected.length, 1, 'a candidate under the line was admitted');
  assert.match(u.rejected[0].reason, /0.699 < 0.7/);
});

test('a candidate that is not an object goes to errored — both null and the merely-wrong', async () => {
  const s = new Sieve({ assess: () => 1, allow: ['permissive'] });
  const r = await s.sift([null, undefined, 'a string', 7, { id: 'ok', content: 'x', licence: 'MIT' }]);
  assert.equal(r.errored.length, 4, 'a non-object candidate slipped past the door');
  for (const e of r.errored) assert.match(e.reason, /not an object/);
  assert.equal(r.kept.length, 1, 'the real candidate was lost with the rubbish');
  assert.equal(r.summary.in, 5, 'the reconciliation lost somebody');
});

test('a poison candidate keeps what was captured before the throw, and only that', async () => {
  // The errored record must carry id/source when they were read before the explosion, and null —
  // never undefined, never a lie — when the explosion WAS reading them.
  const s = new Sieve({ assess: () => { throw new Error('assessor down'); }, allow: ['permissive'] });
  const r = await s.sift([{ id: 'seen', source: 'here', content: 'x' }]);
  assert.equal(r.errored.length, 1);
  assert.equal(r.errored[0].id, 'seen', 'the captured id was dropped');
  assert.equal(r.errored[0].source, 'here', 'the captured source was dropped');
  assert.match(r.errored[0].reason, /assessor down/);

  const hostile = { get id() { throw new Error('trap'); }, content: 'x' };
  const h = await new Sieve({ assess: () => 1, allow: ['permissive'] }).sift([hostile]);
  assert.equal(h.errored.length, 1, 'a throwing accessor aborted the batch');
  assert.equal(h.errored[0].id, null, 'an uncaptured id was reported as something');
});

test('A CANDIDATE WITH NO ID IS KNOWN BY ITS CONTENT-ADDRESS, never by nothing', async () => {
  const s = new Sieve({ assess: () => 1, allow: ['permissive'] });
  const r = await s.sift([{ content: 'anonymous thing', licence: 'MIT' }]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].id, r.kept[0].hash, 'a nameless candidate did not fall back to its hash');
  assert.ok(r.kept[0].id, 'the id came out empty');
});

test('a missing licence is null on the record, not undefined and not a truthy accident', async () => {
  const s = new Sieve({ assess: () => 1, allow: ['unknown'] });
  const r = await s.sift([{ id: 'bare', content: 'x' }]);
  const rec = [...r.kept, ...r.flagged].find(x => x.id === 'bare');
  assert.ok(rec, 'the bare candidate vanished');
  assert.strictEqual(rec.licence, null, 'a missing licence came out as ' + String(rec.licence));
});


test('a thrown bare string is reported as itself, not as "undefined"', async () => {
  // The reason line is `e && e.message || e`. A string has no .message, so the fallback IS the
  // report — break the fallback and every non-Error throw in the estate reads as "undefined".
  const s = new Sieve({ assess: () => { throw 'the pipe burst'; }, allow: ['permissive'] });
  const r = await s.sift([{ id: 'x', content: 'x' }]);
  assert.match(r.errored[0].reason, /the pipe burst/, 'a bare-string throw was reported as: ' + r.errored[0].reason);
});

test('even a thrown FALSY value produces an errored record, never an aborted batch', async () => {
  // `throw undefined` is rare and real. The guard must survive reading .message off it — one
  // flipped operator turns this into a TypeError that escapes the catch and kills the whole sift.
  const s = new Sieve({ assess: () => { throw undefined; }, allow: ['permissive'] });
  const r = await s.sift([{ id: 'x', content: 'x' }, { id: 'y', content: 'y' }]);
  assert.equal(r.errored.length, 2, 'a falsy throw aborted the batch instead of erroring the candidate');
  assert.match(r.errored[0].reason, /processing threw/);
});


test('THE CONTENT ADDRESS IS THE IDENTITY CONTRACT — its exact value is pinned', () => {
  // Everything dedupes and clusters by this hash. Any change to its loop or its primes is a new
  // address space: every stored record silently stops matching itself on the next run. One extra
  // iteration XORs NaN (a no-op) then multiplies once more — a consistent, wrong, new identity.
  assert.equal(contentHash('konomi'), 'd4b0354d21b1610baff26bb8a3d6d289');
  assert.equal(contentHash(''), contentHash(''), 'the empty address is not stable');
  assert.notEqual(contentHash('a'), contentHash('b'));
});
