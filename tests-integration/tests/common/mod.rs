//! Shared helpers for the M1 tests: sandbox connection, raw JSON-RPC, signed transactions, the Mamori fixture.
//!
//! Raw JSON-RPC is used wherever the test must see the chain at optimistic head, one block at a time, or send a
//! transaction without waiting for it. near-workspaces' own views read final blocks and its transactions wait.

#![allow(dead_code)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// 0.01 NEAR: above Mamori's default minimum send (0.001) and far below the 1 NEAR / 24 h cap.
pub const SEND: u128 = NEAR / 100;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The sandbox: an already running node when `KAIGEN_SANDBOX_RPC` is set (Windows + WSL, see
/// tests-integration/sandbox/start.ps1), otherwise a node spawned by near-workspaces (Linux or macOS).
pub async fn sandbox() -> Worker<Sandbox> {
    match std::env::var("KAIGEN_SANDBOX_RPC") {
        Ok(rpc) => {
            let key_file = std::env::var("KAIGEN_SANDBOX_KEY_FILE")
                .expect("KAIGEN_SANDBOX_KEY_FILE must point at the node's validator_key.json");
            let text = std::fs::read_to_string(&key_file).unwrap_or_else(|e| panic!("cannot read {key_file}: {e}"));
            let v: Value = serde_json::from_str(&text).expect("validator_key.json is not JSON");
            let id: AccountId = v["account_id"].as_str().expect("account_id").parse().expect("account id");
            let sk: SecretKey = v["secret_key"].as_str().expect("secret_key").parse().expect("secret key");
            near_workspaces::sandbox()
                .rpc_addr(&rpc)
                .validator_key(ValidatorKey::Known(id, sk))
                .await
                .expect("cannot attach to the sandbox node")
        }
        Err(_) => near_workspaces::sandbox().await.expect("cannot start a local sandbox node"),
    }
}

/// The Mamori wasm under test: `MAMORI_WASM`, else the release build of the working tree.
pub fn mamori_wasm() -> Vec<u8> {
    let path = std::env::var("MAMORI_WASM").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/wasm32-unknown-unknown/release/mamori.wasm")
    });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read the mamori wasm at {}: {e}\nbuild it: cargo build --release --target wasm32-unknown-unknown -p mamori",
            path.display()
        )
    })
}

/// Minimal JSON-RPC client against the node.
#[derive(Clone)]
pub struct Rpc {
    http: reqwest::Client,
    url: String,
}

impl Rpc {
    pub fn new(url: String) -> Self {
        Self { http: reqwest::Client::new(), url }
    }

