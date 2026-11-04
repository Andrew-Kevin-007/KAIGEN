# KAIGEN v3 novelty claims (design draft)

Status: 2026-11-02, updated 2026-11-04 from docs/v3/PRIOR-ART-CHECK.md (pre-release run, 2026-11-04). Each claim is falsifiable, limited to the sources read, and wrong if a counterexample appears. None of these is a headline. The word "novel" is not used until the gate in section 5 is passed.

## 1. Verdict table

| Id | Claim as allowed to be written | Verdict | Evidence |
| --- | --- | --- | --- |
| C1 | Contract-enforced caps on the user's own account. OutLayer enforces in a TEE [PRIOR-ART-CHECK.md C1]. A lower-bound search on 2026-11-04 found nine NEAR repos; eight enforce caps in an on-chain contract per their README or source (privatepay-agent at README level only; policyvault is off-chain) [PRIOR-ART-CHECK.md C1]. All peer behaviour is UNVERIFIED because no code was run. Mamori is one of several on-chain guards, so on-chain enforcement is table stakes, not novelty. | Weak as a differentiator. Not claimed as novel. | Section 2 for the peer list. https://app.outlayer.ai/docs/agent-custody . Mamori enforcement holds only while cage-check passes. OutLayer has an instant owner freeze that Mamori lacks. Six of the nine NEAR peers also expose an owner pause or freeze (UNVERIFIED), so this is not special to OutLayer on NEAR [PRIOR-ART-CHECK.md C1]. |
| C2 | Scoped absence, for the implementation only. In the sources checked on 2026-11-04, we found no account that deletes a function-call key on-chain after N refused calls [PRIOR-ART-CHECK.md C2a]. The idea of a strike counter that revokes or pauses an agent key is published at concept level (Openfort, PolicyLayer; section 2) [PRIOR-ART-CHECK.md C2c]. The specific Mamori implementation (on-chain DeleteKey by the contract itself after counted refusals) was not found in the checked sources. It is not claimed as novel, first or unique. | Holds as a scoped absence for the implementation. The idea is prior art. | Section 2. [PRIOR-ART-CHECK.md C2a, C2b, C2c] |
| C3 | Existing tools list NEAR keys and flag full-access keys (near-mcp, x402 Bazaar, Smithii) [PRIOR-ART-CHECK.md C3a]. Three NEAR peers check part of an agent key's scope per their READMEs, and Veto runs a conformance check of on-chain policy values and refusal behaviour (UNVERIFIED) [PRIOR-ART-CHECK.md C3b]. cage-check adds a policy-specific comparison of `attest()` against the account's key list: method and receiver scope, allowance, recorded keys, pinned global-contract hash. We found no tool in the checked sources that does that combined check [PRIOR-ART-CHECK.md C3b]. | Weak. Verification feature only. | Key-listing tools in LANDSCAPE.md section 2. [PRIOR-ART-CHECK.md C3a, C3b] |
| C4 (engineering property, not novelty) | Account-level aggregate cap with a written loss-bound invariant, attacked by property tests. Not claimed novel. Already account-level per token in v2. Peer status: Leash and near-agent-spend-guard key their spend totals per agent key or agent account (UNVERIFIED, source read); tridon's scope across agents is not stated; semilla1-guard-near has a written loss bound in its SPEC, for a single agent [PRIOR-ART-CHECK.md C4a, C4b]. | Not claimed novel. A written bound exists in single-agent form in one peer. | contracts/mamori/src/lib.rs. OpenZeppelin Stellar has per-rule period limits: https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet . No peer property-test suite was found in the files read; the other peers' test files were not opened [PRIOR-ART-CHECK.md C4c]. |
| C5 (design distinction) | Containment has no external actor on the critical path. In-contract cap enforcement with no external detector is common, among the NEAR peers and the other-chain modules in section 2 [PRIOR-ART-CHECK.md C5]. The contrast is with detector-based products such as Hypernative, which pauses through a granted pause role (vendor-reported) [PRIOR-ART-CHECK.md C5]. Holds as a description, with a cost: the counter sees only calls that reach the contract and only clumsy attackers. | Holds as a description, with a cost. Not a claim that automated response is new. | https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative ; https://www.hypernative.io/insights/blog/how-defi-teams-automate-incident-response-to-stop-exploits-before-funds-move (vendor-reported) |

