# KAIGEN v3 threat model (design draft)

Status: design only. Testnet only. No audit. No contract code of v3 exists yet. "Covered" means loss is bounded under the stated conditions, never prevented. Every bound is per token, per rolling 24 h, in token units, and is void under the conditions in ARCHITECTURE.md section 5. The bound formula has not been re-derived against v3 code.

## 1. Standing assumptions

| Assumption | If false |
|---|---|
| The account has exactly one full-access key, an ML-DSA-65 admin key, and no other classical full-access key | The guard is void. cage-check detects this at a point in time only. A contract cannot restrict a full-access key (https://docs.near.org/protocol/access-keys). |
| Daily keys are classical function-call keys limited to two methods on the account, non-null allowance | Admin gating by `predecessor == current_account` is no longer safe, because every key satisfies it. |
| Production delay floor of 24 h | Bound becomes cap + 2 x pending limit |
| Admin looks at least once per delay period | Pending part of the bound executes |

## 2. Covered (loss bounded by cap plus pending limit, in token units)

| Threat | Source | Mechanism | Remaining gap |
|---|---|---|---|
| Prompt or memory injection of the agent | https://arxiv.org/abs/2503.16248 (memory injection in ElizaOS) | Cap, allowlist if enforced, strike then burn | A calibrated attacker stays in the cap with zero strikes |
| Control-plane compromise of an agent operator | AIXBT dashboard breach, 55.5 ETH, https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth | Same | Same |
| Honest agent error, such as unit misreads or lost state | Lobstar Wilde incident, cause is speculation: https://www.theblock.co/post/390722/ai-agent-created-by-openai-dev-accidentally-sends-entire-memecoin-holdings-to-reply-guy | Per-token cap | Cap is in token units with no price |
| Queue flooding and stale queue items | Design | Count, sum, per-key slots, expiry, purge, `cancel_all` | A hijacked key can still occupy its own slots and spend its own share of the request budget |
| A daily key repeating above-cap calls | Design | Counted refusals, burn at N in 24 h | A prober staying under N per 24 h is never burned |
| Exposure of classical hot keys to a quantum attacker | Resource estimates are papers, not machines (under 1200 logical qubits in https://arxiv.org/abs/2603.28846) | Caps the hot keys while the admin is ML-DSA | This is bounded exposure, not quantum protection. v3 gives no early warning. |

## 3. Partly covered

| Threat | What helps | What does not |
|---|---|---|
| Malicious payee or inflated price (x402 client with no spend limit by default, https://thehackernews.com/2026/10/critical-x402-sdk-flaw-could-let.html, article dated 2026-10-23) | Cap | An allowlisted payee that raises its price is bounded only by the cap. The allowlist is off by default. |
| Cross-key grief inside the cap window (present in v2) | v3 counts only never-succeed refusals, test required | Key A can still exhaust the cap, and honest key B is refused (uncounted) for up to 24 h |
| Admin offline during the cancel window | Delay and expiry | Pending items execute. Optional `sweep_to_safe` only if it ships. |
| Attacker probing with wrong methods | Runtime rejects at access-key layer | The contract cannot count these. Bounded only by the key's gas allowance. |
| Gas drain through key allowances | Non-null allowance, cage-check maximum | Up to 8 keys x 0.25 NEAR by default is outside the cap |
| Queue DoS by one hijacked key | Per-key slots and budget share (v3) | Honest withdrawals through that key are blocked until it is burned or removed |

## 4. Not covered

| Threat | Why |
|---|---|
| Cold admin key compromise | Admin is full-access and can bypass any contract timelock (Transfer, DeployContract, DeleteKey) |
| Any classical full-access key on the account | Guard void. cage-check detects at a point in time. |
| Any key registered on `intents.near` | Signs there with no Mamori cap, whether or not recorded by `register_intents_key`. Balances held on `intents.near` are outside the bound. cage-check lists recorded intents keys as red. |
| Theft inside the cap | Zero delay and no cancel window, the same shape as the Squads spending-limit path (debits are not affected by time lock, https://developers.squads.so/squads-api/api-reference/v1/policies.md) |
| Calibrated attacker using `check` headroom | Sends exactly the cap, never refused, never struck |
| Slow in-cap drain repeated daily | Needs a human to notice |
| Validator and consensus keys, Chain Signatures cross-chain spend | Outside the scope of NEP-645 and of the guard (https://docs.near.org/chain-abstraction/chain-signatures) |
| Blind-signing by the admin | Bybit lesson (https://a16zfrontier.com/posts/article/bybit-hack-lessons) |
| A silent or state-level quantum attacker | No canary exists. Kizashi catches only a disclosed break. |
| Contract bugs | No audit, no formal verification |
| First ML-DSA enrolment | Signed by a classical key, exposed for that step |
| Mainnet behaviour | Never run. Activation of ML-DSA on mainnet unconfirmed. |
| Quantum value of the guard itself | Same bound against any adversary holding the key |

## 5. Attacker table

| Attacker | Capability | What v3 does | Expected outcome | Evidence status |
|---|---|---|---|---|
| Clumsy injected agent | Daily key, sends over cap or to unlisted payee | Counted refusals, burn at N in 24 h | No funds above cap, key deleted | Attack 1, not yet run for v3 |
| Calibrated attacker | Daily key, reads `check`, allowlist off | Cap only | Loses exactly one cap per token per window, zero strikes | Attack 2, mandatory, not yet run |
| Griefing or hijacked key | Daily key | Uncounted refusal for cap exhaustion, per-key queue slots | Honest key not burned. Honest key blocked for up to 24 h. | Attack 9, not yet run |
| Queue flooder | Daily key | Slots, sum, expiry, `cancel_all` | Caps hold | Attack 4, not yet run |
| Planter of a classical full-access key | Existing full-access control or admin mistake | cage-check red | Detection at a point in time only | Attack 8, not yet run |
| Intents-key holder | A key registered on `intents.near` | cage-check red only | Not bounded | Design only |
| Wrong-method prober | Daily key | Runtime rejection | Bounded by gas allowance | Docs only |
| Cold admin thief | ML-DSA admin key | Nothing | Total loss | Out of scope |
| Silent quantum attacker | Classical key break | Cap on hot keys, ML-DSA admin | Hot-key loss bounded, no warning | Resource papers only |
| Stolen watcher or sentinel (stretch) | Classical key with limited methods | Per 6 of ARCHITECTURE.md | Sweep to fixed safe account, or bounded freeze | Stretch, design only |
| Malicious allowlisted payee | Raises price | Cap | Bounded by cap only | Design only |

## 6. Relationship to Kizashi

Kizashi stays optional. It is a circuit breaker for a break someone discloses. The omen key is not a canary. Nothing says it breaks before the keys beside it. It cannot catch a silent attacker or a first-to-break state actor who keeps the break private. Kizashi verifies classical omen signatures (ed25519 and secp256k1) with existing host functions. A contract cannot verify an ML-DSA signature, because NEP-645 lists on-chain verification host functions as out of scope (https://github.com/near/neps/pull/645). Only an in-contract check of an ML-DSA signature, which neither v2 nor v3 contains, would need a new verifier.

## 7. What is unknown

| Item | Status |
|---|---|
| Whether a contract can read its own account's key list | Inference: no host function found. The host-function list was not read. |
| What `signer_account_pk` returns for an ML-DSA signer | Unverified. near-sdk 5.30 has no ML-DSA key variant. |
| Wall-clock length of 200 blocks, yield payload limit | Unverified |
| Gas keys with method restriction, ML-DSA gas-key support | Untested |
| False-positive cost of a strike | No source documents it. We measure ours. |
| Whether an exhausted allowance deletes or merely disables a NEAR function-call key | Unverified in nearcore. The v2 code comment says the runtime deletes it. |
