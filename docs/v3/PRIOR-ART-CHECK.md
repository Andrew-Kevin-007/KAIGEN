# KAIGEN v3 prior-art check (evidence only)

Status: run 2026-11-04 against the claims in NOVELTY-CLAIMS.md and the gate in its section 5. This file records evidence. It gives no "novel" or "first" verdict for anything, and none may be inferred from it. A NOT FOUND row means only that the listed sources, read in the stated way, did not show it.

Verdict labels: PRIOR ART FOUND, NOT FOUND IN THE CHECKED SOURCES, UNDETERMINED.

## 0. How this was done, and its limits

- Search: a US-only summarising web search tool. Its answers are summaries, not result lists. Search negatives are not proof.
- Fetch: a summarising fetch tool. Anything it returns is a model summary of the page, not the page. Quoted fragments below are short and come from those summaries unless a row says RAW.
- RAW means the page was also pulled as raw HTML or JSON and the text was matched directly. Only two pages were raw-verified: the Openfort post (C2c) and the PolicyLayer post on dev.to (C2c).
- Peer projects (Leash, near-agent-spend-guard and the other NEAR repos): no clone, no download, no code run. README and `src` files were read through web fetch only. Every statement about their behaviour is what their public README or source said to a summariser. Treat all of it as UNVERIFIED because no code was run.
- Not possible with these tools: GitHub code search. A string absent from a README or from one `lib.rs` says nothing about other files in the same repo or about repos that did not surface.
- Blocked or failed fetches (HTTP 403, 404, certificate errors) are listed in section 5. Those items are UNDETERMINED, not clean.
- The NEAR peer list (C1) came from one extended search. It is a lower bound on what exists, not a census.

## 1. Result table

| Row | Claim or sub-claim | Verdict |
|---|---|---|
| C1 | On-chain cap enforcement is common. At least two other NEAR testnet guards enforce on-chain. | PRIOR ART FOUND (nine NEAR repos found, not two) |
| C2a | Implementation: an account deletes its own function-call key on-chain after N refused calls. | NOT FOUND IN THE CHECKED SOURCES |
| C2b | Implementation: a NEAR guard keeps a counter of refused calls, with no action attached. | PRIOR ART FOUND (agent-allowance-guard) |
| C2c | Concept: revoke or pause an agent key after N blocked or violating calls, as a recommendation or off-chain feature. | PRIOR ART FOUND (Openfort, PolicyLayer) |
| C3a | Existing tools list a NEAR account's keys and flag full-access keys. | PRIOR ART FOUND |
| C3b | One check that compares the contract's `attest()` with the RPC key list (scope, allowance, recorded keys) and a pinned code hash. | NOT FOUND IN THE CHECKED SOURCES (components found in four peers: three check part of the agent key's scope, one checks policy conformance) |
| C4a | Account-wide cap aggregated across several keys. | UNDETERMINED |
| C4b | A written loss-bound statement for a guard. | PRIOR ART FOUND (semilla1-guard-near SPEC) |
| C4c | Property tests attacking the loss bound. | NOT FOUND IN THE CHECKED SOURCES |
| C5 | Containment with no external actor on the critical path. | PRIOR ART FOUND |
| X1a | (Not in NOVELTY-CLAIMS; README Kizashi) A bounty-backed curve key whose break claim flips an on-chain flag that other contracts read. | PRIOR ART FOUND |
| X1b | (Same) A lockdown that deletes access keys on NEAR when that flag trips. | NOT FOUND IN THE CHECKED SOURCES |
| G1-a | Gate 1: Safe Allowance Module auto-revoke or failure counter. | NOT FOUND IN THE CHECKED SOURCES (README level) |
| G1-b | Gate 1: Argent lock and daily-limit timelocks. | UNDETERMINED |
| G1-c | Gate 1: Fireblocks velocity limits, automatic revocation. | NOT FOUND IN THE CHECKED SOURCES |
| G1-d | Gate 1: Fireblocks whitelist delay (cool-off). | UNDETERMINED |
| G1-e | Gate 1: Hypernative count-based action or key revocation. | NOT FOUND IN THE CHECKED SOURCES |
| G1-f | Gate 1: ERC-7579 Smart Sessions auto-disable after failures. | NOT FOUND IN THE CHECKED SOURCES |
| G1-g | Gate 1: Zodiac Roles auto-revoke after failures. | NOT FOUND IN THE CHECKED SOURCES (docs level) |
| G2 | Gate 2: week-3 attack scripts against Leash and near-agent-spend-guard. | Not a literature check. Not done here. |
| G3 | Gate 3: repeat the C2 search on release day. | Not done. This run is a pre-release run dated 2026-11-04. |