## 2. What was and was not checked for C2 (dated 2026-11-02; extended 2026-11-04)

Checked, no counterexample to the scoped absence found. Rows dated 2026-11-04 are from [PRIOR-ART-CHECK.md C1, C2a, C2b, C2c, section 4].

The nine NEAR repos, found by one extended search (a lower bound, not a census). Each is UNVERIFIED: README and source read through summarising fetches, no code run.

- Leash: https://github.com/mesh-pch/leash-near
- near-agent-spend-guard: https://github.com/mubudot/near-agent-spend-guard
- semilla1-guard-near: https://github.com/semilla1lab/semilla1-guard-near
- tollgate: https://github.com/kimdooo-a/tollgate
- Veto: https://github.com/Bronxydrone/Veto
- agent-allowance-guard: https://github.com/asosa933/agent-allowance-guard
- tridon (AgentSpend): https://github.com/sufianweb3/tridon
- privatepay-agent: https://github.com/Nassami1/privatepay-agent
- policyvault: https://github.com/CloudCorpRecords/policyvault

| Source | Finding | URL |
| --- | --- | --- |
| Coinbase agentic wallet docs | No automatic revocation mentioned. Enforcement location not stated. | https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md |
| OutLayer docs | Freeze from dashboard or on-chain transaction. The page does not describe automatic revocation or auto-freeze after denials. | https://app.outlayer.ai/docs/agent-custody |
| MetaMask delegation docs | Manual `disableDelegation` by the delegator. | https://docs.metamask.io/smart-accounts-kit/guides/delegation/disable-delegation/ |
| Nine NEAR repos (README, and `lib.rs` or `SPEC` for seven) | No strike counter acting on keys. Key deletion exists only in owner-called methods: Leash `revoke_agent`, tollgate `revoke_agent`, tridon `revoke_agent` and `rotate_agent_key`. spend-guard, semilla1, Veto and agent-allowance-guard contain no key-deletion call. | URLs listed above |
| agent-allowance-guard (`contract/src/lib.rs`, summarising read) | `rejection_count` increments on each policy-blocked pay. Per the same read, nothing reads the count to pause or revoke. | https://github.com/asosa933/agent-allowance-guard |
| Openfort blog (raw HTML matched; published 2026-04-03) | Recommends revoking a session key after N blocked attempts. It is a recommendation; it names no implementation and no chain. | https://www.openfort.io/blog/smart-wallet-security-best-practices |
| PolicyLayer dev.to post (raw JSON matched; published 2026-01-05) | Sample `setAutoPause` with a `violation_burst` trigger (threshold 5 in 1 minute, action `pause_agent`). Off-chain gate. Shipped status UNDETERMINED: not in the PolicyLayer docs index or by search. | https://dev.to/l_x_1/the-kill-switch-emergency-controls-for-autonomous-fleets-375k |
| Safe Allowance Module (README), ERC-7579 Smart Sessions (policy source and interface), Zodiac Roles (docs) | No auto-disable or failure counter found at the level read. Safe Allowance and Zodiac: README or docs level only. `SmartSession.sol` not read. | https://github.com/safe-global/safe-modules/tree/main/modules/allowances ; https://github.com/erc7579/smartsessions ; https://docs.roles.gnosisguild.org/general/allowances |
| Turnkey, Privy, Squads | Search summaries only; pages not opened. No violation-triggered revoke found in the summaries. | https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets ; https://squads.so/blog/spending-limits |
| Yellow session keys | Primary docs page failed to load (certificate error). Not checked. | https://docs.yellow.org/docs/learn/advanced/managing-session-keys |
| Fourteen query groups, 2026-11-04 | Listed in PRIOR-ART-CHECK.md section 2 (C2). Search negatives are not proof. | none |

Not checked: `SmartSession.sol`; Solidity source of Safe Allowance and Zodiac Roles (README or docs level only); Solana and Sui session-key systems beyond one search; any private or closed product; test files of the nine NEAR peers. Some repository READMEs were read by a summarising fetch, not as code.

