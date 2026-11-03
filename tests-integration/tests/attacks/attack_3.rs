//! Attack 3 (ARCHITECTURE.md section 7): a burst of in-cap sends. Claim: loss equals one cap.
//! The burst is signed up front and sent back to back without waiting for any answer, so many transactions are in the same
//! few blocks. 3a: one key sends 40 x 0.1 NEAR (4 caps attempted). 3b: four keys send 20 x 0.1 NEAR each, interleaved
//! (8 caps attempted), against the one account-wide cap. Both with an allowance of 10 NEAR per key so the gas allowance is not
//! what limits the burst. 3c: the 3a burst on a key with the default allowance (0.25 NEAR): measured, not assumed, how
//! much of it the chain takes in. The allowlist is off and every payee is the attacker's.

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

use crate::common::*;
use crate::support::*;

const PIECE: u128 = NEAR / 10;
const BURST_TGAS: u64 = 30;
const WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// Sends the interleaved calls of all keys back to back; returns, per call and in send order, the key index and what the
/// chain made of it (`None`: never taken in), plus the wall milliseconds the submission took.
async fn run_burst(rig: &Rig, keys: &[Daily], per_key: usize) -> (Vec<(usize, Option<Facts>)>, u64) {
    let x = rig.f.attacker.id().clone();
    let args = json!({ "token": null, "amount": PIECE.to_string(), "to": x });
    let mut signed: Vec<Vec<SignedCall>> = Vec::new();
    for k in keys {
        let mut signer = rig.signer(k).await;
        let calls: Vec<(&str, Value, u64)> = (0..per_key).map(|_| ("send_small", args.clone(), BURST_TGAS)).collect();
        signed.push(rig.sign_calls(&mut signer, &calls).await);
    }
    let mut order: Vec<(usize, &SignedCall)> = Vec::new();
    for i in 0..per_key {
        for (k, s) in signed.iter().enumerate() {
            order.push((k, &s[i]));
        }
    }
    let started = std::time::Instant::now();
    for (_, t) in &order {
        rig.rpc().send(t).await.unwrap_or_else(|e| panic!("node refused a burst transaction: {e}"));
    }
    let submit_ms = started.elapsed().as_millis() as u64;
    let hashes: Vec<String> = order.iter().map(|(_, t)| t.hash.clone()).collect();
    let all = facts_many_within(rig.rpc(), &rig.vid, &hashes, WAIT).await;
    (order.iter().map(|(k, _)| *k).zip(all).collect(), submit_ms)
}

struct Tally {
    sent: u64,
    cap_refused: u64,
    other: u64,
    dropped: u64,
    per_key_sent: Vec<u64>,
    no_strikes: bool,
}

fn tally(results: &[(usize, Option<Facts>)], keys: usize) -> Tally {
    let mut t = Tally { sent: 0, cap_refused: 0, other: 0, dropped: 0, per_key_sent: vec![0; keys], no_strikes: true };
    for (k, f) in results {
        let Some(f) = f else {
            t.dropped += 1;
            continue;
        };
        match f.out() {
            Out::Sent => {
                t.sent += 1;
                t.per_key_sent[*k] += 1;
            }
            Out::Refused { reason, strikes, burned } => {
                if reason == "over the 24 h limit" {
                    t.cap_refused += 1;
                } else {
                    t.other += 1;
                }
                t.no_strikes &= strikes == 0 && !burned;
            }
            Out::Aborted(_) => t.other += 1,
        }
    }
    t
}