Count: 12 claim rows (7 PRIOR ART FOUND, 4 NOT FOUND, 1 UNDETERMINED) and 7 gate-1 rows (5 NOT FOUND, 2 UNDETERMINED).

## 2. Per-claim evidence

### C1. On-chain cap enforcement

Searched: `NEAR protocol AI agent spending policy vault contract function-call key daily cap github "near-sdk" agent guard repository` (extended); `NEAR hackathon AI agent wallet guard contract function call key policy cap 2026 github`. Opened each repo README, GitHub API metadata, and `lib.rs` where the path was found.

| Source (read mode) | Finding | URL |
|---|---|---|
| Leash, README + `src/lib.rs` | Vault account is the contract account (header comment). Key added with `add_access_key_allowance` on its own account. Per-tx and daily caps, per-token caps, owner approve/reject queue, `set_paused`, `revoke_agent`. README says draft, no audit. Created 2026-10-28. | https://github.com/mesh-pch/leash-near ; https://raw.githubusercontent.com/mesh-pch/leash-near/master/src/lib.rs |
| near-agent-spend-guard, README + `src/lib.rs` | Caps, allowlist, approval threshold, pause. Funds sit in the guard account; source says the agent credential is a function-call key on a separate agent account. README: testnet, no audit. Created 2026-10-30. | https://github.com/mubudot/near-agent-spend-guard ; https://raw.githubusercontent.com/mubudot/near-agent-spend-guard/main/src/lib.rs |
| semilla1-guard-near, README + `contract/src/lib.rs` | Per-tx cap, daily cap, allowlist, cooldown. No pause flag, no key action in source. One agent per vault. | https://github.com/semilla1lab/semilla1-guard-near |
| tollgate, README + `contract/src/lib.rs` | Caps, shared blocklist, approval queue, owner `freeze`. Created 2026-11-01. | https://github.com/kimdooo-a/tollgate |
| Veto, README + `contract/src/lib.rs` | Per-tx, daily, monthly caps, allowlist, `set_paused`, hash-chained decision log. Created 2026-10-31. | https://github.com/Bronxydrone/Veto |
| agent-allowance-guard, README + `contract/src/lib.rs` | Per-payment and 24 h limits, allowlist, `pause`. | https://github.com/asosa933/agent-allowance-guard |
| tridon (AgentSpend), README + `contracts/vault/src/lib.rs` | Total, per-tx, daily, weekly, monthly limits, merchants, `pause`, `revoke_agent`, `rotate_agent_key`. | https://github.com/sufianweb3/tridon |
| privatepay-agent, README only | Daily USDC cap and recipient whitelist on testnet. | https://github.com/Nassami1/privatepay-agent |
| policyvault, README only | Local simulation. README says there is no smart contract in the build. Not on-chain. | https://github.com/CloudCorpRecords/policyvault |
| OutLayer docs | Limits, whitelists, freeze evaluated in a TEE. Freeze from dashboard or by on-chain transaction. Cumulative counters supplied by a gateway. | https://app.outlayer.ai/docs/agent-custody |
| Other chains | OpenZeppelin Stellar agent wallet (`SpendingLimitExceeded`, per period); Safe Allowance Module; Zodiac Roles allowances; Smart Sessions policies (see section 4). | https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |

Observations:

- NOVELTY-CLAIMS says "at least two" NEAR guards. Eight of the nine repos above enforce caps in an on-chain contract per README or source (privatepay-agent at README level only). policyvault is off-chain.
- Six of nine peers expose an owner pause or freeze (Leash, spend-guard, Veto, tollgate, tridon, agent-allowance-guard). The statement that OutLayer has an instant owner freeze that Mamori lacks is true of Mamori, but it is not special to OutLayer on NEAR.
- Architecture: per the Leash header comment, Leash puts the vault on the contract's own account, the same shape as Mamori. spend-guard does not.

Verdict: PRIOR ART FOUND.

### C2. Count-triggered deletion of a function-call key

Searched (all through the summarising search tool):