On NEAR, docs.near.org says an exhausted allowance makes the key unusable. It does not say the runtime deletes the key, and nearcore was not read, so runtime deletion is unverified [PRIOR-ART-CHECK.md C2a]. Mamori's count-triggered deletion is a different mechanism.

Concept-level sources (Openfort, PolicyLayer) show the idea of a count-triggered revoke. They do not show a NEAR contract, a DeleteKey, or any built system [PRIOR-ART-CHECK.md C2c].

Scope limit. ERC-7579 hooks can express circuit breakers (timed pauses), and Hypernative automatically pauses protocols through a granted pause role. The claim is only about count-triggered key deletion, not about circuit breakers or automated containment in general.

## 3. Explicitly not claimed

| Not claimed | Reason and source |
| --- | --- |
| First quantum-safe wallet, or any quantum early warning | Rotation to ML-DSA is native NEAR (https://github.com/near/neps/pull/645 ; vendor-reported two-transaction rotation: https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near ; another post: https://stellar.org/blog/foundation-news/introducing-the-quantum-preparedness-plan). The omen is not a canary. Omen-style prior art (Qanary, Qairos) is listed in LANDSCAPE.md section 1 [PRIOR-ART-CHECK.md X1]. |
| Vault with delay and recovery | Phoenix and earlier (not re-read this workflow) |
| Cancel queue | Zodiac Delay (not re-read this workflow), Leash (README) |
| Daily limit, lock, recovery period | Argent, current details unverified (https://diligence.consensys.io/audits/2023/06/argent-account-multisig-for-starknet) |
| Bounded one-shot pause | Lido (https://research.lido.fi/t/circuitbreaker-programmable-panic-layer/11400) |
| Count-triggered revocation as an idea | Published at concept level: Openfort recommends revoking a session key after N blocked attempts (2026-04-03); PolicyLayer shows a violation-burst auto-pause sample (2026-01-05, shipped status UNDETERMINED) [PRIOR-ART-CHECK.md C2c] |
| Small spends that bypass delay | Squads (https://developers.squads.so/squads-api/api-reference/v1/policies.md) |
| In-transaction enforcement | Safe and Argent guards also enforce in-transaction |
| Pre-execution screening | Hypernative, Forta, Safe |
| On-chain caps on NEAR | Nine NEAR repos found; eight enforce caps on-chain per README or source (UNVERIFIED) [PRIOR-ART-CHECK.md C1] |
| NEP-297-style events, token caps, queue, cancel, expiry | Parity with Leash, near-agent-spend-guard |
| Faster, safer or measurably better than any named product | No comparison has been run |

## 4. Correction to earlier notes

The ERC-7715 revoke method is `wallet_revokeExecutionPermission`, not `wallet_revokePermissions` (https://eips.ethereum.org/EIPS/eip-7715). ERC-7715 is a draft. Secondary sources still quote the old name, so cite the EIP.

## 5. Gate before the word "novel" ships

Status 2026-11-04 [PRIOR-ART-CHECK.md sections 1 and 4]:

- Item 1 is partly run. Argent lock and Fireblocks whitelist delay are UNDETERMINED. Safe Allowance Module, Fireblocks velocity limits, Hypernative auto-response, ERC-7579 Smart Sessions and Zodiac Roles are NOT FOUND at the level read. Safe Allowance and Zodiac are README or docs level only; `SmartSession.sol` and the Zodiac Roles Solidity source were not read.
- Item 2 is not done.
- Item 3 is not done. The 2026-11-04 run is pre-release; the release-day repeat is still needed.

Required before the word "novel" ships:

1. Targeted checks of Safe Allowance Module, Argent lock and daily-limit timelocks, Fireblocks velocity and whitelist delays, Hypernative auto-response, ERC-7579 Smart Sessions, Zodiac Roles source.
2. Week-3 run of the same attack scripts against Leash and near-agent-spend-guard, or comparative wording is dropped.
3. A search for count-triggered key deletion repeated on the day of release, with date, scope and results stated.
