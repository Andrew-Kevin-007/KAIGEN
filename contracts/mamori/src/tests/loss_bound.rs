//! M3 (ROADMAP): the loss bound of docs/v3/LOSS-BOUND.md as a property over random multi-key sequences.
//!
//! A seeded generator (splitmix64, the one in `tests.rs`; proptest is not in Cargo.lock or the offline cache)
//! drives a vault with several daily keys through mixed `send_small`, `request_withdraw`, `execute`, `cancel`,
//! `cancel_all`, `purge_expired`, key add/remove, time jumps and transfer callbacks that succeed or fail. The
//! generator is aimed, not blind: amounts sit at the headroom and one past it, time jumps land on the exact
//! nanosecond a window, an unlock or an expiry turns over, and one key plays the attacker half of the time.
//!
//! The model is a ledger kept apart from the contract: every transfer the contract started, with the block it
//! was started in and whether it landed, failed or is still in flight (in flight counts as lost). After EVERY
//! step the ledger is swept over every 24 h window and compared with the claimed bound, and the contract's books
//! are compared with the model (queue, keys, strikes, window logs, request budgets, per-key shares).
//!
//! A transaction is simulated the way the chain does it: the state is read back from storage, the call runs, the
//! state is written back if it returned and every write is thrown away if it panicked. (Calling the methods on
//! one long-lived struct would keep the writes a panicking call made before it panicked.)
//!
//! A failing sequence is replayed and shrunk (chunks of steps removed while it still fails) before it is
//! reported, so the message is a counterexample, not a trace.
//!
//! `KAIGEN_PROP_SEEDS` and `KAIGEN_PROP_STEPS` scale a run up (a soak); the defaults keep `cargo test` quick.

use super::*;
use near_sdk::borsh::BorshDeserialize;
use near_sdk::env::set_blockchain_interface;
use near_sdk::mock::with_mocked_blockchain;
use near_sdk::{test_vm_config, MockedBlockchain, PromiseResult, RuntimeFeesConfig};
use std::collections::{BTreeMap, BTreeSet, HashMap};

type Res = Result<(), String>;

/// With `KAIGEN_PROP_BOUND_ONLY=1` only a broken loss bound stops a run: every other check is counted and the
/// run goes on. It exists to ask of a mutation whether the bound itself notices it, or only a bookkeeping check.
fn bound_only() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| std::env::var("KAIGEN_PROP_BOUND_ONLY").is_ok_and(|v| v == "1"))
}

static SOFT: std::sync::Mutex<(u64, Vec<String>)> = std::sync::Mutex::new((0, Vec::new()));

/// Ends the step with `msg`, or in bound-only mode (for anything but a broken bound) counts it and goes on.
fn fail(msg: String) -> Res {
    if bound_only() && !msg.starts_with("BOUND BROKEN") {
        let mut soft = SOFT.lock().unwrap();
        soft.0 += 1;
        if soft.1.len() < 6 && !soft.1.iter().any(|m| m == &msg) {
            soft.1.push(msg);
        }
        return Ok(());
    }
    Err(msg)
}

macro_rules! ensure {
    ($cond:expr, $($arg:tt)+) => {
        if !$cond {
            fail(format!($($arg)+))?;
        }
    };
}

thread_local! {
    /// `test_vm_config()` takes 20 ms to build and every call needs one, so it is built once per thread.
    static VM_CONFIG: std::cell::RefCell<Option<Box<dyn std::any::Any>>> = const { std::cell::RefCell::new(None) };
}

/// The VM config, built once per thread. Its type comes from where it is used.
macro_rules! vm_config {
    () => {
        VM_CONFIG.with(|c| {
            Clone::clone(c.borrow_mut().get_or_insert_with(|| Box::new(test_vm_config())).downcast_ref().expect("the config"))
        })
    };
}

/// Daily keys the model knows are `key(1)` to `key(KEYS)`; a call by one the vault does not serve must panic.
const KEYS: u8 = 9;
/// A transfer's callback arrives within this long of the call. A receipt takes a few blocks, so this is generous.
/// Callbacks a day or more late are covered by their own tests at the end of this file (A5 of LOSS-BOUND.md).
const CB_WINDOW: u64 = 30 * SEC;
/// NEAR, one listed NEP-141, and one the admin never listed (it has no cap and can never move).
const TOKENS: usize = 3;

fn tk(tok: usize) -> Option<AccountId> {
    match tok {
        0 => None,
        1 => Some("ft.near".parse().unwrap()),
        _ => Some("other.near".parse().unwrap()),
    }
}

fn tok_of(token: &Option<AccountId>) -> usize {
    match token {
        None => 0,
        Some(a) if a.as_str() == "ft.near" => 1,
        Some(_) => 2,
    }
}

/// Payees 0 and 1 are on the allowlist when it is enforced; payee 2 is not.
fn payee(i: u8) -> AccountId {
    match i {
        0 => accounts(2),
        1 => accounts(5),
        _ => accounts(1),
    }
}

fn listed(i: u8) -> bool {
    i < 2
}

fn id_of(k: &PublicKey) -> u8 {
    (1..=KEYS).find(|n| &key(*n) == k).expect("a key of the model")
}

// ---- configuration -------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Cfg {
    delay_secs: u64,
    /// The 24 h cap per token (NEAR, the listed NEP-141, the unlisted one).
    cap: [u128; TOKENS],
    /// The pending limit per token.
    pending: [u128; TOKENS],
    min_send: u128,
    max_strikes: u32,
    allowlist: bool,
    /// Daily keys recorded at the start.
    keys: u8,
    /// Chance, in percent, that a transfer callback reports a failure.
    fail_pct: u64,
    /// Seed of the callback outcomes, so a replay sees the same ones.
    cb_seed: u64,
    /// Many tiny sends, so the 64-entry window log fills and folds.
    dust: bool,
    /// Most steps come from the greedy drainer (`attack_op`) instead of the random mix.
    attacker: bool,
}

impl Cfg {
    /// The exec part of the claim: one pending limit, or two when the build allows a delay under a day (drill).
    fn exec_claim(&self, tok: usize) -> u128 {
        if cfg!(feature = "drill") && self.delay_secs < MIN_DELAY_SECS {
            2 * self.pending[tok]
        } else {
            self.pending[tok]
        }
    }
}

fn splitmix(x: u64) -> u64 {
    let mut s = x;
    next(&mut s)
}

fn pick(r: &mut u64, xs: &[u128]) -> u128 {
    xs[(next(r) % xs.len() as u64) as usize]
}

fn cfg_for(seed: u64) -> Cfg {
    let mut r = splitmix(seed ^ 0xA076_1D64_78BD_642F);
    let dust = seed % 8 == 3;
    let cap0 = if dust { 5_000 } else { pick(&mut r, &[5, 64, 997, 1_000]) };
    let cap1 = if dust { 5_000 } else { pick(&mut r, &[33, 500, 1_000]) };
    let pending = |cap: u128, how: u128| match how % 4 {
        0 => cap * PENDING_LIMIT_MULTIPLE,
        1 => cap,
        2 => cap / 2 + 1,
        _ => 3 * cap + 7,
    };
    let (h0, h1) = (pick(&mut r, &[0, 1, 2, 3]), pick(&mut r, &[0, 1, 2, 3]));
    let min_send = if dust { 0 } else { pick(&mut r, &[0, 0, 1, cap0 / 10]) };
    let max_strikes = pick(&mut r, &[1, 2, 3, 3, 5]) as u32;
    let allowlist = !dust && pick(&mut r, &[0, 0, 1]) == 1;
    let keys = pick(&mut r, &[1, 2, 3, 4, 5]) as u8;
    let fail_pct = pick(&mut r, &[0, 15, 50]) as u64;
    // A quarter of the runs try a delay the production build refuses; `world_for` falls back for those.
    let delay_secs = if next(&mut r) % 4 == 0 {
        pick(&mut r, &[1, 600, 3_600, 43_200, 86_399]) as u64
    } else {
        pick(&mut r, &[86_400, 86_401, 90_000, 172_800]) as u64
    };
    Cfg { delay_secs, cap: [cap0, cap1, 0], pending: [pending(cap0, h0), pending(cap1, h1), 0], min_send, max_strikes, allowlist, keys, fail_pct, cb_seed: r, dust, attacker: seed % 4 == 1 }
}

// ---- the model -----------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    InFlight,
    Landed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Send,
    Exec,
}

/// One transfer the contract started: the block of the call that started it, not of the callback.
#[derive(Clone, Debug)]
struct Transfer {
    t: u64,
    tok: usize,
    amount: u128,
    kind: Kind,
    status: Status,
}

/// What a successful `request_withdraw` returned, kept to check the queue against.
#[derive(Clone, Debug)]
struct Issued {
    tok: usize,
    amount: u128,
    to: u8,
    by: u8,
    at: u64,
}

#[derive(Clone, Debug)]
struct QItem {
    id: u64,
    unlocks_at: u64,
    w: Withdrawal,
}

enum CbKind {
    Send { ix: usize, tok: usize, amount: u128, ts: u64 },
    /// `requests_before`: how many requests had been made when the execute went out (the contract's `next_id`).
    Exec { ix: usize, id: u64, w: Withdrawal, requests_before: u64 },
    Revoked { key: u8 },
}

struct Cb {
    due: u64,
    serial: u64,
    kind: CbKind,
}