1. `session key automatically revoked after repeated failed or rejected transactions smart account agent` (extended)
2. `"strike" counter agent wallet auto-revoke key after N violations spending policy on-chain`
3. `NEAR function call access key delete after failed attempts smart contract DeleteKey self-revoke`
4. `smart contract wallet "failed attempts" threshold automatically disables session key or delegate "lockout" on-chain policy module` (extended)
5. `"max_strikes" OR "maxViolations" OR "violation threshold" agent wallet session key auto-revoke contract`
6. `AI agent wallet "auto-revoke" OR "auto-freeze" after repeated policy violations denied transactions threshold` (extended)
7. `Turnkey OR Privy policy engine agent wallet repeated denied requests automatic suspension of API key`
8. `Coinbase agentic wallet spending limits session caps "revoke" automatic kill switch policy engine documentation`
9. `ERC-7579 hook circuit breaker auto-pause account after anomalous transactions module rhinestone`
10. `Solana delegate authority auto revoke after policy violations agent wallet Squads spending limit program`
11. `NEAR account contract self-deleting access key rate limit "delete_key" function call key burn after misuse`
12. `Safe Allowance Module OR Roles modifier OR Smart Sessions "revoke after" repeated failed attempts auto-disable delegate module circuit breaker count threshold audit`
13. `policylayer "policy violations" 1 minute pause agent kill switch trigger MCP spending controls`; `policylayer setAutoPause violation_burst auto-pause docs`
14. `TPM 2.0 dictionary attack lockout counter maxTries lockoutRecovery smart card PIN try counter blocked`

C2a. Implementation: delete a function-call key on-chain after N refused calls.

| Source (read mode) | Finding | URL |
|---|---|---|
| Nine NEAR peers, README (all) and `lib.rs` (Leash, spend-guard, semilla1, tollgate, agent-allowance-guard, Veto, tridon) | No strike counter acting on keys. Key deletion exists only in owner-called methods: Leash `revoke_agent`, tollgate `revoke_agent`, tridon `revoke_agent` and `rotate_agent_key`. spend-guard, semilla1, Veto, agent-allowance-guard contain no key-deletion call. Leash sends out-of-policy spends to an owner queue rather than refusing them. | URLs in C1 |
| Coinbase agentic wallet docs | Session and per-tx caps, KYT, OFAC screening. No automatic revocation mentioned. Enforcement location not stated. | https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md |
| OutLayer docs | Page does not describe automatic revocation or auto-freeze after denials. A chain-refused request still counts toward the rate limit. | https://app.outlayer.ai/docs/agent-custody |
| MetaMask delegation docs | Manual `disableDelegation` by the delegator. | https://docs.metamask.io/smart-accounts-kit/guides/delegation/disable-delegation/ |
| Cobo Agentic Wallet docs | Page does not say freeze or revoke can be automatic. A third-party overview calls them manual and lists a "counter" stage in its policy engine without saying what the counter does. | https://www.cobo.com/products/agentic-wallet/manual/security/freeze-revoke ; https://www.alchemy.com/overviews/agent-wallets-session-permission-model |
| OpenZeppelin Stellar agent wallet | `SpendingLimitExceeded`; no counter of rejected attempts; rule ends at its expiry ledger. | https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |
| Turnkey, Privy | Search summary: denials are per request; DENY policies are written by the developer; no automatic suspension found. Pages not opened. | https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets (snippet only) |
| Solana token delegate, Squads spending limits | Search summary: manual revoke; no violation-triggered revoke found. Pages not opened. | https://squads.so/blog/spending-limits (snippet only) |
| Yellow session keys | Search summary: allowance, expiry, manual revoke. Primary docs page failed to load (certificate error). | https://docs.yellow.org/docs/learn/advanced/managing-session-keys (not opened) |
| NEAR protocol | Docs say an exhausted allowance makes the key unusable. They do not say the runtime deletes it. nearcore not read. | https://docs.near.org/protocol/access-keys |

Verdict C2a: NOT FOUND IN THE CHECKED SOURCES. The NOVELTY-CLAIMS wording "in the sources checked ... we found no account that" stays accurate if the source list in section 2 of that file is extended with the nine repos above.

C2b. A refused-call counter on NEAR (no action attached).

| Source (read mode) | Finding | URL |
|---|---|---|
| agent-allowance-guard `contract/src/lib.rs` (summarising fetch) | `rejection_count` and `next_rejection_id` increment on every policy-blocked `pay`. `get_policy` returns `rejection_count`. `get_recent_rejections` returns the last 64. Per the same read, nothing reads the count to pause or revoke. | https://github.com/asosa933/agent-allowance-guard |
| Veto, tollgate, spend-guard, Leash, semilla1 | Refusals are events or panics. No counter found in source. | URLs in C1 |

