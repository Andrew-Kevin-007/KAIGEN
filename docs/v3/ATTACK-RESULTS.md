# KAIGEN v3 attack results (M7 nine scripted attacks, M8 measured table)

Caveat for every number below: sandbox, 128 ms blocks, ed25519 admin. Testnet was not run. Single-validator nearcore sandbox; the vault is Mamori built from this repository's HEAD. No audit, no mainnet.

| fact | value |
|---|---|
| date | 2026-11-04 |
| repository HEAD at the runs | 5107d48. Final build includes a type-alias edit to contracts/mamori/src/lib.rs made after the timed phase; the timed phase ran on the earlier build (see next row) |
| mamori.wasm under test (final build, all non-timed attacks and M8) | out/prod/mamori.wasm, 376,192 bytes, sha256 76abf7141d792199bd010bc7d8d84cdba6dafebc037e6a1bfb54a7c5a1d65532 |
| mamori.wasm, timed phase (attacks 2c, 5, 9b, 11.4, clock jumps) | 376,192 bytes, sha256 f9785d16c6ae6933423c8145e1c344470a2eac78862c680d572593cec27d8a7b. Caveat: differs from the final build only in source line numbers embedded in panic text after the type-alias edit; behaviour identical |
| mamori lib.rs sha256 (final) | c303c27069180d16230368fa8eee6980f73a441675c3cfeb76b62731e4076436 |
| NEP-141 look-alike (attack 7 only) | ft_mock.wasm, 90,531 bytes, sha256 1eadd43b34f990103272a45e885c8803307f6ab2b05bead18f4fd34a669ef5b6 |
| node | nearcore 2.14.0, protocol 88, single validator, init --fast (128 ms blocks), WSL |
| vault admin | ed25519 full-access key (stand-in for the ML-DSA key of production) |
| vault configuration | cap 1 NEAR / 24 h, delay 86,400 s, 3 strikes, pending limit 10 NEAR (default 10 x cap), minimum send 0.001 NEAR |

Source of every number: the `ATTACK-RESULT` line each attack in `tests-integration/tests/attacks` prints (one JSON object per attack). Production of this file is described in section 14.

## 1. Verdicts against the documented claims (ARCHITECTURE.md section 7)

