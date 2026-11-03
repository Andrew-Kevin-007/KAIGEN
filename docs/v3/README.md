# KAIGEN v3

Status: implemented in `contracts/mamori` and `contracts/kizashi`, measured in a single-validator sandbox. Testnet only. No audit. Not run on mainnet. The hash-pinned global contract (M6) is not built. Updated 2026-11-03.

Code state: HEAD 44227f2. The attack numbers were measured at 1a12d57, where `contracts/mamori` was unchanged since 262d92e [ATTACK-RESULTS.md].

## Index

| File | What it holds | State |
|---|---|---|
| README.md (repository root) | Summary for judges and users, v3 status, caveats | Rewritten 2026-11-03 |
| CHANGES-V2-TO-V3.md | Every v2 to v3 change, the breaking change, and the claims checked | New 2026-11-03 |
| LOSS-BOUND.md | The loss bound C + P, its derivation, conditions, property tests, mutation checks | Written 2026-11-03 |
| ATTEST-CHECK.md | `attest()`, `check()`, reason codes and events (the ABI) | Implemented, unit-tested |
| ATTACK-RESULTS.md | Nine scripted attacks and the measured table (M7 and M8) | Measured in the sandbox |
| ARCHITECTURE.md | Mechanisms, interfaces, response loop | Design draft of 2026-11-02, partly stale (see below) |
| THREAT-MODEL.md | Covered, partly covered, not covered, attacker table | Design draft of 2026-11-02, partly stale |
| LANDSCAPE.md | Cited comparison against industry and NEAR peers | Desk review of 2026-11-02. No peer code was run. |
| NOVELTY-CLAIMS.md | Each claim, its verdict, its evidence, what is not claimed | Desk review of 2026-11-02 |
| ROADMAP.md | v2 release checklist, v3 milestones, evidence gates | Status column dated 2026-11-02, not updated |

Stale parts of the design drafts. The design drafts were written before the code. Where they conflict with the progress logs in `docs/internal/V3-*-PROGRESS.md`, the logs and the code are the newer source:

- ARCHITECTURE.md 2.2 and THREAT-MODEL.md sections 6 and 7 say near-sdk 5.30 has no ML-DSA support. V3-W2-EDITH-PROGRESS.md reports that the locked near-sdk 5.30 has `CurveType::MLDSA65`. What the host returns for an ML-DSA signer is still unverified.
- THREAT-MODEL.md says "No contract code of v3 exists yet". That is no longer true.
- ARCHITECTURE.md 2.8 lists eight cage-check rows. `jobs/src/cage.mjs` has ten (ARCH-2.8-1 to 8, ATTEST-1 and ATTEST-2) [V3-W2-CAGE-PROGRESS.md].
- ARCHITECTURE.md section 3 lists `revoke_all_agent_keys()` as a new admin method. The milestone logs do not mention it. The lockdown that is implemented is `lock_down` (partial, repeat `trip` until empty) [ATTEST-CHECK.md section 5]. `sweep_to_safe` is a stretch item in ROADMAP.md and is not in any milestone log.
- LOSS-BOUND.md line numbers refer to `lib.rs` at sha256 276A870A, which is before the `attest()` and `check()` work. Use function names, not line numbers, until the file is re-read.

## Summary

v3 keeps the agent-key guard (the Mamori contract) and makes its limits testable. It is a new code version of Mamori, not an in-place upgrade. The stored state layout changed, so v2 vaults must be redeployed. [CHANGES-V2-TO-V3.md]

The design goal is a stated loss bound for a compromised daily key: per token, per rolling 24 hours, under listed conditions. The bound is `C + P` (cap plus pending limit). With the default pending multiple of 10, that is 11 times the cap. [LOSS-BOUND.md section 1]

The bound is supported by three kinds of evidence:

- An argument from the code (LOSS-BOUND.md section 2).
- A seeded property test over multi-key sequences, with 0 violations in a 4,000-seed soak. [LOSS-BOUND.md section 4]
- Nine scripted sandbox attacks. Each attack's own assertions passed. [ATTACK-RESULTS.md]

Containment is a refusal counter inside the call that is refused. No off-chain detector is on the critical path. The counter sees only calls that reach the contract, and it sees only clumsy attackers. [ARCHITECTURE.md 2.7]

## What v3 does not give

- Any quantum early warning. The omen (Kizashi) is a circuit breaker for a break someone discloses only. [THREAT-MODEL.md section 6]
- Protection against theft inside the cap. [THREAT-MODEL.md section 4]
- Protection while a classical full-access key or an unrecorded function-call key sits on the account. [THREAT-MODEL.md section 1]
- Protection against a calibrated attacker who reads `check` and sends exactly the cap. This attacker loses one cap per window with zero strikes. [ATTACK-RESULTS.md attack 2]

## Measured status by milestone

| Milestone | What | Status | Source |
|---|---|---|---|
| M1 | Burned key is removed from the account (sandbox) | Passed (5 tests) | V3-M1-PROGRESS.md |
| M2 part A | Kizashi `usdc_epoch` race fix | Implemented, tested | V3-KIZASHI-PROGRESS.md |
| M2 part B | Queue `expires_at`, `cancel_all`, `purge_expired`, per-key slots and shares | Implemented, tested | V3-MAMORI-PROGRESS.md |
| M3 | Counting rule, loss-bound derivation, property tests, mutation checks | Done | V3-M3-PROGRESS.md, LOSS-BOUND.md |
| M4 | `attest()`, cage-check, revoked-key check in `add_daily_key` | Done, sandbox-tested | V3-W2-EDITH-PROGRESS.md, V3-W2-CAGE-PROGRESS.md |
| M5 | `check()` view, reason codes, extended events | Done, unit-tested | V3-W2-EDITH-PROGRESS.md, ATTEST-CHECK.md |
| M6 | Hash-pinned global contract on testnet | Not built | ROADMAP.md, ARCHITECTURE.md 3 |
| M7 | Nine scripted attacks | All nine passed on the sandbox | ATTACK-RESULTS.md, V3-W3-ATTACKS-PROGRESS.md |
| M8 | Measured table | Done | ATTACK-RESULTS.md section 11 |
| M9 | Same attacks run against Leash and near-agent-spend-guard | Not run. No comparison is made. | ROADMAP.md, NOVELTY-CLAIMS.md |

## Open items that are not resolved

- Strike window: the 24 h window is kept. A cumulative count is not implemented, and its false-positive cost was not measured. [ROADMAP.md Q4, ATTACK-RESULTS.md 11.4]
- A5: the send refund assumes a transfer's failure callback arrives within 24 h. The design assumes receipts resolve in seconds. This is not enforced in code. [LOSS-BOUND.md 2.4]
- Kizashi residual: a reservation released by the 10 minute timeout, while its transfer is still on its way, can still be double-spent by a read ordered after the release. This is documented, not modelled and not fixed. [V3-KIZASHI-PROGRESS.md step 3]
- The admin's response time is not measured. The recovery numbers are chain-side only. [ATTACK-RESULTS.md section 13]
- The ML-DSA admin flow is not run in v3 tests. The sandbox used an ed25519 admin as a stand-in. [ATTACK-RESULTS.md section 0, ROADMAP.md G1]
