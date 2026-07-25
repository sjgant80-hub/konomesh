// ════════════════════════════════════════════════════════════════
// fallswarm · a load-balancer-free work-distribution runtime
//
// Every worker computes its OWN slice of the work — there is no central router, no coordinator, no
// load balancer. Workers are placed on a unit ring by the golden-ratio low-discrepancy sequence
// (the same additive recurrence that gives a sunflower its 137.5° seed spacing): worker i sits at
// frac(i · φ⁻¹). That sequence is the most uniform placement of N points for ANY N, so:
//
//   • load is even — keys hash onto the ring and go to the nearest worker, and the workers are
//     maximally spread, so no worker is a hot spot;
//   • it is consistent-hashing stable — adding or removing a worker only reshuffles the one arc that
//     changes hands, not the whole assignment;
//   • it is decentralised — a worker needs only its own index and the worker count to know its arc;
//     no node has to be told what to do by a central authority.
//
// `dispatch()` turns the router into a runtime: it routes each task to its worker's handler and
// collects the results — the swarm metabolising a queue of work. Zero dependencies, deterministic.
// ════════════════════════════════════════════════════════════════

export const PHI = (1 + Math.sqrt(5)) / 2;      // 1.6180339887…
export const PHI_INV = PHI - 1;                 // 0.6180339887… — the golden-ratio conjugate
export const GOLDEN_ANGLE_DEG = 360 * (1 - 1 / PHI); // 137.50776… — the sunflower seed angle

const frac = x => x - Math.floor(x);

// A worker's canonical position on the unit ring [0,1) and on the sunflower disc (for visualisation).
export function vogelPoint(i) {
  const ring = frac(i * PHI_INV);
  const angle = frac(i * (GOLDEN_ANGLE_DEG / 360)) * 360;
  const r = Math.sqrt(i);
  return { i, ring, angle, r, x: r * Math.cos(angle * Math.PI / 180), y: r * Math.sin(angle * Math.PI / 180) };
}

// Deterministic string → [0,1) hash (FNV-1a 32-bit, mapped to the unit interval). No dependencies.
export function hashKey(key) {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) / 0x100000000);
}

// The decentralised router. Workers are ordered by their ring position; a key goes to the worker
// whose position is the nearest one at-or-before it on the ring (wrapping around) — a golden-ratio
// consistent-hash ring.
export class Swarm {
  constructor(workerIds = []) {
    this._idx = new Map();   // worker id → its STABLE golden index (assigned once, never reshuffled)
    this._next = 0;
    this.workers = [];
    this.setWorkers(workerIds);
  }

  // Each worker keeps the ring position of its ENROLMENT index for life. Removing a worker never
  // shifts anyone else's position (the golden-ratio sequence stays well-spread even with gaps), which
  // is what makes the ring consistent-hashing stable.
  _slot(id) { if (!this._idx.has(id)) this._idx.set(id, this._next++); return this._idx.get(id); }

  _rebuild() {
    this.ring = this.workers
      .map(id => ({ id, pos: frac(this._slot(id) * PHI_INV) }))
      .sort((a, b) => a.pos - b.pos);
  }

  setWorkers(workerIds) { this.workers = [...workerIds]; for (const id of this.workers) this._slot(id); this._rebuild(); return this; }

  get size() { return this.workers.length; }

  // Which worker owns this key? The first ring node at-or-after the key's hash, wrapping around.
  route(key) {
    if (this.ring.length === 0) return null;
    const h = hashKey(key);
    for (const node of this.ring) if (node.pos >= h) return node.id;
    return this.ring[0].id; // wrap
  }

  add(id) { if (!this.workers.includes(id)) { this.workers.push(id); this._rebuild(); } return this; }
  remove(id) { this.workers = this.workers.filter(w => w !== id); this._rebuild(); return this; }

  // How many of these keys land on each worker — for checking balance.
  distribution(keys) {
    const counts = Object.fromEntries(this.workers.map(w => [w, 0]));
    for (const k of keys) { const w = this.route(k); if (w != null) counts[w]++; }
    return counts;
  }
}

// Metabolise a queue: route each task to its worker's handler and collect { task, worker, result }.
// handlers is a map workerId → (task) => result (sync or async). Tasks with no handler are reported,
// not silently dropped.
export async function dispatch(swarm, tasks, handlers, keyOf = t => t.key ?? t.id ?? String(t)) {
  const out = [];
  for (const task of tasks) {
    const worker = swarm.route(keyOf(task));
    const fn = worker != null ? handlers[worker] : null;
    if (!fn) { out.push({ task, worker, ok: false, error: worker == null ? 'no workers' : `no handler for ${worker}` }); continue; }
    try { out.push({ task, worker, ok: true, result: await fn(task) }); }
    catch (e) { out.push({ task, worker, ok: false, error: String(e && e.message || e) }); }
  }
  return out;
}

export default Swarm;
