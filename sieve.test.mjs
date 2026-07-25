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

test('summary counts reconcile to the input', async () => {
  const s = new Sieve({ assess, minScore: 0.7 });
  const r = await s.sift([
    { content: 'clean\ncode', licence: 'MIT' },      // kept
    { content: 'TODO\nx', licence: 'MIT' },           // rejected
    { content: 'clean\ncode2', licence: 'GPL-3.0' },  // flagged
  ]);
  assert.deepEqual(r.summary, { in: 3, kept: 1, rejected: 1, flagged: 1 });
});

test('cluster groups records that share content', () => {
  const recs = [
    { hash: 'aa', id: '1' }, { hash: 'aa', id: '2' }, { hash: 'bb', id: '3' },
  ];
  const clusters = cluster(recs);
  assert.equal(clusters[0].members.length, 2, 'largest cluster first');
  assert.equal(clusters[0].hash, 'aa');
});

test('an async assessor is awaited', async () => {
  const s = new Sieve({ assess: async c => ({ score: 0.9 }), minScore: 0.7 });
  const r = await s.sift([{ content: 'x', licence: 'MIT' }]);
  assert.equal(r.kept.length, 1);
});
