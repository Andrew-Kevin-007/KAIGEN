//! KAIGEN v3 week 3, milestones M7 and M8 (docs/v3/ROADMAP.md, docs/v3/ARCHITECTURE.md section 7): the nine scripted
//! attacks against a real nearcore sandbox, with an explicit PASS or FAIL against the documented claim and measured
//! numbers (blocks, gas, amounts, strikes). One test binary, one module per attack.
//!
//!   attack_1  clumsy injected agent sends over the cap (and to an unlisted payee), key burned at strike N
//!   attack_2  calibrated attacker: in-cap sends sized from `check`, allowlist off, zero strikes (mandatory)
//!   attack_3  burst of in-cap sends from one key and from several keys
//!   attack_4  queue flood by one key: slots, shares, pending sum, `cancel_all`
//!   attack_5  stale queue item (needs the chain clock moved two days: see `timed`)
//!   attack_6  new payee through `request_withdraw` instead of `send_small`: queued, then cancelled
//!   attack_7  decimal-misread send, on NEAR and on a NEP-141 look-alike with 6 decimals
//!   attack_8  planted ed25519 full-access key and null-allowance key: cage-check red, then green
//!   attack_9  cross-key grief: key A uses the cap up, honest key B must not burn
//!   m8        gas per call, blocks to key deletion, false-positive cost of a strike in replay
//!   timed     the parts that need the chain clock moved by days (2c, 5, 9b, strike lapse); about 100 minutes, `#[ignore]`d, see its header
//!
//! Setup is the one of burn_key.rs: the WSL sandbox from tests-integration/sandbox/start.ps1, the two
//! KAIGEN_SANDBOX variables, MAMORI_WASM, and `node` on PATH for attack 8. Extra variables:
//!   FT_MOCK_WASM             the NEP-141 look-alike for attack 7 (tests-integration/fixtures/ft-mock, build notes there)
//!   KAIGEN_ATTACK_RESULTS    file that every attack appends its measured result to, one JSON line each
//!   KAIGEN_CAGE_JOBS_BIN     jobs/src/bin.mjs to run for attack 8 (default: the working tree's)
//! Run: `cargo test --test attacks <name> -- --test-threads=1 --nocapture`. One sandbox, one test at a time. The result file is
//! turned into docs/v3/ATTACK-RESULTS.md by `render_results.py` in this directory.
//!
//! Caveat that belongs to every number here: a single-validator sandbox with 128 ms blocks, an ed25519 admin standing
//! in for the ML-DSA one, no testnet, no mainnet. The vault is a Mamori built from this repository's HEAD.

#[path = "../common/mod.rs"]
mod common;
mod support;

mod attack_1;
mod attack_2;
mod attack_3;
mod attack_4;
mod attack_6;
mod attack_7;
mod attack_8;
mod attack_9;
mod m8;
mod timed;