#[derive(Clone, Debug)]
enum Op {
    Send { key: u8, tok: usize, amount: u128, to: u8 },
    Request { key: u8, tok: usize, amount: u128, to: u8 },
    Execute { pick: usize },
    Cancel { pick: usize },
    CancelAll,
    Purge,
    Advance(u64),
    Deliver { pick: usize },
    AddKey(u8),
    RemoveKey(u8),
    Trip(Era),
}

#[derive(Default, Clone)]
struct Stats {
    count: BTreeMap<&'static str, u64>,
    peak: BTreeMap<&'static str, u64>,
}

impl Stats {
    fn bump(&mut self, what: &'static str) {
        *self.count.entry(what).or_default() += 1;
    }
    fn peak(&mut self, what: &'static str, v: u64) {
        let e = self.peak.entry(what).or_default();
        *e = (*e).max(v);
    }
    fn merge(&mut self, o: &Stats) {
        for (k, v) in &o.count {
            *self.count.entry(k).or_default() += v;
        }
        for (k, v) in &o.peak {
            self.peak(k, *v);
        }
    }
}

#[derive(Clone, Copy)]
enum Who {
    Admin,
    Daily(u8),
    Anyone,
    Callback,
}

/// Everything the contract says about itself, read in one view.
struct Snap {
    q: Vec<QItem>,
    daily: BTreeSet<u8>,
    revoked: BTreeSet<u8>,
    strikes: [u32; KEYS as usize + 1],
    spent: [u128; TOKENS],
    raw_window: [usize; TOKENS],
    requested_live: [u128; TOKENS],
    by_key_live: [[u128; KEYS as usize + 1]; TOKENS],
}

impl Snap {
    fn read(m: &Mamori, now: u64) -> Snap {
        let q = m.queue().into_iter().map(|v| QItem { id: v.id.0, unlocks_at: v.unlocks_at.0, w: v.withdrawal }).collect();
        let mut s = Snap {
            q,
            daily: m.daily_keys().iter().map(id_of).collect(),
            revoked: m.revoked_keys().iter().map(id_of).collect(),
            strikes: [0; KEYS as usize + 1],
            spent: [0; TOKENS],
            raw_window: [0; TOKENS],
            requested_live: [0; TOKENS],
            by_key_live: [[0; KEYS as usize + 1]; TOKENS],
        };
        for n in 1..=KEYS {
            s.strikes[n as usize] = m.strikes_of(key(n));
        }
        let sum = |log: Vec<(u64, u128)>| log.iter().map(|(_, a)| a).sum::<u128>();
        for tok in 0..TOKENS {
            let t = tk(tok);
            s.spent[tok] = m.spent_24h(t.clone()).0;
            s.raw_window[tok] = m.window.get(&t).map_or(0, Vec::len);
            s.requested_live[tok] = sum(Mamori::live_log(&m.requested, &t, now));
            for n in 1..=KEYS {
                s.by_key_live[tok][n as usize] = sum(Mamori::live_log(&m.requested_by_key, &(key(n), t.clone()), now));
            }
        }
        s
    }
}

struct World {
    cfg: Cfg,
    /// What the chain stores for the account, and the borsh bytes of the contract state under it.
    storage: HashMap<Vec<u8>, Vec<u8>>,
    state: Vec<u8>,
    now: u64,
    era: Era,
    served: BTreeSet<u8>,
    revoked: BTreeSet<u8>,
    strikes: BTreeMap<u8, (u32, u64)>,
    issued: BTreeMap<u64, Issued>,
    /// The contract's queue as of the last check.
    q: Vec<QItem>,
    ledger: Vec<Transfer>,
    pending: Vec<Cb>,
    serial: u64,
    /// The send log of a token has held 64 entries: from then on it may over-count (never under-count).
    folded: [bool; TOKENS],
    /// After a lockdown the contract removes keys by its own rules and the key books are no longer compared.
    sealed: bool,
    stats: Stats,
    expect_new: Option<u64>,
    expect_gone: BTreeSet<u64>,
    /// The drainer's own bookkeeping: when it last tried a send, and how many keys it has asked with at this instant.
    last_send: std::cell::Cell<u64>,
    req_at: std::cell::Cell<(u64, usize)>,
}

impl World {
    /// Err is the panic of `init`, which refuses a delay under a day in a production build.
    fn new(cfg: Cfg) -> Result<World, String> {
        let mut w = World {
            cfg: cfg.clone(),
            storage: HashMap::new(),
            state: vec![],
            now: 3 * DAY_NS,
            era: Era::Calm,
            served: (1..=cfg.keys).collect(),
            revoked: BTreeSet::new(),
            strikes: BTreeMap::new(),
            issued: BTreeMap::new(),
            q: vec![],
            ledger: vec![],
            pending: vec![],
            serial: 0,
            folded: [false; TOKENS],
            sealed: false,
            stats: Stats::default(),
            expect_new: None,
            expect_gone: BTreeSet::new(),
            last_send: std::cell::Cell::new(0),
            req_at: std::cell::Cell::new((0, 0)),
        };
        w.env(Who::Admin, vec![]);
        let m = try_call(|| {
            let mut m = Mamori::init(accounts(1), U128(cfg.cap[0]), cfg.delay_secs);
            m.set_token_limit("ft.near".parse().unwrap(), U128(cfg.cap[1]));
            m.set_pending_limit(None, U128(cfg.pending[0]));
            m.set_pending_limit(tk(1), U128(cfg.pending[1]));
            m.set_min_send(U128(cfg.min_send));
            m.set_max_strikes(cfg.max_strikes);
            if cfg.allowlist {
                m.allow_recipient(payee(0));
                m.allow_recipient(payee(1));
                m.enforce_allowlist(true);
            }
            for n in 1..=cfg.keys {
                let _ = m.add_daily_key(key(n), None);
            }
            m
        })?;
        w.state = near_sdk::borsh::to_vec(&m).expect("state serialises");
        drop(m);
        w.storage = with_mocked_blockchain(|b| b.take_storage());
        w.check(None).map_err(|e| format!("fresh vault: {e}"))?;
        Ok(w)
    }

    fn env(&self, who: Who, results: Vec<PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(vault()).block_timestamp(self.now).account_balance(NearToken::from_near(100));
        match who {
            Who::Admin | Who::Callback => {
                b.predecessor_account_id(vault()).signer_account_id(vault());
            }
            Who::Daily(k) => {
                b.predecessor_account_id(vault()).signer_account_id(vault()).signer_account_pk(key(k));
            }
            Who::Anyone => {
                b.predecessor_account_id(accounts(4)).signer_account_id(accounts(4));
            }
        }
        set_blockchain_interface(MockedBlockchain::new(
            b.build(),
            vm_config!(),
            RuntimeFeesConfig::test(),
            results,
            self.storage.clone(),
            Default::default(),
            None,
        ));
    }

    /// One transaction. The state is read back from storage, `f` runs, and the new state is stored only if it
    /// returned: a panic throws every write away, as it does on the chain.
    fn call<R>(&mut self, who: Who, results: Vec<PromiseResult>, f: impl FnOnce(&mut Mamori) -> R) -> Result<R, String> {
        self.env(who, results);
        let mut m = Mamori::try_from_slice(&self.state).expect("the stored state reads back");
        let out = try_call(|| f(&mut m));
        if out.is_ok() {
            self.state = near_sdk::borsh::to_vec(&m).expect("state serialises");
            drop(m);
            self.storage = with_mocked_blockchain(|b| b.take_storage());
        }
        out
    }

    fn view<R>(&self, f: impl FnOnce(&Mamori) -> R) -> R {
        self.env(Who::Anyone, vec![]);
        let m = Mamori::try_from_slice(&self.state).expect("the stored state reads back");
        f(&m)
    }

    fn cb_fails(&self, serial: u64) -> bool {
        self.cfg.fail_pct > 0 && splitmix(self.cfg.cb_seed ^ serial.wrapping_mul(0x9E37_79B9)) % 100 < self.cfg.fail_pct
    }

    fn schedule(&mut self, kind: CbKind) {
        self.serial += 1;
        let due = self.now + splitmix(self.cfg.cb_seed ^ self.serial) % 31 * SEC;
        self.pending.push(Cb { due, serial: self.serial, kind });
    }

    /// Value of `tok` sent through `send_small` in the 24 h before now that has not failed (in flight counts).
    fn truth_used(&self, tok: usize) -> u128 {
        let cutoff = self.now.saturating_sub(DAY_NS);
        self.ledger.iter().filter(|t| t.kind == Kind::Send && t.tok == tok && t.status != Status::Failed && t.t > cutoff).map(|t| t.amount).sum()
    }

    fn strikes_view(&self, k: u8) -> u32 {
        let cutoff = self.now.saturating_sub(DAY_NS);
        self.strikes.get(&k).filter(|(_, since)| *since > cutoff).map_or(0, |(c, _)| *c)
    }

    // ---- steps --------------------------------------------------------------------------------

    fn step(&mut self, op: &Op) -> Res {
        let per_key = match op {
            Op::Send { key, tok, amount, to } => self.send(*key, *tok, *amount, *to)?,
            Op::Request { key, tok, amount, to } => self.request(*key, *tok, *amount, *to)?,
            Op::Execute { pick } => self.execute(*pick)?,
            Op::Cancel { pick } => self.cancel(*pick)?,
            Op::CancelAll => self.cancel_all()?,
            Op::Purge => self.purge()?,
            Op::Advance(dt) => self.advance_to(self.now.saturating_add(*dt))?,
            Op::Deliver { pick } => {
                if !self.pending.is_empty() {
                    let i = pick % self.pending.len();
                    self.deliver(i)?;
                }
                None
            }
            Op::AddKey(k) => self.add_key(*k)?,
            Op::RemoveKey(k) => self.remove_key(*k)?,
            Op::Trip(e) => self.trip(*e)?,
        };
        self.check(per_key)
    }

