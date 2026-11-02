//! KAIGEN v3 milestone M1 (docs/v3/ROADMAP.md, docs/v3/ARCHITECTURE.md section 2.1): is a burned daily key really
//! deleted on a NEAR chain? The unit-test VM cannot show this: the delete lands in a later receipt.
//! This file: sandbox smoke test, the burn end to end, and the burn's queue cleanup. The in-flight window (a second
//! signed transaction from the burned key while the delete is pending) is in in_flight_window.rs.
//!
//! Needs a NEAR sandbox node (nearcore 2.14.0, protocol 88). nearcore has no Windows build, so on this machine the
//! node runs in WSL and the tests, built on Windows, attach to it (PowerShell, repo root):
//!
//!   cargo build --release --target wasm32-unknown-unknown -p mamori
//!   tests-integration/sandbox/start.ps1          (prints the two variables below)
//!   $env:KAIGEN_SANDBOX_RPC=...; $env:KAIGEN_SANDBOX_KEY_FILE=...
//!   $env:MAMORI_WASM=<path to a mamori.wasm>     (default: target/wasm32-unknown-unknown/release/mamori.wasm)
//!   cd tests-integration; cargo test -- --test-threads=1 --nocapture
//!   tests-integration/sandbox/stop.ps1
//!
//! On Linux or macOS leave the two KAIGEN_SANDBOX variables unset: near-workspaces downloads and starts its own node.
//! The vault's admin here is an ed25519 full-access key; the ML-DSA admin of production is not exercised.

mod common;

use common::*;
use serde_json::json;

/// Step 1: the sandbox is up, a contract deploys, and a call and a view answer.
#[tokio::test]
async fn smoke_deploy_init_and_call() {
    let f = Fixture::new().await;

    let (height, _) = f.rpc.head("optimistic").await;
    let status = f.rpc.call("status", json!([])).await.expect("status");
    println!("sandbox {} protocol {} height {}", status["version"]["version"], status["protocol_version"], height);

    let config = f.rpc.view(f.vault_id(), "config", json!({})).await;
    assert_eq!(config["era"], "Calm");
    assert_eq!(config["delay_secs"], 86_400);
    assert_eq!(config["max_strikes"], 3);
    assert_eq!(config["daily_limit"], NEAR.to_string());
    assert_eq!(f.rpc.view(f.vault_id(), "daily_keys", json!({})).await, json!([]));

    // The admin call went through the real runtime: the allowlist is enforced and lists the payee.
    let list = f.rpc.view(f.vault_id(), "allowlist", json!({})).await;
    assert_eq!(list["enforced"], true);
    assert_eq!(list["accounts"], json!([f.payee.id()]));

    // The vault account holds exactly one key, its full-access admin key.
    let keys = f.rpc.access_keys(f.vault_id()).await;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].1["permission"], "FullAccess");
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: the burn, end to end, through the contract's own path.
// ---------------------------------------------------------------------------------------------------------------

use near_workspaces::types::{Gas, NearToken};
use serde_json::Value;

