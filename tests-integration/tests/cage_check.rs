//! KAIGEN v3 milestone M4, gate E3 and attack 8 (docs/v3/ROADMAP.md, docs/v3/ARCHITECTURE.md 2.8 and section 7):
//! `cage-check` goes RED when a classical full-access key or a null-allowance function-call key is planted on a
//! deployed Mamori vault, and GREEN again once it is removed. The checker under test is the real one, the Node CLI
//! `jobs/src/bin.mjs cage-check`, run as a child process against the sandbox node over RPC; this file only plants and
//! removes keys (signed by the vault's own admin key) and reads the checker's `--json` verdict and exit code.
//!
//! The wasm under test must be a build with the `attest()` view (docs/v3/ATTEST-CHECK.md): every green run here also
//! needs the checker's two attest rows (ATTEST-1, ATTEST-2) green, and those read the contract's real `attest()` over
//! RPC and compare it with the account's keys and the vault's views. `a_v2_vault_without_attest_is_unchecked_not_green`
//! (needs `MAMORI_V2_WASM`, a build without `attest()`; skipped without it) shows what an old vault gets.
//!
//! Setup is the one of burn_key.rs (WSL sandbox via tests-integration/sandbox/start.ps1, the two KAIGEN_SANDBOX
//! variables, MAMORI_WASM), plus `node` on PATH. Run from tests-integration/: `cargo test --test cage_check -- --test-threads=1 --nocapture`.
//!
//! The sandbox vault's admin is an ed25519 full-access key standing in for the ML-DSA admin of production, so every
//! run that is meant to be green passes `--stand-in-admin <that key>`. The checker marks such a result "not a
//! production result". `the_detector_reads_the_real_account...` runs the same GREEN account without the flag and shows
//! it red, so the green runs are not a checker that cannot fail.

mod common;

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use common::*;
use near_workspaces::types::{AccessKey, NearToken};
use serde_json::{json, Value};

const ARCH_1: &str = "ARCH-2.8-1";
const ARCH_2: &str = "ARCH-2.8-2";
const ARCH_3: &str = "ARCH-2.8-3";
const ARCH_4: &str = "ARCH-2.8-4";
const ARCH_5: &str = "ARCH-2.8-5";
const ARCH_6: &str = "ARCH-2.8-6";
const ARCH_7: &str = "ARCH-2.8-7";
/// The two rows attest() brings (not in the ARCHITECTURE.md 2.8 table): it agrees with the chain, and a production build.
const ATTEST_1: &str = "ATTEST-1";
const ATTEST_2: &str = "ATTEST-2";

/// What one run of the checker said.
struct Cage {
    exit: i32,
    verdict: Value,
}

impl Cage {
    fn conditions(&self) -> &Vec<Value> {
        self.verdict["conditions"].as_array().expect("conditions")
    }

    fn with_status(&self, status: &str) -> Vec<String> {
        self.conditions().iter().filter(|c| c["status"] == status).map(|c| c["id"].as_str().unwrap().to_string()).collect()
    }

    fn red(&self) -> Vec<String> {
        self.with_status("RED")
    }

    fn condition(&self, id: &str) -> &Value {
        self.conditions().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no condition {id}"))
    }

    fn offenders(&self, id: &str) -> Vec<String> {
        self.condition(id)["offenders"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect()
    }

    fn detail(&self, id: &str) -> String {
        self.condition(id)["detail"].as_str().unwrap().to_string()
    }
}

/// Runs the Node checker once against the final block of `account` and parses its `--json` verdict.
fn run_checker(rpc_addr: &str, account: &str, pin: &str, stand_in: Option<&str>) -> Cage {
    let jobs = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("jobs").join("src").join("bin.mjs");
    let mut cmd = Command::new("node");
    cmd.arg(&jobs).args(["cage-check", account, "--rpc", rpc_addr, "--code-hash", pin, "--json"]);
    if let Some(admin) = stand_in {
        cmd.args(["--stand-in-admin", admin]);
    }
    let out = cmd.output().unwrap_or_else(|e| panic!("cannot run node (is it on PATH?): {e}"));
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let verdict: Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("cage-check did not print JSON ({e}); exit {:?}\nstdout: {stdout}\nstderr: {}", out.status.code(), String::from_utf8_lossy(&out.stderr)));
    Cage { exit: out.status.code().expect("exit code"), verdict }
}

/// Everything a run needs: the vault fixture, the key the checker accepts as admin, the pinned code hash.
struct Rig {
    f: Fixture,
    admin: String,
    pin: String,
}