    fn send(&mut self, key_id: u8, tok: usize, amount: u128, to: u8) -> Result<Option<(u8, usize)>, String> {
        let (now, cap, t) = (self.now, self.cfg.cap[tok], tk(tok));
        let used = self.truth_used(tok);
        let out = self.call(Who::Daily(key_id), vec![], |m| m.send_small(t.clone(), U128(amount), payee(to)));
        let served = self.served.contains(&key_id);
        let calm = self.era == Era::Calm;
        match out {
            Err(msg) => {
                let want = if !served {
                    "not a recorded daily key"
                } else if !calm {
                    "paused"
                } else if amount == 0 {
                    "amount must be > 0"
                } else {
                    return Err(format!("send_small by key {key_id} panicked: {msg}"));
                };
                ensure!(msg.contains(want), "send_small by key {key_id}: wanted a panic with `{want}`, got `{msg}`");
                self.stats.bump(if served { "send_panic_other" } else { "send_by_unserved_key" });
            }
            Ok(PromiseOrValue::Value(o)) => {
                ensure!(served && calm && amount > 0, "send_small returned a refusal where it had to panic");
                ensure!(!o.sent && o.refused.is_some(), "a refusal that says it sent: {o:?}");
                // The counting rule (ARCHITECTURE 2.1): only a refusal that could never succeed for an honest key counts.
                let (counted, why) = if self.cfg.allowlist && !listed(to) {
                    (true, "allowlist")
                } else if cap == 0 {
                    (false, "no limit")
                } else if tok == 0 && amount < self.cfg.min_send {
                    (false, "below minimum")
                } else if amount > cap {
                    (true, "above the whole cap")
                } else {
                    ensure!(
                        used + amount > cap || self.folded[tok],
                        "send of {amount} refused although the window holds only {used} of {cap} (no fold): a spurious refusal"
                    );
                    (false, "cap used up")
                };
                if counted {
                    let prev = self.strikes.get(&key_id).copied().filter(|(_, since)| now.saturating_sub(*since) <= DAY_NS);
                    let rec = prev.map_or((1, now), |(c, since)| (c + 1, since));
                    let burn = rec.0 >= self.cfg.max_strikes;
                    ensure!(o.strikes == rec.0 && o.burned == burn, "counted refusal ({why}): expected strikes {} burned {burn}, got {o:?}", rec.0);
                    if burn {
                        self.strikes.remove(&key_id);
                        self.served.remove(&key_id);
                        self.revoked.insert(key_id);
                        self.schedule(CbKind::Revoked { key: key_id });
                        self.stats.bump("key_burned");
                    } else {
                        self.strikes.insert(key_id, rec);
                    }
                    self.stats.bump("refusal_counted");
                } else {
                    let seen = self.strikes_view(key_id);
                    ensure!(o.strikes == seen && !o.burned, "uncounted refusal ({why}) moved the strikes: expected {seen}, got {o:?}");
                    self.stats.bump(match why {
                        "no limit" => "refusal_uncounted_no_limit",
                        "below minimum" => "refusal_uncounted_dust",
                        _ => "refusal_uncounted_cap_used_up",
                    });
                }
            }
            Ok(PromiseOrValue::Promise(_)) => {
                ensure!(served && calm && amount > 0, "send_small went through where it had to panic");
                ensure!(!self.cfg.allowlist || listed(to), "payee control broken: a send went to unlisted payee {to} with the allowlist enforced");
                ensure!(cap > 0 && amount <= cap && !(tok == 0 && amount < self.cfg.min_send), "send went through that had to be refused");
                ensure!(used + amount <= cap, "send of {amount} went through with {used} of {cap} already sent in 24 h: the cap is broken at its source");
                self.ledger.push(Transfer { t: now, tok, amount, kind: Kind::Send, status: Status::InFlight });
                let ix = self.ledger.len() - 1;
                self.schedule(CbKind::Send { ix, tok, amount, ts: now });
                self.stats.bump("send_ok");
            }
        }
        Ok(None)
    }

    fn request(&mut self, key_id: u8, tok: usize, amount: u128, to: u8) -> Result<Option<(u8, usize)>, String> {
        let now = self.now;
        let out = self.call(Who::Daily(key_id), vec![], |m| m.request_withdraw(tk(tok), U128(amount), payee(to)));
        let (served, calm) = (self.served.contains(&key_id), self.era == Era::Calm);
        match out {
            Err(msg) => {
                if !served {
                    ensure!(msg.contains("not a recorded daily key"), "request by unserved key {key_id}: `{msg}`");
                } else if !calm {
                    ensure!(msg.contains("lockdown") || msg.contains("paused"), "request outside calm: `{msg}`");
                } else if amount == 0 {
                    ensure!(msg.contains("amount must be > 0"), "zero request: `{msg}`");
                } else {
                    let class = REFUSALS.iter().find(|c| msg.contains(**c));
                    ensure!(class.is_some(), "request_withdraw by key {key_id} refused with an unknown reason: `{msg}`");
                    self.stats.bump(match class.copied() {
                        Some("queue full") => "request_refused_queue_full",
                        Some(SLOTS_USED_UP) => "request_refused_key_slots",
                        Some(OVER_QUEUE_SUM) => "request_refused_pending_sum",
                        Some(OVER_QUEUE_SHARE) => "request_refused_key_queue_share",
                        Some(OVER_BUDGET) => "request_refused_budget",
                        Some(_) => "request_refused_key_budget_share",
                        None => "request_refused_unknown_reason",
                    });
                }
                Ok(None)
            }
            Ok(id) => {
                ensure!(served && calm && amount > 0, "request_withdraw went through where it had to panic");
                self.issued.insert(id.0, Issued { tok, amount, to, by: key_id, at: now });
                self.expect_new = Some(id.0);
                self.stats.bump("request_ok");
                Ok(Some((key_id, tok)))
            }
        }
    }

    fn pick_item(&self, pick: usize) -> Option<QItem> {
        (!self.q.is_empty()).then(|| self.q[pick % self.q.len()].clone())
    }

    fn execute(&mut self, pick: usize) -> Result<Option<(u8, usize)>, String> {
        let now = self.now;
        let item = self.pick_item(pick);
        let id = item.as_ref().map_or(u64::MAX - 1, |i| i.id);
        let out = self.call(Who::Anyone, vec![], |m| m.execute(U64(id)));
        let want = match &item {
            _ if self.era != Era::Calm => Some("paused"),
            None => Some("no such request"),
            Some(i) if now < i.unlocks_at => Some("still locked"),
            Some(i) if now >= i.w.expires_at.0 => Some("expired"),
            Some(_) => None,
        };
        match (out, want) {
            (Err(msg), Some(w)) => {
                ensure!(msg.contains(w), "execute({id}) at {now}: wanted `{w}`, got `{msg}`");
                self.stats.bump(match w {
                    "still locked" => "execute_locked",
                    "expired" => "execute_expired",
                    _ => "execute_other_refusal",
                });
            }
            (Err(msg), None) => fail(format!("execute({id}) of a due, unexpired request was refused: `{msg}`"))?,
            (Ok(promise), want) => {
                // A promise is only built (and its receipts created) when it is dropped.
                drop(promise);
                if let Some(w) = want {
                    fail(format!("execute({id}) went through although it had to fail with `{w}`"))?;
                }
                let w = item.expect("an execute that went through had a queued request").w;
                let tok = tok_of(&w.token);
                self.ledger.push(Transfer { t: now, tok, amount: w.amount.0, kind: Kind::Exec, status: Status::InFlight });
                let ix = self.ledger.len() - 1;
                self.expect_gone.insert(id);
                // What the contract itself put in the callback's arguments (the receipt of the call just made), and it
                // must be the number of requests the model has seen made: `next_id` counts exactly those.
                let r = receipts_text();
                let tag = "\"requests_before\":\"";
                let at = r.find(tag).ok_or_else(|| format!("the callback of execute({id}) carries no requests_before: {r}"))? + tag.len();
                let requests_before: u64 = r[at..].split('"').next().and_then(|n| n.parse().ok()).ok_or("requests_before is not a number")?;
                ensure!(requests_before == self.issued.len() as u64, "execute({id}) told its callback {requests_before} requests, the model has seen {}", self.issued.len());
                self.schedule(CbKind::Exec { ix, id, w, requests_before });
                self.stats.bump("execute_ok");
            }
        }
        Ok(None)
    }

    fn cancel(&mut self, pick: usize) -> Result<Option<(u8, usize)>, String> {
        let item = self.pick_item(pick);
        let id = item.as_ref().map_or(u64::MAX - 1, |i| i.id);
        let out = self.call(Who::Admin, vec![], |m| m.cancel(U64(id)));
        match (out, item) {
            (Ok(()), Some(_)) => {
                self.expect_gone.insert(id);
                self.stats.bump("cancel_ok");
            }
            (Err(msg), None) => ensure!(msg.contains("no such request"), "cancel of an unknown id: `{msg}`"),
            (Ok(()), None) => fail("cancel of an unknown id went through".into())?,
            (Err(msg), Some(_)) => fail(format!("cancel of a queued request failed: `{msg}`"))?,
        }
        Ok(None)
    }

