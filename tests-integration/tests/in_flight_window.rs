//! KAIGEN v3 milestone M1, second half: the in-flight window.
//!
//! When Mamori burns a daily key it stops serving it in the same transaction (the key leaves `daily_keys`), but the
//! DeleteKey is a separate receipt that lands in a later block. In between, the key is still on the account and the
//! runtime still accepts transactions signed by it. A second signed transaction sent into that window must fail:
//! either the contract refuses it (`not a recorded daily key`) or, once the delete has landed, the node rejects the
//! key outright. If any such transaction succeeds, that is the finding and the burn mechanics need a redesign.
//!
//! How it is measured. Each round uses a fresh daily key with default strike rules (3 refusals burn it): a control
//! send proves the key works, two refusals leave it alive, then the burning refusal is submitted and, right behind it
//! and with higher nonces, a stream of valid-looking sends and queue requests from the same key, one every 10 ms
//! (about ten per block) until the key is gone from the account. Every attempt would succeed for a live key. Afterwards
//! each attempt is looked up on chain: did it run, in which block, and what did it return? The blocks of the burn,
//! the DeleteKey receipt and the confirming callback come from the burn transaction's own receipt tree.
//!
//! A round only counts if at least one attempt really ran with the key still on the account, and every block between
//! the burn and the block that applies the delete saw one. Rounds that miss the window are reported, not counted.
//!
//! Run: see the header of burn_key.rs.

mod common;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use near_workspaces::types::NearToken;
use near_workspaces::AccountId;
use serde_json::{json, Value};

/// The contract's own refusal text for a key it no longer serves (`assert_daily_key`).
const NOT_RECORDED: &str = "not a recorded daily key";
/// Pause between flood transactions; blocks are about 128 ms, so this puts around ten attempts in every block.
const FLOOD_PAUSE: Duration = Duration::from_millis(10);
/// The flood ends this many blocks after the key is first seen missing from the account, or after `FLOOD_CAP`.
const BLOCKS_AFTER_DELETE: u64 = 4;
const FLOOD_CAP: Duration = Duration::from_secs(6);
/// Rounds with a fresh key each: at least `REQUIRED_ROUNDS` must really hit the window.
const REQUIRED_ROUNDS: usize = 3;
const MAX_ROUNDS: usize = 15;

struct Attempt {
    call: SignedCall,
    head_at_send: u64,
}

/// What became of one second transaction.
#[derive(Debug, Clone)]
enum Fate {
    /// Ran on chain and the contract refused it (`not a recorded daily key`), in this block.
    RefusedByContract(u64),
    /// Ran on chain and failed for some other reason (the test is then not measuring the burn).
    OtherFailure(u64, String),
    /// Ran on chain and SUCCEEDED. This is the finding the test exists to catch.
    Succeeded(u64),
    /// The chain has no record of it (UNKNOWN_TRANSACTION): dropped because the signing key was gone, or never included.
    NotExecuted,
}

#[derive(Default, Debug)]
struct Round {
    burn_block: u64,
    delete_block: u64,
    last_block: u64,
    attempts: usize,
    /// Per block: [attempts the contract refused, attempts that never executed (by the head they were sent at)].
    per_block: BTreeMap<u64, [usize; 2]>,
    refused_in_window: usize,
    not_executed: usize,
    exercised: bool,
}

/// Both kinds would succeed for a live key (each round proves that first): a 0.01 NEAR send and a 0.01 NEAR queue request.
fn attempt_args(i: usize, payee: &AccountId) -> (&'static str, Value, u64) {
    let args = json!({ "token": null, "amount": SEND.to_string(), "to": payee });
    if i % 2 == 0 {
        ("send_small", args, 50)
    } else {
        ("request_withdraw", args, 20)
    }
}

