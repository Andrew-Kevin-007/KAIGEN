# Mamori as a hash-pinned global contract: tooling and procedure (M6)

Status: 2026-11-04. Testnet only. The publish-only mode (section 4a) was run once on testnet with a 1,024-byte module: publish, create and attach were accepted and the cost was measured (section 6a). The Mamori vault run (`UseGlobalContract` and `init` in one transaction, then cage-check) has NOT been run; its tooling is unit-tested offline only. No audit. Mainnet is not touched, and G2 (mainnet publishing and its real cost) stays open.

Design source: ARCHITECTURE.md section 2.9 ("Ship Mamori as a hash-pinned global contract ... Init runs in the same transaction as attach and needs a `#[private]` init signed by the account's own key"). Code: `jobs/src/globalcontract.mjs` (plan, preflight, run, verification), `jobs/src/globaltx.mjs` (the two actions, signing, sending), the `globalcontract` command in `jobs/src/bin.mjs`, tests in `jobs/test/globalcontract.test.mjs`.

## 1. What the procedure does

| Step | Signed by | Actions |
|---|---|---|
| 1 publish | the funder (a funded testnet account) | `DeployGlobalContract`, mode CodeHash: the code is referenced by its sha256, immutable. Skipped if the node already has code under that hash. |
| 2 create | the funder | `CreateAccount`, `Transfer`, `AddKey` with the vault's new ML-DSA-65 key as full access. The vault never has a classical key. |
| 3 attach | the vault, with that ML-DSA-65 key | ONE transaction: `UseGlobalContract` (by hash) then `FunctionCall init`. Nobody can initialise the instance first. |
| 4 verify | nobody (reads) | See section 5. |

Every step the chain already shows done is skipped, so a run that died half way can be run again with the same command and does not burn twice.

## 2. What the contract allows (read from `contracts/mamori/src/lib.rs`; contracts untouched by this work)

Read at HEAD d4342c0 (`init` at line 387) and again in the working tree on 2026-11-04 (line 469): `lib.rs` has uncommitted edits from another stream, and `init` is unchanged in both. The wasm in `out/` can change when that stream rebuilds; this tool pins whatever file it is given, so read the hash it prints.

- `init` is `#[init] #[private] pub fn init(kizashi: AccountId, daily_limit: U128, delay_secs: u64)`. `#[private]` means the caller must be the account itself. A transaction signed by the vault's own key gives that (signer and receiver are the vault). A transaction signed by the funder does not, so the attach cannot be folded into the create transaction. This is the design in ARCHITECTURE.md 2.9, not a workaround.
- The init can run in the same transaction as the attach: the NEAR docs recommend exactly that (`with-init-call`), and the planner puts `UseGlobalContract` before `FunctionCall`. Whether the runtime loads a global contract for a call in the same receipt was NOT observed; it is the first thing the real run shows.
- A production build refuses `delay_secs` under 86,400 (`MIN_DELAY_SECS`). The tool's default is 86,400. Less works only with a drill build.
- Nothing in the contract blocks the plan. Two facts for the reader: (1) init is not callable again (`PanicOnDefault`, a second call finds state), so a wrong `--kizashi` or `--daily-limit` means a new vault, not a re-init; (2) the vault is created with the ML-DSA key as its only key, so it never holds a classical full-access key that has to be deleted later (the rehearsal in `testnet.mjs` enrols the ML-DSA key with a vault classical key and then deletes that key). This does not remove the "first ML-DSA enrolment" exposure of THREAT-MODEL.md section 4: the creation is still authorised by the funder's classical key, so that exposure moves to the funder at creation time.

## 3. Why there is a `globaltx.mjs`

`@fastnear/api` 2.5.0 (the version in `jobs/node_modules`) has no builder for `DeployGlobalContract` or `UseGlobalContract`. `@fastnear/borsh-schema` says "9-11 ... not modelled" and `@fastnear/utils` `mapAction` throws "Not implemented action" for any other type, so `sendTx` cannot carry them. The tool goes one level down: it serialises the transaction with the library's own borsh codec and its PublicKey, Signature and FunctionCall schemas, adds Action tags 9 and 10, signs the hash with any `{ publicKey, signHash }` signer and sends with the repo's own JSON-RPC client. A shape check refuses to run if a later library version models those tags itself.

Wire format, from nearcore source (`near-primitives` 0.38.0, protocol 88, in the local cargo registry): Action tag 9 = `DeployGlobalContract { code: u32 length + bytes, deploy_mode: u8 }` (0 = CodeHash, 1 = AccountId), tag 10 = `UseGlobalContract { contract_identifier }` with identifier tag 0 = CodeHash then 32 bytes, 1 = AccountId then a string. Only the by-hash forms are built; the by-account (mutable) forms are refused.

