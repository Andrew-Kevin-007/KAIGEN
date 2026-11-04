//! M4b: the ML-DSA admin key can call every admin method, and nothing on the admin side depends on the key type.
//!
//! WHAT THE CONTRACT CHECKS, AND SO WHAT THESE TESTS SHOW. Every admin method is gated by `assert_admin`, which
//! compares `predecessor_account_id` with `current_account_id` and nothing else: it never looks at which key signed.
//! So "the ML-DSA admin can call it" is true by construction, and the tests below prove that construction holds:
//!
//! * the admin methods are enumerated from `lib.rs` itself (not from a list kept here), so a new one fails the test
//!   until it is added to the table, and each one is then actually called under a context whose signer is an
//!   ML-DSA-65 key, with its effect checked;
//! * no admin path reads `env::signer_account_pk()`, which is the one way the gate could come to depend on the key
//!   type (the design note in ARCHITECTURE.md 2.2: a host that cannot hand over an ML-DSA signer key as a classical
//!   `PublicKey` would abort the call). The unit VM cannot make that read abort for an ML-DSA key (near-sdk 5.30
//!   has `CurveType::MLDSA65` and parses it), so the guarantee is checked on the source, as a closed list of the
//!   functions that read the signer key.
//!
//! What they do NOT show. The unit VM has no access-key layer. It will run any method for any caller whose
//! predecessor is the account, a daily key included. That a daily key cannot reach an admin method is enforced by
//! the runtime (its method list is `send_small,request_withdraw`), and is shown on a real nearcore sandbox in
//! `tests-integration`, not here. What the real host returns for `signer_account_pk` when an ML-DSA key signs is
//! unverified; this file does not claim it.

use super::*;

const LIB_SOURCE: &str = include_str!("../lib.rs");

/// An ML-DSA-65 public key (1952 bytes) as the signer of the call: the cold admin key's type.
fn ml_dsa_key() -> PublicKey {
    PublicKey::from_parts(CurveType::MLDSA65, vec![7; 1952]).unwrap()
}

/// A call signed by the ML-DSA admin key (a full-access key, so the predecessor is the account itself).
fn as_ml_dsa_admin(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(vault())
        .signer_account_id(vault())
        .signer_account_pk(ml_dsa_key())
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// How the contract gates one exported method, read from the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// `self.assert_admin()`: predecessor == the account. The ML-DSA admin key's methods.
    Admin,
    /// `#[private]`: near-sdk's own predecessor == the account check (callbacks, `init`). Added by the wasm wrapper,
    /// which the unit VM does not run, so the unit tests cannot call through it.
    Private,
    /// `self.assert_daily_key()`: a recorded classical daily key.
    Daily,
    /// No gate in the method: a view, or open to anyone on purpose.
    Open,
}

/// Every `pub fn` of the exported `impl Mamori` block with the gate its source gives it. Read from `lib.rs` as it
/// is compiled, so the list cannot go stale.
fn exported() -> Vec<(String, Gate)> {
    let exported_impl = LIB_SOURCE.split("\nimpl Mamori {").nth(1).expect("the exported impl block");
    let mut out: Vec<(String, Gate)> = Vec::new();
    let mut private = false;
    for line in exported_impl.lines() {
        let t = line.trim_start();
        if t == "#[private]" {
            private = true;
            continue;
        }
        if t.is_empty() || t.starts_with("#[") || t.starts_with("//") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("    pub fn ") {
            let name = rest.split('(').next().unwrap().to_string();
            out.push((name, if private { Gate::Private } else { Gate::Open }));
        } else if let Some(last) = out.last_mut() {
            if line.contains("self.assert_admin();") {
                last.1 = Gate::Admin;
            } else if line.contains("self.assert_daily_key();") {
                last.1 = Gate::Daily;
            }
        }
        private = false;
    }
    out
}

fn names_with(gate: Gate) -> Vec<String> {
    let mut v: Vec<String> = exported().into_iter().filter(|(_, g)| *g == gate).map(|(n, _)| n).collect();
    v.sort();
    v
}

