# konomesh · design note

> Spec: **konomesh-spec-v1**. The contract of the composed HERD economy.

## Surface

`mesh.mjs` exports:

- `Mesh` — `new Mesh({ workers, handlers, assess, identity, minScore?, allow?, keyOf? })`,
  `metabolize(tasks) → { produced, kept, rejected, flagged, signed, summary }`, `verify()`,
  `contribution()`.
- re-exports `Swarm`, `Sieve`; the vendored engines (`swarm.mjs`, `sieve.mjs`, `lineage.mjs`) keep
  their own surfaces.

## The tract

Per `metabolize` round:

1. **route + work** — `dispatch` sends each task to its worker (golden-ratio ring) and runs the
   worker's handler → an artifact `{ content, licence?, source? }`.
2. **gate** — successfully-produced artifacts go through the `Sieve`: quality (injected `assess`) +
   licence. Kept / rejected / flagged.
3. **sign** — each kept artifact is appended to the single Ed25519 provenance chain (`ledger`) —
   `mint` for the first, `fork` thereafter.

## Invariants

1. **Nothing skips the gate.** Only sieve-kept artifacts are signed; rejected/flagged never reach the
   ledger.
2. **One verifiable chain.** The ledger is append-only across rounds and always verifies via
   `verifyLineage`; tampering with any entry breaks it.
3. **No silent loss.** A task with no worker/handler is reported in `produced`, never dropped.
4. **Decentralised.** Routing has no central coordinator; the gate assessor is injected; the identity
   signs locally.
5. **Zero dependencies.** Engines vendored + verified in-repo (their own suites run in `npm test`).

## Verification

`npm test` runs the integration suite (`mesh.test.mjs`) plus the three vendored engine suites — good
work signed, low-quality rejected, bad-licence flagged, tamper-evidence, multi-round chaining,
contribution spread, missing-handler reporting. CI runs it on push.