## 4. Commands

Dry run (reads the chain, signs and sends nothing, prints plan, preflight and the cost estimate):

    node jobs/src/bin.mjs globalcontract --kizashi <KIZASHI_ACCOUNT> --funder-file <FUNDER_FILE>

For real (burns the published-code cost; `--funder-file` defaults to `KAIGEN_FUNDER_FILE`):

    node jobs/src/bin.mjs globalcontract --kizashi <KIZASHI_ACCOUNT> --funder-file <FUNDER_FILE> --yes

Options: `--wasm` (default `out/prod/mamori.wasm`), `--vault` (default `gv-<first 8 hex of the wasm sha256>.<funder>`, must be a sub-account of the funder), `--vault-near` (default 1), `--daily-limit` (NEAR, default 1), `--delay-secs` (default 86400), `--admin-seed-file` (default `.kaigen-testnet/global-admin-seeds.json`, or under `KAIGEN_TESTNET_DIR`), `--rpc` (default `https://rpc.testnet.fastnear.com`). A node that says it is mainnet is refused whatever the flags.

The funder file is JSON `{"account_id": "...", "private_key": "ed25519:..."}`, the format of `KAIGEN_FUNDER_FILE`. The funder should be a named testnet account (it creates a sub-account). The tool never prints or returns the private key.

Read-only re-check of an existing vault, and the same cage-check on its own:

    node jobs/src/bin.mjs globalcontract --verify <VAULT> --wasm out/prod/mamori.wasm
    node jobs/src/bin.mjs cage-check <VAULT> --rpc https://rpc.testnet.fastnear.com --wasm out/prod/mamori.wasm --admin <ml-dsa-65-hash:... from the record>

Files written by a real run (all under `.kaigen-testnet/`, which is gitignored): the vault's admin seed (`global-admin-seeds.json`, written BEFORE the key is put on the account; back it up, it is the only key of the vault) and a record `global-contract-<vault>.json` with the hashes, transaction ids, the measured cost and the verification result. The record holds no secret.

Before running: pass `--wasm` the build whose hash you intend to publish. `out/` is not in git, and `docs/v3/REPRODUCIBLE-BUILD.md` does not exist yet, so the pinned hash is the hash of the file given. On 2026-11-04 `out/prod/mamori.wasm` is 376,192 bytes, sha256 `76abf7141d792199bd010bc7d8d84cdba6dafebc037e6a1bfb54a7c5a1d65532`, code hash `8zFCKcJBSNQhuVrm9sKWtugPEKMAySaas78LKVfvBaXb`. This replaces the 323,974 bytes that ROADMAP.md and ARCHITECTURE.md 2.9 quote.

## 4a. Publish-only mode and the order to run things in

`globalcontract publish --wasm <file>` publishes ANY valid wasm by code hash from the funder, creates a sub-account of the funder with a new ML-DSA-65 key as its only key, attaches that account with `UseGlobalContract` by the hash (no init, nothing is called), verifies over RPC that the account's `global_contract_hash` equals the published hash and that the code on chain hashes to it, and prints the MEASURED cost. It is a dry run unless `--yes`. `--wasm` is required (nothing is assumed, because it burns about 0.0001 NEAR per byte of whatever it is given), `--vault` names the sub-account (default `gp-<first 8 hex of the wasm sha256>.<funder>`), `--vault-near` its balance (default 0.1). Same files as section 4: the account's ML-DSA seed in `--admin-seed-file` before the key is used, and a record `global-contract-<account>.json`.