    /// `Ok(result)`, or `Err(error object)` for a JSON-RPC error.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        let body = json!({ "jsonrpc": "2.0", "id": "m1", "method": method, "params": params });
        let resp: Value = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .unwrap_or_else(|e| panic!("rpc {method}: transport error {e}"))
            .json()
            .await
            .unwrap_or_else(|e| panic!("rpc {method}: bad JSON {e}"));
        match resp.get("error") {
            Some(e) => Err(e.clone()),
            None => Ok(resp["result"].clone()),
        }
    }

    /// Height and hash of the optimistic head, or of the final block.
    pub async fn head(&self, finality: &str) -> (u64, String) {
        let r = self.call("block", json!({ "finality": finality })).await.expect("block");
        (r["header"]["height"].as_u64().expect("height"), r["header"]["hash"].as_str().expect("hash").to_string())
    }

    pub async fn height_of_block_hash(&self, hash: &str) -> u64 {
        let r = self.call("block", json!({ "block_id": hash })).await.expect("block by hash");
        r["header"]["height"].as_u64().expect("height")
    }

    /// Every access key of the account at the optimistic head: (public key, permission JSON).
    pub async fn access_keys(&self, account: &AccountId) -> Vec<(String, Value)> {
        let r = self
            .call(
                "query",
                json!({ "request_type": "view_access_key_list", "finality": "optimistic", "account_id": account }),
            )
            .await
            .expect("view_access_key_list");
        r["keys"]
            .as_array()
            .expect("keys")
            .iter()
            .map(|k| (k["public_key"].as_str().expect("pk").to_string(), k["access_key"].clone()))
            .collect()
    }

    /// One access key at the optimistic head, or `None` when the account does not hold it.
    pub async fn access_key(&self, account: &AccountId, public_key: &str) -> Option<Value> {
        match self
            .call(
                "query",
                json!({ "request_type": "view_access_key", "finality": "optimistic",
                        "account_id": account, "public_key": public_key }),
            )
            .await
        {
            Ok(r) if r.get("error").is_none() => Some(r),
            Ok(_) => None,
            Err(e) if e.to_string().contains("UNKNOWN_ACCESS_KEY") || e.to_string().contains("does not exist") => None,
            Err(e) => panic!("view_access_key: {e}"),
        }
    }

    /// A view call at the optimistic head, result parsed as JSON.
    pub async fn view(&self, account: &AccountId, method: &str, args: Value) -> Value {
        let r = self
            .call(
                "query",
                json!({ "request_type": "call_function", "finality": "optimistic", "account_id": account,
                        "method_name": method, "args_base64": B64.encode(args.to_string()) }),
            )
            .await
            .unwrap_or_else(|e| panic!("view {method}: {e}"));
        if let Some(err) = r.get("error") {
            panic!("view {method}: {err}");
        }
        let bytes: Vec<u8> = r["result"].as_array().expect("result bytes").iter().map(|b| b.as_u64().unwrap() as u8).collect();
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("view {method}: result is not JSON: {e}"))
    }

    /// Like `view`, but `None` when the deployed code has no such method (the v2 production build has no
    /// `revoked_keys`). Any other failure still panics.
    pub async fn view_if_present(&self, account: &AccountId, method: &str, args: Value) -> Option<Value> {
        let r = self
            .call(
                "query",
                json!({ "request_type": "call_function", "finality": "optimistic", "account_id": account,
                        "method_name": method, "args_base64": B64.encode(args.to_string()) }),
            )
            .await
            .unwrap_or_else(|e| panic!("view {method}: {e}"));
        if let Some(err) = r.get("error") {
            if err.to_string().contains("MethodNotFound") {
                return None;
            }
            panic!("view {method}: {err}");
        }
        Some(self.view(account, method, args).await)
    }

    pub async fn balance(&self, account: &AccountId) -> u128 {
        let r = self
            .call("query", json!({ "request_type": "view_account", "finality": "optimistic", "account_id": account }))
            .await
            .expect("view_account");
        r["amount"].as_str().expect("amount").parse().expect("amount number")
    }
}

/// Signs function-call transactions for one access key with a locally counted nonce, so many can be sent
/// without waiting for any of them.
pub struct KeySigner {
    account: AccountId,
    signer: near_crypto::Signer,
    nonce: u64,
}

impl KeySigner {
    /// `nonce` is the key's current on-chain nonce; the first transaction uses `nonce + 1`.
    pub fn new(account: &AccountId, secret_key: &SecretKey, nonce: u64) -> Self {
        let sk: near_crypto::SecretKey = secret_key.to_string().parse().expect("secret key text");
        Self { account: account.clone(), signer: near_crypto::InMemorySigner::from_secret_key(account.clone(), sk), nonce }
    }

    /// A call to `receiver.method(args)` with `tgas` of prepaid gas and no deposit.
    pub fn call(&mut self, receiver: &AccountId, method: &str, args: &Value, tgas: u64, block_hash: &str) -> SignedCall {
        use near_primitives::transaction::{Action, FunctionCallAction, SignedTransaction};
        self.nonce += 1;
        let action = Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: method.to_string(),
            args: args.to_string().into_bytes(),
            gas: near_primitives::types::Gas::from_gas(tgas * 1_000_000_000_000),
            deposit: near_primitives::types::Balance::from_yoctonear(0),
        }));
        let tx = SignedTransaction::from_actions(
            self.nonce,
            self.account.clone(),
            receiver.clone(),
            &self.signer,
            vec![action],
            block_hash.parse().expect("block hash"),
        );
        SignedCall {
            hash: tx.get_hash().to_string(),
            base64: B64.encode(borsh::to_vec(&tx).expect("borsh")),
            nonce: self.nonce,
            method: method.to_string(),
        }
    }
}

pub struct SignedCall {
    pub hash: String,
    pub base64: String,
    pub nonce: u64,
    pub method: String,
}

impl Rpc {
    /// Sends a signed transaction without waiting for execution (`wait_until: NONE`). `Err` is the node's
    /// synchronous rejection (for example the signing key no longer exists on the account).
    pub async fn send(&self, tx: &SignedCall) -> Result<(), Value> {
        self.send_wait(tx, "NONE").await.map(|_| ())
    }