impl Rig {
    /// A vault with Mamori deployed and two daily keys added through `add_daily_key`, as in production.
    async fn new() -> Self {
        let f = Fixture::new().await;
        let admin = full_access_keys(&f).await.into_iter().next().expect("the admin key");
        for _ in 0..2 {
            let (_, pk) = new_key();
            f.add_daily_key(&pk, None).await;
        }
        // The pin is computed here from the wasm bytes, independently of the checker's own hashing (sha256, base58).
        let pin = near_primitives::hash::hash(&mamori_wasm()).to_string();
        Self { f, admin, pin }
    }

    /// Runs the checker once, against the final block. `stand_in` accepts the sandbox's ed25519 admin as the admin.
    fn check(&self, stand_in: bool) -> Cage {
        run_checker(&self.f.worker.rpc_addr(), self.f.vault_id().as_str(), &self.pin, stand_in.then_some(self.admin.as_str()))
    }

    /// Waits until the final head has caught up with the optimistic one, so the checker (which reads the final
    /// block) sees every transaction already confirmed here. One run then answers for the state under test.
    async fn settle(&self) {
        let (head, _) = self.f.rpc.head("optimistic").await;
        wait_for("the final block to reach the optimistic head", Duration::from_secs(15), || async {
            (self.f.rpc.head("final").await.0 >= head).then_some(())
        })
        .await;
    }

    /// The admin (the vault's own full-access key) adds a key straight to the account, bypassing the contract.
    async fn plant(&self, sk: &near_workspaces::types::SecretKey, access: AccessKey) {
        let r = self.f.vault.batch().add_key(sk.public_key(), access).transact().await.expect("add_key tx");
        assert!(r.is_success(), "AddKey failed: {:?}", r.failures());
        assert!(self.f.rpc.access_key(self.f.vault_id(), &sk.public_key().to_string()).await.is_some(), "the planted key is on the account");
    }

    async fn remove(&self, sk: &near_workspaces::types::SecretKey) {
        let r = self.f.vault.batch().delete_key(sk.public_key()).transact().await.expect("delete_key tx");
        assert!(r.is_success(), "DeleteKey failed: {:?}", r.failures());
        assert!(self.f.rpc.access_key(self.f.vault_id(), &sk.public_key().to_string()).await.is_none(), "the planted key is gone");
    }
}

/// Public keys of the account's full-access keys at the optimistic head.
async fn full_access_keys(f: &Fixture) -> Vec<String> {
    f.rpc.access_keys(f.vault_id()).await.into_iter().filter(|(_, p)| p["permission"] == "FullAccess").map(|(k, _)| k).collect()
}

fn assert_green(c: &Cage, what: &str) {
    assert_eq!(c.exit, 0, "{what}: expected exit 0, got {}: {}", c.exit, c.verdict);
    assert_eq!(c.verdict["verdict"], "GREEN", "{what}: {}", c.verdict);
    assert_eq!(c.conditions().len(), 10, "{what}: the eight conditions of ARCHITECTURE.md 2.8 and the two attest rows ran");
    assert!(c.red().is_empty() && c.with_status("UNKNOWN").is_empty(), "{what}: {}", c.verdict);
    assert_attest_read(c, what);
    // Nothing disagrees at all: attest() matches the views and the account's keys.
    assert_eq!(c.verdict["info"]["attest_cross_check"], "agree", "{what}: {}", c.verdict);
}

/// The checker read the contract's real `attest()` and found it equal to the vault's own views, with ATTEST-2 green: true
/// of a green run and of a run red only because of a planted key (the cross-check status then says "disagree" about the
/// chain, which is the point), and not true of a vault without `attest()`.
fn assert_attest_read(c: &Cage, what: &str) {
    assert_eq!(c.verdict["info"]["attest"], "present", "{what}: attest() was read: {}", c.verdict);
    for id in [ATTEST_1, ATTEST_2] {
        assert_eq!(c.condition(id)["status"], "GREEN", "{what}: {id}: {}", c.condition(id));
    }
}

