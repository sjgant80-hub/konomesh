// ════════════════════════════════════════════════════════════════
// fallsieve · a curation gate — keep what passes, discard the rest, respect the licence
//
// The EXPLORE engine: feed it a set of candidate artifacts (code, snippets, datasets — anything with
// content + provenance) and it keeps only the ones that clear TWO gates and drops the rest:
//
//   1. QUALITY — an injected `assess(candidate) → { score, ... }` runs on each. Below the threshold,
//      it's discarded. The assessor is a parameter, so the sieve is benchmark-agnostic (bring your
//      own — e.g. acg-assessor); the sieve never invents a verdict.
//   2. LICENCE — a candidate you cannot legally reuse is not "kept" just because it scored well.
//      Permissive licences pass; copyleft and unknown licences are FLAGGED, never silently admitted.
//      Ingesting other people's work without licence discipline is how a curation tool becomes theft.
//
// Survivors are content-addressed (identical content dedupes) and carry their full provenance
// (source, licence, score, hash). Nothing is admitted without a source. Zero deps, deterministic.
// ════════════════════════════════════════════════════════════════

// SPDX-ish licence buckets. Permissive → reusable; copyleft → reciprocal obligations (flag for a
// human); unknown/none → do not assume you may reuse it.
export const LICENCE_CLASS = {
  permissive: ['MIT', 'APACHE-2.0', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'ISC', 'UNLICENSE', 'CC0-1.0', '0BSD'],
  copyleft: ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'MPL-2.0', 'CC-BY-SA-4.0'],
};

export function classifyLicence(licence) {
  const l = String(licence || '').trim().toUpperCase();
  if (!l) return 'unknown';
  if (LICENCE_CLASS.permissive.includes(l)) return 'permissive';
  if (LICENCE_CLASS.copyleft.includes(l)) return 'copyleft';
  return 'unknown';
}

// 128-bit content address (hex). Deterministic, zero-dep. Identical content ⇒ identical id. A 32-bit
// address collided within ~65k artifacts (birthday bound), silently dropping distinct content at
// curation scale; 128 bits pushes that past any real corpus. Four FNV-1a passes with distinct seeds,
// each avalanched (fmix32), concatenated. Objects are canonically JSON-serialised; unserialisable
// content (circular / BigInt) yields a stable marker rather than throwing (the caller isolates it).
export function contentHash(content) {
  // Serialise the content; genuinely unserialisable content (circular / BigInt) throws here, and the
  // caller (sift) isolates that candidate into `errored` rather than aborting the batch.
  let s = content == null ? '' : typeof content === 'string' ? content : JSON.stringify(content);
  if (s === undefined) s = String(content);   // JSON.stringify(fn/symbol) → undefined
  let out = '';
  for (const seed of [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]) {
    let h = seed;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out;   // 32 hex chars = 128-bit
}

const DEFAULTS = {
  minScore: 0.7,                 // quality threshold the injected assessor must clear
  allow: ['permissive'],         // licence classes admitted without a human in the loop
};

export class Sieve {
  // assess: (candidate) => { score:Number } | Number. Required — the sieve computes no verdict itself.
  constructor({ assess, minScore = DEFAULTS.minScore, allow = DEFAULTS.allow } = {}) {
    if (typeof assess !== 'function') throw new Error('Sieve requires an injected assess(candidate) function');
    // A non-finite threshold (null / '' / NaN / a stray string from config) would make every
    // `score < minScore` comparison false and silently admit ALL candidates — a gate that isn't a
    // gate. Fail loud instead: an invalid threshold is a configuration error, not a pass-everything.
    if (!Number.isFinite(minScore)) throw new Error('Sieve minScore must be a finite number');
    this.assess = assess;
    this.minScore = minScore;
    this.allow = new Set(allow);
  }

  // Sift candidates → { kept, rejected, flagged }. A candidate is { id?, content, licence?, source? }.
  //   kept     — cleared BOTH gates, deduped by content-address, provenance attached.
  //   rejected — failed the quality gate.
  //   flagged  — passed quality but its licence is not auto-admissible (needs a human decision).
  async sift(candidates = []) {
    const kept = [], rejected = [], flagged = [], errored = [];
    const seen = new Set();
    let deduped = 0;   // survivors that collapsed onto an already-kept content-address

    for (const c of (candidates || [])) {
      if (c == null || typeof c !== 'object') { errored.push({ candidate: c, reason: 'candidate is not an object' }); continue; }
      // FULL per-candidate isolation: EVERY field read (including c.id / c.source / c.licence, which
      // could be throwing accessors on a hostile artifact) plus hashing and assessing happen inside the
      // guard, so a poison candidate drops to `errored` — it never aborts the batch. The catch itself
      // reads no candidate property, so it cannot re-throw.
      let hash, score, licenceClass, cid, csource, clicence;
      try {
        cid = c.id; csource = c.source; clicence = c.licence;
        hash = contentHash(c.content);
        const raw = await this.assess(c);
        score = typeof raw === 'number' ? raw : Number(raw && raw.score);
        licenceClass = classifyLicence(clicence);
      } catch (e) {
        errored.push({ id: null, source: null, reason: `processing threw: ${e && e.message || e}` });
        continue;
      }
      const record = {
        id: cid || hash,
        hash,
        source: csource || null,
        licence: clicence || null,
        licenceClass,
        score: Number.isFinite(score) ? score : 0,
      };

      if (record.score < this.minScore) { rejected.push({ ...record, reason: `score ${record.score} < ${this.minScore}` }); continue; }
      if (!this.allow.has(licenceClass)) { flagged.push({ ...record, reason: `licence class "${licenceClass}" needs a human decision` }); continue; }
      if (seen.has(hash)) { deduped++; continue; }   // identical content-address collapses (counted, not silently lost)
      seen.add(hash);
      kept.push(record);
    }

    // reconciliation holds by construction: kept + rejected + flagged + errored + deduped === in
    return {
      kept, rejected, flagged, errored, deduped,
      summary: { in: (candidates || []).length, kept: kept.length, rejected: rejected.length, flagged: flagged.length, errored: errored.length, deduped },
    };
  }
}

// Group survivors that share content (across differing ids/sources) — the dedup/merge view. Returns
// clusters [{ hash, members:[record...] }] so a caller can see what recombines with what.
export function cluster(records) {
  const by = new Map();
  for (const r of records) { if (!by.has(r.hash)) by.set(r.hash, []); by.get(r.hash).push(r); }
  return [...by.entries()].map(([hash, members]) => ({ hash, members })).sort((a, b) => b.members.length - a.members.length);
}

export default Sieve;
