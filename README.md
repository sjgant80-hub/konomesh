# konomesh

**Live:** [sjgant80-hub.github.io/konomesh](https://sjgant80-hub.github.io/konomesh/)

The **HERD economy** — three sovereign engines wired into one tract. The swarm metabolises a queue of
work into quality-gated, provenance-signed artifacts, load-balanced across workers, with a verifiable
output history and **no central coordinator** anywhere in the loop.

```
task ──▶ ROUTE ──▶ WORK ──▶ GATE ──▶ SIGN ──▶ verifiable ledger
      (fallherd)  (BODY)  (fallsieve) (fallineage)
```

1. **ROUTE** ([fallherd](https://sjgant80-hub.github.io/fallherd/)) — golden-ratio ring, no load balancer.
2. **WORK** (BODY) — the routed worker's handler runs the task and produces an artifact.
3. **GATE** ([fallsieve](https://sjgant80-hub.github.io/fallsieve/)) — quality + licence gate; junk is
   rejected, copyleft/unknown is flagged, never silently kept.
4. **SIGN** ([fallineage](https://sjgant80-hub.github.io/fallineage/)) — each survivor is appended to
   one Ed25519 chain, so the mesh's entire output history is tamper-evident.

## Use

```js
import { Mesh } from './mesh.mjs';
import { generateIdentity } from './lineage.mjs';

const mesh = new Mesh({
  workers:  ['w0', 'w1', 'w2'],
  handlers: { w0: doWork, w1: doWork, w2: doWork },   // (task) => ({ content, licence, source })
  assess:   myBenchmark,                              // quality gate — bring your own
  identity: await generateIdentity(),                 // signs the ledger
  minScore: 0.7,
});

const round = await mesh.metabolize(tasks);   // { produced, kept, rejected, flagged, signed, summary }
await mesh.verify();                          // the whole output ledger is one valid Ed25519 chain
mesh.contribution();                          // per-worker share of what got KEPT
```

### Persistent, encrypted ledger (optional)

Pass an opened [konomium-vault](https://sjgant80-hub.github.io/konomium-vault/) `Vault` as `store` and
the signed ledger is persisted **AES-GCM encrypted** after every round — the mesh's output history
survives a restart without the plaintext ever touching disk:

```js
import { Vault } from './vault.mjs';
const store = await new Vault().open('your master seed');
const mesh  = new Mesh({ ...opts, store });
await mesh.metabolize(tasks);   // ledger auto-saved, encrypted
// …after a restart, on a fresh Mesh with the same store + identity:
await mesh.loadLedger();        // resumes the same verifiable chain
```

## Test

```
npm test
```

Zero dependencies — the three engines are vendored (each zero-dep) and verified in-repo.