Verdict C2b: PRIOR ART FOUND for the counting half only.

C2c. Concept: revoke or pause an agent key after N blocked or violating calls.

| Source (read mode) | Finding | URL |
|---|---|---|
| Openfort blog, "Smart Wallet Security Best Practices for 2026", section "Implement circuit breakers" (RAW HTML matched; page metadata published 2026-04-03) | Lists three automated triggers. One reads: if the agent attempts a blocked operation more than N times, revoke the session key. It is a recommendation. It names no implementation and no chain. | https://www.openfort.io/blog/smart-wallet-security-best-practices |
| PolicyLayer post on dev.to, "The Kill Switch: Emergency Controls for Autonomous Fleets" (RAW JSON matched; `published_at` 2026-01-05) | Code sample under "Trigger: Repeated Failures": `setAutoPause({ trigger: 'violation_burst', threshold: 5, window: '1m', action: 'pause_agent' })`. Off-chain gate in front of signing. The post does not say whether the API is released. I found no `setAutoPause` in PolicyLayer's docs index or by search, so shipped status is UNDETERMINED. | https://dev.to/l_x_1/the-kill-switch-emergency-controls-for-autonomous-fleets-375k ; https://dev.to/api/articles/l_x_1/the-kill-switch-emergency-controls-for-autonomous-fleets-375k |
| Microsoft Entra smart lockout (page `ms.date` 2026-06-03) | Non-blockchain analogue: account locks after a count of failed sign-ins (default 10; 3 for US Gov), and it avoids counting the same bad password twice. | https://learn.microsoft.com/en-us/entra/identity/authentication/howto-password-smart-lockout |
| TPM 2.0 dictionary-attack lockout | Non-blockchain analogue (`maxTries`, recovery time). Search summary only; the source page returned HTTP 503. UNVERIFIED. | https://android.googlesource.com/platform/external/tpm2/+/android-8.1.0_r11/DA.c (not opened) |
| Safe Allowance Module, Zodiac Roles, Smart Sessions, MetaMask | Search for an auto-disable-after-failures feature found none. See section 4. | section 4 |

Verdict C2c: PRIOR ART FOUND for the idea. Openfort's text precedes the v3 date by seven months and states the same trigger and action in general terms. What it does not show is a NEAR contract, a DeleteKey, or any built system.