fn sorted(names: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

/// The classification table. A new export (or a changed gate) fails `every_exported_method_has_the_gate_this_table_names`
/// until it is written down here on purpose.
#[test]
fn every_exported_method_has_the_gate_this_table_names() {
    assert_eq!(
        names_with(Gate::Admin),
        sorted(&[
            "add_daily_key",
            "remove_daily_key",
            "forget_revoked_key",
            "register_intents_key",
            "set_token_limit",
            "set_pending_limit",
            "set_min_send",
            "allow_recipient",
            "disallow_recipient",
            "set_max_strikes",
            "enforce_allowlist",
            "cancel",
            "cancel_all",
        ]),
        "admin methods"
    );
    assert_eq!(
        names_with(Gate::Private),
        sorted(&[
            "init",
            "on_era",
            "lock_down",
            "on_send_done",
            "on_execute_done",
            "on_key_added",
            "on_key_removed",
            "on_revoked_key_deleted",
            "on_intents_removed",
        ]),
        "private (self-call) methods"
    );
    assert_eq!(names_with(Gate::Daily), sorted(&["send_small", "request_withdraw"]), "daily-key methods");
    assert_eq!(
        names_with(Gate::Open),
        sorted(&[
            "execute",
            "purge_expired",
            "trip",
            "era",
            "config",
            "attest",
            "check",
            "daily_keys",
            "intents_keys",
            "revoked_keys",
            "allowlist",
            "strikes_of",
            "token_limit",
            "pending_limit",
            "queue",
            "spent_24h",
        ]),
        "open methods (views and the permissionless ones)"
    );
    // The daily methods are exactly the ones the daily keys' access keys list.
    let mut listed: Vec<String> = DAILY_METHODS.split(',').map(str::to_string).collect();
    listed.sort();
    assert_eq!(listed, names_with(Gate::Daily));
}

/// One admin call: what to arrange first (as the admin), the call itself, and a check that it really took effect.
struct AdminCase {
    name: &'static str,
    prepare: fn(&mut Mamori),
    call: fn(&mut Mamori),
    took_effect: fn(&Mamori) -> bool,
}

fn nothing(_: &mut Mamori) {}

fn admin_cases() -> Vec<AdminCase> {
    vec![
        AdminCase {
            name: "add_daily_key",
            prepare: nothing,
            call: |m| drop(m.add_daily_key(key(2), None)),
            took_effect: |m| m.daily_keys().contains(&key(2)),
        },
        AdminCase {
            name: "remove_daily_key",
            prepare: nothing,
            call: |m| drop(m.remove_daily_key(key(1))),
            took_effect: |m| m.daily_keys().is_empty() && m.revoked_keys() == vec![key(1)],
        },
        AdminCase {
            name: "forget_revoked_key",
            prepare: |m| drop(m.remove_daily_key(key(1))),
            call: |m| m.forget_revoked_key(key(1)),
            took_effect: |m| m.daily_keys().is_empty() && m.revoked_keys().is_empty(),
        },
        AdminCase {
            name: "register_intents_key",
            prepare: nothing,
            call: |m| drop(m.register_intents_key(key(3))),
            took_effect: |m| m.intents_keys() == vec![key(3)],
        },
        AdminCase {
            name: "set_token_limit",
            prepare: nothing,
            call: |m| m.set_token_limit(accounts(2), U128(5)),
            took_effect: |m| m.token_limit(Some(accounts(2))) == U128(5),
        },
        AdminCase {
            name: "set_pending_limit",
            prepare: nothing,
            call: |m| m.set_pending_limit(None, U128(7)),
            took_effect: |m| m.pending_limit(None) == U128(7),
        },
        AdminCase {
            name: "set_min_send",
            prepare: nothing,
            call: |m| m.set_min_send(U128(9)),
            took_effect: |m| m.config().min_send == U128(9),
        },
        AdminCase {
            name: "allow_recipient",
            prepare: nothing,
            call: |m| m.allow_recipient(accounts(3)),
            took_effect: |m| m.allowlist().accounts == vec![accounts(3)],
        },
        AdminCase {
            name: "disallow_recipient",
            prepare: |m| m.allow_recipient(accounts(3)),
            call: |m| m.disallow_recipient(accounts(3)),
            took_effect: |m| m.allowlist().accounts.is_empty(),
        },
        AdminCase {
            name: "set_max_strikes",
            prepare: nothing,
            call: |m| m.set_max_strikes(5),
            took_effect: |m| m.config().max_strikes == 5,
        },
        AdminCase {
            name: "enforce_allowlist",
            prepare: nothing,
            call: |m| m.enforce_allowlist(true),
            took_effect: |m| m.allowlist().enforced,
        },
        AdminCase {
            name: "cancel",
            prepare: |m| {
                as_daily(&key(1), 1_500 * SEC);
                m.request_withdraw(None, U128(1), accounts(3));
                as_admin(1_501 * SEC);
            },
            call: |m| m.cancel(U64(0)),
            took_effect: |m| m.queue().is_empty(),
        },
        AdminCase {
            name: "cancel_all",
            prepare: |m| {
                as_daily(&key(1), 1_500 * SEC);
                m.request_withdraw(None, U128(1), accounts(3));
                as_admin(1_501 * SEC);
            },
            call: |m| assert_eq!(m.cancel_all(), 1),
            took_effect: |m| m.queue().is_empty(),
        },
    ]
}

#[test]
fn the_admin_cases_cover_every_admin_method_the_source_has() {
    let mut cases: Vec<String> = admin_cases().iter().map(|c| c.name.to_string()).collect();
    cases.sort();
    assert_eq!(cases, names_with(Gate::Admin), "a case per admin method, no more and no fewer");
}

/// Each case gets a fresh mocked blockchain: the unit VM keeps its storage across `testing_env!` calls inside one
/// test, and every case sets up its own vault. The mock is per thread, so a thread is a fresh chain.
fn on_a_fresh_chain(f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::spawn(f).join() {
        std::panic::resume_unwind(e);
    }
}

#[test]
fn an_ml_dsa_admin_key_can_call_every_admin_method() {
    // The context really does carry an ML-DSA signer: the test is not vacuous.
    as_ml_dsa_admin(2_000 * SEC);
    assert_eq!(env::signer_account_pk().curve_type(), CurveType::MLDSA65);
    assert_eq!(env::signer_account_pk(), ml_dsa_key());
    for case in admin_cases() {
        on_a_fresh_chain(move || {
            let mut m = setup();
            as_admin(1_400 * SEC);
            (case.prepare)(&mut m);
            as_ml_dsa_admin(2_000 * SEC);
            (case.call)(&mut m);
            assert!((case.took_effect)(&m), "{} was called by the ML-DSA admin and did not take effect", case.name);
        });
    }
}

#[test]
fn every_admin_method_refuses_a_caller_that_is_not_the_account() {
    for case in admin_cases() {
        on_a_fresh_chain(move || {
            let mut m = setup();
            as_admin(1_400 * SEC);
            (case.prepare)(&mut m);
            let before = (m.daily_keys(), m.intents_keys(), m.revoked_keys(), m.queue().len(), m.config().max_strikes);
            as_anyone(2_000 * SEC);
            let msg = panics_with(|| (case.call)(&mut m));
            assert!(msg.contains("admin only"), "{}: expected 'admin only', got {msg:?}", case.name);
            let after = (m.daily_keys(), m.intents_keys(), m.revoked_keys(), m.queue().len(), m.config().max_strikes);
            assert_eq!(before, after, "{} changed state for a stranger", case.name);
        });
    }
}

#[test]
fn the_ml_dsa_admin_key_is_not_a_daily_key_so_it_cannot_spend_through_the_daily_methods() {
    let mut m = setup();
    as_ml_dsa_admin(2_000 * SEC);
    assert!(panics_with(|| {
        let _ = m.send_small(None, U128(1), accounts(3));
    })
    .contains("not a recorded daily key"));
    assert!(panics_with(|| {
        m.request_withdraw(None, U128(1), accounts(3));
    })
    .contains("not a recorded daily key"));
    assert!(m.queue().is_empty());
}

/// The functions whose code reads `signer_account_pk`, from the source (comments skipped).
fn signer_key_readers() -> Vec<String> {
    let mut readers: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in LIB_SOURCE.lines() {
        let t = line.trim_start();
        if t.starts_with("//") {
            continue;
        }
        if t == "#[cfg(test)]" {
            break;
        }
        if let Some(pos) = t.find("fn ") {
            let head = &t[..pos];
            if head.is_empty() || head == "pub " || head == "pub(crate) " {
                current = t[pos + 3..].split(['(', '<']).next().unwrap().to_string();
            }
        }
        if line.contains("signer_account_pk") && !readers.contains(&current) {
            readers.push(current.clone());
        }
    }
    readers.sort();
    readers
}

/// ARCHITECTURE.md 2.2: no method the ML-DSA admin key can reach may read the signer's key. The readers are a
/// closed list: the daily-key gate and the two daily methods, which only a classical daily key can ever reach.
#[test]
fn only_the_daily_key_path_reads_the_signer_key() {
    assert_eq!(signer_key_readers(), sorted(&["assert_daily_key", "request_withdraw", "send_small"]));
    // And the daily gate is called from nowhere else.
    let callers: Vec<String> = {
        let exported_impl = LIB_SOURCE.split("\nimpl Mamori {").nth(1).unwrap();
        let mut current = String::new();
        let mut found = Vec::new();
        for line in exported_impl.lines() {
            if let Some(rest) = line.strip_prefix("    pub fn ") {
                current = rest.split('(').next().unwrap().to_string();
            }
            if line.contains("self.assert_daily_key();") {
                found.push(current.clone());
            }
        }
        found.sort();
        found
    };
    assert_eq!(callers, sorted(&["request_withdraw", "send_small"]));
    assert!(!LIB_SOURCE.split("\nimpl Mamori {").nth(2).unwrap().contains("self.assert_daily_key();"));
}
