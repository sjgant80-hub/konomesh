// ════════════════════════════════════════════════════════════════
// fallherd · a load-balancer-free work-distribution runtime
//
// Every worker computes its OWN slice of the work — there is no central router, no coordinator, no
// load balancer. Routing is IDENTITY-DERIVED consistent hashing: each worker places V virtual nodes
// on the unit ring at hash(`id#v`), and a key goes to the first virtual node at-or-after the key's
// hash (wrapping). Because a worker's positions come from its IDENTITY (not its enrolment order or
// history), two nodes that know the same membership route every key the same way — the property a
// decentralised mesh actually needs. Virtual nodes smooth the arc lengths so no worker is a hot spot,
// and add/remove only reshuffles the arcs the changed worker owned (~1/N of keys).
//
//   • decentralised — position is a pure function of the worker id; replicas agree with no consensus.
//   • balanced — V virtual nodes per worker keep the max/min load ratio tight (a single node per
//     worker leaves large gaps; virtual nodes are the standard fix).
//   • consistent — add/remove moves only the changed worker's keys.
//
// (The golden angle / sunflower placement is kept in `vogelPoint()` for VISUALISATION only — it is a
// pretty even layout, but it is NOT the routing mechanism, because index-order placement can't give
// replicas agreement. Routing is the hashed virtual-node ring above.)
//
// `dispatch()` turns the router into a runtime: it routes each task to its worker's handler and
// collects the results — the herd metabolising a queue of work. Zero dependencies, deterministic.
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

// Deterministic string → [0,1) hash: FNV-1a 32-bit, then a MurmurHash3 fmix32 avalanche so the bits
// are well spread (plain FNV-1a clusters badly on `id#v` keys, wrecking the ring balance). No deps.
export function hashKey(key) {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  // fmix32 finalizer — avalanche the accumulated state into a uniform 32-bit value
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 0) / 0x100000000);
}

export const VNODES = 160;  // virtual nodes per worker — smooths arc lengths so load stays balanced

// The decentralised router. Each worker owns V virtual nodes at hash('id#v'); a key goes to the first
// virtual node at-or-after the key's hash on the ring (wrapping). Positions derive from IDENTITY, so
// the ring is a pure function of the membership set — replicas agree, order and history are irrelevant.
export class Swarm {
  constructor(workerIds = []) {
    this.workers = [];
    this.setWorkers(workerIds);
  }

  _rebuild() {
    const ring = [];
    for (const id of this.workers) for (let v = 0; v < VNODES; v++) ring.push({ id, pos: hashKey(`${id}#${v}`) });
    // sort by position; a stable id tie-break keeps the ring identical across replicas on hash ties
    this.ring = ring.sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Worker ids are normalised to strings, so a numeric id 1 and a string '1' are the same worker (they
  // already hash to the same ring positions via `${id}#v`); without this their identical positions
  // would be tie-broken by array order, reintroducing order-dependence.
  setWorkers(workerIds) { this.workers = [...new Set(workerIds.map(String))]; this._rebuild(); return this; }

  get size() { return this.workers.length; }

  // Which worker owns this key? The first virtual node at-or-after the key's hash, wrapping around.
  route(key) {
    if (this.ring.length === 0) return null;
    const h = hashKey(key);
    // binary search for the first ring node with pos >= h
    let lo = 0, hi = this.ring.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.ring[mid].pos >= h) hi = mid; else lo = mid + 1; }
    return this.ring[lo % this.ring.length].id; // wrap
  }

  add(id) { const s = String(id); if (!this.workers.includes(s)) { this.workers.push(s); this._rebuild(); } return this; }
  remove(id) { const s = String(id); this.workers = this.workers.filter(w => w !== s); this._rebuild(); return this; }

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