| # | attack | documented claim | result | headline measured numbers | amount lost vs the bound C + P |
|---|---|---|---|---|---|
| 1 | clumsy agent | key burned at strike N, no funds above cap move | attack_1a: PASS; attack_1b: PASS; attack_1c: PASS | 1a over-cap: N=3: strikes used 3, key off the account 1 block after the burn decision (11 blocks after the first attempt), funds to attacker 0 NEAR, 12.188 Tgas burnt \| 1b unlisted payee: N=3: strikes used 3, key off the account 1 block after the burn decision (11 blocks after the first attempt), funds to attacker 0 NEAR, 12.503 Tgas burnt \| 1c over-cap: N=10: strikes used 10, key off the account 1 block after the burn decision (46 blocks after the first attempt), funds to attacker 0 NEAR, 31.646 Tgas burnt | lost 0 NEAR in all three; bound C 1 + P 10 = 11 NEAR |
| 2 | calibrated attacker (mandatory) | loss equals exactly one cap, zero strikes | attack_2a: PASS; attack_2b: PASS; attack_2c: PASS | loss 1 NEAR = 1 cap, strikes 0 after 6 more probes, 5 `check` calls, 4 sends over 21 blocks, queue filled to 10 NEAR (locked) \| one day later, nobody cancelling: 11 NEAR in one 24 h window (cap + pending = 11) | 2a: 1 NEAR; 2c: 11 NEAR in one window; bound C 1 + P 10 = 11 NEAR |
| 3 | burst of in-cap sends | loss equals one cap | attack_3a: PASS; attack_3b: PASS; attack_3c: PASS | 1 key: 4 caps attempted in 40 calls, 10 landed, loss 1 NEAR, 2 block \| 4 keys: 8 caps attempted, 10 landed, loss 1 NEAR, 2 blocks \| default allowance: chain took in 8 of 40, loss 0.8 NEAR | 3a 1, 3b 1, 3c 0.8 NEAR; bound C 1 + P 10 = 11 NEAR |
| 4 | queue flood by one key | caps hold, per-key slots hold, cancel_all works | attack_4a: PASS; attack_4b: PASS | 40 dust requests: 16 accepted (2 keys, count cap 32), 24 refused, honest key accepted True, cancel_all removed 17 for 10.538 Tgas \| queued sum 10 NEAR = pending limit 10 | 0 NEAR moved in 4a, 0 in 4b; at most 10 NEAR queued, none executable; bound C 1 + P 10 = 11 NEAR |
| 5 | stale queue item | expires and cannot execute | attack_5: PASS | execute of an expired request: "expired", purge_expired removed 2, 228 chain s past expiry, funds from stale requests 0 | 0 NEAR from the stale requests |
| 6 | new payee via request_withdraw | queued, then cancelled | attack_6: PASS | queued 5 NEAR with no strike, execute at once "still locked", cancelled 11 blocks (1403 chain ms) after the request with 86398596 ms of lock left, funds to payee 0 | 0 NEAR; 5 NEAR was queued; bound C 1 + P 10 = 11 NEAR |
| 7 | decimal-misread send | refused or bounded per token | attack_7: PASS | largest single misread that went through: ft6 50 tokens (cap 100), NEAR 0.5 (cap 1); total held by attacker ft6 55.005 tokens | ft6 55.005 tokens vs cap + pending 1100; NEAR 0.5 vs C 1 + P 10 = 11 NEAR |
| 8 | planted full-access key and null-allowance key | cage-check red, then green after removal | attack_8: PASS | clean cage: exit 0 GREEN; ed25519 full-access key planted: exit 1 RED ARCH-2.8-1; ed25519 key removed: exit 0 GREEN; null-allowance function-call key planted: exit 1 RED ARCH-2.8-3, ARCH-2.8-6; null-allowance key removed: exit 0 GREEN; control, no stand-in flag: exit 1 RED ARCH-2.8-1, ARCH-2.8-2 |  |
| 9 | cross-key grief | honest key B is not burned | attack_9: PASS; attack_9b: PASS | B refused 11 times, strikes 0 (v2 rule burns at 3) \| B succeeds again a day later (last refusal at 0 chain s, first success at 86525 chain s after A's spend) | A spent 1 NEAR (the cap); B lost 0; bound C 1 + P 10 = 11 NEAR |

## 2. Attack 1: clumsy agent

### 1a: 2 NEAR over the 1 NEAR cap, allowlist off, N = 3

| measured | value |
|---|---|
| verdict | PASS |
| variant | amount 2 NEAR (cap 1 NEAR), allowlist off, N=3 |
| strikes used (N) | 3 of 3 |
| first attempt block | 78 |
| burn decision block | 88 |
| DeleteKey receipt block (key off the account from this block) | 89 |
| last callback block | 91 |
| blocks, burn decision to key off the account | 1 |
| blocks, first attempt to key off the account | 11 |
| chain ms, first attempt to key off the account | 1389 |
| key on the account at the burn block / the block before the delete / the delete block | True / True / False |
| gas burnt by all attempts (Tgas) | 12.188 |
| tokens burnt by all attempts (NEAR) | 0.00110722330545 |
| gas burnt by the burning attempt alone (Tgas) | 6.690 |
| allowance at the start / used before the burning attempt (NEAR) | 0.25 / 0.0005051915547643 |
| funds moved to the attacker (NEAR) | 0 |
| vault balance change after settling (NEAR) | -0.00110722330545 |
| after the burn, runtime rejects send_small / request_withdraw | True / True |

### 1b: 0.01 NEAR to a payee off the enforced allowlist, N = 3

| measured | value |
|---|---|
| verdict | PASS |
| variant | amount 0.01 NEAR to a payee off the enforced allowlist, N=3 |
| strikes used (N) | 3 of 3 |
| first attempt block | 149 |
| burn decision block | 159 |
| DeleteKey receipt block (key off the account from this block) | 160 |
| last callback block | 162 |
| blocks, burn decision to key off the account | 1 |
| blocks, first attempt to key off the account | 11 |
| chain ms, first attempt to key off the account | 1394 |
| key on the account at the burn block / the block before the delete / the delete block | True / True / False |
| gas burnt by all attempts (Tgas) | 12.503 |
| tokens burnt by all attempts (NEAR) | 0.0011387352659226 |
| gas burnt by the burning attempt alone (Tgas) | 6.821 |
| allowance at the start / used before the burning attempt (NEAR) | 0.25 / 0.0005235672868913 |
| funds moved to the attacker (NEAR) | 0 |
| vault balance change after settling (NEAR) | -0.0011387352659226 |
| after the burn, runtime rejects send_small / request_withdraw | True / True |

### 1c: 2 NEAR over the cap, allowlist off, N = 10 (the ceiling)

| measured | value |
|---|---|
| verdict | PASS |
| variant | amount 2 NEAR (cap 1 NEAR), allowlist off, N=10 (ceiling) |
| strikes used (N) | 10 of 10 |
| first attempt block | 227 |
| burn decision block | 272 |
| DeleteKey receipt block (key off the account from this block) | 273 |
| last callback block | 275 |
| blocks, burn decision to key off the account | 1 |
| blocks, first attempt to key off the account | 46 |
| chain ms, first attempt to key off the account | 5807 |
| key on the account at the burn block / the block before the delete / the delete block | True / True / False |
| gas burnt by all attempts (Tgas) | 31.646 |
| tokens burnt by all attempts (NEAR) | 0.0028968281564534 |
| gas burnt by the burning attempt alone (Tgas) | 6.741 |
| allowance at the start / used before the burning attempt (NEAR) | 0.25 / 0.0022897312220727 |
| funds moved to the attacker (NEAR) | 0 |
| vault balance change after settling (NEAR) | -0.0028968281564534 |
| after the burn, runtime rejects send_small / request_withdraw | True / True |

## 3. Attack 2: calibrated attacker (mandatory)

### 2a: drain the cap from `check`, probe on, fill the queue (day 0)

| measured | value |
|---|---|
| verdict | PASS |
| cap (NEAR) | 1 |
| loss in the instant path (NEAR) = caps | 1 = 1 |
| sends that moved money | 4 |
| `check` calls used (free views) | 5 |
| blocks, first to last send | 21 |
| strikes after the drain | 0 |
| refused probes after the cap was used up / strikes after them | 6 / 0 |
| gas burnt per send, average (Tgas) | 5.575 |
| gas burnt per refused probe (Tgas) | 2.688 |
| queued after the drain (NEAR) in requests | 10 in 2 |
| gas burnt per request_withdraw (Tgas) | 3.231 |
| queued request executable at once | False |
| key still on the account | True |
| vault balance change after settling (NEAR) | -1.0042470948756399 |

### 2b: uncounted probing until the node stops the key (allowance 0.02 NEAR)

| measured | value |
|---|---|
| verdict | PASS |
| allowance at the start (NEAR) | 0.02 |
| refused probes at 10 Tgas prepaid before the node stopped the key | 37 |
| allowance left when the 10 Tgas probes stopped (NEAR) | 0.0108905699641696 |
| allowance used per probe, last (NEAR) | 0.0002462008117792 |
| gas burnt per probe (Tgas) | 2.685 |
| further probes refused at 5 Tgas prepaid | 1 |
| allowance left at the end (NEAR) | 0.004971436425683 |
| node's own words when asked again | {"cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"NotEnoughAllowance":{"account_id":"dev-20261104062234-84763118708798.test.near","allowance":"10890569964169600000000","cost" |
| strikes at the end | 0 |
| key on the account at the end / still recorded by the vault | True / True |

### 2c: the same attacker one day later with nobody cancelling (chain clock moved 24 h)

| measured | value |
|---|---|
| verdict | PASS |
| cap / pending limit (NEAR), delay (h) | 1 / 10, 24 |
| calls in the tight window (one send and the executes) | 3 |
| blocks spanned by the tight window | 17 |
| most lost in any 24 h window (NEAR) | 11 |
| cap + pending limit (NEAR) | 11 |
| total held by the attacker over the 2 windows (NEAR) | 12 |
| chain seconds between the first cap and the tight window | 86529 |
| gas burnt per execute (Tgas) | 5.552 |
| admin actions taken | 0 |

## 4. Attack 3: burst of in-cap sends

| measured | 3a one key, 10 NEAR allowance | 3b four keys, 10 NEAR allowance each | 3c one key, default 0.25 NEAR allowance |
|---|---|---|---|
| verdict | PASS | PASS | PASS |
| calls signed (keys x calls per key) | 40 (1 x 40) | 80 (4 x 20) | 40 (1 x 40) |
| prepaid gas per call (Tgas) | 30 | 30 | 30 |
| attempted (caps) | 4 | 8 | 4 |
| calls the chain took in / never took in | 40 / 0 | 80 / 0 | 8 / 32 |
| calls that moved money | 10 | 10 | 8 |
| calls refused as cap used up (uncounted) | 30 | 70 | 0 |
| sent per key | [10] | [3, 2, 3, 2] | [8] |
| loss (NEAR) | 1 | 1 | 0.8 |
| strikes after (per key) | [0] | [0, 0, 0, 0] | [0] |
| blocks spanned by the burst | 2 | 2 | 1 |
| wall ms to submit all calls | 83 | 128 | 66 |
| gas per sent call / per refused call, average (Tgas) | 5.526 / 2.677 | 5.527 / 2.677 | 5.525 / 0.000 |

## 5. Attack 4: queue flood

### 4a: 40 dust requests from one of two keys

| measured | value |
|---|---|
| verdict | PASS |
| requests sent / accepted / refused (slots) / never taken in | 40 / 16 / 24 / 0 |
| queue length after the flood (count cap) | 16 (32) |
| honest key's request accepted; queue length then | True; 17 |
| queued value (NEAR) | 0.516 |
| cancel_all removed | 17 |
| cancel_all gas (Tgas) | 10.538 |
| blocks spanned by the flood | 1 |
| gas per accepted / per refused request, average (Tgas) | 4.316 / 4.788 |
| strikes of A after | 0 |

### 4b: both keys fill their share of the pending limit

| measured | value |
|---|---|
| verdict | PASS |
| pending limit / each key's share (NEAR) | 10 / 5 |
| one yocto more from A | over this key's share of the pending limit for this token |
| one yocto more from B | over the pending limit for this token |
| queued sum (NEAR); equals the pending limit | 10; True |
| cancel_all removed / gas (Tgas) | 2 / 3.162 |
| the same request after cancel_all | over the 24 h pending limit for this token |
| gas per request_withdraw (Tgas) | 3.014 |

## 6. Attack 5: stale queue item (chain clock moved 48 h)

### 5: three requests, one executed in its window, two left to expire

| measured | value |
|---|---|
| verdict | PASS |
| requests: executed inside the window / left to go stale | 1 / 2 |
| delay / execute window (h) | 24 / 24 |
| chain seconds past expiry when tried | 228 |
| execute of a stale request | expired |
| queue length after expiry, before the purge | 2 |
| purge_expired removed | 2 |
| execute after the purge | no such request |
| funds reaching the payee from the stale requests (yocto) | 0 |
| gas: execute inside window / execute refused expired / purge_expired of 2 (Tgas) | 5.944 / 2.041 / 3.154 |

## 7. Attack 6: new payee through request_withdraw

### 6: 5 NEAR to an unlisted payee through the queue

| measured | value |
|---|---|
| verdict | PASS |
| request amount (NEAR) = caps | 5 = 5 |
| strikes: after the send_small control / after request_withdraw | 1 / 1 |
| delay (ms) | 86400000 |
| request block / cancel block / blocks between | 1064 / 1075 / 11 |
| chain ms, request to cancel | 1403 |
| lock still left at the cancel (ms) | 86398596 |
| execute at once | still locked |
| execute after the cancel | no such request |
| funds moved to the new payee (yocto) | 0 |
| gas: request / cancel / refused execute (Tgas) | 3.019 / 2.563 / 2.043 |
| admin actions needed | 1 |

## 8. Attack 7: decimal-misread send

| asset | intended | decimals the agent believed | amount sent | outcome | moved to attacker |
|---|---|---|---|---|---|
| ft6 (6 decimals, cap 100) | 5 tokens | 6 | 5 | Sent | 5 |
| ft6 (6 decimals, cap 100) | 5 tokens | 3 | 0.005 | Sent | 0.005 |
| ft6 (6 decimals, cap 100) | 5 tokens | 7 | 50 | Sent | 50 |
| ft6 (6 decimals, cap 100) | 5 tokens | 8 | 500 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| ft6 (6 decimals, cap 100) | 5 tokens | 9 | 5000 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| ft6 (6 decimals, cap 100) | 5 tokens | 18 | 5000000000000 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| ft6 (6 decimals, cap 100) | 5 tokens | 24 | 5000000000000000000 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| ft6 (6 decimals, cap 100) | 5 tokens | 7 | 50000000 raw (repeat) | Refused { reason: "over the 24 h limit", strikes: 0, burned: false } | 0 |
| NEAR (24 decimals, cap 1) | 0.5 NEAR | 24 | 0.5 | Sent | 0.5 |
| NEAR (24 decimals, cap 1) | 0.5 NEAR | 18 | 0.0000005 | Refused { reason: "below the minimum send", strikes: 0, burned: false } | 0 |
| NEAR (24 decimals, cap 1) | 0.5 NEAR | 25 | 5 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| NEAR (24 decimals, cap 1) | 0.5 NEAR | 27 | 500 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| NEAR (24 decimals, cap 1) | 0.5 NEAR | 30 | 500000 | Refused { reason: "over the 24 h limit", strikes: 1, burned: false } | 0 |
| ft8 (8 decimals, no limit set) | 5 tokens | 8 | 500000000 raw | Refused { reason: "no 24 h limit is set for this token", strikes: 0, burned: false } | 0 |

| measured | value |
|---|---|
| verdict | PASS |
| largest single misread that went through: ft6 tokens (cap 100) / NEAR (cap 1) | 50 / 0.5 |
| total held by the attacker: ft6 tokens / NEAR | 55.005 / 0.5 |
| token fixture | ft-mock, NEP-141 look-alike (no storage registration, open mint) |

## 9. Attack 8: planted keys and cage-check

| step | exit code | verdict | red rows | rows run | final block read | checker wall ms |
|---|---|---|---|---|---|---|
| clean cage | 0 | GREEN | none | 10 | 1383 | 467 |
| ed25519 full-access key planted | 1 | RED | ARCH-2.8-1 | 10 | 1393 | 360 |
| ed25519 key removed | 0 | GREEN | none | 10 | 1403 | 372 |
| null-allowance function-call key planted | 1 | RED | ARCH-2.8-3, ARCH-2.8-6 | 10 | 1413 | 387 |
| null-allowance key removed | 0 | GREEN | none | 10 | 1423 | 387 |
| control, no stand-in flag | 1 | RED | ARCH-2.8-1, ARCH-2.8-2 | 10 | 1426 | 376 |

| measured | value |
|---|---|
| verdict | PASS |
| checker | `jobs/src/bin.mjs cage-check`, committed HEAD |
| blocks from the key change's last receipt to the block the checker read: full-access key / null-allowance key | 4 / 4 |
| mode | sandbox, ed25519 admin passed as --stand-in-admin; not a production result |

## 10. Attack 9: cross-key grief

### 9 (day 0)

| measured | value |
|---|---|
| verdict | PASS |
| cap used up by A (NEAR) | 1 |
| refusals of B without a strike | 11 |
| refusal at which the v2 counting rule burns B | 3 |
| strikes of B after | 0 |
| `check` for B | {"counted": false, "headroom": "0", "reason": "cap_exhausted", "verdict": "refuse", "would_burn": false} |
| gas per refused send of B (Tgas) | 2.762 |
| B's request_withdraw during the grief | accepted |
| B still refused after A was removed | True |
| control: counted refusals that burn the same key | 3 |

### 9b: one chain day later

| measured | value |
|---|---|
| verdict | PASS |
| chain seconds after A's spend: B's last refusal | 0 |
| chain seconds after A's spend: B's first success | 86525 |
| window (s) | 86400 |
| strikes of B | 0 |
| gas of B's send (Tgas) | 5.655 |

## 11. M8: measured table

### 11.1 Blocks to key deletion

| case | burn decision block | DeleteKey receipt block (key off the account) | last callback block | blocks, burn to off the account | blocks, first attempt to off the account | chain ms, first attempt to off the account |
|---|---|---|---|---|---|---|
| burn by 3 over-cap sends | 88 | 89 | 91 | 1 | 11 | 1389 |
| burn by 3 unlisted-payee sends | 159 | 160 | 162 | 1 | 11 | 1394 |
| burn by 10 over-cap sends (N = 10) | 272 | 273 | 275 | 1 | 46 | 5807 |

### 11.2 Gas per call type

Gas price 100000000 yocto per gas. Gas is summed over the transaction and every receipt it caused.

| call | gas burnt (Tgas) | tokens burnt (NEAR) | receipts | blocks, tx to last receipt |
|---|---|---|---|---|
| add_daily_key (admin: AddKey receipt + callback) | 5.529 | 0.0004859716413795 | 6 | 3 |
| send_small, sent (NEAR transfer + callback), sample 0 | 5.630 | 0.0004960847211687 | 6 | 3 |
| send_small, sent (NEAR transfer + callback), sample 1 | 5.653 | 0.0004983425561264 | 6 | 3 |
| send_small, sent (NEAR transfer + callback), sample 2 | 5.656 | 0.000498675884378 | 6 | 3 |
| request_withdraw, sample 0 | 3.018 | 0.000279514147211 | 2 | 1 |
| request_withdraw, sample 1 | 3.230 | 0.000300674918341 | 2 | 1 |
| request_withdraw, sample 2 | 3.410 | 0.000318687513932 | 2 | 1 |
| cancel (admin), 1 request | 2.950 | 0.0002726463312639 | 2 | 1 |
| cancel_all (admin), 2 requests | 3.156 | 0.0002932984452523 | 2 | 1 |
| send_small, refused, uncounted (cap used up), sample 0 | 2.765 | 0.0002541460049523 | 2 | 1 |
| send_small, refused, uncounted (cap used up), sample 1 | 2.765 | 0.0002541460049523 | 2 | 1 |
| send_small, refused, uncounted (cap used up), sample 2 | 2.765 | 0.0002541460049523 | 2 | 1 |
| send_small, refused, uncounted (below minimum send) | 2.764 | 0.000254068850522 | 2 | 1 |
| send_small, refused, counted (strike 1) | 2.868 | 0.0002644562342361 | 2 | 1 |
| send_small, refused, counted (strike 2) | 2.886 | 0.0002662412195622 | 2 | 1 |
| send_small, refused, counted, burns the key (strike 3: queue cancel + DeleteKey + callback) | 6.893 | 0.0006223893723204 | 6 | 3 |
| remove_daily_key (admin: DeleteKey + callback) | 6.089 | 0.0005419183988872 | 6 | 3 |

| call (from attack 5) | gas burnt (Tgas) |
|---|---|
| execute, inside its window, 1 NEAR | 5.944 |
| execute, refused as expired | 2.041 |
| purge_expired, 2 requests | 3.154 |

### 11.3 False-positive cost of a strike, in replay

Caveat: scripted honest trace, mistake mix chosen by us; not recorded agent behaviour; chain-side recovery only, admin response time is not measured.

| honest mistake | `check` says counted | strikes after | gas (Tgas) |
|---|---|---|---|
| first payment to a new vendor that is not on the allowlist yet | True | 1 | 2.841 |
| legitimate payment above the whole 24 h cap (1.5 NEAR) | True | 1 | 2.837 |
| dust below the minimum send | False | 0 | 2.740 |
| token with no limit set | False | 0 | 2.810 |
| cap used up by earlier honest spending (account-wide window) | n/a | 0 | 2.757 |
| request_withdraw above the pending limit (a panic) | n/a | 0 | 2.151 |
| zero amount (a panic) | n/a | 0 | 2.156 |

| a false burn (3 counted honest mistakes) | value |
|---|---|
| strikes seen | [1, 2, 3] |
| queued requests cancelled by the burn / value (NEAR) | 2 / 10 |
| burn decision / DeleteKey / confirmed block | 1711 / 1712 / 1714 |
| gas of the burning call (Tgas) | 8.010 |
| admin actions to recover / gas of the re-add (Tgas) | 1 / 5.532 |
| blocks, burn decision to the re-add executed | 7 |
| first send after the re-add | Sent |
| request_withdraw after the re-add | over the 24 h pending limit for this token |

| admin re-adds the burned key at once (40 attempts, 10 ms apart) | value |
|---|---|
| burn decision block / confirmed block | 1754 / 1757 |
| blocks in which the re-add was refused as not confirmed | 3 (blocks [1754, 1755, 1756]) |
| first successful re-add block | 1757 |
| attempts total / that ran before the burn decision / after the first success | 40 / 0 / 19 |

| scripted honest trace, seed | ops | mix: pay / new payee / big pay / dust / no-limit token | burn at op | counted mistakes before burn | uncounted refusals before burn | honest payments completed before burn | ops after the burn | denied by the runtime |
|---|---|---|---|---|---|---|---|---|
| 1 | 80 | 56 / 9 / 4 / 5 / 6 | 34 | 3 | 5 | 27 | 45 | 45 |
| 2 | 80 | 59 / 8 / 2 / 8 / 3 | 29 | 3 | 3 | 24 | 50 | 50 |
| 3 | 80 | 61 / 10 / 2 / 5 / 2 | 15 | 3 | 0 | 13 | 64 | 64 |

### 11.4 A strike lapses (chain clock moved 24 h)

| measured | value |
|---|---|
| verdict | PASS |
| strikes before / strikes_of a day later | 2 / 0 |
| chain seconds since the first strike | 86534 |
| a third mistake then | Refused { reason: "recipient is not on the allowlist", strikes: 1, burned: false } |
| cumulative count (open question Q4) measured | False |

## 12. Chain clock jumps used

| jump | blocks skipped | chain seconds | wall seconds |
|---|---|---|---|
| latest unlock / window end of T0 plus 2 min | 288822 | 86519 | 2964 |
| expiry of the stale requests plus 2 min | 288025 | 86497 | 3172 |

## 13. Not run, and what the numbers do not cover

- Testnet: not run. Mainnet: not run. Every number is from one single-validator nearcore sandbox, 128 ms blocks.
- The vault's admin is an ed25519 full-access key standing in for the ML-DSA key; attack 8 passes it to cage-check as `--stand-in-admin` and the checker marks the result not a production result.
- Attack 7's NEP-141 is `tests-integration/fixtures/ft-mock`, a look-alike with no storage registration and an open mint, not a real token contract.
- The honest traces in 11.3 are scripted by us; no recorded agent behaviour or agent-benchmark data was used. The cumulative strike count (open question Q4) does not exist in the contract and was not measured.
- Admin response time (a human noticing and acting) is not measured; the recovery numbers are chain-side only.
- Leash and near-agent-spend-guard (M9) were not run.
- Attack 2b did not drive an allowance to exactly zero: the node began refusing the key's transactions while it still held the amount shown in 2b, because the prepaid gas of a call is charged against the allowance at a pessimistic price and refunded later. What the runtime does to a key whose allowance reaches exactly 0 was not observed.
- One vault configuration only (cap 1 NEAR, default pending multiple 10, delay 24 h, 3 strikes except attack 1c with 10). Not exercised on a chain: eight daily keys at once, registered intents keys, a non-NEAR token in the queue, the failed-transfer refund and requeue paths (those are covered by the unit and property tests only), the ML-DSA admin.
- Block counts are exact for this sandbox; blocks per second on testnet differ, so the block counts carry over and the chain-millisecond figures do not.

## 14. How these numbers were produced

`tests-integration/tests/attacks/*.rs` run against the WSL sandbox (`tests-integration/sandbox/start.ps1`) with `KAIGEN_ATTACK_RESULTS` set; this file is rendered from that results file by `tests-integration/tests/attacks/render_results.py`. Each attack asserts its own PASS conditions; a failed condition is recorded as FAIL and fails the test. The day-long parts (2c, 5, 9b, 11.4) move the chain clock with `sandbox_fast_forward`; the contract reads that clock, so they exercise the real 24 h rules without waiting (that one test is `#[ignore]`d and took about 100 minutes of wall time; section 12 gives the measured cost).