async fn window_round(f: &Fixture, round: usize) -> Round {
    let vid = f.vault_id().clone();
    let (sk, pk) = new_key();
    // A large allowance so the key is deleted by the burn and not by running out of gas money.
    f.add_daily_key(&pk, Some(NearToken::from_near(10))).await;
    let key = f.daily(&sk);
    let (p0, x0) = (f.rpc.balance(f.payee.id()).await, f.rpc.balance(f.attacker.id()).await);
    let spent0: u128 = f.rpc.view(&vid, "spent_24h", json!({ "token": null })).await.as_str().unwrap().parse().unwrap();

    // Control: the same kind of send the flood uses works for the live key. Then two strikes, key still alive.
    let sent = f.send_small(&key, f.payee.id(), SEND).await.json::<Value>().unwrap();
    assert_eq!(sent["sent"], true, "round {round}: control send must go through");
    for expected in 1..=2u64 {
        let out = f.strike(&key).await;
        assert_eq!((out["burned"].clone(), out["strikes"].clone()), (json!(false), json!(expected)), "round {round}");
    }

    // The next refusal burns the key. Submit it, then keep sending from the same key until the key is gone.
    let nonce = f.rpc.access_key(&vid, &pk).await.expect("key alive before the burn")["nonce"].as_u64().unwrap();
    let (_, final_hash) = f.rpc.head("final").await;
    let mut signer = KeySigner::new(&vid, &sk, nonce);
    let burn = signer.call(&vid, "send_small", &json!({ "token": null, "amount": SEND.to_string(), "to": f.attacker.id() }), 50, &final_hash);

    let head = Arc::new(AtomicU64::new(f.rpc.head("optimistic").await.0));
    let absent_at = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = tokio::spawn({
        let (rpc, vid, pk) = (f.rpc.clone(), vid.clone(), pk.clone());
        let (head, absent_at, stop) = (head.clone(), absent_at.clone(), stop.clone());
        async move {
            while !stop.load(Ordering::Relaxed) {
                let h = rpc.head("optimistic").await.0;
                head.store(h, Ordering::Relaxed);
                if absent_at.load(Ordering::Relaxed) == 0 && rpc.access_key(&vid, &pk).await.is_none() {
                    absent_at.store(h, Ordering::Relaxed);
                }
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
        }
    });

    f.rpc.send(&burn).await.expect("burn tx submitted");
    let started = Instant::now();
    let mut attempts: Vec<Attempt> = Vec::new();
    loop {
        let (h, gone) = (head.load(Ordering::Relaxed), absent_at.load(Ordering::Relaxed));
        if (gone != 0 && h >= gone + BLOCKS_AFTER_DELETE) || started.elapsed() > FLOOD_CAP {
            break;
        }
        let (method, args, tgas) = attempt_args(attempts.len(), f.payee.id());
        let call = signer.call(&vid, method, &args, tgas, &final_hash);
        f.rpc.send(&call).await.expect("node accepted the submission");
        attempts.push(Attempt { call, head_at_send: h });
        tokio::time::sleep(FLOOD_PAUSE).await;
    }
    stop.store(true, Ordering::Relaxed);
    watcher.await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await; // let everything finalize

    // The burn transaction: it must really have burned, and its receipt tree gives the blocks of the chain of events.
    let burn_trace = f.rpc.trace(&burn.hash, &vid, "FINAL").await.expect("burn tx trace");
    assert_eq!(burn_trace.value().expect("burn outcome")["burned"], true, "round {round}: the third refusal burns");
    let burn_block = burn_trace.receipts.iter().find(|r| r.logs.iter().any(|l| l.contains("key_burned"))).expect("burn receipt").height;
    let delete_block = burn_trace.delete_key_height().expect("DeleteKey receipt");
    let last_block = burn_trace.last_receipt_height();

    // Fate of every second transaction, looked up concurrently.
    let mut lookups = tokio::task::JoinSet::new();
    for (i, a) in attempts.iter().enumerate() {
        let (rpc, vid, hash) = (f.rpc.clone(), vid.clone(), a.call.hash.clone());
        lookups.spawn(async move { (i, rpc.trace(&hash, &vid, "NONE").await) });
    }
    let mut fates: Vec<Option<Fate>> = vec![None; attempts.len()];
    while let Some(done) = lookups.join_next().await {
        let (i, result) = done.unwrap();
        fates[i] = Some(match result {
            Err(e) => {
                // Only "the chain has no such transaction" counts as not executed; any other answer is a gap in
                // the measurement (for example an outcome not yet available) and must not pass as a refusal.
                assert!(
                    e.to_string().contains("UNKNOWN_TRANSACTION"),
                    "round {round}: cannot tell what became of an attempt: {e}"
                );
                Fate::NotExecuted
            }
            Ok(t) => {
                let height = t.receipts.first().map_or(t.tx_height, |r| r.height);
                if !t.failed() {
                    Fate::Succeeded(height)
                } else if t.failure_text().contains(NOT_RECORDED) {
                    Fate::RefusedByContract(height)
                } else {
                    Fate::OtherFailure(height, t.failure_text())
                }
            }
        });
    }

    // Verdicts. Any success is the finding; any failure that is not the burn means the test is not measuring it.
    let mut report = Round { burn_block, delete_block, last_block, attempts: attempts.len(), ..Default::default() };
    for (a, fate) in attempts.iter().zip(fates.into_iter().map(Option::unwrap)) {
        match fate {
            Fate::Succeeded(h) => panic!(
                "FINDING: round {round}: a transaction signed by the burned key SUCCEEDED in block {h} (burn block {burn_block}, \
                 DeleteKey block {delete_block}): {} nonce {}",
                a.call.method, a.call.nonce
            ),
            Fate::OtherFailure(h, text) => panic!("round {round}: attempt failed for a reason that is not the burn (block {h}): {text}"),
            Fate::RefusedByContract(h) => {
                assert!(h >= burn_block, "round {round}: a later nonce ran before the burn (block {h} < {burn_block}); pool order assumption broken");
                assert!(h <= delete_block, "round {round}: contract refused in block {h}, after the key was deleted in {delete_block}");
                report.per_block.entry(h).or_default()[0] += 1;
                report.refused_in_window += 1;
            }
            Fate::NotExecuted => {
                report.per_block.entry(a.head_at_send).or_default()[1] += 1;
                report.not_executed += 1;
            }
        }
    }
    // Every block after the burn up to and including the one that applies the delete saw at least one attempt that
    // really ran with the key still on the account, and the contract refused it.
    let covered = (burn_block + 1..=delete_block).all(|h| report.per_block.get(&h).is_some_and(|c| c[0] > 0));
    report.exercised = report.refused_in_window > 0 && covered;

    // Afterwards: key gone, nothing moved but the control send, nothing queued, nothing spent beyond it.
    assert!(f.rpc.access_key(&vid, &pk).await.is_none(), "round {round}: key must be gone from the account");
    assert_eq!(f.rpc.balance(f.payee.id()).await - p0, SEND, "round {round}: only the control send reached the payee");
    assert_eq!(f.rpc.balance(f.attacker.id()).await, x0, "round {round}: the attacker received nothing");
    assert_eq!(f.rpc.view(&vid, "queue", json!({})).await, json!([]), "round {round}: no queue entry from the burned key");
    let spent1: u128 = f.rpc.view(&vid, "spent_24h", json!({ "token": null })).await.as_str().unwrap().parse().unwrap();
    assert_eq!(spent1 - spent0, SEND, "round {round}: the 24 h spend log grew by the control send only");
    if let Some(revoked) = f.rpc.view_if_present(&vid, "revoked_keys", json!({})).await {
        assert_eq!(revoked, json!([]), "round {round}: delete confirmed");
    }
    let late = signer.call(&vid, "send_small", &json!({ "token": null, "amount": SEND.to_string(), "to": f.payee.id() }), 50, &final_hash);
    let err = f.rpc.commit(&late).await.expect_err("after the delete the node rejects the key outright");
    assert!(err.to_string().contains("AccessKeyNotFound"), "round {round}: {err}");
    report
}

#[tokio::test]
async fn second_signed_transaction_from_a_burned_key_fails_while_the_delete_is_in_flight() {
    let f = Fixture::new().await;
    let mut exercised = 0;
    let mut rounds = 0;
    for round in 1..=MAX_ROUNDS {
        let r = window_round(&f, round).await;
        rounds += 1;
        println!(
            "round {round:2}: burn block {} -> DeleteKey block {} -> last callback block {} | {} attempts, {} ran and the contract refused them, {} never executed | exercised={}",
            r.burn_block, r.delete_block, r.last_block, r.attempts, r.refused_in_window, r.not_executed, r.exercised
        );
        for (h, c) in &r.per_block {
            println!("           block {h}: refused by contract {}, never executed (by send height) {}", c[0], c[1]);
        }
        if r.exercised {
            exercised += 1;
        }
        if exercised >= REQUIRED_ROUNDS {
            break;
        }
    }
    assert!(
        exercised >= REQUIRED_ROUNDS,
        "INCONCLUSIVE: only {exercised} of {rounds} rounds hit the in-flight window (need {REQUIRED_ROUNDS}); no round let a burned-key tx through"
    );
}

/// The detector can fail: the very same raw-signed attempts from a key that was NOT burned do succeed and move money.
/// Without this, "every attempt failed" could just mean the harness cannot get a transaction through.
#[tokio::test]
async fn control_the_same_attempts_from_a_live_key_succeed() {
    let f = Fixture::new().await;
    let vid = f.vault_id().clone();
    let (sk, pk) = new_key();
    f.add_daily_key(&pk, Some(NearToken::from_near(10))).await;
    let nonce = f.rpc.access_key(&vid, &pk).await.expect("key")["nonce"].as_u64().unwrap();
    let (_, final_hash) = f.rpc.head("final").await;
    let mut signer = KeySigner::new(&vid, &sk, nonce);
    let p0 = f.rpc.balance(f.payee.id()).await;

    let mut calls = Vec::new();
    for i in 0..4 {
        let (method, args, tgas) = attempt_args(i, f.payee.id());
        let call = signer.call(&vid, method, &args, tgas, &final_hash);
        f.rpc.send(&call).await.expect("submitted");
        calls.push(call);
    }
    tokio::time::sleep(Duration::from_millis(2000)).await;
    for call in &calls {
        let t = f.rpc.trace(&call.hash, &vid, "NONE").await.unwrap_or_else(|e| panic!("{} nonce {} has no outcome: {e}", call.method, call.nonce));
        assert!(!t.failed(), "{} from a live key must succeed: {}", call.method, t.failure_text());
    }
    assert_eq!(f.rpc.balance(f.payee.id()).await - p0, 2 * SEND, "the two send_small attempts moved 0.01 NEAR each");
    assert_eq!(f.rpc.view(&vid, "queue", json!({})).await.as_array().unwrap().len(), 2, "the two request_withdraw attempts queued");
}