    fn cancel_all(&mut self) -> Result<Option<(u8, usize)>, String> {
        let held = self.q.len() as u32;
        let n = self.call(Who::Admin, vec![], |m| m.cancel_all())?;
        ensure!(n == held, "cancel_all returned {n} with {held} queued");
        self.expect_gone.extend(self.q.iter().map(|i| i.id));
        if n > 0 {
            self.stats.bump("cancel_all_nonempty");
        }
        Ok(None)
    }

    fn purge(&mut self) -> Result<Option<(u8, usize)>, String> {
        let now = self.now;
        let stale: Vec<u64> = self.q.iter().filter(|i| now >= i.w.expires_at.0).map(|i| i.id).collect();
        let n = self.call(Who::Anyone, vec![], |m| m.purge_expired())?;
        ensure!(n as usize == stale.len(), "purge_expired returned {n}, {} were expired", stale.len());
        self.expect_gone.extend(stale);
        if n > 0 {
            self.stats.bump("purge_nonempty");
        }
        Ok(None)
    }

    fn add_key(&mut self, k: u8) -> Result<Option<(u8, usize)>, String> {
        let out = self.call(Who::Admin, vec![], |m| {
            let _ = m.add_daily_key(key(k), None);
        });
        let want = if self.revoked.contains(&k) {
            Some("revoked key")
        } else if self.served.len() >= MAX_DAILY_KEYS as usize {
            Some("too many daily keys")
        } else if self.served.contains(&k) {
            Some("already recorded")
        } else {
            None
        };
        match (out, want) {
            (Ok(()), None) => {
                self.served.insert(k);
                self.stats.bump("key_added");
            }
            (Err(msg), Some(w)) => ensure!(msg.contains(w), "add_daily_key({k}): wanted `{w}`, got `{msg}`"),
            (Ok(()), Some(w)) => fail(format!("add_daily_key({k}) went through although it had to fail with `{w}`"))?,
            (Err(msg), None) => fail(format!("add_daily_key({k}) failed: `{msg}`"))?,
        }
        Ok(None)
    }

    fn remove_key(&mut self, k: u8) -> Result<Option<(u8, usize)>, String> {
        let out = self.call(Who::Admin, vec![], |m| {
            let _ = m.remove_daily_key(key(k));
        });
        if self.served.contains(&k) || self.revoked.contains(&k) {
            ensure!(out.is_ok(), "remove_daily_key({k}) failed: {out:?}");
            self.served.remove(&k);
            self.revoked.insert(k);
            self.schedule(CbKind::Revoked { key: k });
            self.stats.bump("key_removed");
        } else {
            let msg = out.err().unwrap_or_default();
            ensure!(msg.contains("unknown daily key"), "remove_daily_key({k}) of an unknown key: `{msg}`");
        }
        Ok(None)
    }

    /// Delivers callbacks that are due before `target`, each at its own due time, then moves the clock.
    fn advance_to(&mut self, target: u64) -> Result<Option<(u8, usize)>, String> {
        while let Some((i, _)) = self.pending.iter().enumerate().filter(|(_, c)| c.due <= target).min_by_key(|(_, c)| (c.due, c.serial)) {
            self.now = self.now.max(self.pending[i].due);
            self.deliver(i)?;
            self.check(None)?;
        }
        self.now = self.now.max(target);
        Ok(None)
    }

    fn deliver(&mut self, i: usize) -> Res {
        let cb = self.pending.remove(i);
        let fails = self.cb_fails(cb.serial);
        let result = vec![if fails { PromiseResult::Failed } else { PromiseResult::Successful(vec![]) }];
        match cb.kind {
            CbKind::Send { ix, tok, amount, ts } => {
                let o = self.call(Who::Callback, result, |m| m.on_send_done(tk(tok), U128(amount), U64(ts)))?;
                self.ledger[ix].status = if fails { Status::Failed } else { Status::Landed };
                self.stats.bump(if fails { "send_callback_failed" } else { "send_callback_landed" });
                self.check(None)?;
                ensure!(o.sent == !fails, "on_send_done reported {o:?} for a transfer that {}", if fails { "failed" } else { "landed" });
            }
            CbKind::Exec { ix, id, w, requests_before } => {
                let expired = self.now >= w.expires_at.0;
                self.call(Who::Callback, result, |m| m.on_execute_done(U64(id), w.clone(), U64(requests_before)))?;
                self.ledger[ix].status = if fails { Status::Failed } else { Status::Landed };
                if fails {
                    let dropped = near_sdk::test_utils::get_logs().iter().any(|l| l.contains("\"execute_dropped\""));
                    if dropped {
                        self.stats.bump("execute_dropped");
                    } else {
                        ensure!(!expired && self.served.contains(&id_of(&w.requested_by)) && self.era != Era::Kaigen, "a failed execute of request {id} was put back although it is expired or its key is gone");
                        ensure!(self.issued.len() as u64 == requests_before, "a failed execute of request {id} was put back although a request was made while it was out");
                        self.expect_new = Some(id);
                        self.stats.bump("execute_requeued");
                    }
                }
            }
            CbKind::Revoked { key: k } => {
                self.call(Who::Callback, result, |m| m.on_revoked_key_deleted(key(k)))?;
                if fails {
                    self.stats.bump("revoked_delete_failed");
                } else {
                    self.revoked.remove(&k);
                    self.stats.bump("revoked_delete_confirmed");
                }
            }
        }
        Ok(())
    }

    /// The last step of a run: the era rises, and nothing may move after it.
    fn trip(&mut self, e: Era) -> Result<Option<(u8, usize)>, String> {
        self.advance_to(self.now + CB_WINDOW + SEC)?;
        let before = self.ledger.len();
        self.call(Who::Callback, vec![], |m| m.on_era(Ok(e)))?;
        if e == Era::Kaigen {
            self.call(Who::Callback, vec![], |m| m.lock_down())?;
        }
        self.era = e;
        self.sealed = true;
        let probe_key = (1..=KEYS).find(|n| self.served.contains(n)).unwrap_or(1);
        let paused = |msg: String, what: &str| -> Res {
            ensure!(msg.contains("paused") || msg.contains("lockdown") || msg.contains("not a recorded daily key"), "{what} after the era rose: `{msg}`");
            Ok(())
        };
        let r = self.call(Who::Daily(probe_key), vec![], |m| m.send_small(None, U128(1), payee(0)));
        paused(r.err().ok_or("send_small went through after the era rose")?, "send_small")?;
        let r = self.call(Who::Daily(probe_key), vec![], |m| m.request_withdraw(None, U128(1), payee(0)));
        paused(r.err().ok_or("request_withdraw went through after the era rose")?, "request_withdraw")?;
        let id = self.q.first().map_or(0, |i| i.id);
        let r = self.call(Who::Anyone, vec![], |m| m.execute(U64(id)));
        paused(r.err().ok_or("execute went through after the era rose")?, "execute")?;
        ensure!(self.ledger.len() == before, "value moved after the era rose");
        if e == Era::Kaigen {
            self.expect_gone.extend(self.q.iter().map(|i| i.id));
        }
        self.stats.bump(if e == Era::Kaigen { "trip_kaigen" } else { "trip_warning" });
        Ok(None)
    }

    // ---- the checks ---------------------------------------------------------------------------

