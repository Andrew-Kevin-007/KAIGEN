# KAIGEN roadmap: v2 release, v3 milestones, evidence gates

Status: 2026-11-04. Testnet only. No audit. No mainnet run. Nothing here is a promise of results.

Every status below cites its source file in square brackets. "Not re-checked" means no source was checked for that item on 2026-11-04. A file named as absent was not present in `docs/v3/` or `docs/internal/` when checked on 2026-11-04.

## 1. v2 release checklist (now)

Source: docs/PLAN-submission-and-mainnet.md (dated 30 Oct 2026). Submission window: Sun 1 Nov 2026 00:00 UTC to Sat 14 Nov 2026 23:59 UTC. The plan states engineering ends 9 to 10 Nov and semester-7 exams run 11 to 20 Nov.

| # | Item | Owner | Done when | Status |
|---|---|---|---|---|
| 1 | README corrections and prior-art section per plan section A | Kevin approves edits | Diff read | Not re-checked. README.md was updated 2026-11-03 and still has UNVERIFIED markers [README.md; CHANGES-V2-TO-V3.md section 6] |
| 2 | Hosted app points at testnet drill contracts | Claude Code | Page opens with data | Not re-checked. README.md says there is no live demo yet [README.md, status section] |
| 3 | Kizashi fixes K1 to K6 and pre-deploy script | Claude Code | `cargo test --workspace` green | Partly. Race fix in place; `cargo test -p kizashi` 88 passed, 89 with drill [V3-KIZASHI-PROGRESS.md step 3]. K1 to K6 and the pre-deploy script not checked there |
| 4 | Mamori fixes S1, S-queue, S3, F1, production delay | Claude Code | New tests green. Production delay floor is 24 h per lib.rs, the 5 min figure in older notes is stale. | Partly. Expiry, `cancel_all`, `purge_expired`, per-key slots and shares in place; `cargo test -p mamori` 120 passed, 117 with drill [V3-MAMORI-PROGRESS.md steps 1 to 3]. Burn cancels a burned key's queued requests [LOSS-BOUND.md section 2.5]. S1, S3, F1 not checked there. Production delay refused under 86,400 s [LOSS-BOUND.md section 1] |
| 5 | Reproducible rebuild of both wasm | Claude Code | Same code hash on a second machine or container | In progress. Only a one-machine rebuild of the v2-testnet tag is recorded [V3-M1-PROGRESS.md (c)]. docs/v3/REPRODUCIBLE-BUILD.md absent |
| 6 | Testnet rehearsal including a zero-key Kizashi | Claude Code | `judge-report.json` regenerated | Rehearsal passed on 2026-11-04 with the v3 drill build (owner ran it on 2026-11-04; the run output is not in the repo). Zero-key Kizashi run pending [PLAN-submission-and-mainnet.md section A, Tue 3 Nov] |
| 7 | Gate G1 on mainnet protocol 86 with a throwaway account | Kevin runs it | Transaction links. See section 3. | Open, owner's [ROADMAP.md section 3; PLAN-submission-and-mainnet.md section B stage 1] |
| 8 | Evidence gate review before any irreversible lock | Kevin decides | Checklist in plan section B all green | Open. Waits on G1 and the other gate items [PLAN-submission-and-mainnet.md section B] |
| 9 | Demo recording and submission | Kevin | Submitted by 13 Nov, window closes 14 Nov 23:59 UTC | Open. docs/v3/DEMO-SCRIPT.md absent. Not submitted [PLAN-submission-and-mainnet.md section A; README.md] |

Rules from the plan that stand: the lock is the last thing and is never done under time pressure, a testnet-proven submission is eligible, and only Kevin holds funded mainnet keys, moves funds, posts and submits. v2 ships as is. v3 work does not start on the v2 contract files until the v2 tag exists. [PLAN-submission-and-mainnet.md ground rules 1, 2, 4]

## 2. v3 milestones (about three weeks, one developer with agents)

Scheduling conflict to decide (Q-start): the three weeks do not fit before 20 Nov exams. A start on 21 Nov would end near 12 Dec. Weeks below are relative.

