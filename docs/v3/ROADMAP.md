# KAIGEN roadmap: v2 release, v3 milestones, evidence gates

Status: 2026-11-02. Testnet only. No audit. No mainnet run. Nothing here is a promise of results.

## 1. v2 release checklist (now)

Source: docs/PLAN-submission-and-mainnet.md (dated 30 Oct 2026). Submission window: Sun 1 Nov 2026 00:00 UTC to Sat 14 Nov 2026 23:59 UTC. The plan states engineering ends 9 to 10 Nov and semester-7 exams run 11 to 20 Nov. Status of each item below was not re-checked in this workflow.

| # | Item | Owner | Done when |
|---|---|---|---|
| 1 | README corrections and prior-art section per plan section A | Kevin approves edits | Diff read |
| 2 | Hosted app points at testnet drill contracts | Claude Code | Page opens with data |
| 3 | Kizashi fixes K1 to K6 and pre-deploy script | Claude Code | `cargo test --workspace` green |
| 4 | Mamori fixes S1, S-queue, S3, F1, production delay | Claude Code | New tests green. Production delay floor is 24 h per lib.rs, the 5 min figure in older notes is stale. |
| 5 | Reproducible rebuild of both wasm | Claude Code | Same code hash on a second machine or container |
| 6 | Testnet rehearsal including a zero-key Kizashi | Claude Code | `judge-report.json` regenerated |
| 7 | Gate G1 on mainnet protocol 86 with a throwaway account | Kevin runs it | Transaction links. See section 3. |
| 8 | Evidence gate review before any irreversible lock | Kevin decides | Checklist in plan section B all green |
| 9 | Demo recording and submission | Kevin | Submitted by 13 Nov, window closes 14 Nov 23:59 UTC |

Rules from the plan that stand: the lock is the last thing and is never done under time pressure, a testnet-proven submission is eligible, and only Kevin holds funded mainnet keys, moves funds, posts and submits. v2 ships as is. v3 work does not start on the v2 contract files until the v2 tag exists.

## 2. v3 milestones (about three weeks, one developer with agents)

Scheduling conflict to decide (Q-start): the three weeks do not fit before 20 Nov exams. A start on 21 Nov would end near 12 Dec. Weeks below are relative.

| Week | Milestone | Deliverable | Pass condition |
|---|---|---|---|
| 1 | M1 | Integration test (near-workspaces sandbox or testnet) that a burned key is really deleted, including a second signed transaction from the burned key in the in-flight window | If it fails, redesign burn mechanics before anything else |
| 1 | M2 | Kizashi double-claim race fix. Paths matrix. Queue `expires_at`, `cancel_all`, `purge_expired`, per-key slots and budget share | Tests green |
| 1 | M3 | Counting rule change (only never-succeed refusals) and cross-key grief test. Loss-bound invariant re-derived against the code, property tests | Bound holds as property over random multi-key sequences. Formula written with all conditions of ARCHITECTURE.md section 5 |
| 1 | Yield spike | One day, default NO-GO | Continue only if a use exists that needs no human within 200 blocks |
| 2 | M4 | `attest()`, cage-check with all red conditions, planted-key test, revoked-key check in `add_daily_key`, ML-DSA-admin-can-call-all-admin-methods test | Attack 8 red then green |
| 2 | M5 | `check` view, extended events, reason codes | Advisory result documented |
| 2 | M6 | Hash-pinned global contract on testnet, init in the same transaction as attach (needs `#[private]` init signed by the ML-DSA key) | Deploy works on testnet. Mainnet availability stays unconfirmed. |
| 2 | Stretch | Policy-key split, `sweep_to_safe`, sentinel, only if M1 to M6 are green | Not promised |
| 3 | M7 | Fuzz and invariant suite, nine scripted testnet attacks (ARCHITECTURE.md section 7), including the mandatory calibrated attacker | Each attack has pass or fail and measured blocks |
| 3 | M8 | Measured table: blocks to key deletion, gas costs, false-positive cost of a strike in replay | Measured numbers only |
| 3 | M9 | Same attack scripts run against Leash and near-agent-spend-guard (their READMEs are unverified until run), or comparative wording dropped. Docs rewrite. v3 tagged testnet-only. | Comparison table limited to code we ran |

Cut order if time runs short: sentinel, yield, per-agent grant objects, `sweep_to_safe`, policy-key split. SDK and MCP server are already cut.

## 3. Evidence gates

| Gate | Statement | Who | Status |
|---|---|---|---|
| G1 | ML-DSA admin flow runs on mainnet protocol 86 (AddKey, DeleteKey, deploy, delete the classical key) using a throwaway account | Kevin runs it himself with his own keys | Open. Proven on testnet protocol 88 only. |
| G2 | Global-contract publishing works on mainnet and its real cost is known. Docs rate gives about 32 NEAR for the 323,974-byte mamori.wasm (estimate). | Kevin | Open |
| G4 | Exact `intents.near` method names confirmed | Kevin or Claude Code read-only | Open per README |
| E1 | M1 integration test passes | Claude Code | Open |
| E2 | Loss-bound property tests pass, including cross-key grief and delay >= 24 h assumption | Claude Code | Open |
| E3 | cage-check goes red on planted ed25519 full-access key and null-allowance key, green after removal | Claude Code | Open |
| E4 | Measured blocks-to-deletion table published | Claude Code | Open |
| E5 | Comparison run against Leash and near-agent-spend-guard, or comparative wording absent | Claude Code | Open |
| E6 | Prior-art checks of NOVELTY-CLAIMS.md section 5 done before "novel" is written | Claude Code | Open |

Mainnet rule. Claude Code does not enter keys, move funds or run G1. `jobs/src/mainnet.mjs` is dry-run by default. Kevin runs `mainnet execute` and `mainnet lock` himself. Before any mainnet statement, confirm ML-DSA activation by RPC status. A release note says 2.13.0 moves to protocol 86 with ML-DSA-65 (https://newreleases.io/project/github/near/nearcore/release/2.13.0), and a vendor blog reports a mainnet rotation (https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near). KAIGEN itself has not run on mainnet.

## 4. Open questions for Kevin

| # | Question | Recommendation |
|---|---|---|
| Q-start | Start v3 on 21 Nov, after exams, or earlier at reduced scope? | After exams |
| Q1 | Is 90 seconds the real demo limit? At 3 minutes add attacks 3 and 6. | Keep 90 s, attack 2 first |
| Q2 | Policy-key split in v3, or document delay-to-loosen as not applicable? | Document as not applicable unless M1 to M6 are green early |
| Q3 | Yield spike, one day? | Skip. Default is NO-GO. |
| Q4 | Keep the 24 h strike window (recommended) or make the count cumulative? Measure false-positive cost first. | Keep window |
| Q-ABI | Make `request_withdraw` refusals recorded (breaking return type) or keep them uncounted? | Keep uncounted |
| Q5 | If `sweep_to_safe` ships: who is the safe account, who are the watchers? | Only if it ships |
| Q6 | Is a mainnet dry run a stated future item after the RPC check and G2? Global-contract cost is about 10 NEAR per 100 KB, burnt (https://docs.near.org/smart-contracts/global-contracts). | Yes, as future item |
| Q7 | Run the NOVELTY-CLAIMS.md section 5 prior-art checks before any "novel" wording? | Yes |
| Q8 | Kizashi: fix the race and mark optional everywhere, or drop it from the v3 demo? | Fix, mark optional, drop from demo |
