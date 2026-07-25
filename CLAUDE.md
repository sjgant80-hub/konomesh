# CLAUDE.md · konomesh

Instructions for any agent working in this repository. See `SPEC.md` for the contract.

## What this is

The composed HERD economy: route (fallherd) → work (BODY) → gate (fallsieve) → sign (fallineage), in
one tract. `mesh.mjs` is the composition; `swarm.mjs` / `sieve.mjs` / `lineage.mjs` are vendored
engines; `index.html` is a demo.

## Invariants to preserve

1. **Nothing skips the gate.** Only sieve-**kept** artifacts get signed onto the ledger. Never sign a
   rejected or flagged artifact — that would defeat the quality + licence discipline the whole mesh
   exists to enforce.
2. **One append-only verifiable ledger.** `metabolize` extends the same Ed25519 chain across rounds;
   `verify()` must stay valid. Do not reset the ledger between rounds.
3. **No silent loss.** Report tasks with no worker/handler in `produced`; never drop them.
4. **Vendored engines are verified copies, not forks.** If you update `swarm.mjs`/`sieve.mjs`/
   `lineage.mjs`, re-sync from their source repos (fallherd/fallsieve/fallineage) and keep their test
   files green here. A change that reddens `npm test` does not ship.
5. **Zero dependencies.**

## Run
```
npm test
```
CI runs `npm test` (integration + the three vendored engine suites) on every push.

## Seam

Public, general-purpose distributed-runtime tool. Routing / gating / signing / provenance language
only. Do NOT introduce the private cosmology (no κ/θ/Ψ, no "Konomium genome" mysticism, no element or
dyad references). φ appears only as the golden ratio.