fn assert_red(c: &Cage, expected: &[&str], what: &str) {
    assert_eq!(c.exit, 1, "{what}: any red is exit 1, got {}: {}", c.exit, c.verdict);
    assert_eq!(c.verdict["verdict"], "RED", "{what}");
    assert_eq!(c.red(), expected.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{what}: exactly these conditions are red: {}", c.verdict);
    assert!(c.with_status("UNKNOWN").is_empty(), "{what}: nothing is left unchecked: {}", c.verdict);
    // A planted key is a fact about the account, not about the vault's books: the real attest() still agrees with the views.
    assert_attest_read(c, what);
}

/// Attack 8 and gate E3. The account is checked clean, an ed25519 full-access key is planted (red), removed (green), a
/// null-allowance function-call key is planted (red), removed (green).
#[tokio::test]
async fn attack_8_planted_ed25519_full_access_key_and_null_allowance_key_go_red_then_green() {
    let t = Rig::new().await;
    let vid = t.f.vault_id().clone();

    // The cage as deployed: the admin, two recorded daily keys with 0.25 NEAR each, the pinned code.
    t.settle().await;
    let clean = t.check(true);
    assert_green(&clean, "clean cage");
    assert_eq!(clean.verdict["mode"], "sandbox-stand-in-admin", "the sandbox run says it is not a production result");
    assert_eq!(clean.verdict["info"]["daily_keys"].as_array().unwrap().len(), 2);
    // Values that only the contract's real attest() holds (the fixture enforces the allowlist and inits with a 24 h delay).
    assert_eq!(clean.verdict["info"]["allowlist_enforced"], true);
    let attest = t.f.rpc.view(&vid, "attest", json!({})).await;
    assert_eq!((attest["contract"].clone(), attest["attest_version"].clone(), attest["drill_build"].clone()), (json!("mamori"), json!(1), json!(false)));
    println!("real attest() on the sandbox: {attest}");
    let raw_hash = t.f.rpc.call("query", json!({ "request_type": "view_account", "finality": "final", "account_id": vid })).await.unwrap()["code_hash"].clone();
    assert_eq!(raw_hash, json!(t.pin), "the pin is the hash the node reports for the deployed wasm");

    // 1. Plant an ed25519 full-access key.
    let (sk1, pk1) = new_key();
    t.plant(&sk1, AccessKey::full_access()).await;
    t.settle().await;
    let planted = t.check(true);
    assert_red(&planted, &[ARCH_1], "ed25519 full-access key planted");
    assert_eq!(planted.offenders(ARCH_1), vec![pk1.clone()], "the checker names the planted key");
    println!("planted ed25519 full-access key {pk1}: exit {}, red {:?}", planted.exit, planted.red());

    t.remove(&sk1).await;
    t.settle().await;
    assert_green(&t.check(true), "after the planted full-access key was removed");

    // 2. Plant a function-call key with a null (unlimited) allowance, scoped like a daily key and added outside the contract.
    let (sk2, pk2) = new_key();
    t.plant(&sk2, AccessKey::function_call_access(&vid, &["send_small", "request_withdraw"], None)).await;
    let on_chain = t.f.rpc.access_key(&vid, &pk2).await.expect("planted key");
    assert_eq!(on_chain["permission"]["FunctionCall"]["allowance"], Value::Null, "the node lists the planted key's allowance as null (unlimited)");
    t.settle().await;
    let null_key = t.check(true);
    assert_red(&null_key, &[ARCH_3, ARCH_6], "null-allowance function-call key planted");
    assert_eq!(null_key.offenders(ARCH_3).len(), 1);
    assert!(null_key.offenders(ARCH_3)[0].starts_with(&pk2), "the checker names the null-allowance key");
    assert_eq!(null_key.offenders(ARCH_6), vec![pk2.clone()], "it is also not recorded by the vault, since the contract never added it");
    assert!(
        null_key.detail(ARCH_6).contains("not in daily_keys()") && null_key.detail(ARCH_6).contains("not in attest().daily_keys"),
        "both the view and the real attest() say the vault does not record it: {}",
        null_key.detail(ARCH_6)
    );
    println!("planted null-allowance key {pk2}: exit {}, red {:?}", null_key.exit, null_key.red());

    t.remove(&sk2).await;
    t.settle().await;
    assert_green(&t.check(true), "after the null-allowance key was removed");
}

/// The green runs above are not a checker that cannot fail: the same clean account, judged as production (no stand-in
/// admin), is red, because its only full-access key is classical.
#[tokio::test]
async fn the_detector_reads_the_real_account_a_clean_cage_without_the_stand_in_flag_is_red() {
    let t = Rig::new().await;
    t.settle().await;
    assert_green(&t.check(true), "clean cage with the stand-in admin");
    let production = t.check(false);
    assert_red(&production, &[ARCH_1, ARCH_2], "classical admin judged as production");
    assert_eq!(production.verdict["mode"], "production");
    assert_eq!(production.offenders(ARCH_1), vec![t.admin.clone()]);
}

/// Rows 4 and 5 on the chain: a function-call key with no method list and another receiver, with a bounded allowance.
#[tokio::test]
async fn a_function_call_key_with_no_method_list_and_another_receiver_goes_red() {
    let t = Rig::new().await;
    let other = t.f.payee.id().clone();
    let (sk, pk) = new_key();
    t.plant(&sk, AccessKey::function_call_access(&other, &[], Some(NearToken::from_millinear(250)))).await;
    t.settle().await;
    let c = t.check(true);
    assert_red(&c, &[ARCH_4, ARCH_5, ARCH_6], "scope-escape key planted");
    assert_eq!(c.offenders(ARCH_4), vec![pk.clone()]);
    t.remove(&sk).await;
    t.settle().await;
    assert_green(&t.check(true), "after the scope-escape key was removed");
}

/// The false-positive side: a key Mamori burned itself must not leave the cage red once its DeleteKey has landed.
#[tokio::test]
async fn a_key_the_vault_burned_itself_does_not_leave_the_cage_red() {
    let t = Rig::new().await;
    let vid = t.f.vault_id().clone();
    let (sk, pk) = new_key();
    t.f.add_daily_key(&pk, None).await;
    t.settle().await;
    let before = t.check(true);
    assert_green(&before, "three recorded daily keys");
    assert_eq!(before.verdict["info"]["daily_keys"].as_array().unwrap().len(), 3);

    let key = t.f.daily(&sk);
    for _ in 0..2 {
        assert_eq!(t.f.strike(&key).await["burned"], false);
    }
    assert_eq!(t.f.strike(&key).await["burned"], true);
    wait_for("burned key deleted from the account", Duration::from_secs(10), || async { t.f.rpc.access_key(&vid, &pk).await.is_none().then_some(()) }).await;
    wait_for("revoked ledger empty", Duration::from_secs(10), || async {
        (t.f.rpc.view(&vid, "revoked_keys", json!({})).await == json!([])).then_some(())
    })
    .await;
    t.settle().await;
    let after = t.check(true);
    assert_green(&after, "after the burn and its confirmation");
    assert_eq!(after.verdict["info"]["daily_keys"].as_array().unwrap().len(), 2, "the burned key is no longer recorded");
}

/// Row 7 through the real attest(): a key the admin registered for intents.near is recorded by the vault and signs there
/// with no Mamori cap. The sandbox has no intents.near, so the promise to it fails after the vault has recorded the key;
/// the record stays (there is no unregister call outside lock-down), so this test goes red and does not go green again.
#[tokio::test]
async fn a_recorded_intents_key_goes_red_through_the_real_attest() {
    let t = Rig::new().await;
    let vid = t.f.vault_id().clone();
    t.settle().await;
    assert_green(&t.check(true), "before the intents key");

    let (_, pk) = new_key();
    // The call as a whole ends in the failed promise to the absent intents.near, so its result is not asserted on.
    let _ = t.f.vault.call("register_intents_key").args_json(json!({ "public_key": pk })).max_gas().transact().await.expect("register_intents_key tx");
    wait_for("the intents key to be recorded", Duration::from_secs(10), || async {
        (t.f.rpc.view(&vid, "intents_keys", json!({})).await == json!([pk])).then_some(())
    })
    .await;
    let attest = t.f.rpc.view(&vid, "attest", json!({})).await;
    assert_eq!(attest["intents_keys"], json!([pk]), "the real attest() lists it too");
    t.settle().await;
    let c = t.check(true);
    assert_red(&c, &[ARCH_7], "intents key recorded");
    assert_eq!(c.offenders(ARCH_7), vec![pk.clone()]);
    assert!(c.detail(ARCH_7).contains("attest().intents_keys records"), "the attest() copy is named: {}", c.detail(ARCH_7));
    println!("recorded intents key {pk}: exit {}, red {:?}", c.exit, c.red());
}

type SandboxWorker = near_workspaces::Worker<near_workspaces::network::Sandbox>;

/// A vault of its own from `wasm`, inited with `delay_secs` (a production build refuses under 86 400, a drill build does
/// not), on the sandbox, settled so the checker (which reads the final block) sees it.
async fn deploy_vault(wasm: &[u8], delay_secs: u64) -> (SandboxWorker, Rpc, near_workspaces::Contract) {
    let worker = sandbox().await;
    let rpc = Rpc::new(worker.rpc_addr());
    let account = worker.dev_create_account().await.expect("vault account");
    let vault = account.deploy(wasm).await.expect("deploy").into_result().expect("deploy result");
    let kizashi = format!("kizashi.{}", worker.root_account().expect("root account").id());
    vault
        .call("init")
        .args_json(json!({ "kizashi": kizashi, "daily_limit": (NEAR).to_string(), "delay_secs": delay_secs }))
        .transact()
        .await
        .expect("init tx")
        .into_result()
        .expect("init");
    let (head, _) = rpc.head("optimistic").await;
    wait_for("the final block to reach the optimistic head", Duration::from_secs(15), || async { (rpc.head("final").await.0 >= head).then_some(()) }).await;
    (worker, rpc, vault)
}

/// The wasm named by the environment variable `var`, or None after saying the test is skipped.
fn wasm_from_env(var: &str) -> Option<Vec<u8>> {
    match std::env::var(var) {
        Ok(path) => Some(std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {var} {path}: {e}"))),
        Err(_) => {
            println!("skipped: {var} is not set");
            None
        }
    }
}

/// The checker against a vault from `deploy_vault`, with its own full-access key as the stand-in admin and the hash of `wasm` as the pin.
async fn check_deployed(worker: &SandboxWorker, rpc: &Rpc, vault: &near_workspaces::Contract, wasm: &[u8]) -> Cage {
    let admin = rpc.access_keys(vault.id()).await.into_iter().find(|(_, p)| p["permission"] == "FullAccess").expect("the admin key").0;
    let pin = near_primitives::hash::hash(wasm).to_string();
    run_checker(&worker.rpc_addr(), vault.id().as_str(), &pin, Some(&admin))
}

/// An old (v2) vault has no `attest()`: the two attest rows cannot be checked, so the verdict is UNKNOWN and the exit
/// code 3, never green, while the eight rows still judge it. Needs `MAMORI_V2_WASM` = a build without `attest()` (for
/// example the pre-attest build in D:\HACK-Projects\toolchain\m1-wasm); skipped without it.
#[tokio::test]
async fn a_v2_vault_without_attest_is_unchecked_not_green() {
    let Some(wasm) = wasm_from_env("MAMORI_V2_WASM") else { return };
    let (worker, rpc, vault) = deploy_vault(&wasm, 86_400).await;
    assert!(rpc.view_if_present(vault.id(), "attest", json!({})).await.is_none(), "the build in MAMORI_V2_WASM has no attest()");

    let c = check_deployed(&worker, &rpc, &vault, &wasm).await;
    assert_eq!(c.exit, 3, "unchecked is exit 3, not 0: {}", c.verdict);
    assert_eq!(c.verdict["verdict"], "UNKNOWN");
    assert!(c.red().is_empty(), "{}", c.verdict);
    assert_eq!(c.with_status("UNKNOWN"), vec![ATTEST_1.to_string(), ATTEST_2.to_string()], "{}", c.verdict);
    assert_eq!(c.with_status("GREEN").len(), 8, "the eight rows of ARCHITECTURE.md 2.8 are still judged and green: {}", c.verdict);
    assert_eq!((c.verdict["info"]["attest"].clone(), c.verdict["info"]["attest_cross_check"].clone()), (json!("absent"), json!("absent")));
    println!("v2 vault without attest(): exit {}, unknown {:?}", c.exit, c.with_status("UNKNOWN"));
}

/// ATTEST-2 on a real node: a `drill` build (delay floor off) inited with a one-hour delay does not keep the loss bound's
/// delay condition, so the checker is red on that row and on no other; the rest of the cage is clean and the real
/// attest() agrees with the vault's views. Needs `MAMORI_DRILL_WASM` = a build with `--features drill`; skipped without it.
#[tokio::test]
async fn a_drill_build_with_a_short_delay_is_red_on_the_production_row() {
    let Some(wasm) = wasm_from_env("MAMORI_DRILL_WASM") else { return };
    let (worker, rpc, vault) = deploy_vault(&wasm, 3_600).await;
    let attest = rpc.view(vault.id(), "attest", json!({})).await;
    assert_eq!((attest["drill_build"].clone(), attest["config"]["delay_secs"].clone()), (json!(true), json!(3_600)), "{attest}");

    let c = check_deployed(&worker, &rpc, &vault, &wasm).await;
    assert_eq!(c.exit, 1, "{}", c.verdict);
    assert_eq!(c.red(), vec![ATTEST_2.to_string()], "{}", c.verdict);
    assert!(c.with_status("UNKNOWN").is_empty(), "{}", c.verdict);
    assert_eq!(c.condition(ATTEST_1)["status"], "GREEN", "the real attest() agrees with the views: {}", c.verdict);
    assert_eq!(c.offenders(ATTEST_2), vec!["drill_build".to_string(), "config.delay_secs".to_string()]);
    println!("drill build, delay 3600: exit {}, red {:?}: {}", c.exit, c.red(), c.detail(ATTEST_2));
}