The output of a real run includes the funder's balance read before and after the publish transaction, and the split of what that transaction's OWN outcome burnt into gas and the deploy (storage) charge. `tokens_burnt` in the outcome is not gas alone: for a global deploy it also contains the storage charge, so the gas is taken from the gas UNITS (`gas_burnt` x the gas price, the price being the transaction outcome's own `tokens_burnt / gas_burnt`; a refund receipt burns no tokens and is not counted), and the deploy charge is what `tokens_burnt` holds beyond that:

    MEASURED publishing cost for <bytes> bytes of code:
      funder balance before <X> NEAR, after <Y> NEAR, fell by <Z> NEAR
      the outcome burnt <T> NEAR in all (tokens_burnt, which includes the storage charge)
      of which gas <G> NEAR (<units> gas units x <price> yoctoNEAR) and the deploy charge <C> NEAR
      deploy charge / bytes = <Q> yoctoNEAR per byte exactly (the estimate is 100000000000000000000 per byte, ...)
      gas of the other transactions: create <..>, attach <..> NEAR

If the outcome carries no usable `gas_burnt`, or the balance fell by more than the gas while the outcome shows no charge, the tool prints NO per-byte figure and says why (never a 0). The first real run printed gas = the whole 0.102466 NEAR and 0 per byte because the first version took `tokens_burnt` for gas; that is fixed and pinned by a test built from that run's real outcome.

The same numbers are in the record (`measured`: `bytes`, `funderBalanceBeforeYocto`, `funderBalanceAfterYocto`, `fellByYocto`, `tokensBurntYocto`, `gasUnits`, `gasPriceYocto`, `gasBurntYocto`, `storageBurnYocto`, `yoctoPerByte`, `yoctoPerByteRemainder`, `unexplainedYocto`, `warnings`). If the code is already on chain under that hash nothing is paid, nothing is measured, and the output says so.

Read-only analysis of a publish that already happened (any publish transaction, by its hash and signer; it calls `EXPERIMENTAL_tx_status`, takes the code hash from the transaction and the byte count from the code the node holds under it, or from `--bytes`):

    node jobs/src/bin.mjs globalcontract --cost-of <PUBLISH_TX_HASH> --signer <FUNDER_ACCOUNT_ID> [--bytes <n>]

The small module for the measurement is `jobs/test/fixtures/trivial.wasm`: 1,024 bytes, sha256 `806e2476b2af830f9cc990b199064e2111d42b115c652a67b7b49c6450b5b876` (code hash `9eLbZQzfJ1ktm2GTmfXThPX85eMeyagB83GAZqo5UN2H`), recorded in `trivial.wasm.sha256` and pinned by a unit test. It is hand-assembled from the wasm binary format by `jobs/test/fixtures/make-trivial-wasm.mjs` (no toolchain, no dependency; `node jobs/test/fixtures/make-trivial-wasm.mjs` rebuilds it byte for byte): no imports, no memory, one exported function `ping` with the NEAR method signature `() -> ()`, its body `nop` repeated until the file is exactly 1,024 bytes. The test checks that it compiles, runs and has that one export. Whether `DeployGlobalContract` validates or prepares the code is not known; a module with no memory import is what the runtime's own preparation tests accept (`near-vm-runner` 0.38.0, `prepare.rs`).

Run in this order. Each command without `--yes` is the dry run (reads only, prints the plan, the preflight and the estimate).

(1) The measurement run with the small fixture. Funds: the funder must have about 0.7 NEAR available (0.1024 burnt + 0.1 moved to the sub-account + a 0.5 NEAR margin the preflight demands); about 0.21 NEAR actually leaves it.

    node jobs/src/bin.mjs globalcontract publish --wasm jobs/test/fixtures/trivial.wasm --funder-file <FUNDER_FILE>
    node jobs/src/bin.mjs globalcontract publish --wasm jobs/test/fixtures/trivial.wasm --funder-file <FUNDER_FILE> --yes

Done on 2026-11-04 (section 6a): 0.0001 NEAR per byte, 100000000000000000000 yoctoNEAR, exactly. For the byte size of the wasm to publish, multiply: the cost of step 1 of the full run is `bytes x 100000000000000000000` yoctoNEAR plus gas.

(2) The full Mamori run (publish, vault with init, cage-check), after (1) has confirmed the price and the transaction path. Funds: about 39.12 NEAR available on ONE funder account at the estimated rate (37.6192 burnt for 376,192 bytes + 1 for the vault + 0.5 margin), plus gas. The tool uses one funder file and cannot pool two accounts: with about 19.8 NEAR spread over two funders the run is about 19.3 NEAR short, so first move the balance of one funder to the other with an ordinary transfer, and add faucet drops (about 10 NEAR each per IP per 12 h). After (1), replace 39.12 by `376192 x yoctoPerByte` NEAR plus 1.5.

    node jobs/src/bin.mjs globalcontract --kizashi <KIZASHI_ACCOUNT> --funder-file <FUNDER_FILE>
    node jobs/src/bin.mjs globalcontract --kizashi <KIZASHI_ACCOUNT> --funder-file <FUNDER_FILE> --yes

Use the `--wasm` that is the build you mean to pin (default `out/prod/mamori.wasm`; its size and hash change whenever it is rebuilt). A publish-only run of the same wasm first would publish it and leave an account without init; the full run then skips the publish. Do not do that to save a step: the cost is the same and the full run is the one that initialises the vault.

## 5. Verification (step 4)

Over RPC, after the attach: (1) `view_account` of the vault: `global_contract_hash` equals the published hash, `global_contract_account_id` is absent, and `code_hash` is the all-1s "no local code" value; (2) `view_global_contract_code` for that hash returns code that hashes to it; (3) the `config` view answers and equals the init arguments; (4) cage-check runs with the hash pinned and the new ML-DSA handle as admin, and every condition must be GREEN. The cage-check row ARCH-2.8-8 already reads `global_contract_hash`.

## 6. Cost

ESTIMATE, not measured: publishing burns 0.0001 NEAR per byte of code (nearcore `near-parameters` 0.38.0, `77.yaml`: `global_contract_storage_amount_per_byte` set from a 999999999999999999999999999 yN placeholder to 0.0001 N), which is the docs' "10 NEAR per 100 KB, entirely burnt". For 376,192 bytes that is about 37.6192 NEAR. With the vault's 1 NEAR and a 0.5 NEAR margin the funder needs about 39.1 NEAR available, plus gas. The vault's own cost is a small reference ("typically under 0.001 NEAR" per the docs) plus its state.

MEASURED on testnet, 1,024 bytes: see section 6a. The faucet gives about 10 NEAR per request (see `testnet.mjs`), so a funder with 39 NEAR needs several consolidated drops or another source: that is the practical blocker for the full run.

## 6a. The measured run (testnet, 2026-11-04)

Run by the coordinator with `globalcontract publish --wasm jobs/test/fixtures/trivial.wasm --funder-file <file> --yes` (1,024 bytes, sha256 `806e2476b2af830f9cc990b199064e2111d42b115c652a67b7b49c6450b5b876`, code hash `9eLbZQzfJ1ktm2GTmfXThPX85eMeyagB83GAZqo5UN2H`). Funder `kaigen-funder-a00266.testnet`, attached account `gp-806e2476.kaigen-funder-a00266.testnet`.

| Step | Transaction |
|---|---|
| publish (`DeployGlobalContract`, CodeHash) | `BpqsZRxPHFhsr26evVxELm9qJC5cnUE6GbhEM5AQNHfg` |
| create (`CreateAccount` + `Transfer` + `AddKey` ML-DSA-65) | `BbCsrkDCxbMLp3qMvTkU9jFZRV3NLHG35WCpeu6n4fLH` |
| attach (`UseGlobalContract` by hash, signed by the account's ML-DSA-65 key) | `7UFZN79bEgzTNYFhJuyG8KeAaLjxrh62PAiK24qKNDdW` |

The hash check passed (the account's `global_contract_hash` equals the published hash; the code on chain hashes to it).

Measured, from the funder's balances and the publish transaction's own outcome (`globalcontract --cost-of BpqsZRxP... --signer kaigen-funder-a00266.testnet`, a read-only `EXPERIMENTAL_tx_status` call, which gave the split below):

| Quantity | Value |
|---|---|
| Code | 1,024 bytes |
| Funder balance before | 9.968286 NEAR (9968286480263932600000000 yocto) |
| Funder balance after | 9.865820 NEAR (9865820049562835000000000 yocto) |
| Balance fell by | 0.102466 NEAR (102466430701097600000000 yocto) = the outcome's `tokens_burnt`, difference 0 |
| Gas | 664,307,010,976 gas units (299,801,760,976 for the transaction + 364,505,250,000 for the deploy receipt; the refund receipt's 223,182,562,500 units burnt no tokens) x 100,000,000 yocto = 0.000066431 NEAR |
| Deploy (storage) charge | 0.102400 NEAR = 102400000000000000000000 yocto |
| Charge per byte | 100000000000000000000 yocto = 0.0001 NEAR, exactly (1,024 x 10^20) |
| Gas of the other two transactions | create 0.0071149895375 NEAR, attach 0.0000687934850176 NEAR |

This agrees with the estimate (0.0001 NEAR per byte, nearcore `77.yaml`; the docs' 10 NEAR per 100 KB) at this size. The `measured` block in that run's record file (`global-contract-gp-806e2476...json`) was written by the first version and shows gas = the whole fall and 0 per byte: it is wrong in those fields and right in the balances; `--cost-of` gives the correct split.

EXTRAPOLATION to the 376,192-byte `out/prod/mamori.wasm`, NOT measured at that size: the deploy charge scales with bytes, 376,192 x 10^20 yocto = 37.6192 NEAR, burnt. Gas also grows with size: scaling the 1,024-byte figure linearly gives at most about 0.0244 NEAR (244 Tgas); the true figure is lower, since part of it is a fixed base cost. So the publish costs about 37.64 NEAR at most on this extrapolation; with the vault's 1 NEAR and the preflight's 0.5 NEAR margin the funder needs about 39.15 NEAR available. Whether the price stays 0.0001 NEAR per byte at 376 KB, and whether the publish fits the per-transaction and per-chunk gas limits at that size, is not shown by a 1,024-byte run.

## 7. Verified, and not verified (2026-11-04)

| Item | Status | Evidence |
|---|---|---|
| `@fastnear/api` 2.5.0 cannot build the two actions | Verified | `actions` object, borsh-schema comment at line 219, `mapAction` default branch |
| Action tags 9 and 10 and their field layout | Read from source, not accepted by a node yet | `near-primitives` 0.38.0 `action/mod.rs`, `near-primitives-core` `global_contract.rs` |
| Ordinary actions serialise byte for byte as the library does | Verified by test | `wire: the ordinary actions ...` |
| The two new actions serialise to hand-computed bytes, and an independent reader that shares no code with the borsh library parses them | Verified by test | `wire: DeployGlobalContract and UseGlobalContract are tags 9 and 10 ...` |
| Signatures verify over the hash of the sent bytes (ed25519 and ML-DSA-65) | Verified by test, against the test's fake node | `end to end: ...` |
| Testnet is protocol 88, reports `global_contract_host_fns: true`, answers `NO_GLOBAL_CONTRACT_CODE` for an unpublished hash | Verified by read-only RPC, 2026-11-04 | `status`, `EXPERIMENTAL_protocol_config`, `query view_global_contract_code` |
| Mainnet node software has the feature (protocol 86, `global_contract_host_fns: true`) | Read-only RPC, 2026-11-04. This shows the node has the code, NOT that publishing works or what it costs there. G2 open. | same calls on the mainnet RPC |
| Docs: by-hash is immutable, 10 NEAR per 100 KB burnt, init in the same transaction, examples testnet only, no availability statement | Read 2026-11-04 | https://docs.near.org/smart-contracts/global-contracts |
| `trivial.wasm` is valid, 1,024 bytes, one exported function, and its sha256 is the recorded one | Verified by test (it compiles and `ping` runs in Node's wasm engine) | `fixture: trivial.wasm matches its recorded sha256 ...` |
| The NEAR runtime accepts that module as a global contract | Verified: the publish of `trivial.wasm` succeeded on testnet (tx `BpqsZRxP...`) | section 6a |
| A live node accepts these transactions | Verified for `DeployGlobalContract` (ed25519-signed), `CreateAccount` + `Transfer` + `AddKey` of an ML-DSA-65 key (ed25519-signed), and `UseGlobalContract` signed by the ML-DSA-65 key itself: all three included and final. NOT verified for `UseGlobalContract` + `FunctionCall init` in one transaction | section 6a |
| `UseGlobalContract` and `init` in one receipt work, and a failed init rolls the whole batch back | NOT verified (the fake world models it) | needs the real run |
| The positive answer shape of `view_global_contract_code` (`code_base64`, `hash`) | Verified: the run's check that the code under the hash hashes to it passed, and `--cost-of` read the byte count from it | section 6a |
| Cross-shard distribution delay between the publish and the attach | Not measured. In the one real run the attach followed the publish after the tool saw the code on the node, and worked; a failure there is resumable. | section 6a |
| Testnet burn rate and the measured cost | Measured at 1,024 bytes: 0.0001 NEAR per byte exactly, gas 0.000066431 NEAR. At 376,192 bytes: an extrapolation (about 37.6192 NEAR plus gas), not measured | section 6a |
| cage-check GREEN on the real vault | NOT run on a real vault | the offline test world is GREEN |

## 8. If something goes wrong

- Preflight fails: nothing is sent. The failed check says which.
- The publish transaction fails: no vault exists yet; fix the cause and run again.
- The attach fails (for example `GlobalContractDoesNotExist` before the code reached the vault's shard, or an init panic): the vault exists with its ML-DSA key and no contract; run the same command again and it resumes at the attach. A wrong init argument cannot be repaired by a second init, so use a new `--vault`.
- A run that died after the create but before its seed file was read: the seed was written before the key was used, so it is in `--admin-seed-file`.
- `--vault` must be a sub-account of the funder, and an existing vault is only reused if its admin seed is on file and matches a full-access key on it; anything else is refused before a transaction is sent.