| Week | Milestone | Deliverable | Pass condition | Status |
|---|---|---|---|---|
| 1 | M1 | Integration test (near-workspaces sandbox or testnet) that a burned key is really deleted, including a second signed transaction from the burned key in the in-flight window | If it fails, redesign burn mechanics before anything else | Passed, on a sandbox (not testnet) [V3-M1-PROGRESS.md] |
| 1 | M2 | Kizashi double-claim race fix. Paths matrix. Queue `expires_at`, `cancel_all`, `purge_expired`, per-key slots and budget share | Tests green | Done [V3-KIZASHI-PROGRESS.md; V3-MAMORI-PROGRESS.md] |
| 1 | M3 | Counting rule change (only never-succeed refusals) and cross-key grief test. Loss-bound invariant re-derived against the code, property tests | Bound holds as property over random multi-key sequences. Formula written with all conditions of ARCHITECTURE.md section 5 | Done [LOSS-BOUND.md] |
| 1 | Yield spike | One day, default NO-GO | Continue only if a use exists that needs no human within 200 blocks | Skipped by decision (Q3) [ROADMAP.md section 4] |
| 2 | M4 | `attest()`, cage-check with all red conditions, planted-key test, revoked-key check in `add_daily_key`, ML-DSA-admin-can-call-all-admin-methods test | Attack 8 red then green | Done [ATTEST-CHECK.md; V3-W2-CAGE-PROGRESS.md] |
| 2 | M5 | `check` view, extended events, reason codes | Advisory result documented | Done [ATTEST-CHECK.md; V3-W2-CAGE-PROGRESS.md] |
| 2 | M6 | Hash-pinned global contract on testnet, init in the same transaction as attach (needs `#[private]` init signed by the ML-DSA key) | Deploy works on testnet. Mainnet availability stays unconfirmed. | Tooling built (`jobs/src/globalcontract.mjs`, `jobs/src/globaltx.mjs`). Proven on testnet protocol 88 with a 1,024-byte module: publish by code hash, create the account with an ML-DSA-65 key, attach with `UseGlobalContract`; `global_contract_hash` equals the published hash. Measured: 0.1024 NEAR deploy charge (exactly 1e20 yocto per byte) plus 0.000066431 NEAR gas. Not run: the real Mamori publish (376,192 bytes; about 37.6 NEAR is an extrapolation, not measured; funds not available), and `UseGlobalContract` plus `init` in one transaction. Mainnet is protocol 86; availability unconfirmed. No owner decision is needed to build. [GLOBAL-CONTRACT.md sections 3, 4, 6, 6a, 7; MAINNET-READS.md] |
| 2 | Stretch | Policy-key split, `sweep_to_safe`, sentinel, only if M1 to M6 are green | Not promised IN PROGRESS. Policy-key split and `sweep_to_safe` are being built; design in [STRETCH-DESIGN.md](STRETCH-DESIGN.md) (not yet committed). Not promised. Untracked in the working tree: `contracts/mamori/src/tests/policy.rs`, `contracts/mamori/src/tests/sweep.rs`, `docs/v3/STRETCH-DESIGN.md`. Fallback tag `v3-core-testnet` (pushed) points at d4342c0, one commit before the M6 tooling commit fe8d9d9, so it does not mark the state before the stretch work. `sweep_to_safe` still needs a safe account and watchers (Q5) [git status; git ls-remote --tags origin; ROADMAP.md section 4] |
| 3 | M7 | Fuzz and invariant suite, nine scripted testnet attacks (ARCHITECTURE.md section 7), including the mandatory calibrated attacker | Each attack has pass or fail and measured blocks | Done on a sandbox [ATTACK-RESULTS.md section 1] |
| 3 | M8 | Measured table: blocks to key deletion, gas costs, false-positive cost of a strike in replay | Measured numbers only | Done on a sandbox [ATTACK-RESULTS.md section 11] |
| 3 | M9 | Same attack scripts run against Leash and near-agent-spend-guard (their READMEs are unverified until run), or comparative wording dropped. Docs rewrite. v3 tagged testnet-only. | Comparison table limited to code we ran | Peer guards NOT run. Running their code is for the owner to do. README.md makes no comparison with them [README.md, measured results; ATTACK-RESULTS.md section 13]. LANDSCAPE.md (lines 39 to 40) and NOVELTY-CLAIMS.md (row C4) still name both guards with comparative wording [LANDSCAPE.md; NOVELTY-CLAIMS.md]. Tag `v3-core-testnet` exists on origin, at d4342c0 [git ls-remote --tags origin] |

Cut order if time runs short: sentinel, yield, per-agent grant objects, `sweep_to_safe`, policy-key split. SDK and MCP server are already cut.

## 3. Evidence gates

