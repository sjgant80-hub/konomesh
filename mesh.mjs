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
import { mint, fork, verifyLineage } from './lineage.mjs';

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
  }

  static LEDGER_KEY = 'konomesh-ledger';

  // Reload a previously-persisted ledger from the encrypted store (call after constructing with the
  // same store + identity to resume where a prior run left off).
  async loadLedger() {
    if (this.store) { const saved = await this.store.get(Mesh.LEDGER_KEY); if (Array.isArray(saved)) this.ledger = saved; }
    return this.ledger;
  }

  // Run a batch of tasks through the whole tract. Returns what was produced, kept, rejected, flagged,
  // and the new ledger records signed this round.
  async metabolize(tasks = []) {
    // 1 + 2 · route each task to its worker and run the work (BODY).
    const produced = await dispatch(this.swarm, tasks, this.handlers, this.keyOf);

    // 3 · gate the produced artifacts. Only successfully-produced ones become candidates.
    const candidates = produced
      .filter(p => p.ok && p.result && p.result.content != null)
      .map(p => ({
        id: `${p.worker}:${this.keyOf(p.task)}`,
        content: p.result.content,
        licence: p.result.licence,
        source: p.worker,
      }));
    const sifted = await this.sieve.sift(candidates);

    // 4 · sign each survivor onto the single provenance chain (append-only, tamper-evident).
    const signedThisRound = [];
    for (const kept of sifted.kept) {
      const rec = this.ledger.length === 0
        ? await mint(kept.content, this.identity)
        : await fork(this.ledger[this.ledger.length - 1], kept.content, this.identity);
      const entry = { ...rec, worker: kept.source, artifact: kept.id };
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

  // Verify the whole output history — the mesh's ledger is one Ed25519 chain.
  async verify() { return verifyLineage(this.ledger); }

  // Per-worker share of what actually got KEPT (the productive load, not just routed load).
  contribution() {
    const c = {};
    for (const e of this.ledger) c[e.worker] = (c[e.worker] || 0) + 1;
    return c;
  }
}

export default Mesh;
export { Swarm, Sieve };
