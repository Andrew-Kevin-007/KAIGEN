//! Attack 8 (ARCHITECTURE.md section 7, gate E3): a planted classical full-access key and a planted null-allowance
//! function-call key. Claim: cage-check goes red, then green after removal. The checker is the real Node CLI
//! (`jobs/src/bin.mjs cage-check`), run as a child process against the sandbox over RPC; this file plants and removes
//! the keys (signed by the vault's own admin key) and reads the checker's `--json` verdict and exit code.
//!
//! Which checker: `KAIGEN_CAGE_JOBS_BIN` if set, else the working tree's `jobs/src/bin.mjs`. The week-3 run used the
//! working tree's, which was the committed HEAD (1a12d57, with the attest() cross-check rows ATTEST-1 and ATTEST-2) because
//! the cage-check work had been committed by then. The vault's admin is ed25519, so every run that is meant to be green
//! passes `--stand-in-admin`; the checker then marks the result "not a production result". A last run without the flag
//! shows red, so the green runs are not a checker that cannot fail.
//!
//! Attack 8 needs `node` on PATH.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use near_workspaces::types::AccessKey;
use serde_json::{json, Value};

use crate::common::*;
use crate::support::*;

struct Cage {
    exit: i32,
    verdict: Value,
    wall_ms: u128,
}

impl Cage {
    fn conditions(&self) -> &Vec<Value> {
        self.verdict["conditions"].as_array().expect("conditions")
    }

    fn red(&self) -> Vec<String> {
        self.conditions().iter().filter(|c| c["status"] == "RED").map(|c| c["id"].as_str().unwrap().to_string()).collect()
    }

    fn has_all_eight_arch_rows(&self) -> bool {
        (1..=8).all(|n| self.conditions().iter().any(|c| c["id"] == format!("ARCH-2.8-{n}")))
    }

    fn unknown(&self) -> usize {
        self.conditions().iter().filter(|c| c["status"] == "UNKNOWN").count()
    }

    fn offenders(&self, id: &str) -> Vec<String> {
        let c = self.conditions().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no condition {id}"));
        c["offenders"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect()
    }

    fn block(&self) -> u64 {
        self.verdict["block"]["height"].as_u64().expect("block height")
    }

    fn summary(&self) -> Value {
        json!({ "exit": self.exit, "verdict": self.verdict["verdict"], "conditions_run": self.conditions().len(), "condition_ids": self.conditions().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(), "red": self.red(), "unknown": self.unknown(), "block_read": self.block(), "wall_ms": self.wall_ms })
    }
}

fn checker() -> PathBuf {
    std::env::var("KAIGEN_CAGE_JOBS_BIN").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("jobs").join("src").join("bin.mjs"))
}

fn run_checker(rig: &Rig, pin: &str, stand_in: Option<&str>) -> Cage {
    let mut cmd = Command::new("node");
    cmd.arg(checker()).args(["cage-check", rig.vid.as_str(), "--rpc", &rig.f.worker.rpc_addr(), "--code-hash", pin, "--json"]);
    if let Some(admin) = stand_in {
        cmd.args(["--stand-in-admin", admin]);
    }
    let started = Instant::now();
    let out = cmd.output().unwrap_or_else(|e| panic!("cannot run node (is it on PATH?): {e}"));
    let wall_ms = started.elapsed().as_millis();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let verdict: Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("cage-check did not print JSON ({e}); exit {:?}\nstdout: {stdout}\nstderr: {}", out.status.code(), String::from_utf8_lossy(&out.stderr)));
    Cage { exit: out.status.code().expect("exit code"), verdict, wall_ms }
}

/// The checker reads the final block: wait until the final head has caught up with everything sent so far.
async fn settle(rig: &Rig) {
    let (head, _) = rig.rpc().head("optimistic").await;
    wait_for("the final block to reach the optimistic head", Duration::from_secs(15), || async { (rig.rpc().head("final").await.0 >= head).then_some(()) }).await;
}

async fn full_access_keys(rig: &Rig) -> Vec<String> {
    rig.rpc().access_keys(&rig.vid).await.into_iter().filter(|(_, p)| p["permission"] == "FullAccess").map(|(k, _)| k).collect()
}

