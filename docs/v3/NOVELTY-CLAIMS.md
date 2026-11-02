# KAIGEN v3 novelty claims (design draft)

Status: 2026-11-02. Each claim is falsifiable, limited to the sources read, and wrong if a counterexample appears. None of these is a headline. The word "novel" is not used until the gate in section 5 is passed.

## 1. Verdict table

| Id | Claim as allowed to be written | Verdict | Evidence |
|---|---|---|---|
| C1 | Contract-enforced caps on the user's own account. OutLayer enforces in a TEE. At least two other open-source NEAR testnet guards (Leash, near-agent-spend-guard) also enforce on-chain. Mamori is one of several on-chain guards, so on-chain enforcement is table stakes, not novelty. | Weak as a differentiator. Not claimed as novel. | https://app.outlayer.ai/docs/agent-custody ; https://github.com/mesh-pch/leash-near ; https://github.com/mubudot/near-agent-spend-guard . Mamori enforcement holds only while cage-check passes. OutLayer has an instant owner freeze that Mamori lacks. |
| C2 | In the sources checked on 2026-11-02, we found no account that deletes a function-call key on-chain after N refused calls. Scoped absence, not a claim that none exists. | Holds as a scoped absence. | Section 2. |
| C3 | Existing tools list keys and flag full-access keys. cage-check adds a policy-specific comparison of `attest()` against the key list: method and receiver scope, allowance, recorded keys, pinned global-contract hash. We found no tool that does that combined check. | Weak. Verification feature only. | Key-listing tools in LANDSCAPE.md section 2. |
| C4 (engineering property, not novelty) | Account-level aggregate cap with a written loss-bound invariant, attacked by property tests. | Not claimed novel. Already account-level per token in v2. We have not verified that peer guards lack it. | contracts/mamori/src/lib.rs. OpenZeppelin Stellar has per-rule period limits: https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |
| C5 (design distinction) | Containment has no external actor on the critical path. Competitors read use an external detector, Mamori uses none. | Holds as a description, with a cost: the counter sees only calls that reach the contract and only clumsy attackers. | https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative ; https://www.hypernative.io/insights/blog/how-defi-teams-automate-incident-response-to-stop-exploits-before-funds-move (vendor-reported) |

## 2. What was and was not checked for C2 (dated 2026-11-02)

Checked, no counterexample found:

| Source | Finding | URL |
|---|---|---|
| Coinbase agentic wallet docs | No automatic revocation mentioned | https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md |
| OutLayer docs | Revocation and freeze are manual | https://app.outlayer.ai/docs/agent-custody |
| MetaMask delegation docs | Explicit disable only | https://docs.metamask.io/smart-accounts-kit/guides/delegation/disable-delegation/ |
| Leash on NEAR | Revocation is owner-initiated, no strike counter | https://github.com/mesh-pch/leash-near |
| near-agent-spend-guard | Refused calls are plain failures, no counter | https://github.com/mubudot/near-agent-spend-guard |
| OpenZeppelin Stellar agent wallet | Rejects with `SpendingLimitExceeded`, no counter | https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |
| Cobo Agentic Wallet | Manual freeze or revoke only | https://www.cobo.com/products/agentic-wallet/manual/security/freeze-revoke |
| Yellow session keys | No strike mechanism found (page URL not retained) | Unverified |
| Two broad web searches (ERC-4337 and ERC-7579 session-key modules, agent wallets) | Nothing found. Search negatives are not proof. | none |
| Safe Shield article, Zodiac Delay source, Argent audit report | Read earlier in the design work. Not re-read for this check by the verifiers. | https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative ; https://diligence.consensys.io/audits/2023/06/argent-account-multisig-for-starknet |

Not checked: source code of ERC-7579 Smart Sessions, Zodiac Roles and Safe Allowance modules; Solana and Sui session-key systems; any private or closed product. Some repository READMEs were read by a summarising fetch, not as code. On NEAR an exhausted allowance leaves the key unusable or deleted by the runtime, which is not the same as Mamori's count-triggered deletion (the runtime behaviour is unverified in nearcore).

Scope limit. ERC-7579 hooks can express circuit breakers (timed pauses), and Hypernative automatically pauses protocols through a granted pause role. The claim is only about count-triggered key deletion, not about circuit breakers or automated containment in general.

## 3. Explicitly not claimed

| Not claimed | Reason and source |
|---|---|
| First quantum-safe wallet, or any quantum early warning | Rotation to ML-DSA is native NEAR (https://github.com/near/neps/pull/645 ; vendor-reported two-transaction rotation: https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near ; another post: https://stellar.org/blog/foundation-news/introducing-the-quantum-preparedness-plan). The omen is not a canary. |
| Vault with delay and recovery | Phoenix and earlier (not re-read this workflow) |
| Cancel queue | Zodiac Delay (not re-read this workflow), Leash (README) |
| Daily limit, lock, recovery period | Argent, current details unverified (https://diligence.consensys.io/audits/2023/06/argent-account-multisig-for-starknet) |
| Bounded one-shot pause | Lido (https://research.lido.fi/t/circuitbreaker-programmable-panic-layer/11400) |
| Small spends that bypass delay | Squads (https://developers.squads.so/squads-api/api-reference/v1/policies.md) |
| In-transaction enforcement | Safe and Argent guards also enforce in-transaction |
| Pre-execution screening | Hypernative, Forta, Safe |
| On-chain caps on NEAR | Leash and near-agent-spend-guard |
| NEP-297-style events, token caps, queue, cancel, expiry | Parity with Leash, near-agent-spend-guard |
| Faster, safer or measurably better than any named product | No comparison has been run |

## 4. Correction to earlier notes

The ERC-7715 revoke method is `wallet_revokeExecutionPermission`, not `wallet_revokePermissions` (https://eips.ethereum.org/EIPS/eip-7715). ERC-7715 is a draft. Secondary sources still quote the old name, so cite the EIP.

## 5. Gate before the word "novel" ships

1. Targeted checks of Safe Allowance Module, Argent lock and daily-limit timelocks, Fireblocks velocity and whitelist delays, Hypernative auto-response, ERC-7579 Smart Sessions, Zodiac Roles source.
2. Week-3 run of the same attack scripts against Leash and near-agent-spend-guard, or comparative wording is dropped.
3. A search for count-triggered key deletion repeated on the day of release, with date, scope and results stated.
