//! Shared helpers for the scripted attacks: what one transaction did on the chain (heights, timestamps, gas), a vault
//! rig with daily keys, burst sending, a sliding 24 h window over a ledger, the chain-clock jump, and the result sink.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::time::{Duration, Instant};

use base64::Engine as _;
use near_workspaces::types::{Gas, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

use crate::common::*;

pub const CAP: u128 = NEAR; // Fixture::new(): daily_limit = 1 NEAR
pub const PENDING: u128 = 10 * NEAR; // default pending limit: 10 x the cap
pub const DAY_NS: u64 = 86_400_000_000_000;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---------------------------------------------------------------------------------------------------------------
// Results: a PASS/FAIL against the documented claim, and the measured numbers
// ---------------------------------------------------------------------------------------------------------------

/// Prints one `ATTACK-RESULT {json}` line and appends it to `KAIGEN_ATTACK_RESULTS` when that is set.
pub fn record(id: &str, result: &Value) {
    let line = json!({ "id": id, "result": result }).to_string();
    println!("ATTACK-RESULT {line}");
    if let Ok(path) = std::env::var("KAIGEN_ATTACK_RESULTS") {
        let mut f = OpenOptions::new().create(true).append(true).open(&path).unwrap_or_else(|e| panic!("cannot open {path}: {e}"));
        writeln!(f, "{line}").expect("write the result line");
    }
}

/// The checks that decide an attack's verdict. A failed check is still recorded, then the test fails.
pub struct Checks {
    items: Vec<(String, bool)>,
}

impl Checks {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    pub fn check(&mut self, name: &str, ok: bool) {
        println!("  [{}] {name}", if ok { "ok  " } else { "FAIL" });
        self.items.push((name.to_string(), ok));
    }

    pub fn finish(self, id: &str, claim: &str, measured: Value) {
        if let Some(failure) = self.record_only(id, claim, measured) {
            panic!("{failure}");
        }
    }

    /// Records the result and returns the failure text instead of panicking, for a test that has more phases to run.
    pub fn record_only(self, id: &str, claim: &str, measured: Value) -> Option<String> {
        let failed: Vec<&str> = self.items.iter().filter(|(_, ok)| !ok).map(|(n, _)| n.as_str()).collect();
        let verdict = if failed.is_empty() { "PASS" } else { "FAIL" };
        let checks: Vec<Value> = self.items.iter().map(|(n, ok)| json!({ "check": n, "ok": ok })).collect();
        record(id, &json!({ "claim": claim, "verdict": verdict, "checks": checks, "measured": measured }));
        (!failed.is_empty()).then(|| format!("{id}: FAIL, checks that did not hold: {failed:?}"))
    }
}

/// An exact NEAR amount, trailing zeros trimmed ("1", "0.01", "0.000000000000000000000001").
pub fn near_str(yocto: u128) -> String {
    let (whole, frac) = (yocto / NEAR, yocto % NEAR);
    if frac == 0 {
        return whole.to_string();
    }
    format!("{whole}.{}", format!("{frac:024}").trim_end_matches('0'))
}

/// `after - before` as a signed decimal string (a vault's balance can go up: a contract earns a share of the gas it burns).
pub fn delta(before: u128, after: u128) -> String {
    (after as i128 - before as i128).to_string()
}

pub fn tgas(gas: u64) -> String {
    format!("{:.3}", gas as f64 / 1e12)
}

fn u64_of(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64().map(u128::from)).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------------------------
// What one transaction did
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Rcpt {
    pub id: String,
    pub executor: String,
    /// Block the receipt executed in, and that block's timestamp (ns).
    pub height: u64,
    pub ts: u64,
    pub logs: Vec<String>,
    pub gas_burnt: u64,
    pub delete_key: bool,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Facts {
    pub hash: String,
    /// Block that took the transaction in, and its timestamp (ns).
    pub tx_height: u64,
    pub tx_ts: u64,
    pub status: Value,
    /// Gas burnt by the transaction and every receipt it caused, callbacks included.
    pub gas_burnt: u64,
    pub tokens_burnt: u128,
    pub receipts: Vec<Rcpt>,
}

/// What `send_small` returned, or why it aborted.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Sent,
    Refused { reason: String, strikes: u64, burned: bool },
    Aborted(String),
}

async fn block_info(rpc: &Rpc, cache: &mut HashMap<String, (u64, u64)>, hash: &str) -> (u64, u64) {
    if let Some(x) = cache.get(hash) {
        return *x;
    }
    let r = rpc.call("block", json!({ "block_id": hash })).await.expect("block by hash");
    let x = (r["header"]["height"].as_u64().expect("height"), u64_of(&r["header"]["timestamp"]));
    cache.insert(hash.to_string(), x);
    x
}

/// Waits for the transaction to be final and reads everything off its receipt tree.
pub async fn facts(rpc: &Rpc, hash: &str, sender: &AccountId) -> Facts {
    facts_within(rpc, hash, sender, Duration::from_secs(30)).await.unwrap_or_else(|| panic!("transaction {hash} was not final after 30 s"))
}

/// Like `facts`, but `None` if the chain never took the transaction in (a raw transaction the node accepted without
/// executing, for example because the key's allowance could not cover its prepaid gas at that moment).
pub async fn facts_within(rpc: &Rpc, hash: &str, sender: &AccountId, within: Duration) -> Option<Facts> {
    let started = Instant::now();
    let r = loop {
        match rpc
            .call("EXPERIMENTAL_tx_status", json!({ "tx_hash": hash, "sender_account_id": sender, "wait_until": "FINAL" }))
            .await
        {
            Ok(v) if v.get("transaction_outcome").is_some() && v["final_execution_status"] == "FINAL" => break v,
            _ => {}
        }
        if started.elapsed() > within {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let mut cache = HashMap::new();
    let (tx_height, tx_ts) = block_info(rpc, &mut cache, r["transaction_outcome"]["block_hash"].as_str().expect("tx block")).await;
    let mut gas_burnt = u64_of(&r["transaction_outcome"]["outcome"]["gas_burnt"]);
    let mut tokens_burnt = u128_of(&r["transaction_outcome"]["outcome"]["tokens_burnt"]);

    let mut actions_of: HashMap<String, Vec<Value>> = HashMap::new();
    for rc in r["receipts"].as_array().cloned().unwrap_or_default() {
        if let (Some(id), Some(actions)) = (rc["receipt_id"].as_str(), rc["receipt"]["Action"]["actions"].as_array()) {
            actions_of.insert(id.to_string(), actions.clone());
        }
    }
    let mut receipts = Vec::new();
    for o in r["receipts_outcome"].as_array().cloned().unwrap_or_default() {
        let (height, ts) = block_info(rpc, &mut cache, o["block_hash"].as_str().expect("receipt block")).await;
        let id = o["id"].as_str().expect("receipt id").to_string();
        let gas = u64_of(&o["outcome"]["gas_burnt"]);
        gas_burnt += gas;
        tokens_burnt += u128_of(&o["outcome"]["tokens_burnt"]);
        let actions = actions_of.get(&id).cloned().unwrap_or_default();
        receipts.push(Rcpt {
            delete_key: actions.iter().any(|a| a.get("DeleteKey").is_some()),
            methods: actions.iter().filter_map(|a| a["FunctionCall"]["method_name"].as_str().map(str::to_string)).collect(),
            id,
            executor: o["outcome"]["executor_id"].as_str().unwrap_or_default().to_string(),
            height,
            ts,
            logs: o["outcome"]["logs"].as_array().map(|l| l.iter().map(|s| s.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default(),
            gas_burnt: gas,
        });
    }
    Some(Facts { hash: hash.to_string(), tx_height, tx_ts, status: r["status"].clone(), gas_burnt, tokens_burnt, receipts })
}

/// Facts for many transactions at once, in the order of `hashes`; every one must be taken in by the chain.
pub async fn facts_many(rpc: &Rpc, sender: &AccountId, hashes: &[String]) -> Vec<Facts> {
    facts_many_within(rpc, sender, hashes, Duration::from_secs(30)).await.into_iter().map(|f| f.expect("every transaction answered")).collect()
}

/// Facts for many transactions at once, in the order of `hashes`; `None` for one the chain never took in within `within`.
pub async fn facts_many_within(rpc: &Rpc, sender: &AccountId, hashes: &[String], within: Duration) -> Vec<Option<Facts>> {
    let mut set = tokio::task::JoinSet::new();
    for (i, h) in hashes.iter().enumerate() {
        let (rpc, sender, h) = (rpc.clone(), sender.clone(), h.clone());
        set.spawn(async move { (i, facts_within(&rpc, &h, &sender, within).await) });
    }
    let mut out: Vec<Option<Facts>> = vec![None; hashes.len()];
    while let Some(done) = set.join_next().await {
        let (i, f) = done.expect("facts task");
        out[i] = f;
    }
    out
}

impl Facts {
    /// The JSON the transaction returned, if it succeeded with a value.
    pub fn value(&self) -> Option<Value> {
        let b64 = self.status.get("SuccessValue")?.as_str()?;
        if b64.is_empty() {
            return None;
        }
        serde_json::from_slice(&B64.decode(b64).ok()?).ok()
    }

    pub fn failed(&self) -> bool {
        self.status.get("Failure").is_some()
    }

    /// The text of a contract panic ("queue full"), else the whole failure, else `None` for a success.
    pub fn panic_text(&self) -> Option<String> {
        let fail = self.status.get("Failure")?.to_string();
        match fail.find("panicked: ") {
            Some(i) => Some(fail[i + "panicked: ".len()..].split('"').next().unwrap_or_default().trim_end_matches('\\').to_string()),
            None => Some(fail),
        }
    }

    /// `send_small`'s answer.
    pub fn out(&self) -> Out {
        if let Some(p) = self.panic_text() {
            return Out::Aborted(p);
        }
        let v = self.value().expect("send_small returned a SendOutcome");
        if v["sent"] == true {
            return Out::Sent;
        }
        Out::Refused {
            reason: v["refused"].as_str().unwrap_or_default().to_string(),
            strikes: v["strikes"].as_u64().unwrap_or(0),
            burned: v["burned"] == true,
        }
    }

    /// The first receipt that ran on `account`: the call itself.
    pub fn call_receipt(&self, account: &AccountId) -> &Rcpt {
        self.receipts.iter().find(|r| r.executor == account.as_str()).expect("a receipt ran on the vault")
    }

    pub fn receipt_with_log(&self, needle: &str) -> Option<&Rcpt> {
        self.receipts.iter().find(|r| r.logs.iter().any(|l| l.contains(needle)))
    }

    pub fn delete_height(&self) -> Option<u64> {
        self.receipts.iter().find(|r| r.delete_key).map(|r| r.height)
    }

    pub fn last_height(&self) -> u64 {
        self.receipts.iter().map(|r| r.height).max().unwrap_or(self.tx_height)
    }

    /// Every `EVENT_JSON:` log of the transaction, parsed.
    pub fn events(&self) -> Vec<Value> {
        self.receipts
            .iter()
            .flat_map(|r| r.logs.iter())
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .filter_map(|j| serde_json::from_str(j).ok())
            .collect()
    }

    pub fn events_named(&self, name: &str) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["event"] == name).collect()
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------------------------------------------

/// A daily key as the vault knows it: secret, public text, and an account handle that signs with it.
pub struct Daily {
    pub sk: SecretKey,
    pub pk: String,
    pub acct: Account,
}

pub struct Rig {
    pub f: Fixture,
    pub vid: AccountId,
}

impl Rig {
    /// A fresh vault (1 NEAR / 24 h cap, 24 h delay, 3 strikes, pending limit 10 NEAR). `allowlist_on` keeps the
    /// fixture's enforced allowlist (only `f.payee` is listed); false turns it off, the default of the contract.
    pub async fn new(allowlist_on: bool) -> Self {
        let f = Fixture::new().await;
        if !allowlist_on {
            f.admin("enforce_allowlist", json!({ "on": false })).await;
        }
        let vid = f.vault_id().clone();
        Self { f, vid }
    }

    pub fn rpc(&self) -> &Rpc {
        &self.f.rpc
    }

    /// An account's balance once the gas refunds of the calls so far have landed. A call that prepays gas takes the
    /// prepaid amount at once and gets the unused part back a few blocks later (a 300 Tgas admin call holds about 1 NEAR
    /// in this sandbox for a moment), so a balance read right after a call is low by that much.
    pub async fn settled_balance(&self, account: &AccountId) -> u128 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        self.f.rpc.balance(account).await
    }

    pub async fn add_daily(&self, allowance: Option<NearToken>) -> Daily {
        let (sk, pk) = new_key();
        self.f.add_daily_key(&pk, allowance).await;
        let acct = self.f.daily(&sk);
        Daily { sk, pk, acct }
    }

    /// A call signed by a daily key, waited for until final, read off the chain.
    pub async fn call_as(&self, key: &Daily, method: &str, args: Value, tgas: u64) -> Facts {
        let r = key
            .acct
            .call(&self.vid, method)
            .args_json(args)
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await
            .unwrap_or_else(|e| panic!("{method} as {}: {e}", key.pk));
        facts(&self.f.rpc, &r.outcome().transaction_hash.to_string(), &self.vid).await
    }

    pub async fn send_small(&self, key: &Daily, to: &AccountId, amount: u128) -> Facts {
        self.call_as(key, "send_small", json!({ "token": null, "amount": amount.to_string(), "to": to }), 50).await
    }

    pub async fn request(&self, key: &Daily, token: Option<&AccountId>, amount: u128, to: &AccountId) -> Facts {
        self.call_as(key, "request_withdraw", json!({ "token": token, "amount": amount.to_string(), "to": to }), 30).await
    }

    /// An admin call (the vault's own full-access key), read off the chain.
    pub async fn admin_tx(&self, method: &str, args: Value) -> Facts {
        let r = self.f.vault.call(method).args_json(args).max_gas().transact().await.unwrap_or_else(|e| panic!("admin {method}: {e}"));
        facts(&self.f.rpc, &r.outcome().transaction_hash.to_string(), &self.vid).await
    }

    /// A call by anyone (`execute`, `purge_expired`).
    pub async fn anyone_tx(&self, who: &Account, method: &str, args: Value, tgas: u64) -> Facts {
        let r = who.call(&self.vid, method).args_json(args).gas(Gas::from_tgas(tgas)).transact().await.unwrap_or_else(|e| panic!("{method}: {e}"));
        facts(&self.f.rpc, &r.outcome().transaction_hash.to_string(), who.id()).await
    }

    pub async fn view(&self, method: &str, args: Value) -> Value {
        self.f.rpc.view(&self.vid, method, args).await
    }

    pub async fn strikes(&self, pk: &str) -> u64 {
        self.view("strikes_of", json!({ "public_key": pk })).await.as_u64().expect("strikes")
    }

    pub async fn queue(&self) -> Vec<Value> {
        self.view("queue", json!({})).await.as_array().expect("queue").clone()
    }

    /// The loss bound's two terms for NEAR as the vault is configured (LOSS-BOUND.md): the 24 h cap C and the pending limit P,
    /// read from its own `config` view, added to a result so every attack states its loss next to C + P.
    pub async fn with_bound(&self, mut measured: Value) -> Value {
        let cfg = self.view("config", json!({})).await;
        let c: u128 = cfg["daily_limit"].as_str().expect("daily_limit").parse().expect("number");
        let p: u128 = cfg["pending_limit"].as_str().expect("pending_limit").parse().expect("number");
        measured["bound"] = json!({
            "C_cap_yocto": c.to_string(), "P_pending_limit_yocto": p.to_string(), "C_plus_P_yocto": (c + p).to_string(),
            "delay_secs": cfg["delay_secs"], "max_strikes": cfg["max_strikes"],
        });
        measured
    }

    pub async fn spent_24h(&self) -> u128 {
        self.view("spent_24h", json!({ "token": null })).await.as_str().expect("spent").parse().expect("number")
    }

    /// `check` as the hijacked key would call it.
    pub async fn check(&self, pk: &str, token: Option<&AccountId>, amount: u128, to: &AccountId) -> Value {
        self.view("check", json!({ "key": pk, "asset": token, "amount": amount.to_string(), "to": to })).await
    }

    pub async fn on_account(&self, pk: &str) -> bool {
        self.f.rpc.access_key(&self.vid, pk).await.is_some()
    }

    /// Raw signer for a daily key, starting from the nonce the chain holds now.
    pub async fn signer(&self, key: &Daily) -> KeySigner {
        let nonce = self.f.rpc.access_key(&self.vid, &key.pk).await.expect("key on the account")["nonce"].as_u64().expect("nonce");
        KeySigner::new(&self.vid, &key.sk, nonce)
    }

    /// Signs `calls` with one key without sending them: (method, args, tgas).
    pub async fn sign_calls(&self, signer: &mut KeySigner, calls: &[(&str, Value, u64)]) -> Vec<SignedCall> {
        let (_, bh) = self.f.rpc.head("final").await;
        calls.iter().map(|(m, a, g)| signer.call(&self.vid, m, a, *g, &bh)).collect()
    }
}

/// Sends already signed transactions one after the other without waiting for any of them.
pub async fn send_all(rpc: &Rpc, txs: &[SignedCall]) {
    for t in txs {
        rpc.send(t).await.unwrap_or_else(|e| panic!("node refused {}: {e}", t.method));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------------------------------------------

/// Height and timestamp (ns) of the optimistic head.
pub async fn head_info(rpc: &Rpc) -> (u64, u64) {
    let r = rpc.call("block", json!({ "finality": "optimistic" })).await.expect("block");
    (r["header"]["height"].as_u64().expect("height"), u64_of(&r["header"]["timestamp"]))
}

pub async fn gas_price(rpc: &Rpc) -> u128 {
    let r = rpc.call("gas_price", json!([null])).await.expect("gas_price");
    u128_of(&r["gas_price"])
}

pub async fn node_version(rpc: &Rpc) -> Value {
    let s = rpc.call("status", json!([])).await.expect("status");
    json!({ "nearcore": s["version"]["version"], "protocol": s["protocol_version"] })
}

/// Allowance (yoctoNEAR) left on a function-call key, `None` if the key is not on the account or has none (null).
pub async fn allowance_of(rpc: &Rpc, account: &AccountId, pk: &str) -> Option<u128> {
    let k = rpc.access_key(account, pk).await?;
    k["permission"]["FunctionCall"]["allowance"].as_str().and_then(|s| s.parse().ok())
}

/// Whether the account held the key in the state AFTER the given block.
pub async fn key_present_at(rpc: &Rpc, account: &AccountId, pk: &str, height: u64) -> bool {
    match rpc
        .call("query", json!({ "request_type": "view_access_key", "block_id": height, "account_id": account, "public_key": pk }))
        .await
    {
        Ok(r) if r.get("error").is_none() => true,
        Ok(_) => false,
        Err(e) if e.to_string().contains("UNKNOWN_ACCESS_KEY") || e.to_string().contains("does not exist") => false,
        Err(e) => panic!("view_access_key at {height}: {e}"),
    }
}

/// The largest total of `(timestamp ns, amount)` events that fall in any window (a, a + 24 h].
pub fn max_window(events: &[(u64, u128)]) -> u128 {
    let mut sorted = events.to_vec();
    sorted.sort();
    (0..sorted.len())
        .map(|i| sorted[i..].iter().take_while(|(t, _)| *t - sorted[i].0 < DAY_NS).map(|(_, a)| a).sum::<u128>())
        .max()
        .unwrap_or(0)
}

pub fn ms_between(from_ns: u64, to_ns: u64) -> u64 {
    to_ns.saturating_sub(from_ns) / 1_000_000
}

// ---------------------------------------------------------------------------------------------------------------
// Moving the chain clock (sandbox_fast_forward)
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug)]
pub struct Jump {
    pub blocks: u64,
    pub chain_seconds: u64,
    pub wall_seconds: u64,
}

/// Fast-forwards the sandbox until the head's timestamp is at least `target_ts`. Measured on nearcore 2.14.0: the node
/// advances the block timestamp by roughly 0.3 s per skipped block and works through about 120 blocks per second, so a
/// day of chain time costs about 40 minutes of wall time. Done in chunks of at most 20,000 blocks so progress shows.
pub async fn jump_clock_to(rpc: &Rpc, target_ts: u64) -> Jump {
    let started = Instant::now();
    let (h0, t0) = head_info(rpc).await;
    let mut ns_per_block: u64 = 297_000_000;
    loop {
        let (h, t) = head_info(rpc).await;
        if t >= target_ts {
            return Jump { blocks: h - h0, chain_seconds: (t - t0) / 1_000_000_000, wall_seconds: started.elapsed().as_secs() };
        }
        let delta = ((target_ts - t) / ns_per_block + 1).min(20_000);
        rpc.call("sandbox_fast_forward", json!({ "delta_height": delta })).await.expect("sandbox_fast_forward");
        let (h2, t2) = head_info(rpc).await;
        if h2 > h {
            ns_per_block = ((t2 - t) / (h2 - h)).max(1);
        }
        println!(
            "  clock jump: +{} blocks, {} s of chain time left, {} s wall so far",
            h2 - h,
            target_ts.saturating_sub(t2) / 1_000_000_000,
            started.elapsed().as_secs()
        );
    }
}