    fn check(&mut self, per_key: Option<(u8, usize)>) -> Res {
        let (now, cfg) = (self.now, self.cfg.clone());
        let snap = self.view(|m| Snap::read(m, now));
        ensure!(snap.q.len() as u32 <= MAX_QUEUE, "the queue holds {} entries, the cap is {MAX_QUEUE}", snap.q.len());
        let n = self.served.len().max(1) as u128;
        for tok in 0..TOKENS {
            let queued: u128 = snap.q.iter().filter(|i| tok_of(&i.w.token) == tok).map(|i| i.w.amount.0).sum();
            ensure!(queued <= cfg.pending[tok], "token {tok}: {queued} queued against a pending limit of {}", cfg.pending[tok]);
            ensure!(snap.requested_live[tok] <= cfg.pending[tok], "token {tok}: {} asked for in 24 h against {}", snap.requested_live[tok], cfg.pending[tok]);
            ensure!(snap.spent[tok] <= cfg.cap[tok], "token {tok}: window holds {} against a cap of {}", snap.spent[tok], cfg.cap[tok]);
            // The window log never forgets a transfer that left (it may remember one that did not, after a fold).
            let truth = self.truth_used(tok);
            if snap.raw_window[tok] >= MAX_WINDOW_ENTRIES {
                self.folded[tok] = true;
                self.stats.bump("window_log_full");
            }
            ensure!(snap.spent[tok] >= truth, "token {tok}: the window log under-counts: it says {} but {truth} was sent and has not failed", snap.spent[tok]);
            ensure!(self.folded[tok] || snap.spent[tok] == truth, "token {tok}: window log {} differs from the ledger {truth} with no fold", snap.spent[tok]);
            for k in 1..=KEYS {
                ensure!(snap.by_key_live[tok][k as usize] <= cfg.pending[tok], "key {k}, token {tok}: asked for more than the whole pending limit in 24 h");
            }
        }
        if let Some((k, tok)) = per_key {
            // The M2 shares, right after the request that used them: this key holds at most 1/n of the room and of the budget.
            let mine: Vec<&QItem> = snap.q.iter().filter(|i| id_of(&i.w.requested_by) == k).collect();
            ensure!(mine.len() as u128 <= u128::from(MAX_QUEUE) / n, "key {k} holds {} of its {} slots", mine.len(), u128::from(MAX_QUEUE) / n);
            let queued: u128 = mine.iter().filter(|i| tok_of(&i.w.token) == tok).map(|i| i.w.amount.0).sum();
            let share = cfg.pending[tok] / n;
            ensure!(queued <= share, "key {k} has {queued} queued against its share {share} of {} (n = {n})", cfg.pending[tok]);
            ensure!(snap.by_key_live[tok][k as usize] <= share, "key {k} asked for {} in 24 h against its share {share}", snap.by_key_live[tok][k as usize]);
        }
        if !self.sealed {
            ensure!(snap.daily == self.served, "daily keys: contract {:?}, model {:?}", snap.daily, self.served);
            ensure!(snap.revoked == self.revoked, "revoked keys: contract {:?}, model {:?}", snap.revoked, self.revoked);
        }
        for k in 1..=KEYS {
            let seen = self.strikes_view(k);
            ensure!(snap.strikes[k as usize] == seen, "strikes of key {k}: contract {}, model {seen}", snap.strikes[k as usize]);
        }
        // Every queued request is one the vault issued, unchanged, from a key it still serves.
        let unlock_ns = cfg.delay_secs * SEC;
        for i in &snap.q {
            let rec = self.issued.get(&i.id).ok_or_else(|| format!("request {} is queued but was never issued", i.id))?;
            let w = &i.w;
            ensure!(
                tok_of(&w.token) == rec.tok && w.amount.0 == rec.amount && w.to == payee(rec.to) && id_of(&w.requested_by) == rec.by && w.requested_at.0 == rec.at,
                "request {} changed in the queue: {w:?} vs {rec:?}",
                i.id
            );
            ensure!(i.unlocks_at == rec.at + unlock_ns, "request {}: unlocks at {} not {}", i.id, i.unlocks_at, rec.at + unlock_ns);
            ensure!(w.expires_at.0 == i.unlocks_at + EXECUTE_WINDOW_SECS * SEC, "request {}: expires at {}", i.id, w.expires_at.0);
            ensure!(self.sealed || self.served.contains(&rec.by), "request {} is queued for key {} that the vault no longer serves", i.id, rec.by);
        }
        // Nothing enters the queue but the request that was just made (or the one put back), and nothing leaves it
        // but by execute, cancel, expiry, or the removal of its key.
        let before: BTreeMap<u64, QItem> = self.q.iter().map(|i| (i.id, i.clone())).collect();
        let after: BTreeSet<u64> = snap.q.iter().map(|i| i.id).collect();
        for i in &snap.q {
            ensure!(before.contains_key(&i.id) || self.expect_new == Some(i.id), "request {} appeared in the queue from nowhere", i.id);
        }
        for (id, old) in &before {
            if !after.contains(id) {
                let owner_gone = !self.served.contains(&id_of(&old.w.requested_by));
                ensure!(
                    self.expect_gone.contains(id) || now >= old.w.expires_at.0 || owner_gone || self.sealed,
                    "request {id} vanished from the queue (not executed, cancelled, expired or its key removed)"
                );
            }
        }
        self.q = snap.q;
        self.expect_new = None;
        self.expect_gone.clear();
        self.check_bound()
    }

    /// The claim, swept over every 24 h window that starts at a transfer: sends within the cap, execs within the
    /// pending claim, both together within cap + pending claim. Nothing that has not failed is left out.
    fn check_bound(&mut self) -> Res {
        for tok in 0..TOKENS {
            let ev: Vec<&Transfer> = self.ledger.iter().filter(|t| t.tok == tok && t.status != Status::Failed).collect();
            let (mut hi, mut sends, mut execs) = (0usize, 0u128, 0u128);
            let (cap, claim) = (self.cfg.cap[tok], self.cfg.exec_claim(tok));
            let mut lo_sends = 0u128;
            let mut lo_execs = 0u128;
            for lo in 0..ev.len() {
                // The window is (ev[lo].t - 1, ev[lo].t - 1 + 24 h]: every transfer from lo on that is less than 24 h later.
                while hi < ev.len() && ev[hi].t < ev[lo].t + DAY_NS {
                    match ev[hi].kind {
                        Kind::Send => sends += ev[hi].amount,
                        Kind::Exec => execs += ev[hi].amount,
                    }
                    hi += 1;
                }
                let (s, x) = (sends - lo_sends, execs - lo_execs);
                ensure!(s <= cap, "BOUND BROKEN token {tok}: {s} sent through send_small in a window starting at {}, cap {cap}", ev[lo].t);
                ensure!(x <= claim, "BOUND BROKEN token {tok}: {x} executed from the queue in a window starting at {}, claim {claim} (delay {} s)", ev[lo].t, self.cfg.delay_secs);
                ensure!(s + x <= cap + claim, "BOUND BROKEN token {tok}: {} lost in a window starting at {}, claim {}", s + x, ev[lo].t, cap + claim);
                let total = u64::try_from((s + x) * 10_000 / (cap + self.cfg.pending[tok]).max(1)).unwrap_or(u64::MAX);
                self.stats.peak("window_total_bp_of_cap_plus_pending", total);
                self.stats.peak("window_exec_bp_of_pending", u64::try_from(x * 10_000 / self.cfg.pending[tok].max(1)).unwrap_or(u64::MAX));
                self.stats.peak("window_send_bp_of_cap", u64::try_from(s * 10_000 / cap.max(1)).unwrap_or(u64::MAX));
                match ev[lo].kind {
                    Kind::Send => lo_sends += ev[lo].amount,
                    Kind::Exec => lo_execs += ev[lo].amount,
                }
            }
        }
        Ok(())
    }
}

// ---- the generator -------------------------------------------------------------------------------

impl World {
    /// Mostly a key the vault serves (key 1, the attacker, half of the time), now and then any of the nine.
    fn pick_key(&self, r: &mut u64) -> u8 {
        let served: Vec<u8> = self.served.iter().copied().collect();
        match next(r) % 100 {
            0..=44 if self.served.contains(&1) => 1,
            0..=84 if !served.is_empty() => served[(next(r) % served.len() as u64) as usize],
            _ => 1 + (next(r) % u64::from(KEYS)) as u8,
        }
    }

    fn pick_tok(&self, r: &mut u64) -> usize {
        match next(r) % 20 {
            0..=10 => 0,
            11..=17 => 1,
            _ => 2,
        }
    }

    fn send_amount(&self, r: &mut u64, tok: usize) -> u128 {
        let cap = self.cfg.cap[tok];
        let room = cap.saturating_sub(self.truth_used(tok));
        let rnd = |r: &mut u64, m: u128| 1 + u128::from(next(r)) % m.max(1);
        if self.cfg.dust && next(r) % 100 < 98 {
            return rnd(r, 2);
        }
        match next(r) % 16 {
            0 => 1,
            1..=3 => room.max(1),
            4 => room + 1,
            5 => room.saturating_sub(1).max(1),
            6 => cap,
            7 => cap + 1,
            8 => rnd(r, cap),
            9 => rnd(r, cap / 16 + 1),
            10 => 0,
            _ => rnd(r, room),
        }
    }

    fn request_amount(&self, r: &mut u64, tok: usize) -> u128 {
        let p = self.cfg.pending[tok];
        let queued: u128 = self.q.iter().filter(|i| tok_of(&i.w.token) == tok).map(|i| i.w.amount.0).sum();
        let room = p.saturating_sub(queued);
        let share = p / self.served.len().max(1) as u128;
        let rnd = |r: &mut u64, m: u128| 1 + u128::from(next(r)) % m.max(1);
        // The dust runs queue many tiny requests, so the per-key slots (MAX_QUEUE / n) are what runs out.
        if self.cfg.dust && next(r) % 10 < 8 {
            return rnd(r, 2);
        }
        match next(r) % 14 {
            0 => 1,
            1..=3 => room.max(1),
            4 => room + 1,
            5 | 6 => share.max(1),
            7 => share + 1,
            8 => p,
            9 => p + 1,
            10 => rnd(r, p / 16 + 1),
            11 => room.min(share).max(1),
            _ => rnd(r, room),
        }
    }

    /// Instants at which something turns over: a window entry leaves, a request unlocks or expires, a strike ages
    /// out. `fine` adds the nanosecond before and after each, which is where an off-by-one would show.
    fn boundaries(&self, fine: bool) -> Vec<u64> {
        let mut b = vec![];
        let mut add = |t: u64| {
            for x in if fine { vec![t.saturating_sub(1), t, t + 1] } else { vec![t] } {
                if x > self.now {
                    b.push(x);
                }
            }
        };
        for t in self.ledger.iter().rev().take(40) {
            add(t.t + DAY_NS);
        }
        for i in &self.q {
            add(i.unlocks_at);
            add(i.w.expires_at.0);
        }
        for rec in self.issued.values().rev().take(20) {
            add(rec.at + DAY_NS);
        }
        for (_, since) in self.strikes.values() {
            add(since + DAY_NS);
        }
        b
    }

