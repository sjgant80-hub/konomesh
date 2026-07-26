// ════════════════════════════════════════════════════════════════
// konomesh · the HERD economy — route → work → gate → sign, composed
//
// The three engines of the herd, wired into one tract:
//   1. ROUTE  (fallherd/swarm) — a task is routed to a worker with no central coordinator.
//   2. WORK   (BODY) — that worker's handler runs the task and produces an artifact
//                      { content, licence?, source? }. This is the card→tool binding: a task name
//                      resolves to the code that does it.
//   3. GATE   (fallsieve) — every produced artifact is assessed for quality + licence. Only survivors
//                      pass; low-quality is rejected, copyleft/unknown-licence is flagged, never
//                      silently admitted.
//   4. SIGN   (fallineage) — each survivor is appended to ONE Ed25519 provenance chain, giving the
//                      mesh a single tamper-evident ledger of everything it has produced and kept.
//
// The result: the swarm metabolises a queue of work into quality-gated, provenance-signed artifacts,
// load-balanced across workers, with a verifiable output history — and no central authority anywhere
// in the loop. Zero dependencies (the three engines are vendored, each zero-dep itself).
// ════════════════════════════════════════════════════════════════

import { Swarm, dispatch } from './swarm.mjs';
import { Sieve } from './sieve.mjs';
import { mint, fork, verifyLineage, sha256Hex } from './lineage.mjs';

// Canonical serialisation so object artifacts don't all collapse to "[object Object]" when hashed.
const ser = v => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
// The exact bytes signed for a ledger entry's attribution — one definition, used by both sign + verify
// so the key order can never drift between them.
const attribCanon = (worker, artifact, payloadHash) => JSON.stringify({ worker, artifact, payloadHash });

export class Mesh {
  // opts: { workers[], handlers{workerId→(task)=>{content,licence?,source?}}, assess, identity,
  //         minScore?, allow?, keyOf?, store? }
  // store (optional) — an opened konomium Vault. When present, the signed ledger is persisted
  // ENCRYPTED after every round and can be reloaded with loadLedger(), so the mesh's output history
  // survives a restart without the plaintext ever touching disk.
  constructor({ workers = [], handlers = {}, assess, identity, minScore, allow, keyOf, store } = {}) {
    if (!identity || !identity.keyPair) throw new Error('Mesh requires a signing identity (from generateIdentity())');
    this.swarm = new Swarm(workers);
    this.handlers = handlers;
    this.sieve = new Sieve({ assess, minScore, allow });
    this.identity = identity;
    this.keyOf = keyOf || (t => t.key ?? t.id ?? String(t));
    this.store = store || null;
    this.ledger = [];   // the growing Ed25519 provenance chain of accepted artifacts
    this._lock = Promise.resolve();   // single-flight guard so concurrent metabolize() calls serialise
  }

  static LEDGER_KEY = 'konomesh-ledger';

  // Reload a previously-persisted ledger from the encrypted store (call after constructing with the
  // same store + identity to resume where a prior run left off).
  async loadLedger() {
    if (this.store) { const saved = await this.store.get(Mesh.LEDGER_KEY); if (Array.isArray(saved)) this.ledger = saved; }
    return this.ledger;
  }

  // Run a batch through the whole tract. Serialised: two concurrent metabolize() calls would both fork
  // from the same tip across the awaits and corrupt the append-only chain, so calls queue on _lock.
  metabolize(tasks = []) {
    const run = this._lock.then(() => this._metabolize(tasks));
    this._lock = run.then(() => {}, () => {});   // the queue continues whether a round resolves or throws
    return run;
  }

  async _metabolize(tasks) {
    // 1 + 2 · route each task to its worker and run the work (BODY).
    const produced = await dispatch(this.swarm, tasks, this.handlers, this.keyOf);

    // 3 · gate the produced artifacts. Only successfully-produced ones become candidates.
    // Candidate ids must be UNIQUE, or two artifacts sharing a task key (worker+key) would collide and
    // one's ledger entry could bind the OTHER's content (even a rejected sibling's). Disambiguate on
    // collision so every produced artifact keeps its own id and its own content.
    const usedIds = new Set();
    const candidates = produced
      .filter(p => p.ok && p.result && p.result.content != null)
      .map((p, i) => {
        let id = `${p.worker}:${this.keyOf(p.task)}`;
        while (usedIds.has(id)) id = `${id}#${i}`;
        usedIds.add(id);
        return { id, content: p.result.content, licence: p.result.licence, source: p.worker };
      });
    // keep the real produced content addressable by its now-unique artifact id — the sieve's kept
    // records carry only a content-address, so we hash the ACTUAL content here (SHA-256) to bind it.
    const contentOf = new Map(candidates.map(c => [c.id, c.content]));
    const sifted = await this.sieve.sift(candidates);

    // 4 · sign each survivor onto the single provenance chain (append-only, tamper-evident). The
    // SIGNED content binds the attribution (worker + artifact + a hash of the REAL produced content),
    // so none of those can be rewritten without breaking the signature — and two different payloads for
    // the same task no longer sign identically.
    const signedThisRound = [];
    for (const kept of sifted.kept) {
      const payloadHash = await sha256Hex(ser(contentOf.get(kept.id)));
      const signed = attribCanon(kept.source, kept.id, payloadHash);
      const rec = this.ledger.length === 0
        ? await mint(signed, this.identity)
        : await fork(this.ledger[this.ledger.length - 1], signed, this.identity);
      const entry = { ...rec, worker: kept.source, artifact: kept.id, payloadHash };
      this.ledger.push(entry);
      signedThisRound.push(entry);
    }

    // persist the ledger encrypted-at-rest if a store was provided
    if (this.store && signedThisRound.length) await this.store.put(Mesh.LEDGER_KEY, this.ledger);

    return {
      produced,
      kept: sifted.kept,
      rejected: sifted.rejected,
      flagged: sifted.flagged,
      signed: signedThisRound,
      summary: {
        in: tasks.length,
        produced: candidates.length,
        kept: sifted.kept.length,
        rejected: sifted.rejected.length,
        flagged: sifted.flagged.length,
        ledgerDepth: this.ledger.length,
      },
    };
  }

  // Verify the whole output history: the Ed25519 chain (via lineage) AND that each entry's attribution
  // (worker / artifact / payloadHash) reproduces its SIGNED contentHash — so tampering with the
  // attribution fields is caught even though they sit outside lineage's own canon.
  async verify() {
    // An empty ledger is legitimately valid (a round where everything was correctly rejected/flagged
    // signs nothing) — that is "nothing kept", not "tampered".
    if (this.ledger.length === 0) return { valid: true, depth: 0, root: null, tip: null, breaks: [] };
    const v = await verifyLineage(this.ledger);
    if (!v.valid) return v;
    for (const e of this.ledger) {
      const expect = await sha256Hex(attribCanon(e.worker, e.artifact, e.payloadHash));
      if (expect !== e.contentHash) {
        return { ...v, valid: false, breaks: [...(v.breaks || []), { seq: e.seq, reason: 'worker/artifact attribution does not match the signed contentHash — tampered' }] };
      }
    }
    return v;
  }

  // Per-worker share of what actually got KEPT (the productive load, not just routed load).
  contribution() {
    const c = {};
    for (const e of this.ledger) c[e.worker] = (c[e.worker] || 0) + 1;
    return c;
  }
}

export default Mesh;
export { Swarm, Sieve };