    /// `send_tx` with an explicit `wait_until` level; returns the node's raw answer.
    pub async fn send_wait(&self, tx: &SignedCall, wait_until: &str) -> Result<Value, Value> {
        self.call("send_tx", json!({ "signed_tx_base64": tx.base64, "wait_until": wait_until })).await
    }

    /// The legacy `broadcast_tx_commit`: waits for the transaction to execute, or errors at once if it is invalid.
    pub async fn commit(&self, tx: &SignedCall) -> Result<Value, Value> {
        self.call("broadcast_tx_commit", json!([tx.base64])).await
    }

    /// What the chain recorded for a transaction, or the node's error (unknown or dropped transaction).
    pub async fn trace(&self, tx_hash: &str, sender: &AccountId, wait_until: &str) -> Result<Trace, Value> {
        let r = self
            .call("EXPERIMENTAL_tx_status", json!({ "tx_hash": tx_hash, "sender_account_id": sender, "wait_until": wait_until }))
            .await?;
        if r.get("transaction_outcome").is_none() {
            return Err(json!({ "no_outcome_yet": r["final_execution_status"] }));
        }
        let mut heights = std::collections::HashMap::new();
        let height_of = |hash: String| {
            let rpc = self.clone();
            async move { rpc.height_of_block_hash(&hash).await }
        };
        let tx_height = height_of(r["transaction_outcome"]["block_hash"].as_str().unwrap().to_string()).await;
        let delete_ids: Vec<String> = r["receipts"]
            .as_array()
            .map(|rs| {
                rs.iter()
                    .filter(|x| {
                        x["receipt"]["Action"]["actions"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|act| act.get("DeleteKey").is_some()))
                    })
                    .map(|x| x["receipt_id"].as_str().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let mut receipts = Vec::new();
        for o in r["receipts_outcome"].as_array().cloned().unwrap_or_default() {
            let hash = o["block_hash"].as_str().unwrap().to_string();
            let height = match heights.get(&hash) {
                Some(h) => *h,
                None => {
                    let h = height_of(hash.clone()).await;
                    heights.insert(hash, h);
                    h
                }
            };
            let id = o["id"].as_str().unwrap().to_string();
            receipts.push(ReceiptTrace {
                delete_key: delete_ids.contains(&id),
                id,
                executor: o["outcome"]["executor_id"].as_str().unwrap_or_default().to_string(),
                height,
                status: o["outcome"]["status"].clone(),
                logs: o["outcome"]["logs"].as_array().map(|l| l.iter().map(|s| s.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default(),
            });
        }
        Ok(Trace { status: r["status"].clone(), tx_height, receipts })
    }
}

/// Outcome of one transaction as the chain recorded it.
#[derive(Debug, Clone)]
pub struct Trace {
    /// Final status: `{"SuccessValue": "<base64>"}` or `{"Failure": ...}`.
    pub status: Value,
    /// Block that converted the transaction into its first receipt.
    pub tx_height: u64,
    pub receipts: Vec<ReceiptTrace>,
}

#[derive(Debug, Clone)]
pub struct ReceiptTrace {
    pub id: String,
    pub executor: String,
    /// Block in which the receipt executed.
    pub height: u64,
    pub status: Value,
    pub logs: Vec<String>,
    /// The receipt carries a DeleteKey action.
    pub delete_key: bool,
}

impl Trace {
    pub fn failed(&self) -> bool {
        self.status.get("Failure").is_some()
    }

    /// The JSON value the transaction returned, if it succeeded with one.
    pub fn value(&self) -> Option<Value> {
        let b64 = self.status.get("SuccessValue")?.as_str()?;
        serde_json::from_slice(&B64.decode(b64).ok()?).ok()
    }

    pub fn failure_text(&self) -> String {
        self.status.to_string()
    }

    /// The execution height of the DeleteKey receipt, if the transaction produced one.
    pub fn delete_key_height(&self) -> Option<u64> {
        self.receipts.iter().find(|r| r.delete_key).map(|r| r.height)
    }

    /// Execution height of the receipt that ran `method`'s callback after the delete (the last receipt).
    pub fn last_receipt_height(&self) -> u64 {
        self.receipts.iter().map(|r| r.height).max().unwrap_or(self.tx_height)
    }
}

/// Polls `check` every 50 ms until it returns `Some`, or panics after `timeout`.
pub async fn wait_for<T, F, Fut>(what: &str, timeout: Duration, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let start = Instant::now();
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(start.elapsed() < timeout, "timed out after {timeout:?} waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A freshly generated ed25519 key, as the near-workspaces type and the public key text.
pub fn new_key() -> (SecretKey, String) {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let pk = sk.public_key().to_string();
    (sk, pk)
}

/// Mamori deployed on its own throwaway sandbox account, plus a payee on its allowlist and an attacker that is not.
pub struct Fixture {
    pub worker: Worker<Sandbox>,
    pub rpc: Rpc,
    /// The vault account; its own full-access key is the admin (stands in for the ML-DSA key of production).
    pub vault: Contract,
    pub payee: Account,
    pub attacker: Account,
}

impl Fixture {
    /// Deploys Mamori, inits it (1 NEAR / 24 h cap, 24 h delay, a Kizashi account that is never called),
    /// enforces the allowlist and lists the payee.
    pub async fn new() -> Self {
        let worker = sandbox().await;
        let rpc = Rpc::new(worker.rpc_addr());
        let account = worker.dev_create_account().await.expect("vault account");
        let vault = account.deploy(&mamori_wasm()).await.expect("deploy").into_result().expect("deploy result");
        let payee = worker.dev_create_account().await.expect("payee account");
        let attacker = worker.dev_create_account().await.expect("attacker account");

        let kizashi = format!("kizashi.{}", worker.root_account().expect("root account").id());
        vault
            .call("init")
            .args_json(json!({ "kizashi": kizashi, "daily_limit": (NEAR).to_string(), "delay_secs": 86_400 }))
            .transact()
            .await
            .expect("init tx")
            .into_result()
            .expect("init");
        let f = Self { worker, rpc, vault, payee, attacker };
        f.admin("enforce_allowlist", json!({ "on": true })).await;
        f.admin("allow_recipient", json!({ "account": f.payee.id() })).await;
        f
    }

    pub fn vault_id(&self) -> &AccountId {
        self.vault.id()
    }

    /// An admin call: signed by the vault account's own full-access key, so predecessor == current account.
    pub async fn admin(&self, method: &str, args: Value) -> Vec<String> {
        let r = self
            .vault
            .call(method)
            .args_json(args)
            .max_gas()
            .transact()
            .await
            .unwrap_or_else(|e| panic!("admin {method}: {e}"));
        assert!(r.is_success(), "admin {method} failed: {:?}", r.failures());
        r.logs().iter().map(|s| s.to_string()).collect()
    }

    /// Adds a daily key (`None` is the contract's default allowance) and waits until it is on the account.
    pub async fn add_daily_key(&self, public_key: &str, allowance: Option<NearToken>) {
        let allowance = allowance.map(|a| a.as_yoctonear().to_string());
        self.admin("add_daily_key", json!({ "public_key": public_key, "allowance": allowance })).await;
        let id = self.vault_id().clone();
        wait_for("daily key on the account", Duration::from_secs(10), || async {
            self.rpc.access_key(&id, public_key).await.map(|_| ())
        })
        .await;
    }

    /// The vault account as signed by a daily key: calls made through it use that key.
    pub fn daily(&self, secret_key: &SecretKey) -> Account {
        Account::from_secret_key(self.vault_id().clone(), secret_key.clone(), &self.worker)
    }

    /// A refused `send_small` to the attacker (not on the allowlist): one counted strike. Returns the `SendOutcome`.
    pub async fn strike(&self, key: &Account) -> Value {
        let r = self.send_small(key, self.attacker.id(), SEND).await;
        assert!(r.is_success(), "a refusal is a normal return, not a failure: {:?}", r.failures());
        r.json::<Value>().expect("SendOutcome json")
    }

    /// `send_small` as the given daily key (50 Tgas prepaid, enough for the transfer and its callback).
    pub async fn send_small(&self, key: &Account, to: &AccountId, amount: u128) -> near_workspaces::result::ExecutionFinalResult {
        key.call(self.vault_id(), "send_small")
            .args_json(json!({ "token": null, "amount": amount.to_string(), "to": to }))
            .gas(near_workspaces::types::Gas::from_tgas(50))
            .transact()
            .await
            .expect("send_small transaction")
    }
}