Inference, labelled as mine and not found in any source: EVM modules that read a revert as a refusal cannot count it, because the revert rolls back the write. Two sources are consistent with this. Zodiac Roles docs say no allowance balances update when condition evaluation fails or the call reverts (https://docs.roles.gnosisguild.org/general/allowances). Smart Sessions `UsageLimitPolicy.sol` returns a failure and leaves `used` unwritten (https://raw.githubusercontent.com/erc7579/smartsessions/main/contracts/external/policies/UsageLimitPolicy.sol). spend-guard and Veto also panic on refusal and store nothing, per their source reads. Mamori records refusals as outcomes. This may explain why a counter is rare. It does not show the idea is unpublished.

### C3. cage-check

Searched: `NEAR account security scanner access keys full access key audit tool check account keys function call permissions receiver method names`; `verify smart account configuration matches declared policy owners modules guard check tool "Safe" config checker script signers threshold modules guard`; `ERC-7484 registry adapter checks installed modules attestations smart account verify configuration security`.

C3a. Key listing and full-access flagging.

| Source (read mode) | Finding | URL |
|---|---|---|
| near-mcp `account_list_access_keys` | Returns the raw key list. Does not compare against policy, does not flag. | https://glama.ai/mcp/servers/@nearai/near-mcp/tools/account_list_access_keys |
| x402 Bazaar `near_account` | Identifies full-access keys and function-call keys limited to one contract, raises flags (single-key control, replaceable contract). No policy or attestation comparison stated. | https://glama.ai/mcp/connectors/tr.com.402/x402-bazaar/tools/near_account |
| Smithii token-safety article | Checks "nobody holds a full access key". No function-call key check described. | https://smithii.io/?p=64535 |

Verdict C3a: PRIOR ART FOUND.

C3b. The combined check (attest() against the RPC key list, method and receiver scope, allowance, recorded keys, pinned code hash). Nearby components found; the combination was not.

| Source (read mode) | What it does | What it does not do, per the same read | URL |
|---|---|---|---|
| privatepay-agent, README (`agent/keyGuard.ts`) | Startup check that fails closed on a full-access key, wrong receiver, extra methods, missing allowance. | RPC call and policy source not stated. Single agent key only, not the account key list. | https://github.com/Nassami1/privatepay-agent |
| near-agent-spend-guard, README | Dashboard shows the agent key's receiver, methods, gas allowance and the count of full-access keys. Demo checks the key's permissions on chain before the first call. | No contract self-report is compared. | https://github.com/mubudot/near-agent-spend-guard |
| agent-allowance-guard, README | Verify step reads the agent key's `method_names` and receiver. | README gives no full key-list check. | https://github.com/asosa933/agent-allowance-guard |
| Veto, README | `chain:conformance`: 37 assertions on owner, agent, allowlist, policy hash and refusal behaviour, read from on-chain events. | Does not say it reads the account key list or code hash. Source: `policy_hash` is a caller-supplied string the contract stores unverified. | https://github.com/Bronxydrone/Veto |
| tollgate, `lib.rs` | `list_agents` returns keys from the contract's own map. | No view of the chain's key set; no code that checks the two match. | https://github.com/kimdooo-a/tollgate |
| Safe Security Hub (page dated 2026-07-02, vendor marketing) | 12 automated checks on a Safe's on-chain configuration: signers, threshold, installed modules and guards recognised, version against official deployments. | Does not say it takes a user-declared baseline. | https://safe.global/blog/workspace-security-hub |
| ERC-7484 (Draft, created 2023-08-14) | Registry checks attestations on individual modules at install and execution. | Does not evaluate the account's full module set against a policy. | https://eips.ethereum.org/EIPS/eip-7484 |

Verdict C3b: NOT FOUND IN THE CHECKED SOURCES. The statement in NOVELTY-CLAIMS that the other tools only list keys is no longer accurate: three NEAR peers (privatepay-agent, near-agent-spend-guard, agent-allowance-guard) check part of the agent key's scope per their READMEs, and Veto checks on-chain policy values against expected ones.

### C4. Account-level cap, written loss bound, property tests

Searched: peer `lib.rs` files and one SPEC (opened, listed in C1); OpenZeppelin Stellar docs.

| Sub-claim | Source (read mode) | Finding | URL |
|---|---|---|---|
| C4a | Leash `lib.rs` | Spent totals are keyed by agent public key (`spent: LookupMap<PublicKey, SpendWindow>`). Each registered key has its own budget, so exposure grows with the key count. Same read says the window logic is a fixed window although the README says rolling. UNVERIFIED. | https://raw.githubusercontent.com/mesh-pch/leash-near/master/src/lib.rs |
| C4a | spend-guard `lib.rs` | `agents: BTreeMap<AccountId, Agent>`, daily total per agent account. | https://raw.githubusercontent.com/mubudot/near-agent-spend-guard/main/src/lib.rs |
| C4a | OpenZeppelin Stellar docs | Limit appears per context rule; page does not say how several rules combine. | https://docs.openzeppelin.com/stellar-contracts/accounts/agent-wallet |
| C4a | tridon README | Vault-enforced total, daily, weekly, monthly limits. Scope across several agents not stated. | https://github.com/sufianweb3/tridon |
| C4b | semilla1-guard-near `SPEC.md` | States the worst case is bounded to `daily_cap` and lists the guarantees the bound depends on. One agent per vault. Notes `owner_withdraw` bypasses the bound. | https://github.com/semilla1lab/semilla1-guard-near |
| C4c | Leash `lib.rs`; semilla1 SPEC | Unit `#[test]` only. No proptest or fuzzing mentioned. Other peers' test files were not opened. | URLs above |

Verdicts: C4a UNDETERMINED (Leash and spend-guard are per agent; tridon and others not resolved). C4b PRIOR ART FOUND (single-agent form). C4c NOT FOUND IN THE CHECKED SOURCES.

### C5. No external actor on the containment path

Searched: Hypernative, Safe Shield and guard pages; plus the in-contract sources listed in C1 and section 4.

| Source (read mode) | Finding | URL |
|---|---|---|
| Hypernative blog (vendor) | Pause role granted "to a Hypernative-controlled address"; pause within a handful of blocks after detection; response pre-configured at onboarding. Count-based action and key revocation not described. | https://www.hypernative.io/insights/blog/how-defi-teams-automate-incident-response-to-stop-exploits-before-funds-move |
| Safe Shield / Guardian help article (Hypernative-authored) | Adds an on-chain Transaction Guard that blocks high-risk transactions; policies managed in the Hypernative dashboard; removal needs a 24 h timelock. The article does not say where the screening runs. | https://help.safe.global/articles/7610775969-understanding-safe-shield-guardian-by-hypernative |
| Safe guards doc | A faulty guard "can cause a denial of service and lock funds". No automatic response by count. | https://docs.safefoundation.org/smart-account/guards |
| In-contract limit enforcement with no external actor | Safe Allowance Module, Zodiac Roles, Smart Sessions policies, the nine NEAR repos. | section 4; C1 |

Verdict C5: PRIOR ART FOUND for the property (in-contract enforcement with no external detector is the usual form for caps). The contrast with detector-based products holds for Hypernative. The automated response part of the design is the C2 question.

### X1. Omen (not in NOVELTY-CLAIMS; README line 9)

NOVELTY-CLAIMS section 3 disclaims "any quantum early warning" but lists no prior-art check for the omen mechanism itself. Searched: `quantum canary honeypot bounty public key funded address signature proves elliptic curve break trigger early warning blockchain` (extended); `smart contract kill switch triggered by proof of cryptographic break "canary" ed25519 OR secp256k1 key bounty claim lockdown vault`.

| Source (read mode) | Finding | URL |
|---|---|---|
| Qanary, Solana devnet, README (repo created 2026-10-10) | Bounty behind an Ed25519 key with no known private key. A valid claim "permanently sets a public tripped flag". Vaults read the flag: the Ed25519 owner path is allowed only while untripped. README states unaudited, devnet, and that it is a signal an attacker chooses to send, not a detector. | https://github.com/tradersirin-hash/qanary |
| Qairos, Ethereum prototype page (undated) | Twelve EC keys (16 to 256 bits) carry bounties. The contract verifies a claimed key itself (commit and reveal). Armed breaks raise `threatLevel()`. `QairosGuard` contracts lock chosen functions at a threshold. Local deployment, no audit, mainnet "Not yet". | https://qairos-hosting.replit.app/ |
| QCAP, IACR ePrint 2026/618 (submitted 2026-03-30) | Trustless protocol for publicly auditable challenges on Bitcoin, as an early-warning signal. Abstract-level read only. | https://eprint.iacr.org/2026/618 |
| Bitcoin Honeypot Address Protocol (post dated 2026-08-13) | Taproot canary on secp192r1. A spend signals a break. No automatic on-chain action. | https://www.discrypt.cat/implementing-a-bitcoin-honeypot-address-protocol/ |

X1a PRIOR ART FOUND (bounty-backed key, break claim verified by a contract, flag or level read by other contracts). All four sources are prototypes or proposals, none audited, so this is prior art as published designs, not as deployed systems.
X1b NOT FOUND IN THE CHECKED SOURCES: none of the four deletes NEAR access keys. Qanary restricts a classical owner path on Solana; Qairos locks functions on Ethereum.

## 3. What this changes in the existing docs (not applied; this task edits only this file)

1. LANDSCAPE.md section 2 and NOVELTY-CLAIMS C1, C2: the NEAR peer set is at least nine repos, not two. Added here: semilla1-guard-near, tollgate, Veto, agent-allowance-guard, tridon, privatepay-agent, policyvault.
2. NOVELTY-CLAIMS C2: add the concept-level sources (Openfort 2026-04-03, PolicyLayer 2026-01-05) and agent-allowance-guard's `rejection_count`. The scoped-absence wording survives. Because the idea is published at concept level (C2c), any sentence that presents the idea, as opposed to the Mamori implementation, as the differentiator should cite those sources.
3. NOVELTY-CLAIMS C3: replace "existing tools list keys and flag full-access keys" with the component overlap in C3b above.
4. NOVELTY-CLAIMS C4: "we have not verified that peer guards lack it" is now partly resolved: Leash and spend-guard are per agent; semilla1 SPEC states a loss bound.
5. NOVELTY-CLAIMS section 2 note on NEAR allowance: docs.near.org says "unusable"; deletion is not stated.
6. Add the omen mechanism (X1) to NOVELTY-CLAIMS, or remove the omen from any sentence that implies originality.
7. Leash comparison for the week-3 run (gate 2): per a summarising read of source, its 24 h window may be fixed, not rolling, and a failed native payment may not be re-queued. Check by running the code, which this task did not do.

## 4. Gate 1 product checks (NOVELTY-CLAIMS section 5, item 1)

| Product | Sources opened | Finding | Verdict |
|---|---|---|---|
| Safe Allowance Module | Module README page (tree/main/modules/allowances); a Solidity path guess returned 404, so contract source was not read | Per-delegate, per-token allowance with `resetTimeMin`; `deleteAllowance`, `removeDelegate` are Safe transactions; no automatic revocation or failure counter described. https://github.com/safe-global/safe-modules/tree/main/modules/allowances | G1-a NOT FOUND (README level) |
| Argent lock, daily limit | `support.argent.xyz` (403), Diligence audit (403 after redirect), `ready.co/blog/vault` (failed), `argentlabs/argent-contracts` README, `argent-contracts-starknet` docs/argent_account.md | Ethereum README says only "lockable". Starknet doc mentions guardians and sessions, not lock or daily limit. A search summary (not opened) reports a five-day lock period and a 24 h hold above the daily limit, with sources disagreeing on whether daily limits survive. https://github.com/argentlabs/argent-contracts ; https://raw.githubusercontent.com/argentlabs/argent-contracts-starknet/main/docs/argent_account.md | G1-b UNDETERMINED |
| Fireblocks policy engine | Developer reference page | `amount` with `amountScope` SINGLE_TX or TIMEFRAME and `periodSec` (velocity-style windows); actions ALLOW, BLOCK, 2-TIER; no automatic key or user revocation described. https://developers.fireblocks.com/reference/configure-transaction-authorization-policy.md | G1-c NOT FOUND |
| Fireblocks whitelist delay | Support article 360019661399 returned 403 | Search summary only: a send to an address in cool-off fails with `ADDRESS_WHITELISTING_SUSPENDED`. Duration and who sets it not read. https://support.fireblocks.io/hc/en-us/articles/360019661399 | G1-d UNDETERMINED |
| Hypernative auto-response | Blog (see C5) | External detector, pause role, seconds to a few blocks (vendor-reported), no count-based action, no key revocation. | G1-e NOT FOUND |
| ERC-7579 Smart Sessions | Repo tree; `contracts/external/policies` listing (ArgPolicy, ContractWhitelist, ERC20SpendingLimit, SimpleGas, Sudo, TimeFrame, UniAction, UsageLimit, ValueLimit); `UsageLimitPolicy.sol`; `ISmartSession.sol` | Policies only return pass or fail. Interface has `disable*` and `removeSession` functions and no auto-disable or failure counter. `SmartSession.sol` itself was not read. https://github.com/erc7579/smartsessions | G1-f NOT FOUND |
| Zodiac Roles | Roles docs allowances page; repo README | Allowances with refill, period, balance; `CallWithinAllowance` rate limit; no update on failed or reverted calls; no automatic revocation. Solidity source not opened. https://docs.roles.gnosisguild.org/general/allowances ; https://github.com/gnosisguild/zodiac-modifier-roles | G1-g NOT FOUND (docs level) |

Gate items 2 and 3: gate 2 is an execution task. Gate 3 needs the same searches repeated on the release day with date, scope and results written. The query strings in C2 are the reusable set.

## 5. Not checked, blocked, or snippet-only

- Blocked or failed fetches: Argent support, Diligence report, ready.co (Argent), Fireblocks support article, Yellow docs (certificate), Android TPM source (503), Rhinestone docs (certificate), Zodiac wiki host (DNS), DeepWiki (429), PolicyLayer mcpservers listing (403).
- Search-summary only, page not opened: Turnkey, Privy, Squads, Yellow, Argent lock details, Fireblocks cool-off, TPM, ZeroDev (policies named Call, Gas, Signature, Rate limit, Timestamp, Sudo; rate-limit page not read).
- Not checked at all: Solana and Sui session-key systems beyond one search, Starknet session keys in code, Biconomy session modules, ERC-6900, Cosmos authz, Lit, Hinomi, closed products, non-English sources, the full list of GitHub repos tagged for the NEAR hackathon, and test files of the nine NEAR peers.
- No GitHub code search was available, so every NOT FOUND above is limited to the pages and files named in its row.