#[tokio::test]
async fn attack_8_planted_ed25519_full_access_key_and_null_allowance_key_go_red_then_green() {
    let rig = Rig::new(true).await;
    let rpc = rig.rpc();
    let vid = rig.vid.clone();
    for _ in 0..2 {
        rig.add_daily(None).await; // as in production: two daily keys added through add_daily_key
    }
    let admin = full_access_keys(&rig).await.into_iter().next().expect("the admin key");
    let pin = near_primitives::hash::hash(&mamori_wasm()).to_string(); // independent of the checker's own hashing
    let mut c = Checks::new();
    let mut runs = Vec::new();

    // 0. The cage as deployed: green.
    settle(&rig).await;
    let clean = run_checker(&rig, &pin, Some(&admin));
    c.check("clean cage: exit 0, GREEN, the eight ARCHITECTURE.md 2.8 rows ran (plus any attest rows), none red or unknown", clean.exit == 0 && clean.verdict["verdict"] == "GREEN" && clean.has_all_eight_arch_rows() && clean.red().is_empty() && clean.unknown() == 0);
    c.check("the sandbox run says it is not a production result", clean.verdict["mode"] == "sandbox-stand-in-admin");
    runs.push(json!({ "step": "clean cage", "result": clean.summary() }));

    // 1. Plant an ed25519 full-access key.
    let (sk1, pk1) = new_key();
    let plant1 = rig.f.vault.batch().add_key(sk1.public_key(), AccessKey::full_access()).transact().await.expect("add_key");
    c.check("the full-access key was planted on the account", plant1.is_success() && rig.on_account(&pk1).await);
    let plant1_facts = facts(rpc, &plant1.outcome().transaction_hash.to_string(), &vid).await;
    settle(&rig).await;
    let red1 = run_checker(&rig, &pin, Some(&admin));
    c.check("planted ed25519 full-access key: exit 1, RED, exactly ARCH-2.8-1, none unknown", red1.exit == 1 && red1.verdict["verdict"] == "RED" && red1.red() == vec!["ARCH-2.8-1".to_string()] && red1.unknown() == 0);
    c.check("the checker names the planted key", red1.offenders("ARCH-2.8-1") == vec![pk1.clone()]);
    runs.push(json!({ "step": "ed25519 full-access key planted", "plant_block": plant1_facts.last_height(), "result": red1.summary(), "offender_is_planted_key": red1.offenders("ARCH-2.8-1") == vec![pk1.clone()] }));

    let rm1 = rig.f.vault.batch().delete_key(sk1.public_key()).transact().await.expect("delete_key");
    c.check("the planted key was removed", rm1.is_success() && !rig.on_account(&pk1).await);
    let rm1_facts = facts(rpc, &rm1.outcome().transaction_hash.to_string(), &vid).await;
    settle(&rig).await;
    let green1 = run_checker(&rig, &pin, Some(&admin));
    c.check("after removal: exit 0, GREEN again", green1.exit == 0 && green1.verdict["verdict"] == "GREEN" && green1.red().is_empty());
    runs.push(json!({ "step": "ed25519 key removed", "remove_block": rm1_facts.last_height(), "result": green1.summary() }));

    // 2. Plant a function-call key with a null (unlimited) allowance, scoped like a daily key, added outside the contract.
    let (sk2, pk2) = new_key();
    let plant2 = rig.f.vault.batch().add_key(sk2.public_key(), AccessKey::function_call_access(&vid, &["send_small", "request_withdraw"], None)).transact().await.expect("add_key");
    let on_chain = rpc.access_key(&vid, &pk2).await.expect("planted key on the account");
    c.check("the node lists the planted key's allowance as null (unlimited)", plant2.is_success() && on_chain["permission"]["FunctionCall"]["allowance"] == Value::Null);
    let plant2_facts = facts(rpc, &plant2.outcome().transaction_hash.to_string(), &vid).await;
    settle(&rig).await;
    let red2 = run_checker(&rig, &pin, Some(&admin));
    c.check("planted null-allowance key: exit 1, RED, exactly ARCH-2.8-3 and ARCH-2.8-6 (also unrecorded), none unknown", red2.exit == 1 && red2.red() == vec!["ARCH-2.8-3".to_string(), "ARCH-2.8-6".to_string()] && red2.unknown() == 0);
    c.check("the checker names the null-allowance key (row 3) and the unrecorded key (row 6)", red2.offenders("ARCH-2.8-3").len() == 1 && red2.offenders("ARCH-2.8-3")[0].starts_with(&pk2) && red2.offenders("ARCH-2.8-6") == vec![pk2.clone()]);
    runs.push(json!({ "step": "null-allowance function-call key planted", "plant_block": plant2_facts.last_height(), "result": red2.summary() }));

    let rm2 = rig.f.vault.batch().delete_key(sk2.public_key()).transact().await.expect("delete_key");
    c.check("the second planted key was removed", rm2.is_success() && !rig.on_account(&pk2).await);
    let rm2_facts = facts(rpc, &rm2.outcome().transaction_hash.to_string(), &vid).await;
    settle(&rig).await;
    let green2 = run_checker(&rig, &pin, Some(&admin));
    c.check("after removal: exit 0, GREEN again", green2.exit == 0 && green2.verdict["verdict"] == "GREEN" && green2.red().is_empty());
    runs.push(json!({ "step": "null-allowance key removed", "remove_block": rm2_facts.last_height(), "result": green2.summary() }));

    // 3. The same clean account judged as production (no stand-in flag) is red: the green runs above can fail.
    let production = run_checker(&rig, &pin, None);
    c.check("control: the same clean account without the stand-in flag is RED (rows 1 and 2: the sandbox admin is ed25519)", production.exit == 1 && production.red() == vec!["ARCH-2.8-1".to_string(), "ARCH-2.8-2".to_string()]);
    runs.push(json!({ "step": "control, no stand-in flag", "result": production.summary() }));

    let measured = json!({
        "node": node_version(rpc).await,
        "checker_file": checker().display().to_string(),
        "mode": "sandbox, ed25519 admin passed as --stand-in-admin; not a production result",
        "runs": runs,
        "plant1_to_checker_block_distance": red1.block() as i64 - plant1_facts.last_height() as i64,
        "plant2_to_checker_block_distance": red2.block() as i64 - plant2_facts.last_height() as i64,
    });
    c.finish("attack_8", "cage-check goes red on a planted ed25519 full-access key and a null-allowance key, green after removal", measured);
}
