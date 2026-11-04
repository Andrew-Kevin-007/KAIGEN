# KAIGEN v3 architecture (design draft)

Status: design draft. The v3 contract views, queue controls and cage-check are built and were run on a local nearcore sandbox, not on testnet [ATTEST-CHECK.md header; ATTACK-RESULTS.md section 1]. Testnet only as the target. No audit, no mainnet run. All latency figures are targets until week 3 publishes measured testnet numbers. Facts about v2 come from contracts/mamori/src/lib.rs as read on 2026-11-02.

## 1. Components

| Component | Role | Changes in v3 |
|---|---|---|
| Mamori | Guard contract on the user's own NEAR account. Daily (agent) keys are classical function-call keys limited to `send_small` and `request_withdraw`. | New code version. Queue and state layout change. |
| Cold admin key | ML-DSA-65 full-access key. Signs AddKey, DeleteKey, deploys, admin methods. | Unchanged. |
| cage-check | Off-chain checker. Reads RPC state and compares it with policy. | New. |
| Kizashi | Optional omen registry. Retained only as a circuit breaker for a disclosed break. | Double-claim race fix only. |
| Hinomi | Exposure index. | Out of scope for v3. |

## 2. Mechanisms

### 2.1 Refusal, strike, burn

v2 rule kept: N refusals (default 3, ceiling 10) from one daily key inside a fixed 24 h window delete that key. A prober that stays under N per 24 h is never burned, and its loss is bounded only by the cap. Whether to make the count cumulative instead is open question Q4 in ROADMAP.md, and its false-positive cost must be measured before it is chosen.

What counts. A refusal is counted only if it can never succeed for an honest key.

| Refusal | v2 | v3 |
|---|---|---|
| Payee not on allowlist (allowlist enforced) | Counted | Counted |
| Amount above the full 24 h cap | Counted | Counted |
| Cap currently exhausted by earlier spend | Counted | Uncounted |
| Queue full, request budget spent | Panic, uncounted | Panic, uncounted (unless the return type changes, see 2.9) |
| Token with no limit, below minimum send | Uncounted | Uncounted |
| Zero amount, era not calm, caller not a daily key | Panic | Panic |
| Method outside the key's list, wrong receiver | Rejected by the NEAR runtime at the access-key layer. The contract never runs. | Same. Bounded only by the key's gas allowance. |

Reason for the change in row 3. The cap window is account-wide. A hijacked or griefing key A that uses up the cap makes honest key B's legitimate call refused. If that refusal is counted, B is burned after three attempts. v2 already avoids this for `request_withdraw` for the same reason. Test required: key A exhausts the cap, key B must not burn.

Burn mechanics (v2, kept). On the Nth counted refusal the call returns normally and persists state: the key is removed from `daily_keys` (this is what makes the contract refuse it from the next call, checked in `assert_daily_key`), its queued withdrawals are cancelled, and a `DeleteKey` promise is scheduled. `revoked_keys` is only a ledger of deletes the account has not yet confirmed, kept for retry. The `DeleteKey` action lands in a later receipt. The exact block distance is measured in week 3, not asserted.

v3 additions: `require!(!revoked_keys.contains(key))` in `add_daily_key`. Only the admin can re-add a burned key, immediately. A delay exists only if the policy-key split (section 6) ships.

Test requirement (M1). An integration test in near-workspaces sandbox or on testnet proves the key is gone after the `DeleteKey` receipt, and that a second signed transaction from the burned key in the in-flight window is refused. The unit-testing VM cannot show cross-receipt key deletion.

### 2.2 Caller identity

Every key on a NEAR account has `predecessor == current account`, so a bare predecessor check is not access control for per-key logic. v2 already uses `env::signer_account_pk()` for strikes. Admin gating by `predecessor == current_account` is safe only because the runtime restricts function-call keys to the two daily methods. It is void if cage-check fails.

