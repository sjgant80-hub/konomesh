#!/usr/bin/env node
// Real Ed25519 against the Web Crypto engine — no mocked crypto. The load-bearing tests: a tampered
// record, a forged signature, and a broken parent link are all caught by verifyLineage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, mint, fork, verifyRecord, verifyLineage, sha256Hex } from './lineage.mjs';

test('an identity has a 32-byte (64-hex) public key and a usable private key', async () => {
  const id = await generateIdentity();
  assert.match(id.pub, /^[0-9a-f]{64}$/);
  assert.ok(id.keyPair.privateKey);
});

test('a minted root record verifies', async () => {
  const alice = await generateIdentity();
  const root = await mint('the original build', alice);
  assert.equal(root.seq, 0);
  assert.equal(root.parent, null);
  assert.equal(root.author, alice.pub);
  assert.equal((await verifyRecord(root)).valid, true);
});

test('a fork chain of three authors verifies end to end', async () => {
  const a = await generateIdentity(), b = await generateIdentity(), c = await generateIdentity();
  const r0 = await mint('v1', a);
  const r1 = await fork(r0, 'v2 — b improved it', b);
  const r2 = await fork(r1, 'v3 — c improved it', c);
  const v = await verifyLineage([r0, r1, r2]);
  assert.equal(v.valid, true);
  assert.equal(v.depth, 3);
  assert.equal(v.root, r0.id);
  assert.equal(v.tip, r2.id);
  assert.equal(v.authors.length, 3);
});

test('TAMPER: altering a record’s content breaks its id and fails verification', async () => {
  const a = await generateIdentity();
  const root = await mint('honest content', a);
  const forged = { ...root, contentHash: await sha256Hex('swapped content') };
  const v = await verifyRecord(forged);
  assert.equal(v.valid, false);
  assert.match(v.reason, /tampered|signature/);
});

test('FORGE: claiming someone else’s authorship fails the signature check', async () => {
  const a = await generateIdentity(), b = await generateIdentity();
  const root = await mint('content', a);
  // attacker keeps a's signature but swaps the author field to b — sig no longer matches
  const forged = { ...root, author: b.pub };
  const rebuiltId = await sha256Hex(JSON.stringify({ contentHash: forged.contentHash, author: forged.author, parent: forged.parent, seq: forged.seq }) + forged.sig);
  forged.id = rebuiltId; // even fixing the id, the signature can't verify against b
  const v = await verifyRecord(forged);
  assert.equal(v.valid, false);
  assert.match(v.reason, /signature does not verify/);
});

test('BROKEN LINK: a fork pointing at the wrong parent is caught', async () => {
  const a = await generateIdentity(), b = await generateIdentity();
  const r0 = await mint('v1', a);
  const rogue = await mint('unrelated', b);      // not part of the chain
  const r1 = await fork(rogue, 'v2', b);          // validly signed, but parent isn't r0
  const v = await verifyLineage([r0, r1]);
  assert.equal(v.valid, false);
  assert.ok(v.breaks.some(x => /parent link broken/.test(x.reason)));
});

test('SEQ (multi-record): a fork whose seq does not increment by 1 is caught', async () => {
  const a = await generateIdentity();
  const r0 = await mint('v1', a);
  const r1 = await fork(r0, 'v2', a);           // valid seq 1
  const v = await verifyLineage([r0, r1, r1]);  // third has seq 1, should be 2 relative to its parent
  assert.equal(v.valid, false);
  assert.ok(v.breaks.some(x => /seq does not increment/.test(x.reason)), 'the multi-record seq check fired');
});

test('CRITICAL: a small-order (all-zeros) key + all-zeros sig cannot forge a valid chain', async () => {
  const zeroAuthor = '0'.repeat(64), zeroSig = '0'.repeat(128);
  const canon = r => JSON.stringify({ contentHash: r.contentHash, author: r.author, parent: r.parent, seq: r.seq });
  const f0 = { contentHash: await sha256Hex('forged'), author: zeroAuthor, parent: null, seq: 0, sig: zeroSig };
  f0.id = await sha256Hex(canon(f0) + f0.sig);
  const vr = await verifyRecord(f0);
  assert.equal(vr.valid, false);
  assert.match(vr.reason, /small-order/, 'rejected specifically as a small-order key, not incidentally');
  assert.equal((await verifyLineage([f0])).valid, false, 'no private key ⇒ no valid chain');
});

test('a BigInt/Symbol seq returns invalid — verifyLineage never throws', async () => {
  const a = await generateIdentity();
  const bad = { ...(await mint('v1', a)), seq: 0n };
  const r1 = await fork(await mint('v1', a), 'v2', a);
  assert.equal(typeof (await verifyLineage([bad, r1])).valid, 'boolean', 'no throw on a BigInt seq');
  assert.equal((await verifyLineage([bad, r1])).valid, false);
});

test('a record with malformed non-hex fields returns invalid, not a throw', async () => {
  const a = await generateIdentity();
  const root = await mint('x', a);
  // parent set to a value that breaks canon()'s assumptions shouldn't crash verifyLineage
  const v = await verifyLineage([{ ...root, parent: { nested: 'bad' } }]);
  assert.equal(typeof v.valid, 'boolean');
  assert.equal(v.valid, false);
});

test('id-integrity is enforced independently — tampering ONLY the id is caught', async () => {
  const a = await generateIdentity();
  const root = await mint('content', a);
  // everything else valid (sig still verifies); only the id is swapped
  const v = await verifyRecord({ ...root, id: 'deadbeef'.repeat(8) });
  assert.equal(v.valid, false);
  assert.match(v.reason, /id does not match/);
});

