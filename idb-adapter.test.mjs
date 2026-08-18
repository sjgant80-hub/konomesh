// Tests for the IndexedDB adapter — with a fake IndexedDB, so its guards are killable in Node.
//
// The header used to say the round-trip is "verified in a real browser, not mocked" — which meant
// the mutation gate could break every branch of this file and no test would notice. A browser-only
// claim is exactly where test-theatre hides: the suite is green because the code never runs. The
// fake below is ten lines of request objects, and it makes every guard in this file falsifiable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idbAvailable, openIdbAdapter } from './idb-adapter.mjs';

/** The smallest IndexedDB that honours the adapter's contract: requests with onsuccess/onerror. */
function fakeIDB({ failGet = false, failOpen = false, bareErrors = false } = {}) {
  const dbs = new Map();
  const mkReq = (result, error) => {
    const r = { result, error };
    queueMicrotask(() => (error !== undefined || (failGet && r._isGet))
      ? r.onerror && r.onerror()
      : r.onsuccess && r.onsuccess());
    return r;
  };
  return {
    open(dbName) {
      const req = {};
      queueMicrotask(() => {
        if (failOpen) {
          if (!bareErrors) req.error = new Error('open exploded');
          req.onerror && req.onerror();
          return;
        }
        if (!dbs.has(dbName)) dbs.set(dbName, new Map());
        const data = dbs.get(dbName);
        req.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              get: (id) => {
                const r = mkReq(data.get(id), bareErrors ? undefined : undefined);
                r._isGet = true;
                if (failGet && !bareErrors) r.error = new Error('get exploded');
                return r;
              },
              put: (v, id) => { data.set(id, v); return mkReq(undefined); },
              delete: (id) => { data.delete(id); return mkReq(undefined); },
              getAllKeys: () => mkReq([...data.keys()]),
              clear: () => { data.clear(); return mkReq(undefined); },
            }),
          }),
        };
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    deleteDatabase(dbName) { dbs.delete(dbName); return mkReq(undefined); },
  };
}

const withIDB = async (idb, fn) => {
  globalThis.indexedDB = idb;
  try { return await fn(); } finally { delete globalThis.indexedDB; }
};

test('THE GUARD TELLS THE TRUTH IN EVERY ENVIRONMENT', () => {
  // Bare Node: no indexedDB at all. The typeof check is what stops this being a ReferenceError —
  // flip it and idbAvailable() THROWS instead of answering, which is the worst thing a
  // feature-detect can do.
  assert.equal(idbAvailable(), false, 'bare Node reported IndexedDB as available');

  // Present-but-null is a real browser failure mode (privacy modes), and it is not availability.
  globalThis.indexedDB = null;
  try { assert.equal(idbAvailable(), false, 'indexedDB === null reported as available'); }
  finally { delete globalThis.indexedDB; }

  globalThis.indexedDB = fakeIDB();
  try { assert.equal(idbAvailable(), true); }
  finally { delete globalThis.indexedDB; }
});

test('opening without IndexedDB refuses with a sentence, not a crash', async () => {
  await assert.rejects(() => openIdbAdapter('x'), /unavailable in this environment/);
});

test('A MISSING RECORD IS NULL, NEVER UNDEFINED', async () => {
  // The adapter promises the memoryAdapter interface, and vault code distinguishes "no record"
  // (null) from "no answer" (undefined). Blur them and every cache-miss path upstream misreads.
  await withIDB(fakeIDB(), async () => {
    const a = await openIdbAdapter('t1');
    assert.strictEqual(await a.get('nope'), null, 'a missing record came back undefined');
    await a.set('k', 'ciphertext');
    assert.equal(await a.get('k'), 'ciphertext');
  });
});

test('the round-trip holds: set, keys, delete, clear', async () => {
  await withIDB(fakeIDB(), async () => {
    const a = await openIdbAdapter('t2');
    await a.set('a', '1'); await a.set('b', '2');
    assert.deepEqual((await a.keys()).sort(), ['a', 'b']);
    await a.delete('a');
    assert.deepEqual(await a.keys(), ['b']);
    await a.clear();
    assert.deepEqual(await a.keys(), []);
  });
});

test('A FAILED REQUEST WITH NO ERROR OBJECT STILL REJECTS WITH A REASON', async () => {
  // IndexedDB can fire onerror with request.error unset. `req.error || new Error(...)` is the only
  // thing standing between that and a rejection carrying undefined — which surfaces upstream as
  // "the vault failed: undefined", the least actionable sentence in the product.
  await withIDB(fakeIDB({ failGet: true, bareErrors: true }), async () => {
    const a = await openIdbAdapter('t3');
    await assert.rejects(() => a.get('k'), /IndexedDB request failed/,
      'the fallback reason was lost');
  });
});

test('and a failed request WITH an error keeps the real one', async () => {
  await withIDB(fakeIDB({ failGet: true }), async () => {
    const a = await openIdbAdapter('t4');
    await assert.rejects(() => a.get('k'), /get exploded/, 'the real error was replaced by the fallback');
  });
});

test('a failed OPEN with no error object names the database in its fallback', async () => {
  await withIDB(fakeIDB({ failOpen: true, bareErrors: true }), async () => {
    await assert.rejects(() => openIdbAdapter('the-db'), /could not open IndexedDB database "the-db"/);
  });
});

test('a failed open with a real error keeps it', async () => {
  await withIDB(fakeIDB({ failOpen: true }), async () => {
    await assert.rejects(() => openIdbAdapter('x'), /open exploded/);
  });
});