    fn advance_ns(&self, r: &mut u64) -> u64 {
        match next(r) % 24 {
            0..=2 => 0,
            3 => 1,
            4..=7 => SEC,
            8..=9 => 10 * SEC,
            10 => 60 * SEC,
            11 => 3_600 * SEC,
            12 => 6 * 3_600 * SEC,
            13 => DAY_NS - 1,
            14 => DAY_NS,
            15 => DAY_NS + 1,
            16 => self.cfg.delay_secs * SEC,
            _ => {
                let b = self.boundaries(true);
                if b.is_empty() { 60 * SEC } else { b[(next(r) % b.len() as u64) as usize] - self.now }
            }
        }
    }

    /// A drainer that does the most it legally can. It empties the cap; asks for as much as the room, the budget and
    /// each key's share allow, key after key; and executes a due request once half of the request budget is free
    /// again (as late as it can, which is what puts two pending limits into one window when the delay is short) or,
    /// a third of the time, at once (so the last batch of a window is not held back). When the queue is full it adds
    /// a key and asks with it, to see whether the shares of a bigger key set leave the account-wide limit standing,
    /// and now and then it asks where the model says the contract must refuse (room or budget used up), so that a
    /// missing refusal shows.
    fn attack_op(&self, r: &mut u64) -> Op {
        let tok = usize::from(next(r) % 2 == 0);
        let (p, cap) = (self.cfg.pending[tok], self.cfg.cap[tok]);
        let cutoff = self.now.saturating_sub(DAY_NS);
        let asked: u128 = self.issued.values().filter(|v| v.tok == tok && v.at > cutoff).map(|v| v.amount).sum();
        let queued: u128 = self.q.iter().filter(|i| tok_of(&i.w.token) == tok).map(|i| i.w.amount.0).sum();
        let (budget, room) = (p.saturating_sub(asked), p.saturating_sub(queued));
        if self.q.iter().any(|i| self.now >= i.w.expires_at.0) {
            return Op::Purge;
        }
        let due = self.q.iter().position(|i| tok_of(&i.w.token) == tok && self.now >= i.unlocks_at && self.now < i.w.expires_at.0);
        if let Some(ix) = due {
            if budget * 2 >= p || next(r) % 3 == 0 {
                return Op::Execute { pick: ix };
            }
        }
        if budget > 0 && room == 0 && self.served.len() < MAX_DAILY_KEYS as usize && next(r) % 3 == 0 {
            if let Some(k) = (1..=KEYS).find(|k| !self.served.contains(k) && !self.revoked.contains(k)) {
                return Op::AddKey(k);
            }
        }
        let probe = (room == 0 || budget == 0) && next(r) % 4 == 0;
        if (budget > 0 && room > 0) || probe {
            let (t, n) = self.req_at.get();
            let n = if t == self.now { n } else { 0 };
            if n < self.served.len() {
                self.req_at.set((self.now, n + 1));
                let key = *self.served.iter().nth(n).expect("n < len");
                let share = p / self.served.len() as u128;
                let mine: u128 = self.q.iter().filter(|i| id_of(&i.w.requested_by) == key && tok_of(&i.w.token) == tok).map(|i| i.w.amount.0).sum();
                let amount = if room == 0 {
                    share.min(if budget > 0 { budget } else { share })
                } else if budget == 0 {
                    share.saturating_sub(mine).min(room)
                } else {
                    share.saturating_sub(mine).min(room).min(budget)
                };
                return Op::Request { key, tok, amount: amount.max(1), to: 0 };
            }
        }
        let cap_room = cap.saturating_sub(self.truth_used(tok));
        if cap_room > 0 && self.last_send.get() != self.now {
            self.last_send.set(self.now);
            return Op::Send { key: self.served.iter().copied().next().unwrap_or(1), tok, amount: cap_room, to: 0 };
        }
        Op::Advance(self.boundaries(next(r) % 4 == 0).into_iter().min().map_or(60 * SEC, |t| t - self.now))
    }

    fn gen_op(&self, r: &mut u64) -> Op {
        if self.cfg.attacker && next(r) % 100 < 85 {
            return self.attack_op(r);
        }
        let (key, tok, to) = (self.pick_key(r), self.pick_tok(r), (next(r) % 3) as u8);
        let tok = if self.cfg.dust { tok.min(1) } else { tok };
        let pick = next(r) as usize;
        // With a queue nearly full, a new key often arrives: its share is a slice of room the others already hold.
        let nearly_full = (0..2).any(|t| {
            let queued: u128 = self.q.iter().filter(|i| tok_of(&i.w.token) == t).map(|i| i.w.amount.0).sum();
            self.cfg.pending[t] > 0 && queued * 10 >= self.cfg.pending[t] * 9
        });
        if nearly_full && next(r) % 5 == 0 {
            if let Some(k) = (1..=KEYS).find(|k| !self.served.contains(k) && !self.revoked.contains(k)) {
                return Op::AddKey(k);
            }
        }
        // The dust runs mostly send, so the 64-entry window log fills and folds while callbacks fail.
        let roll = if self.cfg.dust && next(r) % 100 < 45 { 0 } else { next(r) % 100 };
        match roll {
            0..=27 => Op::Send { key, tok, amount: self.send_amount(r, tok), to },
            28..=48 => Op::Request { key, tok, amount: self.request_amount(r, tok), to },
            49..=60 => Op::Execute { pick },
            61..=62 => Op::Cancel { pick },
            63 => Op::CancelAll,
            64..=66 => Op::Purge,
            67..=90 => Op::Advance(if self.cfg.dust && next(r) % 40 != 0 { 1 + next(r) % (30 * SEC) } else { self.advance_ns(r) }),
            91..=94 => Op::Deliver { pick },
            95 => Op::AddKey(1 + (next(r) % u64::from(KEYS)) as u8),
            _ => Op::RemoveKey(1 + (next(r) % u64::from(KEYS)) as u8),
        }
    }
}

// ---- runs, replay, shrinking ---------------------------------------------------------------------

struct Failure {
    seed: u64,
    cfg: Cfg,
    ops: Vec<Op>,
    msg: String,
}

enum Outcome {
    Passed(Stats),
    Failed(Box<Failure>),
}

/// The configuration of a run, with a delay the production build refuses replaced by the floor.
fn world_for(seed: u64, stats: &mut Stats) -> Result<World, String> {
    let mut cfg = cfg_for(seed);
    match World::new(cfg.clone()) {
        Ok(w) => Ok(w),
        Err(msg) if msg.contains("withdrawal delay must be at least") => {
            assert!(cfg.delay_secs < MIN_DELAY_SECS, "init refused a delay of {} s: {msg}", cfg.delay_secs);
            stats.bump("init_refused_short_delay");
            cfg.delay_secs = MIN_DELAY_SECS + seed % 3 * 3_600;
            World::new(cfg)
        }
        Err(msg) => Err(msg),
    }
}

fn run_seed(seed: u64, steps: usize) -> Outcome {
    let mut stats = Stats::default();
    let mut w = match world_for(seed, &mut stats) {
        Ok(w) => w,
        Err(msg) => return Outcome::Failed(Box::new(Failure { seed, cfg: cfg_for(seed), ops: vec![], msg })),
    };
    let steps = if w.cfg.dust || w.cfg.attacker { steps * 3 } else { steps };
    let mut r = splitmix(seed);
    let mut ops = vec![];
    let result = (|| -> Res {
        for _ in 0..steps {
            let op = w.gen_op(&mut r);
            ops.push(op.clone());
            w.step(&op)?;
        }
        // The last step: sometimes the era rises. Then every callback still in the air is delivered.
        if next(&mut r) % 8 == 0 {
            let op = Op::Trip(if next(&mut r) % 2 == 0 { Era::Warning } else { Era::Kaigen });
            ops.push(op.clone());
            w.step(&op)?;
        }
        let op = Op::Advance(CB_WINDOW + SEC);
        ops.push(op.clone());
        w.step(&op)
    })();
    match result {
        Ok(()) => {
            assert!(w.pending.is_empty(), "callbacks left in the air");
            stats.merge(&w.stats);
            Outcome::Passed(stats)
        }
        Err(msg) => Outcome::Failed(Box::new(Failure { seed, cfg: w.cfg.clone(), ops, msg })),
    }
}

/// Runs `ops` from a fresh vault; Err is the first violation.
fn replay(cfg: &Cfg, ops: &[Op]) -> Res {
    let mut w = World::new(cfg.clone())?;
    for op in ops {
        w.step(op)?;
    }
    Ok(())
}

/// Removes chunks of steps while the sequence still breaks something (at most `budget` replays).
fn shrink(cfg: &Cfg, ops: Vec<Op>, mut budget: usize) -> Vec<Op> {
    let mut cur = ops;
    let mut chunk = cur.len().div_ceil(2).max(1);
    loop {
        let mut i = 0;
        while i < cur.len() && budget > 0 {
            let mut cand = cur.clone();
            cand.drain(i..(i + chunk).min(cur.len()));
            budget -= 1;
            if replay(cfg, &cand).is_err() {
                cur = cand;
            } else {
                i += chunk;
            }
        }
        if chunk == 1 || budget == 0 {
            return cur;
        }
        chunk = chunk.div_ceil(2);
    }
}

