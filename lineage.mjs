// ════════════════════════════════════════════════════════════════
// fallineage · Ed25519-signed provenance chains (the LINEAGE descent)
//
// Answers one question un-forgeably: "who made this, from what, in what order?" A lineage is a chain
// of records — a root MINT and successive FORKs — where each record is signed by its author's Ed25519
// key and points at its parent by the parent's own content-address. `verifyLineage()` walks the chain
// and rejects any tampering, any broken parent link, and any forged signature.
//
// The load-bearing separation: three independent identifiers, never conflated —
//   • contentHash — WHAT the artifact is (SHA-256 of its bytes). Split from provenance on purpose:
//     two people can hold the same content; that says nothing about who authored the lineage.
//   • record id  — the content-address of the provenance RECORD itself (who/parent/seq/sig). This is
//     what a child points at, so a forged parent cannot be substituted without breaking the chain.
//   • sig        — an Ed25519 proof that THIS author minted THIS record. Not transferable, not forgeable
//     without the private key.
//
// Real Web Crypto Ed25519 (browser + Node ≥ 20). Zero dependencies. The private key never leaves the
// identity object; only the public key (hex) is embedded in records.
// ════════════════════════════════════════════════════════════════

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('fallineage: Web Crypto (crypto.subtle) unavailable — needs a browser or Node >= 20');
const ENC = new TextEncoder();

const hexOf = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const bytesOf = hex => { const u = new Uint8Array(hex.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16); return u; };

export async function sha256Hex(str) {
  return hexOf(await subtle.digest('SHA-256', ENC.encode(String(str))));
}

// A fresh signing identity. `pub` (hex) is safe to publish/embed; `keyPair.privateKey` stays here.
export async function generateIdentity() {
  const keyPair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = hexOf(await subtle.exportKey('raw', keyPair.publicKey));
  return { keyPair, pub };
}

// The canonical bytes a record's signature covers — the provenance claim, without the sig or id.
function canon(r) {
  return JSON.stringify({ contentHash: r.contentHash, author: r.author, parent: r.parent, seq: r.seq });
}

async function signCanon(identity, rec) {
  const sig = hexOf(await subtle.sign({ name: 'Ed25519' }, identity.keyPair.privateKey, ENC.encode(canon(rec))));
  const id = await sha256Hex(canon(rec) + sig);
  return { ...rec, sig, id };
}

// Root of a lineage: an author mints a claim over some content.
export async function mint(content, identity) {
  const contentHash = await sha256Hex(content);
  return signCanon(identity, { contentHash, author: identity.pub, parent: null, seq: 0 });
}

// A fork: a (possibly different) author derives a new record from a parent, pointing at the parent's id.
export async function fork(parent, content, identity) {
  const contentHash = await sha256Hex(content);
  return signCanon(identity, { contentHash, author: identity.pub, parent: parent.id, seq: parent.seq + 1 });
}

// Verify a single record: its id must content-address its own canonical form + sig (no tampering),
// and the signature must verify against the author's public key.
export async function verifyRecord(rec) {
  if (!rec || typeof rec !== 'object') return { valid: false, reason: 'not a record' };
  const expectId = await sha256Hex(canon(rec) + rec.sig);
  if (expectId !== rec.id) return { valid: false, reason: 'record id does not match its contents — tampered' };
  let pub;
  try { pub = await subtle.importKey('raw', bytesOf(rec.author), { name: 'Ed25519' }, false, ['verify']); }
  catch { return { valid: false, reason: 'author public key is malformed' }; }
  const ok = await subtle.verify({ name: 'Ed25519' }, pub, bytesOf(rec.sig), ENC.encode(canon(rec)));
  return ok ? { valid: true } : { valid: false, reason: 'signature does not verify against the author key' };
}

// Verify a whole chain [root, …, tip]: every record signs true, parents link by id, seq increments.
export async function verifyLineage(chain) {
  const breaks = [];
  if (!Array.isArray(chain) || chain.length === 0) return { valid: false, depth: 0, root: null, tip: null, breaks: [{ reason: 'empty chain' }] };

  for (let i = 0; i < chain.length; i++) {
    const rec = chain[i];
    const v = await verifyRecord(rec);
    if (!v.valid) breaks.push({ seq: rec && rec.seq, id: rec && rec.id, reason: v.reason });

    if (i === 0) {
      if (rec.parent !== null) breaks.push({ seq: rec.seq, reason: 'root must have a null parent' });
      if (rec.seq !== 0) breaks.push({ seq: rec.seq, reason: 'root seq must be 0' });
    } else {
      if (rec.parent !== chain[i - 1].id) breaks.push({ seq: rec.seq, reason: `parent link broken — points at ${rec.parent}, previous record is ${chain[i - 1].id}` });
      if (rec.seq !== chain[i - 1].seq + 1) breaks.push({ seq: rec.seq, reason: 'seq does not increment by 1' });
    }
  }

  return {
    valid: breaks.length === 0,
    depth: chain.length,
    root: chain[0].id,
    tip: chain[chain.length - 1].id,
    authors: [...new Set(chain.map(r => r.author))],
    breaks,
  };
}

export default verifyLineage;