#[tokio::test]
async fn burned_key_is_gone_from_the_account_access_keys() {
    let f = Fixture::new().await;
    let vid = f.vault_id().clone();

    // The account starts with exactly one key, the admin's full-access key.
    let keys = f.rpc.access_keys(&vid).await;
    assert_eq!(keys.len(), 1, "fresh vault holds one key");
    assert_eq!(keys[0].1["permission"], "FullAccess");
    let admin_pk = keys[0].0.clone();

    // Add a daily key through the contract (default allowance). It is a real function-call key on the account.
    let (sk, pk) = new_key();
    f.add_daily_key(&pk, None).await;
    let on_chain = f.rpc.access_key(&vid, &pk).await.expect("daily key on the account");
    let fc = &on_chain["permission"]["FunctionCall"];
    assert_eq!(fc["receiver_id"], vid.as_str(), "key is scoped to the vault itself");
    assert_eq!(fc["method_names"], json!(["send_small", "request_withdraw"]), "key can reach only the two daily methods");
    assert_eq!(fc["allowance"], NearToken::from_millinear(250).as_yoctonear().to_string(), "default allowance is 0.25 NEAR, not unlimited");
    assert!(f.rpc.view(&vid, "daily_keys", json!({})).await.as_array().unwrap().iter().any(|k| k == &json!(pk)));
    assert_eq!(f.rpc.access_keys(&vid).await.len(), 2);

    // Control: before the burn the key works, so a later failure is the burn and not a broken call.
    let key = f.daily(&sk);
    let (p0, x0) = (f.rpc.balance(f.payee.id()).await, f.rpc.balance(f.attacker.id()).await);
    let sent = f.send_small(&key, f.payee.id(), SEND).await;
    assert_eq!(sent.json::<Value>().unwrap()["sent"], true, "a within-cap send to a listed payee goes through");
    assert_eq!(f.rpc.balance(f.payee.id()).await - p0, SEND, "the payee received exactly the amount");
    // Two counted refusals: strikes 1 and 2, key still alive on the account and still recorded.
    for expected in 1..=2u64 {
        let out = f.strike(&key).await;
        assert_eq!((out["sent"].clone(), out["burned"].clone(), out["strikes"].clone()), (json!(false), json!(false), json!(expected)));
        assert!(f.rpc.access_key(&vid, &pk).await.is_some(), "key must survive strike {expected}");
    }
    assert_eq!(f.rpc.view(&vid, "strikes_of", json!({ "public_key": pk })).await, json!(2));

    // The third refusal burns it. The call returns normally; the delete is a later receipt.
    let burn = f.send_small(&key, f.attacker.id(), SEND).await;
    let hash = burn.outcome().transaction_hash.to_string();
    let burn_logs: Vec<String> = burn.logs().iter().map(|l| l.to_string()).collect();
    let out = burn.json::<Value>().unwrap();
    assert_eq!((out["sent"].clone(), out["burned"].clone(), out["strikes"].clone()), (json!(false), json!(true), json!(3)));
    assert!(burn_logs.iter().any(|l| l.contains("\"event\":\"key_burned\"") && l.contains(&pk)), "key_burned event names the key");

    // What the chain did, block by block, from the burn transaction's receipt tree.
    let trace = f.rpc.trace(&hash, &vid, "FINAL").await.expect("burn tx trace");
    let burn_height = trace.receipts.iter().find(|r| r.logs.iter().any(|l| l.contains("key_burned"))).expect("burn receipt").height;
    let delete_height = trace.delete_key_height().expect("the burn scheduled a DeleteKey receipt");
    let confirmed_height = trace.last_receipt_height();
    println!("burn executed in block {burn_height}, DeleteKey receipt in block {delete_height}, last callback in block {confirmed_height}");
    assert!(delete_height > burn_height, "the delete is a later receipt than the burn decision");
    assert!(!trace.failed(), "burn tx and all its receipts succeeded: {}", trace.failure_text());

    // The key is really gone from the account, and only the admin key remains.
    wait_for("burned key deleted from the account", std::time::Duration::from_secs(10), || async {
        f.rpc.access_key(&vid, &pk).await.is_none().then_some(())
    })
    .await;
    let after = f.rpc.access_keys(&vid).await;
    assert_eq!(after.len(), 1, "exactly one key left: {after:?}");
    assert_eq!(after[0].0, admin_pk, "the survivor is the admin key");
    assert_eq!(after[0].1["permission"], "FullAccess");

    // The contract agrees: not served, delete confirmed (revoked ledger empty), strikes cleared, queue emptied.
    assert!(!f.rpc.view(&vid, "daily_keys", json!({})).await.as_array().unwrap().iter().any(|k| k == &json!(pk)));
    // The v2 production build has no `revoked_keys` view; where it exists it must be empty once the account confirmed.
    if let Some(revoked) = f.rpc.view_if_present(&vid, "revoked_keys", json!({})).await {
        assert_eq!(revoked, json!([]), "account confirmed the delete");
    }
    assert_eq!(f.rpc.view(&vid, "strikes_of", json!({ "public_key": pk })).await, json!(0));

    // A transaction signed by the burned key is now refused by the runtime itself.
    let (_, bh) = f.rpc.head("final").await;
    let mut late = KeySigner::new(&vid, &sk, 1_000_000_000_000);
    let call = late.call(&vid, "send_small", &json!({ "token": null, "amount": SEND.to_string(), "to": f.payee.id() }), 50, &bh);
    // `send_tx` with `wait_until: NONE` accepts anything without looking; `commit` validates against current state.
    let err = f.rpc.commit(&call).await.expect_err("a tx from a deleted key must be rejected");
    assert!(err.to_string().contains("AccessKeyNotFound"), "rejected because the key is gone: {err}");

    // Money: only the one control send moved.
    assert_eq!(f.rpc.balance(f.payee.id()).await - p0, SEND);
    assert_eq!(f.rpc.balance(f.attacker.id()).await, x0, "the attacker received nothing");
}

/// Burning a key also cancels the withdrawals it had queued (ARCHITECTURE.md 2.1). Separate from the test above so a
/// build that deletes the key but leaves its queue alone still shows the key-deletion result on its own.
#[tokio::test]
async fn burn_cancels_the_burned_keys_queued_withdrawals() {
    let f = Fixture::new().await;
    let vid = f.vault_id().clone();
    let (sk, pk) = new_key();
    f.add_daily_key(&pk, None).await;
    let key = f.daily(&sk);

    let queued = key
        .call(&vid, "request_withdraw")
        .args_json(json!({ "token": null, "amount": SEND.to_string(), "to": f.payee.id() }))
        .gas(Gas::from_tgas(20))
        .transact()
        .await
        .unwrap();
    assert!(queued.is_success(), "request_withdraw works before the burn: {:?}", queued.failures());
    assert_eq!(f.rpc.view(&vid, "queue", json!({})).await.as_array().unwrap().len(), 1);

    for _ in 0..2 {
        assert_eq!(f.strike(&key).await["burned"], false);
    }
    assert_eq!(f.strike(&key).await["burned"], true);
    wait_for("burned key deleted from the account", std::time::Duration::from_secs(10), || async {
        f.rpc.access_key(&vid, &pk).await.is_none().then_some(())
    })
    .await;
    assert_eq!(f.rpc.view(&vid, "queue", json!({})).await, json!([]), "the burned key's queued withdrawal was cancelled");
}