Constraint. Two sources disagree on ML-DSA support in near-sdk 5.30, and this paragraph does not choose between them. (a) This design text says `PublicKey` has no ML-DSA variant (https://docs.rs/near-sdk/latest/near_sdk/struct.PublicKey.html, cited here, not checked by this edit). (b) V3-W2-EDITH-PROGRESS.md (M4b and W2 FINAL) reports that the locked near-sdk 5.30 has `CurveType::MLDSA65` and parses a 1952-byte ML-DSA key. Both statements are to be re-verified against the near-sdk source before relying on them. `signer_account_pk` is cited above as aborting when the bytes do not parse. No method reachable by the ML-DSA admin key may read `signer_account_pk`. This is why v2 `assert_admin` reads only the predecessor. Sentinel, policy and watcher keys must be classical, or their methods must avoid the read; that rule was written on statement (a) and is left as it is until the re-check. Required test: the ML-DSA admin can call every admin method (the unit-test VM run is reported in V3-W2-EDITH-PROGRESS.md M4b). What the host returns for an ML-DSA signer is unverified [V3-W2-EDITH-PROGRESS.md W2 FINAL].

### 2.3 Value-moving paths

A daily key can reach only `send_small` and `request_withdraw` on the account itself, and a function-call key cannot attach a deposit (https://docs.near.org/protocol/access-keys). Approve-versus-transfer, nested-call and hook bypasses seen in session-key designs on other chains therefore have no route in v3 unless a new exported method is added. v3 adds no new value-moving export. The paths matrix is the list of Mamori exports, each tagged as value-moving or not, with a test that fails if a new export is added without a tag. Those other-chain bypass reports are background only.

### 2.4 Queue

Prior art, not novelty: Zodiac Delay and Phoenix. Neither source was re-read in this workflow. The repository name (SafeDelay versus zodiac-modifier-delay) and the Phoenix details (overflow, flooding, Certora proof) are unverified.

| Item | Rule |
|---|---|
| `request_withdraw` | Stores `expires_at >= unlocks_at + minimum cancel window`. With a 24 h delay a 2 h expiry is impossible, so the value is a decision with a justification, not a copy of a vendor default. |
| Execute | Permissionless after the delay. Stale items cannot execute. |
| Caps | Count (32 in v2), pending sum per token with `checked_add`, 24 h request budget. v3 adds per-key slots and a per-key share of the request budget, because a single hijacked key can fill all slots with dust or spend the account-wide budget, which neither `cancel` nor `cancel_all` refunds. |
| Expired items | `purge_expired`. Expired entries are ignored by the count and the pending sum, otherwise a flood persists. |
| Cancel | `cancel(id)` and `cancel_all()` (admin). |
| New payee | With the allowlist enforced, `send_small` to an unlisted payee is refused with a strike. `request_withdraw` to any payee queues. The allowlist is off by default, so in the default config any payee gets instant sends up to the cap. A daily key can never add a payee. Auto-promotion is rejected because it lets a key loosen its own limits. Every first payment to a new payee through the queue waits 24 h, which is a cost for honest agents. |

### 2.5 Allowance rule

0 means unlimited only through the contract host function that adds a key. In an AddKey action, 0 means every call fails (https://docs.near.org/protocol/access-keys). Mamori already passes a non-zero allowance (default 250 mNEAR) and rejects 0. v3 adds a regression test.

### 2.6 Intents

v3 adds no `ft_transfer_call`. A key registered through `register_intents_key` signs on `intents.near` with no Mamori cap, whether or not Mamori recorded it. Balances held on `intents.near` are outside the loss bound. 1Click sends funds to a per-quote deposit address, and the docs do not state whether the destination is visible on-chain (unverified; https://docs.near-intents.org/integration/distribution-channels/1click-api). Intents is listed under Not covered in THREAT-MODEL.md.

### 2.7 `check` and events

`check(key, asset, amount, to) -> {verdict, reason, headroom}` is a view with no state change. Views have no signer, so the key is a parameter. The result is advisory and can race with state changes. Events extend the existing `kaigen` NEP-297 events with reason code and spend-after. Receipts are event-only. No `receipts()` storage view exists, because unbounded per-call storage allows a storage-staking grief. Emit few events per call, since log limits per receipt were not read.

Known weakness. A hijacked key can call `check` for free, read exact headroom and send exactly the cap without ever being refused. The refusal ladder catches only clumsy attackers. Rate limiting does not apply to views.

### 2.8 `attest()` and cage-check

`attest()` is informational. It returns recorded state: configured caps, strike counts, recorded daily and intents keys. It does not return the code hash or an admin key hash, because the contract by design never reads the admin key, and no host function for a contract's own code hash or key list is known (inference: the host-function list was not read). A full-access key can deploy a version of `attest()` that returns clean data.

cage-check takes the code hash from RPC `view_account` and the key list from RPC `view_access_key_list`, and treats `attest()` as a cross-check only. It reports a point-in-time state. It cannot see an AddKey one block after the check. ML-DSA keys appear on chain only as `ml-dsa-65-hash:...`, so the checker needs the full public key from the admin (https://github.com/near/neps/pull/645).

Fails (red) if any of these hold:

| Condition | Why |
|---|---|
| Any classical (ed25519, secp256k1) full-access key | Guard is void |
| Anything other than exactly one ML-DSA full-access key | Unexpected admin surface |
| A function-call key with allowance null (unlimited) or above the configured maximum | Gas drain outside the cap. A zero allowance can sign nothing and is not the danger. |
| A function-call key with empty or omitted `method_names` | It can call any method |
| A function-call key whose receiver is not the account, or whose methods go beyond the two daily methods (or the dedicated propose_* and sentinel methods if those ship) | Scope escape |
| A function-call key not recorded in Mamori | Outside strike and cap accounting |
| A recorded intents key | Signs on `intents.near` with no cap |
| Code hash from RPC differs from the pinned global-contract hash | Hash pinning is a deploy-time property only. A full-access key can swap code or the hash later, so the hash is re-read each run. |
| ATTEST-1 (not one of the eight). `attest()` disagrees with the account asked about, or with `config()`, `daily_keys()`, `intents_keys()` or `revoked_keys()` at the same block, or is not Mamori's `attest()` at all | `attest()` is a cross-check. A lying `attest()` can only add a red here, never clear one. |
| ATTEST-2 (not one of the eight). `attest().drill_build` is true, or `config.delay_secs` is under `min_delay_secs` | The loss bound's delay condition. A drill build allows a delay under the production floor (ATTEST-CHECK.md 2.1; LOSS-BOUND.md E4). |

ATTEST-1 and ATTEST-2 are not rows of the table above. The code names the eight rows ARCH-2.8-1 to ARCH-2.8-8 by their order in this table, and gives ATTEST-1 and ATTEST-2 their own names so they are not read as part of the eight [jobs/src/cage.mjs lines 9-24, 40-52]. `attest()` also adds evidence to two of the eight: a function-call key that `attest().daily_keys` does not record is red under ARCH-2.8-6, and any key in `attest().intents_keys` is red under ARCH-2.8-7 [jobs/src/cage.mjs lines 18-19, 157-162]. With no `attest()` (a v2 build), ATTEST-1 and ATTEST-2 are UNKNOWN, so such a vault is never GREEN [jobs/src/cage.mjs line 25].

Exit codes of `cage-check`: 0 all rows GREEN; 1 at least one row RED; 3 nothing RED but at least one row could not be checked, which is not a clean bill; 2 bad usage [jobs/src/cage.mjs lines 27-28, 397-398, and the `CAGE_USAGE` text at line 441].

Attack 8 in section 7 plants an ed25519 full-access key and a null-allowance key.

### 2.9 Deployment

Ship Mamori as a hash-pinned global contract (https://docs.near.org/smart-contracts/global-contracts). Never reference it by publisher account. Say "the publisher cannot upgrade it", not "it cannot change": the account's own full-access key can still deploy code or switch the hash. A pinned hash also makes a bug unfixable without redeploy and state migration. Init runs in the same transaction as attach and needs a `#[private]` init signed by the account's own key, which is the ML-DSA admin key, so that path is tested.

Cost per the docs: 10 NEAR per 100 KB, burnt. `out/prod/mamori.wasm` is 323,974 bytes, so about 32 NEAR at the docs rate (estimate). The docs show testnet commands only and do not state mainnet availability (unconfirmed, gate G2). Deterministic account IDs (NEP-616) stay a non-goal.

Breaking-change option. Making `request_withdraw` refusals recorded changes its return type from U64, which breaks the v2 ABI. v3 either takes that break on purpose or keeps those refusals uncounted. This is Q-ABI in ROADMAP.md.

## 3. Interfaces (v3 target; status per row)

| Method | Caller | Notes |
|---|---|---|
| `send_small(token, amount, to)` | Daily key | Existing. Returns `SendOutcome`. |
| `request_withdraw(token, amount, to)` | Daily key | Existing. Stores `expires_at`. Return type decision Q-ABI. |
| `execute(id)` | Anyone | Existing. After delay, before expiry. |
| `cancel(id)`, `cancel_all()` | Admin | `cancel_all` built, run in attack 4 [ATTACK-RESULTS.md section 1]. |
| `purge_expired()` | Anyone | Built, run in attack 5 [ATTACK-RESULTS.md section 1]. |
| `strikes_of(key)` | View | Existing. |
| `revoke_all_agent_keys()` | Admin | New. Reuse the gas-gated partial pattern of `lock_down`, repeat until empty. About 20 Tgas per daily key, so 8 daily keys fit one transaction, but not with intents keys. No single-call promise. |
| `check(key, asset, amount, to)` | View | Built, advisory [ATTEST-CHECK.md section 3]. |
| `attest()` | View | Built, informational [ATTEST-CHECK.md section 2]. |
| `add_daily_key` | Admin | Adds revoked-key check. |

## 4. Real-time response loop

All latency entries are targets. We quote no vendor latency. Forta and Hypernative latency statements were not re-checked in this workflow.

| Stage | Trigger | Actor | Latency |
|---|---|---|---|
| Prevent | Cap, allowlist, minimum send, queue caps, expiry | Contract, every call | Same transaction |
| Detect | A counted refusal (the refusal is the detector) | Contract | Same transaction. Sees only calls that reach Mamori and only clumsy attackers. |
| Contain | Nth counted refusal inside 24 h: key removed from `daily_keys`, queue entries of that key cancelled, `DeleteKey` scheduled | Contract | Key refused from the next call. Deletion in a later receipt. Blocks to deletion measured in week 3. |
| Bound | Rolling per-token cap and pending limit | Contract | Always on |
| Recover | `cancel`, `cancel_all`, `revoke_all_agent_keys` (repeat), re-key | Cold ML-DSA admin | Human timescale |
| Verify | cage-check | Anyone, off-chain | Point in time |

Stretch items (section 6) are not in this loop and are not promised.

Why in-account containment, and its limit. At Euler an alert arrived about three minutes early and nothing acted on it (https://forta.org/blog/detecting-a-197-million-hack-before-exploitation-euler-finance-hack-retrospective). That post is written by Forta, the vendor that sold the alert, and Euler was a protocol exploit that a per-key refusal counter would not detect. It illustrates alert-without-action. It is not evidence for Mamori's counter.

In-transaction enforcement is not novel. Safe Guardian works as a Transaction Guard that blocks transactions (https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative), and Hypernative reports automated on-chain pauses through a granted pause role (https://www.hypernative.io/insights/blog/how-defi-teams-automate-incident-response-to-stop-exploits-before-funds-move, vendor-reported). Those use an external detector. Mamori uses none. The queue delay is a cancel window, not a detection window. A delay between a decision and its effect was exploited in the Tether blacklist case (https://cointelegraph.com/news/tether-blacklist-delay-allowed-78-million-usdt-move).

## 5. Loss bound

Stated per token, per rolling 24 h window, in token units with no price. It is a vector over tokens, not one number.

    loss(token, 24h) <= cap(token) + pending_limit(token)

This holds only while all of these hold:

| Condition | Note |
|---|---|
| Delay >= 24 h | Queue contents at window start (at most the pending limit) can execute, and nothing requested inside the window can. With delay under 24 h the bound is cap + 2 x pending limit, because the request window also admits one pending limit inside the window. Drill builds break this. |
| No classical full-access key and no extra function-call key | cage-check at a point in time |
| No key registered on `intents.near` | Such a key is outside the cap whether or not Mamori recorded it. Balances held on `intents.near` are outside the bound. |
| Gas allowances counted separately | Up to 8 keys x 0.25 NEAR default are drained outside the cap. |
| Admin is online during the cancel window for the pending part | Otherwise the pending part executes. |
| Allowlist enforced for payee control | Off by default. With it off, any payee gets instant sends up to the cap. |

Not bounded: repeated in-cap drain across many windows without human review, and a calibrated attacker who reads `check` headroom and sends exactly the cap with zero strikes. The refund path in `on_send_done` re-attributes failed sends by heuristic, and the property tests must cover it. The formula was re-derived against `lib.rs` at HEAD 65fde6a [LOSS-BOUND.md header]. It must be re-derived after any code change before it is published anywhere. Strikes do not add to the bound, because spend before and after a strike sits in the same window.

## 6. Stretch items (not promised, in cut order)

| Item | Design | Default and conditions |
|---|---|---|
| Deny-only sentinel | A classical function-call key limited to a `freeze` method. Freeze is bounded and auto-expiring by lazy timestamp comparison (NEAR has no scheduled execution). Cooldown or cumulative-freeze budget so a stolen sentinel cannot re-freeze every block. Admin can always unfreeze, because guard-induced fund lock is a documented risk (https://docs.safefoundation.org/smart-account/guards). | Stretch. Must use classical key (2.2). |
| Yield hold | `promise_yield_create` (https://docs.near.org/smart-contracts/anatomy/yield-resume). The timeout is a fixed protocol parameter (200 blocks, not configurable), resume must come from a method of the same contract, and the callback runs with an error on timeout. Payload size limit and the wall-clock length of 200 blocks are unverified. | Default NO-GO. A human admin has only minutes to resume, so approval is realistic only for a bot admin, which defeats the design. Spike runs one day and only continues if it finds a use that needs no human within 200 blocks. |
| `sweep_to_safe(id)` | Destination fixed at init. Applies only inside an admin-declared emergency window. Items sweep rather than vanish. Watchers are classical keys using `signer_account_pk`. | A watcher is value-moving authority: add it to cage-check method and receiver rules and to the loss text. A stolen watcher can sweep the whole queue to the safe account, a loss only if the safe account is compromised, and a censorship grief otherwise. |
| Policy-key split | Cold ML-DSA full-access key almost never used, plus a restricted function-call policy key whose loosening (raise cap, add daily key) waits a delay the cold key can cancel. The policy key's method list contains only dedicated `propose_*` methods, never an admin method, because `assert_admin` is `predecessor == self` and every key satisfies it. Loosening is applied by a permissionless `apply()` after the delay. cage-check verifies those method lists. | Without the split, delay-to-loosen is not a security control, because a full-access admin can bypass any contract timelock. Safe's 24 h guard-removal timelock is precedent (same Safe help article as above, authored by Hypernative). |

## 7. Test and demo design

Tests: unit, property (random multi-key call sequences with queue interleavings, loss bound asserted after every step), fuzz on amounts and order, paths matrix. Named cases: burned keys cannot act, refusal persistence, overflow, queue flood, expiry, zero-allowance rejection, key A exhausts cap and key B must not burn, ML-DSA admin can call every admin method.

Scripted testnet attacks, each with pass or fail and measured blocks:

| # | Attack | Expected |
|---|---|---|
| 1 | Injected agent sends over the cap repeatedly (clumsy attacker) | Key burned at strike N, no funds above cap move |
| 2 | Calibrated attacker: in-cap sends to an attacker payee, headroom read from `check`, allowlist off. Mandatory. | Loss equals exactly one cap, zero strikes. This is the honest picture of what the counter does not do. |
| 3 | Burst of in-cap sends | Loss equals one cap |
| 4 | Queue flood by one key | Caps hold, per-key slots hold, `cancel_all` works |
| 5 | Stale queue item | Expires and cannot execute |
| 6 | New payee via `request_withdraw` (not `send_small`) | Queued, then cancelled |
| 7 | Decimal-misread send | Refused or bounded per token |
| 8 | Planted ed25519 full-access key and a null-allowance key | cage-check red, then green after removal |
| 9 | Cross-key grief: key A exhausts the cap | Honest key B is not burned |

Demo (90 seconds, Q1 open): run attack 2, then attack 1, then attack 8. One table: scenario, theoretical bound, measured loss, blocks to containment, admin actions needed. Measured numbers only, no speed comparison against vendors. A CrAIBench-style replay is optional and asserts only the contract outcome. A strike's false-positive cost is measured in replay and reported.

## Corrections pending

- ML-DSA support in near-sdk 5.30 (section 2.2, Constraint paragraph): the design text says there is no ML-DSA variant; V3-W2-EDITH-PROGRESS.md says `CurveType::MLDSA65` and `env::ml_dsa_verify` are present in the locked version. Both are kept with their sources. Re-verify against the near-sdk source before relying on either. THREAT-MODEL.md sections 6 and 7 carry the same disagreement.