test('id is NOT malleable — upper-casing the sig hex does not mint a new valid record', async () => {
  const a = await generateIdentity();
  const root = await mint('content', a);
  const upperSig = root.sig.toUpperCase();
  const forgedId = await sha256Hex(JSON.stringify({ contentHash: root.contentHash, author: root.author, parent: root.parent, seq: root.seq }) + upperSig);
  const v = await verifyRecord({ ...root, sig: upperSig, id: forgedId });
  assert.equal(v.valid, false, 'a case-variant sig is rejected, so one signature yields exactly one id');
});

test('a non-root first record (wrong parent or seq) is rejected', async () => {
  const a = await generateIdentity();
  const r0 = await mint('v1', a);
  const r1 = await fork(r0, 'v2', a);   // seq 1, parent r0.id — a valid NON-root record
  const v = await verifyLineage([r1]);  // placed as the root of a chain
  assert.equal(v.valid, false);
  assert.ok(v.breaks.some(x => /root must have a null parent|root seq must be 0/.test(x.reason)));
});

test('a null/undefined chain element returns invalid — never throws', async () => {
  const a = await generateIdentity();
  const r0 = await mint('v1', a);
  const v = await verifyLineage([r0, null, undefined]);
  assert.equal(v.valid, false);
  assert.ok(v.breaks.some(x => /not a record/.test(x.reason)));
});

test('a record with sig / author omitted returns invalid — never throws', async () => {
  const a = await generateIdentity();
  const r0 = await mint('v1', a);
  const { sig, ...noSig } = r0;
  assert.equal((await verifyRecord(noSig)).valid, false, 'missing sig → invalid, not a crash');
  assert.equal((await verifyRecord({ ...r0, author: 'zz' })).valid, false, 'malformed author → invalid');
});

test('content-address is split from provenance: same content, different lineages', async () => {
  const a = await generateIdentity(), b = await generateIdentity();
  const ra = await mint('identical bytes', a);
  const rb = await mint('identical bytes', b);
  assert.equal(ra.contentHash, rb.contentHash, 'same content → same contentHash');
  assert.notEqual(ra.id, rb.id, 'but different provenance records');
  assert.notEqual(ra.author, rb.author);
});

test('an empty chain is invalid, not silently accepted', async () => {
  const v = await verifyLineage([]);
  assert.equal(v.valid, false);
});

test('verification is stable — re-verifying a good chain stays valid', async () => {
  const a = await generateIdentity();
  const chain = [await mint('x', a)];
  chain.push(await fork(chain[0], 'y', a));
  assert.equal((await verifyLineage(chain)).valid, true);
  assert.equal((await verifyLineage(chain)).valid, true);
});


// ─── the boundaries the mutation gate proved nothing was holding (estate bring-up) ───

test('EACH MALFORMED FIELD ALONE makes a record invalid — never only all of them together', async () => {
  // The check is a chain of ORs. Flipped to ANDs, a forged record with one well-formed field slips
  // past the shape gate and reaches real crypto with garbage — a different, wronger failure.
  const alice = await generateIdentity();
  const good = await mint('real content', alice);
  const cases = [
    { ...good, sig: 'zz' },                          // bad sig alone
    { ...good, author: 'nothex' },                    // bad author alone
    { ...good, id: 42 },                              // bad id alone
    { ...good, seq: 'zero' },                         // bad seq alone
  ];
  for (const rec of cases) {
    const v = await verifyRecord(rec);
    assert.equal(v.valid, false);
    assert.match(v.reason, /well-formed/, 'one bad field was not enough: ' + v.reason);
  }
});

test('A SMALL-ORDER AUTHOR ALONE IS REJECTED, and a small-order signature point alone too', async () => {
  // The all-zeros key plus all-zeros signature forges a chain with no private key (RFC 8032 §8.5).
  // Each half must trip the guard on its own — requiring both is exactly the forgery.
  const alice = await generateIdentity();
  const good = await mint('real content', alice);
  const zeros64 = '0'.repeat(64);
  const badAuthor = await verifyRecord({ ...good, author: zeros64 });
  assert.equal(badAuthor.valid, false);
  assert.match(badAuthor.reason, /small-order/, 'a weak KEY alone was not rejected: ' + badAuthor.reason);
  const badSig = await verifyRecord({ ...good, sig: zeros64 + good.sig.slice(64) });
  assert.equal(badSig.valid, false);
  assert.match(badSig.reason, /small-order/, 'a weak SIGNATURE point alone was not rejected: ' + badSig.reason);
});

test('a hole or a non-record in the middle of a chain is named as exactly that', async () => {
  // `!prev || typeof prev !== 'object'`: null passes the typeof test (typeof null is "object") and
  // a string passes the truthiness test — each side of the OR catches what the other cannot.
  const alice = await generateIdentity();
  const root = await mint('root', alice);
  const child = await fork(root, 'child', alice);

  const withNull = await verifyLineage([null, child]);
  const brk = withNull.breaks.find(b => /previous chain element is not a record/.test(b.reason));
  assert.ok(brk, 'a null link was not flagged: ' + JSON.stringify(withNull.breaks));
  // The break points at the record that noticed the hole — its seq must be the record's NUMBER,
  // not the record itself. `rec && rec.seq` flipped to `||` puts the whole object in the report.
  assert.strictEqual(brk.seq, child.seq, 'the break carried ' + typeof brk.seq + ' instead of the seq number');
  const withString = await verifyLineage(['not a record', child]);
  assert.ok(withString.breaks.some(b => /not a record/.test(b.reason)),
    'a string link was not flagged: ' + JSON.stringify(withString.breaks));
});