async fn burst_case(id: &str, claim: &str, key_count: usize, per_key: usize, allowance: NearToken, full_cap_expected: bool) {
    let rig = Rig::new(false).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    let x = rig.f.attacker.id().clone();
    let mut keys = Vec::new();
    for _ in 0..key_count {
        keys.push(rig.add_daily(Some(allowance)).await);
    }
    let att0 = rpc.balance(&x).await;
    let mut c = Checks::new();

    let (results, submit_ms) = run_burst(&rig, &keys, per_key).await;
    let t = tally(&results, key_count);
    let lost = rpc.balance(&x).await - att0;
    let attempted = (key_count * per_key) as u128 * PIECE;
    let taken: Vec<&Facts> = results.iter().filter_map(|(_, f)| f.as_ref()).collect();
    let ledger: Vec<(u64, u128)> = taken.iter().filter(|f| f.out() == Out::Sent).map(|f| (f.call_receipt(&vid).ts, PIECE)).collect();
    let heights: Vec<u64> = taken.iter().map(|f| f.call_receipt(&vid).height).collect();
    let (first, last) = (*heights.iter().min().unwrap(), *heights.iter().max().unwrap());

    if full_cap_expected {
        c.check("loss equals exactly one cap (balance of the attacker's payee)", lost == CAP);
        c.check("every call was taken in by the chain; exactly cap / piece went through, the rest were cap refusals", t.dropped == 0 && t.sent as u128 * PIECE == CAP && t.sent + t.cap_refused == (key_count * per_key) as u64 && t.other == 0);
    } else {
        c.check("loss never above one cap (balance of the attacker's payee)", lost <= CAP);
        c.check("what the chain took in was sent or cap-refused, nothing else", t.other == 0 && t.sent as u128 * PIECE == lost);
    }
    c.check("no refusal in the burst was a strike", t.no_strikes);
    let mut strikes_after = Vec::new();
    for k in &keys {
        strikes_after.push(rig.strikes(&k.pk).await);
    }
    let mut all_on = true;
    for k in &keys {
        all_on &= rig.on_account(&k.pk).await;
    }
    c.check("every key still has zero strikes and is on the account", strikes_after.iter().all(|s| *s == 0) && all_on);
    c.check("the contract's own books agree with the payee's balance: spent_24h", rig.spent_24h().await == lost);
    c.check("the 24 h ledger of landed sends holds the same amount", max_window(&ledger) == lost);

    let gas_total: u64 = taken.iter().map(|f| f.gas_burnt).sum();
    let gas_sent: u64 = taken.iter().filter(|f| f.out() == Out::Sent).map(|f| f.gas_burnt).sum();
    let refused_n = (taken.len() as u64).saturating_sub(t.sent);
    let measured = rig.with_bound(json!({
        "node": node_version(rpc).await,
        "keys": key_count,
        "calls_per_key": per_key,
        "prepaid_tgas_per_call": BURST_TGAS,
        "allowance_per_key_near": near_str(allowance.as_yoctonear()),
        "attempted_yocto": attempted.to_string(),
        "attempted_in_caps": attempted / CAP,
        "calls_signed": key_count * per_key,
        "calls_taken_in_by_the_chain": taken.len(),
        "calls_never_taken_in": t.dropped,
        "calls_that_moved_money": t.sent,
        "calls_refused_cap_exhausted": t.cap_refused,
        "sent_per_key": t.per_key_sent,
        "loss_yocto": lost.to_string(),
        "loss_near": near_str(lost),
        "strikes_after": strikes_after,
        "first_block_executed": first,
        "last_block_executed": last,
        "blocks_spanned_by_the_burst": last - first + 1,
        "wall_ms_to_submit_all_calls": submit_ms,
        "gas_burnt_all_calls": gas_total,
        "gas_burnt_per_sent_call_avg": if t.sent > 0 { gas_sent / t.sent } else { 0 },
        "gas_burnt_per_refused_call_avg": if refused_n > 0 { (gas_total - gas_sent) / refused_n } else { 0 },
    })).await;
    c.finish(id, claim, measured);
}

#[tokio::test]
async fn attack_3a_burst_from_one_key_loses_one_cap() {
    burst_case("attack_3a", "burst of in-cap sends from one key: loss equals one cap", 1, 40, NearToken::from_near(10), true).await;
}

#[tokio::test]
async fn attack_3b_burst_from_four_keys_shares_one_cap() {
    burst_case("attack_3b", "burst of in-cap sends from four keys: the cap is account-wide, loss equals one cap", 4, 20, NearToken::from_near(10), true).await;
}

/// The same burst on a key with the default 0.25 NEAR allowance. Each call prepays its gas against the allowance at the
/// node's pessimistic gas price and gets the unused part back a few blocks later, so only a few can be in flight at once.
/// What lands is measured. The loss still cannot be above one cap.
#[tokio::test]
async fn attack_3c_the_default_allowance_throttles_a_burst_and_the_loss_stays_within_one_cap() {
    burst_case("attack_3c", "burst on a default-allowance key: the loss never exceeds one cap (the allowance throttles how much of the burst lands)", 1, 40, NearToken::from_millinear(250), false).await;
}
