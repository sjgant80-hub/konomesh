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

// FNV-1a 32-bit content address (hex). Deterministic, zero-dep. Identical content ⇒ identical id.
export function contentHash(content) {
  const s = String(content == null ? '' : content);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const DEFAULTS = {
  minScore: 0.7,                 // quality threshold the injected assessor must clear
  allow: ['permissive'],         // licence classes admitted without a human in the loop
};

export class Sieve {
  // assess: (candidate) => { score:Number } | Number. Required — the sieve computes no verdict itself.
  constructor({ assess, minScore = DEFAULTS.minScore, allow = DEFAULTS.allow } = {}) {
    if (typeof assess !== 'function') throw new Error('Sieve requires an injected assess(candidate) function');
    this.assess = assess;
    this.minScore = minScore;
    this.allow = new Set(allow);
  }

  // Sift candidates → { kept, rejected, flagged }. A candidate is { id?, content, licence?, source? }.
  //   kept     — cleared BOTH gates, deduped by content-address, provenance attached.
  //   rejected — failed the quality gate.
  //   flagged  — passed quality but its licence is not auto-admissible (needs a human decision).
  async sift(candidates = []) {
    const kept = [], rejected = [], flagged = [];
    const seen = new Set();

    for (const c of candidates) {
      const hash = contentHash(c.content);
      const raw = await this.assess(c);
      const score = typeof raw === 'number' ? raw : Number(raw && raw.score);
      const licenceClass = classifyLicence(c.licence);
      const record = {
        id: c.id || hash,
        hash,
        source: c.source || null,
        licence: c.licence || null,
        licenceClass,
        score: Number.isFinite(score) ? score : 0,
      };

      if (record.score < this.minScore) { rejected.push({ ...record, reason: `score ${record.score} < ${this.minScore}` }); continue; }
      if (!this.allow.has(licenceClass)) { flagged.push({ ...record, reason: `licence class "${licenceClass}" needs a human decision` }); continue; }
      if (seen.has(hash)) continue;         // content-address dedup — identical survivors collapse
      seen.add(hash);
      kept.push(record);
    }

    return {
      kept, rejected, flagged,
      summary: { in: candidates.length, kept: kept.length, rejected: rejected.length, flagged: flagged.length },
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
