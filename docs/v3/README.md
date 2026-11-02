# KAIGEN v3 (design draft)

Status: design only. Testnet only. No outside audit. No mainnet run. Written 2026-11-02.

A search for the string "v3" over README.md, docs/ and .claude/drafts found no earlier v3 document. docs/internal contents beyond file names, app/ and site/ were not searched. "Not found" in these documents always means "not found in the sources checked", never "does not exist".

## Index

| File | What it holds |
|---|---|
| README.md | This index, the summary, the v2-versus-v3 table |
| ARCHITECTURE.md | Mechanisms, interfaces, the real-time response loop, the loss bound |
| THREAT-MODEL.md | Covered, partly covered, not covered, attacker table |
| LANDSCAPE.md | Cited comparison against industry and against NEAR peers |
| ROADMAP.md | v2 release checklist, v3 milestones, evidence gates including mainnet gate G1 |
| NOVELTY-CLAIMS.md | Each claim, its verdict, its evidence, and what is not claimed |

## Summary

v3 keeps the agent-key guard (the Mamori contract) as the thing worth building and tries to make its limits provable instead of asserted. v3 is a new code version of Mamori, not an in-place upgrade of v2. It changes the stored Withdrawal layout and possibly the return type of `request_withdraw`. v2 vaults are not migrated, and there is no mainnet state to migrate.

The design goal is a stated loss bound for a compromised agent key, per token, per rolling 24 hours, under listed conditions, together with tests that attack that bound and a checker that tells anyone when the conditions no longer hold. Containment is a refusal counter inside the call that is refused. No off-chain detector or vendor-held key is on the critical path. That absence of an external actor is the one design point that differs from the vendor products read (Safe with Hypernative, Forta), and it is a trade, not a free gain: the counter only sees calls that reach the contract and only sees clumsy attackers.

What v3 does not give: any quantum early warning, any quantum protection beyond capping classical hot keys while the admin key is already ML-DSA, any protection against theft inside the cap, or any protection if a classical full-access key sits on the account. Rotating to ML-DSA keys is native NEAR (a vendor reports doing it in two transactions, https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near), and the guard's loss bound is the same against any adversary holding the key, quantum or not.

Kizashi (the omen registry) stays optional. It is a circuit breaker for a break someone discloses. It is not an early warning, and a silent or state-level attacker never claims. v3 adds nothing to it except the double-claim fix.

On "better than what exists": at least two open-source NEAR testnet guards already enforce caps on-chain (Leash, https://github.com/mesh-pch/leash-near; near-agent-spend-guard, https://github.com/mubudot/near-agent-spend-guard). No comparative claim is made until week-3 numbers are produced by running the same attack scripts against code we actually ran. Their README claims are unverified until then.

## v2 versus v3

v2 column is taken from contracts/mamori/src/lib.rs as read on 2026-11-02, not from older notes. The 5 minute delay floor in docs/ARCHITECTURE-REVIEW.md and in the plan is stale for production builds.

| Area | v2 (code today) | v3 (proposed) | Kind of change |
|---|---|---|---|
| Refusal of a send | `send_small` policy refusals return a recorded outcome and persist the strike. `request_withdraw` refusals panic and earn no strike. Unauthenticated callers, zero amount and a non-calm era panic. | Same split. M1 is an integration test (near-workspaces sandbox or testnet, not the unit VM) proving the `DeleteKey` receipt removes the key, including a second signed transaction from the burned key in the in-flight window. | Test added |
| Strike window | N refusals inside a 24 h window (default 3). A prober that stays under N per 24 h is never burned. | Window kept (decision Q4). Only refusals that can never succeed are counted (payee not allowed, amount above the full cap). Cap or queue currently exhausted is uncounted. | Behaviour change, fixes a cross-key grief hole present in v2 |
| Delay floor | Production floor 24 h (`MIN_DELAY_SECS = 86_400`), shorter in drill builds. | Unchanged. The loss bound depends on delay >= 24 h. | None |
| Queue | `MAX_QUEUE = 32`, pending sum per token with `checked_add`, 24 h request budget, default pending limit 10x the daily limit. | Adds `expires_at` (at least `unlocks_at` plus a minimum cancel window), `cancel_all`, `purge_expired`, per-key queue slots and a per-key share of the request budget, property tests. Expired items must be purged or ignored by the count and the pending sum, otherwise stale entries keep occupying slots. | Withdrawal borsh layout change |
| Cap | Already account-level per token (maps keyed by token, not by key). Only strikes are per key. | Same. v3 adds the written invariant and property tests over multi-key, queue-interleaved sequences. | Test and docs only |
| Tokens | Daily keys reach `ft_transfer` through `send_small` only. `ft_transfer_call` is never called. | v3 adds no `ft_transfer_call`. | None |
| Intents keys | `register_intents_key` adds a key on `intents.near` and records it so lockdown can remove it. That key signs on `intents.near` with no Mamori cap. | Unchanged. `cage-check` lists recorded intents keys as a red item. The loss bound is void while one exists. | Checker only |
| Burned key return | Admin can re-add immediately. `add_daily_key` does not check `revoked_keys`. | Adds `require!(!revoked_keys.contains(key))` to `add_daily_key`. No delay unless the policy-key split ships. | Fix |
| Non-zero allowance | Already enforced (`Allowance::limited` panics on 0, default 250 mNEAR). | Regression test only. | Test |
| Events | NEP-297-style events already emitted under standard `kaigen`. | Extended with refusal reason codes and spend-after. | Parity |
| Pre-flight | None | `check(key, asset, amount, to)` view, advisory, can race with state changes. | New |
| Posture | Config and key views | `attest()` (informational, self-reported) and an off-chain `cage-check` that reads code hash and key list from RPC. | New |
| Deployment | Per-account deploy | Hash-pinned global contract, init in the same transaction as attach. Mainnet availability unconfirmed. | New |
| Kizashi | Double-claim race | Race fixed, marked optional everywhere. | Fix |

Parity note: events, token caps, queue, cancel and rolling cap are parity with existing NEAR guards (Leash, near-agent-spend-guard), not advances. The aggregate cap is an engineering property that we test. We have not verified that peer guards lack it.

## Honest limits in one place

Testnet only, no audit, no formal verification, no measured v3 numbers yet. The ML-DSA admin flow is proven on testnet protocol 88 only. Mainnet protocol 86 has not run it (gate G1, run by Kevin). A release note says nearcore 2.13.0 moves to protocol 86 with ML-DSA-65 (https://newreleases.io/project/github/near/nearcore/release/2.13.0). Confirm activation by RPC status before any mainnet statement.
