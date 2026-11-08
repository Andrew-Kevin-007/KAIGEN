# X-ray and the blast-radius meter

Status: 2026-11-08. Testnet only. Both are read-only browser pages in `app/`; neither signs, sends or asks for a key.

## /xray

Paste any NEAR account (ours or a rival's). The page reads it over the app's configured RPC (never a URL the visitor types) at one final block, and grades it with the same fifteen rows as `kaigen-jobs cage-check` (ARCH-2.8-1 to 8, ATTEST-1 to 7), ported to `app/lib/cage.ts` with tests in `app/lib/cage.test.ts`.

It shows every access key (full access, or function call with receiver, methods and allowance), the code hash, whether the account answers `attest()` as a Mamori vault, and one verdict that mirrors cage-check's exit codes:

| Verdict | cage-check exit | Meaning |
|---|---|---|
| GREEN | 0 | all 15 rows hold at the block read |
| RED | 1 | at least one row fails; the rows name the key or condition |
| UNKNOWN | 3 | nothing is red but a row could not be read; not a clean bill |

Where a row cannot be judged from the browser it is UNKNOWN, never green:

- **Code hash (ARCH-2.8-8).** The page knows one hash, the published production build (`AoxPd3zABfzDRoPsE14ReAzMrzq5o5rMFj8FZXn9zKoQ`). A match is GREEN. Any other hash is UNKNOWN, not RED, because a stranger's vault may run code this page was never told about. A hash typed into "Pin what you expect" makes a different hash RED.
- **Admin identity (ARCH-2.8-2).** Without an expected admin the row checks only that there is exactly one ML-DSA full-access key, not whose it is (same as cage-check without `--admin`). Typing an expected admin key, as the chain spells it, compares it.
- **No `attest()`.** An account without it (an ordinary account, or a v2 vault) leaves all seven ATTEST rows UNKNOWN.
- Not ported: the sandbox stand-in admin (rehearsal only).

For an account that is not a Mamori vault the page says so, states what its keys allow ("a full-access key: whoever holds it can take everything"), and does not say anything about whether the account is safe beyond what the key list proves.

Examples (testnet): `vault.kaigen-funder-a00266.testnet` (drill build: RED on ATTEST-2, delay 10 s), `pv-45cbcb96.kaigen-funder-ee0d56.testnet` (production mode: GREEN, 15 of 15), `kaigen-funder-a00266.testnet` (ordinary account, one ed25519 full-access key: RED on ARCH-2.8-1).

Limits: one block, no intents key added without `register_intents_key`, and `attest()` is only as honest as the code answering it (the code hash row is what ties it to known code). The reads are not atomic with each other beyond sharing a block hash.

## Blast-radius meter (vault page)

From the vault's `attest()` and, for tokens, `token_limit` and `pending_limit`, the vault page shows the most an agent key can lose in any 24 hours, per token, by the bound in `LOSS-BOUND.md` section 1:

    loss_T(W) <= C_T + P_T      delay >= 24 h
    loss_T(W) <= C_T + 2 P_T    delay under 24 h (drill builds)

C is `config.daily_limit` (NEAR) or `token_limit(T)`, P is `config.pending_limit` or `pending_limit(T)`. The expandable note shows the numbers used. If an input is missing or not a whole number, nothing is shown for that token (for NEAR, nothing at all). NEP-141 tokens cannot be listed on chain, so the meter shows those in the vault's queue and any token contract the visitor adds. The tight example of the doc (C = 1000, P = 3000: 4000; with a 1 h delay 7000) is a unit test in `app/lib/blast.test.ts`.

The bound is per 24 hours (a slow daily drain is not limited by it), assumes the admin cancels an unwanted queued withdrawal inside the delay, and holds only while the cage is intact, which is what /xray checks.