fn run_many(seeds: u64, steps: usize) -> (Stats, Option<Failure>) {
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8) as u64;
    let results: Vec<Outcome> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|w| s.spawn(move || (w..seeds).step_by(workers as usize).map(|seed| run_seed(seed, steps)).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("a worker panicked")).collect()
    });
    let mut stats = Stats::default();
    let mut failure = None;
    for o in results {
        match o {
            Outcome::Passed(s) => stats.merge(&s),
            Outcome::Failed(f) => {
                if failure.as_ref().is_none_or(|g: &Failure| f.ops.len() < g.ops.len()) {
                    failure = Some(*f);
                }
            }
        }
    }
    (stats, failure)
}

fn env_or(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn report(f: Failure) -> ! {
    let small = shrink(&f.cfg, f.ops.clone(), 300);
    let why = replay(&f.cfg, &small).err().unwrap_or_else(|| f.msg.clone());
    let steps: Vec<String> = small.iter().enumerate().map(|(i, op)| format!("  {i:>3}: {op:?}")).collect();
    panic!(
        "seed {} broke the model ({} steps, shrunk to {}).\nfirst violation: {}\nshrunk violation: {why}\nconfig: {:?}\nsteps:\n{}",
        f.seed,
        f.ops.len(),
        small.len(),
        f.msg,
        f.cfg,
        steps.join("\n")
    );
}

// ---- the tests -----------------------------------------------------------------------------------

#[test]
fn the_loss_bound_holds_after_every_step_of_random_multi_key_sequences() {
    let (seeds, steps) = (env_or("KAIGEN_PROP_SEEDS", 300), env_or("KAIGEN_PROP_STEPS", 110) as usize);
    let (stats, failure) = run_many(seeds, steps);
    if let Some(f) = failure {
        report(f);
    }
    println!("{seeds} seeds x {steps} steps (dust runs three times as long)\ncounts: {:#?}\npeaks (basis points): {:#?}", stats.count, stats.peak);
    if bound_only() {
        let soft = SOFT.lock().unwrap();
        println!("BOUND-ONLY: the loss bound held in every window of every step; {} other checks failed and were not fatal, first: {:?}", soft.0, soft.1);
        return;
    }
    // A property over sequences that never reach the interesting states proves nothing: every case below has to
    // have been met, and the attacker has to have reached the claimed bound itself, not just stayed under it.
    for what in [
        "send_ok",
        "request_ok",
        "execute_ok",
        "execute_locked",
        "execute_expired",
        "cancel_ok",
        "cancel_all_nonempty",
        "purge_nonempty",
        "refusal_counted",
        "refusal_uncounted_cap_used_up",
        "refusal_uncounted_dust",
        "refusal_uncounted_no_limit",
        "key_burned",
        "key_added",
        "key_removed",
        "send_by_unserved_key",
        "send_callback_failed",
        "send_callback_landed",
        "execute_requeued",
        "execute_dropped",
        "revoked_delete_confirmed",
        "request_refused_pending_sum",
        "request_refused_key_slots",
        "request_refused_key_queue_share",
        "request_refused_key_budget_share",
        "window_log_full",
        "trip_kaigen",
        "trip_warning",
    ] {
        assert!(stats.count.get(what).copied().unwrap_or(0) > 0, "the sequences never met `{what}`: {:?}", stats.count);
    }
    assert!(stats.peak["window_send_bp_of_cap"] >= 10_000, "no run ever used the whole cap: {:?}", stats.peak);
    assert!(stats.peak["window_exec_bp_of_pending"] >= 10_000, "no run ever executed a whole pending limit inside one window: {:?}", stats.peak);
    assert!(stats.peak["window_total_bp_of_cap_plus_pending"] >= 10_000, "no run ever lost cap + pending in one window: {:?}", stats.peak);
    if cfg!(feature = "drill") {
        // The build that allows a delay under a day must show why the floor exists: more than cap + pending in one window.
        assert!(
            stats.peak["window_total_bp_of_cap_plus_pending"] > 10_000,
            "no drill run found the 2 x pending limit that a short delay allows: {:?}",
            stats.peak
        );
    } else {
        assert!(stats.count.get("init_refused_short_delay").copied().unwrap_or(0) > 0, "no run offered a delay under a day: {:?}", stats.count);
        assert_eq!(stats.peak["window_total_bp_of_cap_plus_pending"], 10_000, "the claim is cap + pending, no more: {:?}", stats.peak);
    }
}

/// Runs the scripted steps on a vault with `cfg` (a production-valid delay) and returns the world.
fn scripted(cfg: Cfg, ops: &[Op]) -> World {
    let mut w = World::new(cfg).expect("the vault initialises");
    for (i, op) in ops.iter().enumerate() {
        w.step(op).unwrap_or_else(|e| panic!("step {i} {op:?}: {e}"));
    }
    w
}

fn plain_cfg(delay_secs: u64) -> Cfg {
    Cfg { delay_secs, cap: [1_000, 1_000, 0], pending: [3_000, 3_000, 0], min_send: 0, max_strikes: 3, allowlist: false, keys: 2, fail_pct: 0, cb_seed: 1, dust: false, attacker: false }
}

#[test]
fn a_calibrated_attacker_loses_exactly_cap_plus_pending_in_one_window_and_not_one_more() {
    // The bound is tight, so the property above is not a vacuous upper limit. Two keys, so each may queue half of
    // the pending limit (1500 of 3000). Request both halves, wait out the 24 h delay, then in one window send the
    // whole cap and execute both requests: 1000 + 3000. Then try for one more of each.
    let d = 86_400;
    let w = scripted(
        plain_cfg(d),
        &[
            Op::Request { key: 1, tok: 0, amount: 1_500, to: 2 },
            Op::Request { key: 2, tok: 0, amount: 1_500, to: 2 },
            Op::Advance(d * SEC),
            Op::Send { key: 1, tok: 0, amount: 1_000, to: 2 },
            Op::Execute { pick: 0 },
            Op::Execute { pick: 0 },
            Op::Send { key: 2, tok: 0, amount: 1, to: 2 },
            Op::Request { key: 1, tok: 0, amount: 1, to: 2 },
            Op::Advance(60 * SEC),
        ],
    );
    assert_eq!(w.stats.peak["window_total_bp_of_cap_plus_pending"], 10_000);
    assert_eq!(w.stats.count["refusal_uncounted_cap_used_up"], 1, "the extra unit is refused without a strike");
    assert_eq!(w.stats.count["execute_ok"], 2);
    assert!(w.strikes.is_empty(), "the calibrated attacker is never struck");
    // The request made after the cap was used up cannot run inside this window: it unlocks a day after it was made.
    let queued = w.q.len();
    assert_eq!(queued, 1);
}

#[test]
fn a_delay_under_a_day_lets_two_pending_limits_through_one_window_which_is_what_the_floor_is_for() {
    // The same attacker against a vault whose delay was lowered below the floor (the production `init` refuses
    // it, so the field is set directly, as the helpers in tests.rs do). Two keys, 1500 each of the 3000.
    let mut w = World::new(plain_cfg(MIN_DELAY_SECS)).unwrap();
    w.env(Who::Admin, vec![]);
    let mut m = Mamori::try_from_slice(&w.state).unwrap();
    m.delay_secs = 3_600;
    w.state = near_sdk::borsh::to_vec(&m).unwrap();
    drop(m);
    w.storage = with_mocked_blockchain(|b| b.take_storage());
    w.cfg.delay_secs = 3_600;
    let h = 3_600 * SEC;
    // Ask at t, execute at t + 23 h, ask again at t + 24 h (the request budget of the first is out of its 24 h),
    // execute at t + 25 h: four executions, 6000 = 2 x pending, inside one 24 h window.
    let steps = [
        Op::Request { key: 1, tok: 0, amount: 1_500, to: 2 },
        Op::Request { key: 2, tok: 0, amount: 1_500, to: 2 },
        Op::Advance(23 * h),
        Op::Execute { pick: 0 },
        Op::Execute { pick: 0 },
        Op::Advance(h),
        Op::Request { key: 1, tok: 0, amount: 1_500, to: 2 },
        Op::Request { key: 2, tok: 0, amount: 1_500, to: 2 },
        Op::Advance(h),
        Op::Execute { pick: 0 },
        Op::Execute { pick: 0 },
    ];
    let broke = steps.iter().find_map(|op| w.step(op).err());
    let executed: u128 = w.ledger.iter().filter(|t| t.kind == Kind::Exec).map(|t| t.amount).sum();
    if cfg!(feature = "drill") {
        // A drill build claims 2 x pending for a short delay (ARCHITECTURE.md section 5) and meets it exactly.
        assert_eq!(broke, None);
        assert_eq!(executed, 6_000);
    } else {
        // A production build claims cap + pending only because `init` refuses this delay: with it, the model sees
        // more, and the third execution is the first to cross 3000.
        let e = broke.expect("with a 1 h delay the model must see more than the production claim");
        assert!(e.contains("BOUND BROKEN") && e.contains("claim 3000"), "{e}");
        assert_eq!(executed, 4_500);
    }
}

#[test]
fn a_failure_callback_more_than_a_day_late_gives_nothing_back_so_the_window_cannot_under_count() {
    // Assumption A5 used to be: the refund in `on_send_done` finds its entry by time and amount; inside 24 h the entry
    // is there, or a later slot stands in for it, which can only over-count; after 24 h the next send had pruned the
    // entry and the refund took the failed amount out of ANOTHER send's entry (window said 200 with 600 in flight, and
    // the next 800 went through). The property test never reached it, because it delivers every callback within 30 s.
    // Now a send that has left the 24 h window is not refunded at all: nothing counts it, so there is nothing to give back.
    let mut w = World::new(plain_cfg(MIN_DELAY_SECS)).unwrap();
    w.step(&Op::Send { key: 1, tok: 0, amount: 400, to: 2 }).unwrap();
    let late = w.pending.remove(0); // the callback of that send, held back
    w.step(&Op::Advance(DAY_NS + 60 * SEC)).unwrap(); // the 400 leaves the window
    w.step(&Op::Send { key: 1, tok: 0, amount: 600, to: 2 }).unwrap(); // fits: the window is empty again
    w.pending.push(late);
    w.cfg.fail_pct = 100;
    let i = w.pending.len() - 1;
    w.now += 61 * SEC; // the callback arrives 24 h and a minute late, reporting that the 400 never left
    w.deliver(i).expect("the late failure takes nothing out of the 600 that did leave");
    let (spent, log) = w.view(|m| (m.spent_24h(None).0, m.window.get(&None::<AccountId>).cloned().unwrap_or_default()));
    assert_eq!(spent, 600, "the window still says what is in flight");
    assert_eq!(log.iter().map(|(_, a)| a).sum::<u128>(), 600, "and so does the stored log: {log:?}");
    // So the attacker does not get the 400 back: 600 is in flight, and another 800 is refused, uncounted.
    w.step(&Op::Send { key: 1, tok: 0, amount: 800, to: 2 }).expect("the model and the contract agree that 800 does not fit");
    assert_eq!(w.stats.count["refusal_uncounted_cap_used_up"], 1);
    assert!(w.strikes.is_empty());
}

#[test]
fn failure_callbacks_that_arrive_up_to_three_days_late_never_make_the_window_under_count() {
    // The property test above delivers within 30 s. This one holds a third of the send callbacks back by 12 to 60 h
    // while the clock moves in jumps of up to 20 h, with half of the callbacks reporting a failure, and the model
    // checks after every step and every delivery that the window never says less than what has left and not failed.
    let (mut late, mut late_failures, mut aged_out_failures) = (0u64, 0u64, 0u64);
    for seed in 0..120u64 {
        let mut r = splitmix(seed ^ 0x5EED_1A7E);
        let mut cfg = plain_cfg(MIN_DELAY_SECS);
        cfg.fail_pct = 50;
        cfg.cb_seed = r;
        let mut w = World::new(cfg).expect("the vault initialises");
        for step in 0..80 {
            let known = w.pending.len();
            let op = match next(&mut r) % 5 {
                0..=2 => Op::Send { key: 1 + (next(&mut r) % 2) as u8, tok: 0, amount: 1 + u128::from(next(&mut r) % 700), to: 2 },
                3 => Op::Advance(1 + next(&mut r) % (20 * 3_600 * SEC)),
                _ => Op::Advance(next(&mut r) % (60 * SEC)),
            };
            w.step(&op).unwrap_or_else(|e| panic!("seed {seed} step {step} {op:?}: {e}"));
            if w.pending.len() > known && next(&mut r) % 3 == 0 {
                let delay = 12 * 3_600 * SEC + next(&mut r) % (48 * 3_600 * SEC);
                let (due, serial, ts) = {
                    let cb = w.pending.last_mut().expect("the new callback");
                    let CbKind::Send { ts, .. } = cb.kind else { continue };
                    cb.due = w.now + delay;
                    (cb.due, cb.serial, ts)
                };
                late += 1;
                if w.cb_fails(serial) {
                    late_failures += 1;
                    aged_out_failures += u64::from(due - ts >= DAY_NS);
                }
            }
        }
        w.step(&Op::Advance(4 * DAY_NS)).unwrap_or_else(|e| panic!("seed {seed} drain: {e}"));
        assert!(w.pending.is_empty(), "callbacks left in the air");
    }
    println!("late callbacks {late}, of which reporting a failure {late_failures}, of which a day or more after the send {aged_out_failures}");
    assert!(aged_out_failures >= 50, "the run met only {aged_out_failures} failures that arrived a day or more late");
}

fn exec_cb(w: &World, id: u64) -> usize {
    w.pending.iter().position(|c| matches!(&c.kind, CbKind::Exec { id: i, .. } if *i == id)).expect("its callback is in the air")
}

fn queue_pos(w: &World, id: u64) -> usize {
    w.q.iter().position(|i| i.id == id).expect("it is queued")
}

/// The order of the finding in docs/v3/LOSS-BOUND.md 2.2: four requests of 750 (two per key; pending limit 3000) unlock,
/// two of them (ids 1 and 3) are executed and their transfers will fail, a request of 750 per key is made while they are
/// out, the other two (ids 0 and 2) are executed, and then the failure callbacks arrive. Every callback is held back by
/// hand so that the clock and the order are the test's. Returns the world after the callbacks, with the new requests as
/// ids 4 and 5.
fn two_failed_executes_with_requests_made_while_they_were_out() -> World {
    let d = MIN_DELAY_SECS;
    let mut w = World::new(plain_cfg(d)).unwrap();
    for (k, a) in [(1u8, 750u128), (1, 750), (2, 750), (2, 750)] {
        w.step(&Op::Request { key: k, tok: 0, amount: a, to: 2 }).unwrap();
    }
    w.step(&Op::Advance(d * SEC)).unwrap(); // all four unlock; their request budget has aged out to the nanosecond
    let hold = |w: &mut World| w.pending.iter_mut().for_each(|c| c.due = u64::MAX / 2);
    for id in [1u64, 3] {
        let p = queue_pos(&w, id);
        w.step(&Op::Execute { pick: p }).unwrap(); // out of the queue; the transfer will fail
        hold(&mut w);
    }
    for k in [1u8, 2] {
        w.step(&Op::Request { key: k, tok: 0, amount: 750, to: 2 }).unwrap(); // takes the room the two in flight held
    }
    assert_eq!(w.stats.count["request_ok"], 6);
    w.step(&Op::Advance(SEC)).unwrap();
    for id in [0u64, 2] {
        let p = queue_pos(&w, id);
        w.step(&Op::Execute { pick: p }).unwrap(); // frees the room the two in flight would need to come back
        hold(&mut w);
    }
    for (id, fail_pct) in [(1u64, 100u64), (3, 100), (0, 0), (2, 0)] {
        let i = exec_cb(&w, id);
        w.cfg.fail_pct = fail_pct;
        w.deliver(i).and_then(|_| w.check(None)).unwrap_or_else(|e| panic!("callback of {id}: {e}"));
    }
    w.cfg.fail_pct = 0;
    w
}

#[test]
fn a_failed_execute_is_not_put_back_after_a_request_was_made_while_it_was_out() {
    // Without the rule the two failed executes came back (the queue sum did not see them while they were out), were
    // executed again, and 4500 = 1.5 x the pending limit left the queue inside one 24 h window ("BOUND BROKEN").
    let mut w = two_failed_executes_with_requests_made_while_they_were_out();
    w.step(&Op::Advance(0)).unwrap();
    assert_eq!(w.stats.count["execute_dropped"], 2, "both failed executes are dropped: {:?}", w.stats.count);
    assert!(w.stats.count.get("execute_requeued").is_none(), "{:?}", w.stats.count);
    let queued: Vec<u64> = w.q.iter().map(|i| i.id).collect();
    assert!(queued.contains(&4) && queued.contains(&5) && queued.len() == 2, "only the two new requests are queued: {queued:?}");
    // The new requests unlock a day after they were made, which is inside the same 24 h window as the two executes.
    w.step(&Op::Advance(MIN_DELAY_SECS * SEC - SEC)).unwrap();
    for id in [4u64, 5] {
        let p = queue_pos(&w, id);
        w.step(&Op::Execute { pick: p }).unwrap_or_else(|e| panic!("execute of {id}: {e}"));
    }
    assert_eq!(w.stats.peak["window_exec_bp_of_pending"], 10_000, "the window carried exactly one pending limit: {:?}", w.stats.peak);
    // The keys whose requests were dropped can ask again; they are not locked out.
    w.step(&Op::Request { key: 1, tok: 0, amount: 750, to: 2 }).unwrap();
    assert_eq!(w.stats.count["request_ok"], 7);
}

#[test]
fn a_failed_execute_with_no_request_made_while_it_was_out_still_comes_back_and_can_run_again() {
    // The rule must cost the honest case nothing: the same first steps, no new requests in between.
    let d = MIN_DELAY_SECS;
    let mut w = World::new(plain_cfg(d)).unwrap();
    for (k, a) in [(1u8, 750u128), (2, 750)] {
        w.step(&Op::Request { key: k, tok: 0, amount: a, to: 2 }).unwrap();
    }
    w.step(&Op::Advance(d * SEC)).unwrap();
    let p = queue_pos(&w, 0);
    w.step(&Op::Execute { pick: p }).unwrap();
    w.pending.iter_mut().for_each(|c| c.due = u64::MAX / 2);
    w.step(&Op::Advance(SEC)).unwrap();
    let i = exec_cb(&w, 0);
    w.cfg.fail_pct = 100;
    w.deliver(i).and_then(|_| w.check(None)).unwrap();
    w.cfg.fail_pct = 0;
    assert_eq!(w.stats.count["execute_requeued"], 1);
    assert!(w.q.iter().any(|i| i.id == 0), "the request is back");
    let p = queue_pos(&w, 0);
    w.step(&Op::Execute { pick: p }).expect("and it can be executed again");
}