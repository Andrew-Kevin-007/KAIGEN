# KAIGEN v3 landscape (design draft)

Status: comparison as of 2026-11-02, limited to the sources listed. Every cell carries a source URL or is marked unverified. Absence from a few searches is not proof of absence. Many facts are vendor-authored or secondary. We make no latency or speed comparison against any vendor. Nothing here claims mainnet, audits or measured results for KAIGEN.

Review limits. Searches ran through a US-only summarising search tool. Several repository READMEs were read through summarising fetches, not as code. The NEAR peer repos are hackathon drafts dated October 2026, testnet and unaudited, so their README claims are unverified until their code is run.

## 1. Industry and standards

| Product or standard | Where policy is enforced | Response to a misbehaving key or agent | Source and status |
|---|---|---|---|
| Coinbase Agentic Wallets | Not stated in the docs read | No automatic revocation mentioned in the docs read | https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md . Enforcement location unverified. |
| Polygon agentic wallets (session keys) | Unverified | Unverified | Secondary source only, URL not retained in this workflow. Unverified. |
| Turnkey, Privy, Crossmint | Reported as off-chain policy at the signing layer | Unverified | Secondary sources only, URLs not retained in this workflow. Unverified. |
| Fireblocks | Reported as an enclave policy engine with velocity control | Unverified. Velocity limits and whitelist delays are unverified. | Secondary source, URL not retained. Unverified. The only Fireblocks page relied on here is the ML-DSA NEAR rotation post in section 3. |
| Safe with Hypernative Guardian | On-chain Transaction Guard that blocks transactions, with screening by Hypernative | 24 h timelock for guard removal. Guards can lock funds if they misfire. | https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative (authored by Hypernative); https://docs.safefoundation.org/smart-account/guards |
| Hypernative automated response | External detector with a granted pause role | Automatic protocol pause, vendor-reported | https://www.hypernative.io/insights/blog/how-defi-teams-automate-incident-response-to-stop-exploits-before-funds-move . Latency beyond "seconds" not stated in the pages read. |
| Forta Firewall | External detection and screening | Alerting and screening. Latency statements on Forta pages conflict or were not re-checked. | https://docs.forta.network/en/latest/forta-firewall-overview/ (not re-read this workflow); Euler retrospective, vendor-authored: https://forta.org/blog/detecting-a-197-million-hack-before-exploitation-euler-finance-hack-retrospective |
| Argent | On-chain account | Daily limit, guardians, lock and recovery period. Current details unverified. | https://diligence.consensys.io/audits/2023/06/argent-account-multisig-for-starknet (2023 audit, Starknet multisig) |
| ERC-7715 (draft) | Wallet permissions request | Revocation by `wallet_revokeExecutionPermission`. Older name `wallet_revokePermissions` still appears in secondary sources. | https://eips.ethereum.org/EIPS/eip-7715 (status Draft) |
| MetaMask delegation | On-chain delegation framework | Explicit disable only in the page read | https://docs.metamask.io/smart-accounts-kit/guides/delegation/disable-delegation/ |
| Squads (Solana) | On-chain spending limits | Spending-limit debits are not affected by time lock | https://developers.squads.so/squads-api/api-reference/v1/policies.md |
| Zodiac Delay | On-chain queue | Cancelable delayed execution | Source repository not re-read this workflow. Name of repository (SafeDelay or zodiac-modifier-delay) unverified. |
| Phoenix (vault with delay and recovery) | On-chain | Delayed withdrawals | https://ar5iv.labs.arxiv.org/html/2106.01240 returned HTTP 503 when checked. Not checked this workflow. |
| Lido CircuitBreaker | On-chain | Bounded one-shot pause | https://research.lido.fi/t/circuitbreaker-programmable-panic-layer/11400 (not re-read this workflow) |
| OpenZeppelin Stellar agent wallet | On-chain (Stellar) | Rejects with `SpendingLimitExceeded`, per-rule period limits, no refusal counter seen | https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |
| Cobo Agentic Wallet | Not examined | Manual freeze or revoke only | https://www.cobo.com/products/agentic-wallet/manual/security/freeze-revoke |

## 2. NEAR specific