| Gate | Statement | Who | Status |
|---|---|---|---|
| G1 | ML-DSA admin flow runs on mainnet protocol 86 (AddKey, DeleteKey, deploy, delete the classical key) using a throwaway account | Kevin runs it himself with his own keys | Open, owner's. Proven on testnet protocol 88 only [ROADMAP.md section 3; PLAN-submission-and-mainnet.md section B stage 1] |
| G2 | Global-contract publishing works on mainnet and its real cost is known. Testnet protocol 88: 0.0001 NEAR per byte measured at 1,024 bytes (0.1024 NEAR deploy charge, plus 0.000066431 NEAR gas). The 376,192-byte mamori.wasm is not measured; about 37.6 NEAR is an extrapolation. Mainnet is protocol 86; publishing there is unconfirmed. | Kevin | Open, owner's [ROADMAP.md section 3; GLOBAL-CONTRACT.md sections 6 and 6a; MAINNET-READS.md] |
| G4 | Exact `intents.near` method names confirmed | Kevin or Claude Code read-only | In progress. Method names not yet confirmed [V3-W2-CAGE-PROGRESS.md final step 3, "left for later"]. docs/v3/MAINNET-READS.md absent |
| E1 | M1 integration test passes | Claude Code | Met, on a sandbox [V3-M1-PROGRESS.md steps 2 and 3] |
| E2 | Loss-bound property tests pass, including cross-key grief and delay >= 24 h assumption | Claude Code | Met, on a sandbox [LOSS-BOUND.md sections 3 to 5] |
| E3 | cage-check goes red on planted ed25519 full-access key and null-allowance key, green after removal | Claude Code | Met, on a sandbox [V3-W2-CAGE-PROGRESS.md final step 2] |
| E4 | Measured blocks-to-deletion table published | Claude Code | Met, on a sandbox [ATTACK-RESULTS.md section 11.1] |
| E5 | Comparison run against Leash and near-agent-spend-guard, or comparative wording absent | Claude Code | Not met as a comparison (dropped). The route is "comparative wording absent", which is not yet complete: LANDSCAPE.md and NOVELTY-CLAIMS.md still name both guards [NOVELTY-CLAIMS.md section 5 item 2; LANDSCAPE.md lines 33 to 34] |
| E6 | Prior-art checks of NOVELTY-CLAIMS.md section 5 done before "novel" is written | Claude Code | In progress. docs/v3/PRIOR-ART-CHECK.md absent [NOVELTY-CLAIMS.md section 5 item 1] |

Mainnet rule. Claude Code does not enter keys, move funds or run G1. `jobs/src/mainnet.mjs` is dry-run by default. Kevin runs `mainnet execute` and `mainnet lock` himself. Before any mainnet statement, confirm ML-DSA activation by RPC status. A release note says 2.13.0 moves to protocol 86 with ML-DSA-65 (https://newreleases.io/project/github/near/nearcore/release/2.13.0), and a vendor blog reports a mainnet rotation (https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near). KAIGEN itself has not run on mainnet.

## 4. Open questions for Kevin

| # | Question | Recommendation | Status |
|---|---|---|---|
| Q-start | Start v3 on 21 Nov, after exams, or earlier at reduced scope? | After exams | Open. No decision recorded in the repo. Exams 11 to 20 Nov [PLAN-submission-and-mainnet.md ground rule 3] |
| Q1 | Is 90 seconds the real demo limit? At 3 minutes add attacks 3 and 6. | Keep 90 s, attack 2 first | Open. The design still says "Q1 open" [ARCHITECTURE.md, demo paragraph]. docs/v3/DEMO-SCRIPT.md absent |
| Q2 | Policy-key split in v3, or document delay-to-loosen as not applicable? | Document as not applicable unless M1 to M6 are green early | Superseded on 2026-11-04. Earlier recommendation was "document as not applicable". Policy-key split and `sweep_to_safe` are now in progress (section 2, stretch row) [ROADMAP.md section 2, stretch row; git status] |
| Q3 | Yield spike, one day? | Skip. Default is NO-GO. | Decided: skipped [ROADMAP.md section 2, yield row] |
| Q4 | Keep the 24 h strike window (recommended) or make the count cumulative? Measure false-positive cost first. | Keep window | Window kept. Cumulative count not implemented [CHANGES-V2-TO-V3.md section 2] |
| Q-ABI | Make `request_withdraw` refusals recorded (breaking return type) or keep them uncounted? | Keep uncounted | Kept uncounted. Signature unchanged [CHANGES-V2-TO-V3.md section 2] |
| Q5 | If `sweep_to_safe` ships: who is the safe account, who are the watchers? | Only if it ships | Open. Not built [ROADMAP.md section 2, stretch row]. Owner decides the safe account and watchers |
| Q6 | Is a mainnet dry run a stated future item after the RPC check and G2? Global-contract cost is about 10 NEAR per 100 KB, burnt (https://docs.near.org/smart-contracts/global-contracts). | Yes, as future item | Open. Depends on G2, which is open [ROADMAP.md section 3] |
| Q7 | Run the NOVELTY-CLAIMS.md section 5 prior-art checks before any "novel" wording? | Yes | In progress, same as E6. docs/v3/PRIOR-ART-CHECK.md absent [NOVELTY-CLAIMS.md section 5] |
| Q8 | Kizashi: fix the race and mark optional everywhere, or drop it from the v3 demo? | Fix, mark optional, drop from demo | Race fixed and Kizashi stays optional [CHANGES-V2-TO-V3.md section 3]. The demo design lists attacks 2, 1 and 8 only [ARCHITECTURE.md, demo paragraph] |