| Product | Where policy is enforced | Response to a misbehaving key | Source and status |
|---|---|---|---|
| OutLayer | Per-transaction limits, whitelists and freeze evaluated inside a TEE. A gateway supplies cumulative counters. Policy stored on-chain. | Freeze is manual and instant. Revocation is manual. | https://app.outlayer.ai/docs/agent-custody . Mamori has no instant owner freeze. |
| Leash on NEAR | On-chain contract, function-call keys | Rolling 24 h cap, per-NEP-141 token caps, allowlist, owner-approved queue, per-agent pause, owner `revoke_agent` deletes the key, expiry, decision events. Revocation is owner-initiated, no strike counter seen. | https://github.com/mesh-pch/leash-near . Hackathon repo, testnet, unaudited, README read, code not run. |
| near-agent-spend-guard | On-chain contract, spend-only function-call key | Per-transaction and daily caps, allowlist, approval threshold, pause. Refused calls are plain failures with no counter. Dashboard shows the count of full-access keys, demo verifies the restricted key's permissions on chain. | https://github.com/mubudot/near-agent-spend-guard . Hackathon repo, testnet, unaudited, README read, code not run. |
| NEAR key listing tools | Off-chain | List keys and flag full-access ones | near-mcp `account_list_access_keys`: https://glama.ai/mcp/servers/@nearai/near-mcp/tools/account_list_access_keys ; x402 Bazaar `near_account` risk checker: https://glama.ai/mcp/connectors/tr.com.402/x402-bazaar/tools/near_account ; Smithii rug checker: https://smithii.io/?p=64535 |
| NEAR native ML-DSA rotation | Protocol | ML-DSA-65 full-access and function-call keys. On chain they appear as `ml-dsa-65-hash:...`. Verification costs 100 Ggas per transaction signature. No in-contract verification host function (listed as out of scope). | NEP-645: https://github.com/near/neps/pull/645 ; a release note says nearcore 2.13.0 moves 84 to 86 and stabilizes ML-DSA-65: https://newreleases.io/project/github/near/nearcore/release/2.13.0 ; Fireblocks reports a rotation in two transactions (vendor-reported): https://www.fireblocks.com/blog/post-quantum-key-rotation-ml-dsa-near . Mainnet activation unconfirmed by us. |
| NEAR global contracts | Protocol | Deploy once by hash or by account | https://docs.near.org/smart-contracts/global-contracts . Docs show testnet commands. Cost 10 NEAR per 100 KB burnt. Mainnet availability unconfirmed. |

## 3. KAIGEN versus the above

| Property | KAIGEN v2 (code read 2026-11-02) | KAIGEN v3 (proposed, not built) | Closest comparators |
|---|---|---|---|
| Enforcement location | Contract on the user's own account | Same | Leash, near-agent-spend-guard (on-chain); OutLayer (TEE plus gateway); Safe, Argent, MetaMask (on-chain on other chains). On-chain enforcement is table stakes. |
| Rolling cap | Per token, account-wide, 24 h | Same, written invariant, property tests | Leash (rolling 24 h per README); OpenZeppelin Stellar (per-rule period limits). Whether peers have an account-level aggregate was not verified. |
| Allowlist | Off by default | Off by default, behaviour specified | Leash, near-agent-spend-guard |
| Queue with cancel | Yes, 24 h production floor | Plus expiry, `cancel_all`, per-key slots | Leash (README); Zodiac Delay, Phoenix (unverified this workflow) |
| Auto response to repeated misuse | Burn after N refusals in 24 h, no external actor | Same, with fixed counting rules | Scoped search found none that deletes a key after a count of refusals (see NOVELTY-CLAIMS.md). External-detector pauses exist (Hypernative). |
| Events | NEP-297-style under standard `kaigen` | Extended | Leash (README), parity |
| Posture check | Views only | `attest()` plus cage-check from RPC | Generic key-listing tools exist. The combined policy comparison was not found elsewhere in sources read. |
| Instant owner freeze | No | Not planned (sentinel is a stretch item) | OutLayer has one |
| Post-quantum | ML-DSA-65 admin, testnet protocol 88 only | Same. No early warning. | NEAR native rotation. KAIGEN adds nothing to rotation itself. |
| Deployment | Per-account contract | Hash-pinned global contract, if mainnet supports it | NEAR docs |
| Measured results | None for v3. v2 has testnet drill records in fire-tests/. | Week-3 numbers, including the same attack scripts against Leash and near-agent-spend-guard | None published by us yet |

## 4. Not compared

Solana and Sui session-key systems, ERC-7579 Smart Sessions, Zodiac Roles and Safe Allowance module source, Yellow session keys, and any private or closed product were not checked.
