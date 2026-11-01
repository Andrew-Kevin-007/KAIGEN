//! Mamori (守り, protection): the KAIGEN guard that runs on every vault account.
//!
//! Key model: one ML-DSA-65 full-access admin key (the only full-access key) plus classical
//! function-call "daily keys" limited to `send_small` and `request_withdraw`. Admin methods are
//! gated on `predecessor == current account`: only a full-access key can sign those calls, because
//! the runtime already stops a daily key from calling any other method. The contract therefore
//! never has to read the admin key, which matters because it is a post-quantum key.
//! When Kizashi reports `kaigen`, `trip` deletes every recorded classical key.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, is_promise_success, near, require, serde_json, AccountId, Allowance, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

const DAY_NS: u64 = 86_400_000_000_000;
const MAX_DAILY_KEYS: u32 = 8;
const MAX_INTENTS_KEYS: u32 = 8;
const MAX_QUEUE: u32 = 32;
const MAX_ALLOWED: u32 = 32;
/// Refused attacks tolerated from one daily key inside a 24 hour window before the vault burns that key.
const DEFAULT_MAX_STRIKES: u32 = 3;
const MAX_STRIKES_CEILING: u32 = 10;
/// Bound on sends remembered per token per 24 h. A send that finds the log full is folded into the newest
/// entry, which then expires 24 h after that send: dust can neither bloat storage nor lock honest keys out,
/// and no send ever leaves the cap early.
const MAX_WINDOW_ENTRIES: usize = 64;
/// Default for how much value may wait in the withdrawal queue at once, and be asked for in 24 h, per token,
/// as a multiple of that token's 24 h limit. A token without a limit therefore gets zero.
/// `set_pending_limit` overrides it.
const PENDING_LIMIT_MULTIPLE: u128 = 10;
/// Default smallest NEAR `send_small` (0.001 NEAR, a few times its own gas); `set_min_send` changes it.
const DEFAULT_MIN_SEND: NearToken = NearToken::from_millinear(1);
const NO_LIMIT_REASON: &str = "no 24 h limit is set for this token";
const BELOW_MIN_REASON: &str = "below the minimum send";
const DEFAULT_ALLOWANCE: NearToken = NearToken::from_millinear(250);
const DAILY_METHODS: &str = "send_small,request_withdraw";
const INTENTS: &str = "intents.near";

const ERA_GAS: Gas = Gas::from_tgas(5);
const FT_GAS: Gas = Gas::from_tgas(30);
const INTENTS_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Bookkeeping callbacks that only touch a set.
const SMALL_CALLBACK_GAS: Gas = Gas::from_tgas(5);
/// `on_era` itself plus the `lock_down` receipt it schedules.
const TRIP_CALLBACK_GAS: Gas = Gas::from_tgas(200);
/// Least gas `lock_down` is given; `on_era` passes it everything it has left on top (unused gas weight).
const LOCK_DOWN_GAS: Gas = Gas::from_tgas(150);
/// `lock_down` starts another key only with this much gas left. Measured in the unit-test VM, which charges
/// the real fees: a daily key costs about 20 Tgas (delete, callback, and a data receipt for the `then`) and
/// an intents key about 34 Tgas, so 8 + 8 keys need over 400 Tgas: more than one transaction can carry.
/// What does not fit stays recorded for the next `trip`. Includes room for the writes that close the receipt.
const FANOUT_STEP_GAS: Gas = Gas::from_tgas(40);
/// A zero or tiny delay lets a daily key empty the vault through `request_withdraw` + `execute`
/// before the admin can react, so `init` refuses it. Drill builds may use shorter delays (they do not
/// enforce this at all). This is the production floor, 24 h: a withdrawal a hijacked key queues must outlast
/// a day, so an owner who looks once a day can still cancel it. It is a decision about every production
/// vault (the `pending_limit` and `request_withdraw` budget bound how much can be queued, the delay bounds
/// how fast), so lower it only on purpose. Keep it a multiple of 3600, the refusal message counts hours.
#[cfg_attr(feature = "drill", allow(dead_code))] // only `init`'s production check reads it
const MIN_DELAY_SECS: u64 = 86_400;

/// Same wire format as Kizashi's `Era`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Era {
    Calm,
    Warning,
    Kaigen,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Withdrawal {
    /// `None` is NEAR; `Some(contract)` is a NEP-141 token.
    pub token: Option<AccountId>,
    pub amount: U128,
    pub to: AccountId,
    pub requested_at: U64,
    /// The daily key that asked. Removing or burning that key cancels the request.
    pub requested_by: PublicKey,
}

/// Refusals counted against one daily key in the current window.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct Strikes {
    count: u32,
    since: u64,
}

/// What `send_small` tells its caller. A refusal is a normal, recorded outcome rather than a panic, because
/// a panic would roll back the strike it has to count.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendOutcome {
    pub sent: bool,
    pub refused: Option<String>,
    /// How many refusals this key has now in the 24 hour window.
    pub strikes: u32,
    /// True when this refusal was the last one allowed: the vault deleted the key.
    pub burned: bool,
}

impl SendOutcome {
    fn sent() -> Self {
        Self { sent: true, refused: None, strikes: 0, burned: false }
    }
}

#[near(serializers = [json])]
pub struct QueuedView {
    pub id: U64,
    #[serde(flatten)]
    pub withdrawal: Withdrawal,
    /// Earliest `execute` time (ns): the request time plus the delay. `execute` also needs the era to be
    /// calm, so a request that unlocks while the era is warning or kaigen stays frozen (see `execute`).
    pub unlocks_at: U64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub kizashi: AccountId,
    pub era: Era,
    pub daily_limit: U128,
    pub delay_secs: u64,
    /// Always equal to `delay_secs`. The delay used to double at warning, but `execute` only runs while the
    /// era is calm, so no request could ever have waited out a doubled delay and the doubling was removed.
    /// The field stays so that existing readers of this view keep parsing it.
    pub effective_delay_secs: u64,
    pub max_strikes: u32,
    /// Most NEAR that may wait in the withdrawal queue at once, and be asked for in 24 h.
    pub pending_limit: U128,
    /// Smallest NEAR `send_small` accepts.
    pub min_send: U128,
}

#[near(serializers = [json])]
pub struct AllowlistView {
    pub enforced: bool,
    pub accounts: Vec<AccountId>,
}

#[ext_contract(ext_kizashi)]
#[allow(dead_code)]
trait KizashiView {
    fn era(&self) -> Era;
}

/// Nothing is deployed to mainnet yet and the testnet drill vaults are throwaway, so these fields may still
/// change. From the first mainnet deploy on, a layout change makes every deployed vault fail to read its
/// state, `trip` included: it then needs a `migrate` that reads the old layout. The test
/// `the_state_layout_is_pinned_so_a_change_cannot_brick_a_deployed_vault_unnoticed` fails on any change.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mamori {
    kizashi: AccountId,
    /// 24 h cap for NEAR, in yoctoNEAR. Tokens need an explicit `set_token_limit`; none means zero.
    daily_limit: u128,
    delay_secs: u64,
    /// Cached from Kizashi by `trip`.
    era: Era,
    daily_keys: IterableSet<PublicKey>,
    intents_keys: IterableSet<PublicKey>,
    token_limits: LookupMap<AccountId, u128>,
    /// Admin overrides of the default pending limit, per token (`None` is NEAR).
    pending_limits: LookupMap<Option<AccountId>, u128>,
    /// Value asked for through `request_withdraw` in the last 24 h, per token. Neither `execute` nor `cancel`
    /// takes anything back out, so the pending limit also bounds the rate, whatever the delay.
    requested: LookupMap<Option<AccountId>, Vec<(u64, u128)>>,
    /// Smallest NEAR `send_small`, in yoctoNEAR.
    min_send: u128,
    window: LookupMap<Option<AccountId>, Vec<(u64, u128)>>,
    queue: IterableMap<u64, Withdrawal>,
    next_id: u64,
    /// Optional policy: when enforced, `send_small` can only pay these accounts. Larger sends still go
    /// through the delayed queue, where the admin can cancel them.
    allowed: IterableSet<AccountId>,
    allowlist_enforced: bool,
    /// Refusals per daily key. At `max_strikes` the key is burned.
    max_strikes: u32,
    strikes: LookupMap<PublicKey, Strikes>,
    /// Daily keys the vault no longer serves (removed by the admin, or burned for repeated refusals) whose
    /// deletion from the account the account has not confirmed. See `delete_revoked_key`.
    revoked_keys: IterableSet<PublicKey>,
}

#[near]
impl Mamori {
    /// Admin, once.
    #[init]
    #[private]
    pub fn init(kizashi: AccountId, daily_limit: U128, delay_secs: u64) -> Self {
        #[cfg(not(feature = "drill"))]
        require!(
            delay_secs >= MIN_DELAY_SECS,
            format!("withdrawal delay must be at least {} hours", MIN_DELAY_SECS / 3600)
        );
        Self {
            kizashi,
            daily_limit: daily_limit.0,
            delay_secs,
            era: Era::Calm,
            daily_keys: IterableSet::new(b"d"),
            intents_keys: IterableSet::new(b"i"),
            token_limits: LookupMap::new(b"l"),
            pending_limits: LookupMap::new(b"p"),
            requested: LookupMap::new(b"r"),
            min_send: DEFAULT_MIN_SEND.as_yoctonear(),
            window: LookupMap::new(b"w"),
            queue: IterableMap::new(b"q"),
            next_id: 0,
            allowed: IterableSet::new(b"a"),
            allowlist_enforced: false,
            max_strikes: DEFAULT_MAX_STRIKES,
            strikes: LookupMap::new(b"s"),
            revoked_keys: IterableSet::new(b"x"),
        }
    }

    // ---- admin ----------------------------------------------------------------------------

    /// Adds a classical function-call key limited to `send_small` and `request_withdraw`, and records it.
    pub fn add_daily_key(&mut self, public_key: PublicKey, allowance: Option<U128>) -> Promise {
        self.assert_admin();
        require!(self.era != Era::Kaigen, "lockdown: classical keys can no longer be added");
        require!(self.daily_keys.len() < MAX_DAILY_KEYS, "too many daily keys");
        require!(self.daily_keys.insert(public_key.clone()), "daily key already recorded");
        let allowance = allowance.map_or(DEFAULT_ALLOWANCE, |a| NearToken::from_yoctonear(a.0));
        let me = env::current_account_id();
        emit("add_daily_key", serde_json::json!({ "public_key": public_key }));
        Promise::new(me.clone())
            .add_access_key_allowance(
                public_key.clone(),
                Allowance::limited(allowance).unwrap_or_else(|| env::panic_str("allowance must be > 0")),
                me.clone(),
                DAILY_METHODS,
            )
            .then(Self::ext(me).with_static_gas(SMALL_CALLBACK_GAS).on_key_added(public_key))
    }

    /// Stops serving a daily key at once, cancels its queued requests and deletes it from the account. The
    /// key stays in `revoked_keys()` until the account confirms the delete, so a delete that failed is not
    /// forgotten: calling this again for such a key retries the delete, and kaigen's `lock_down` tries once more.
    pub fn remove_daily_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_admin();
        let served = self.daily_keys.remove(&public_key);
        require!(served || self.revoked_keys.contains(&public_key), "unknown daily key");
        emit("remove_daily_key", serde_json::json!({ "public_key": public_key, "retry": !served }));
        self.cancel_queued_by(&public_key, "key_removed");
        self.delete_revoked_key(&public_key)
    }

    /// Adds a classical key on `intents.near` for swaps and records it so `trip` can remove it.
    pub fn register_intents_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_admin();
        require!(self.era != Era::Kaigen, "lockdown: classical keys can no longer be added");
        require!(self.intents_keys.len() < MAX_INTENTS_KEYS, "too many intents keys");
        require!(self.intents_keys.insert(public_key.clone()), "intents key already recorded");
        emit("register_intents_key", serde_json::json!({ "public_key": public_key }));
        intents_call("add_public_key", &public_key)
    }

    /// Spend cap for a NEP-141 token over 24 h, in the token's smallest unit. Zero disables it.
    pub fn set_token_limit(&mut self, token: AccountId, limit: U128) {
        self.assert_admin();
        self.token_limits.insert(token, limit.0);
    }

    /// The most value of one token (`None` is NEAR) that may wait in the withdrawal queue at once, and be
    /// asked for through `request_withdraw` in any 24 h. Without a call, it is `PENDING_LIMIT_MULTIPLE` times
    /// the token's 24 h limit, so zero for a token without one. Zero here shuts the queue for that token.
    pub fn set_pending_limit(&mut self, token: Option<AccountId>, limit: U128) {
        self.assert_admin();
        emit("set_pending_limit", serde_json::json!({ "token": token, "limit": limit }));
        self.pending_limits.insert(token, limit.0);
    }

    /// Smallest NEAR amount `send_small` accepts; smaller ones are refused without a strike.
    pub fn set_min_send(&mut self, min: U128) {
        self.assert_admin();
        self.min_send = min.0;
        emit("set_min_send", serde_json::json!({ "min": min }));
    }

    /// Adds a recipient that `send_small` may pay while the allowlist is enforced.
    pub fn allow_recipient(&mut self, account: AccountId) {
        self.assert_admin();
        require!(self.allowed.len() < MAX_ALLOWED, "allowlist is full");
        require!(self.allowed.insert(account.clone()), "already allowed");
        emit("allow_recipient", serde_json::json!({ "account": account }));
    }

    pub fn disallow_recipient(&mut self, account: AccountId) {
        self.assert_admin();
        require!(self.allowed.remove(&account), "not on the allowlist");
        emit("disallow_recipient", serde_json::json!({ "account": account }));
    }

    /// How many refusals one daily key may collect in 24 hours before the vault burns it.
    pub fn set_max_strikes(&mut self, max: u32) {
        self.assert_admin();
        require!((1..=MAX_STRIKES_CEILING).contains(&max), "max strikes must be between 1 and 10");
        self.max_strikes = max;
        emit("set_max_strikes", serde_json::json!({ "max": max }));
    }

    /// Turns the recipient policy on or off. Off by default, so an empty list never locks anyone out.
    pub fn enforce_allowlist(&mut self, on: bool) {
        self.assert_admin();
        self.allowlist_enforced = on;
        emit("enforce_allowlist", serde_json::json!({ "on": on }));
    }

    pub fn cancel(&mut self, id: U64) {
        self.assert_admin();
        let w = self.queue.remove(&id.0).unwrap_or_else(|| env::panic_str("no such request"));
        emit("cancel", serde_json::json!({ "id": id, "to": w.to, "token": w.token, "amount": w.amount }));
    }

    // ---- daily keys -----------------------------------------------------------------------

    /// Sends within the 24 h limit, to allowed recipients. Paused once the era is warning.
    ///
    /// A request that breaks the policy (a recipient not on the allowlist, or more than the limit) is
    /// REFUSED, not reverted: the call succeeds, nothing moves, and the refusal counts as a strike against
    /// the key that made it. At `max_strikes` inside 24 hours the vault deletes that key. A hijacked agent
    /// therefore gets a handful of attempts, not an unlimited number of tries or an unlimited gas bill.
    ///
    /// Two refusals are returned the same way but earn NO strike, because they say nothing about the key:
    /// a token with no 24 h limit (an honest first send of a new token must not burn a key) and a NEAR
    /// amount below the minimum send (dust). Neither moves anything; the key's gas allowance bounds them.
    ///
    /// What earns no strike, all of it on purpose, so nobody has to re-derive it: those two refusals; every
    /// panic (a zero amount, an era that is not calm, a caller that is not a recorded daily key), because a
    /// panic rolls its own strike back; and every refusal of `request_withdraw` (see there). Each still costs
    /// the caller gas from the key's allowance, and the runtime deletes a function-call key whose allowance
    /// is used up, so none of them is unbounded. Counting dust or an unlisted token would burn the honest key
    /// that retries a new token before the admin lists it; counting `request_withdraw` refusals needs a new
    /// return type for that method.
    pub fn send_small(&mut self, token: Option<AccountId>, amount: U128, to: AccountId) -> PromiseOrValue<SendOutcome> {
        self.assert_daily_key();
        require!(self.era == Era::Calm, "paused: era is not calm");
        require!(amount.0 > 0, "amount must be > 0");
        let key = env::signer_account_pk();
        if self.allowlist_enforced && !self.allowed.contains(&to) {
            return PromiseOrValue::Value(self.refuse(&key, "recipient is not on the allowlist"));
        }
        if self.limit_for(&token) == 0 {
            return PromiseOrValue::Value(self.refuse_uncounted(&key, NO_LIMIT_REASON));
        }
        if token.is_none() && amount.0 < self.min_send {
            return PromiseOrValue::Value(self.refuse_uncounted(&key, BELOW_MIN_REASON));
        }
        let now = env::block_timestamp();
        if let Err(reason) = self.spend(&token, amount.0, now) {
            return PromiseOrValue::Value(self.refuse(&key, reason));
        }
        emit("send_small", serde_json::json!({ "token": token, "amount": amount, "to": to }));
        PromiseOrValue::Promise(transfer(&token, amount.0, to).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_send_done(token, amount, U64(now)),
        ))
    }

    /// Queues a larger send. The admin can cancel until it unlocks. Per token, the pending limit bounds the
    /// value waiting in the queue at once and also the value asked for in any 24 h: executing or cancelling
    /// a request gives none of that budget back. A hijacked key can therefore put only that much at risk,
    /// and move at most that much a day, whatever the delay.
    ///
    /// Only while the era is calm, like `execute`: outside calm a request could never run, so accepting it
    /// would only spend the request budget and a queue slot on something frozen. At kaigen the refusal says
    /// "lockdown", at warning "paused".
    ///
    /// Refusals here are panics, not recorded outcomes, so they earn no strike (a panic rolls the strike back).
    /// That covers an amount over the pending limit or the 24 h request budget, and a full queue. Turning
    /// them into recorded refusals would change this method's return type (a public contract), and a full
    /// queue or a spent budget is as likely an honest key as a hijacked one; what bounds a key that keeps
    /// trying is the gas allowance of its access key, which each failed call spends.
    pub fn request_withdraw(&mut self, token: Option<AccountId>, amount: U128, to: AccountId) -> U64 {
        self.assert_daily_key();
        require!(self.era != Era::Kaigen, "lockdown");
        require!(self.era == Era::Calm, "paused: era is not calm");
        require!(amount.0 > 0, "amount must be > 0");
        require!(self.queue.len() < MAX_QUEUE, "queue full");
        require!(self.fits_pending(&token, amount.0), "over the pending limit for this token");
        let limit = self.pending_limit_for(&token);
        require!(
            Self::add_to_window(&mut self.requested, &token, amount.0, env::block_timestamp(), limit),
            "over the 24 h pending limit for this token"
        );
        let id = self.next_id;
        self.next_id += 1;
        let requested_by = env::signer_account_pk();
        let w = Withdrawal { token, amount, to, requested_at: U64(env::block_timestamp()), requested_by };
        emit("request_withdraw", serde_json::json!({ "id": id, "token": w.token, "amount": w.amount, "to": w.to }));
        self.queue.insert(id, w);
        U64(id)
    }

    // ---- anyone ---------------------------------------------------------------------------

    /// Sends a queued request once the delay has passed AND the era is calm. Both are needed, always.
    ///
    /// What a warning does to a queued request: nothing leaves through it. It stays in the queue, frozen,
    /// whether or not its delay has passed, and the admin can `cancel` it at any time (cancel is never paused).
    /// The era only rises in production, so a request still queued when a warning arrives never executes;
    /// at kaigen `lock_down` discards the queue and logs what it held. (A drill vault follows Kizashi back
    /// down after its `reset`, and then its frozen requests can run once the era is calm and they are unlocked.)
    pub fn execute(&mut self, id: U64) -> Promise {
        require!(self.era == Era::Calm, "paused: era is not calm");
        let w = self.queue.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        require!(env::block_timestamp() >= self.unlocks_at(&w), "still locked");
        self.queue.remove(&id.0);
        emit("execute", serde_json::json!({ "id": id, "to": w.to, "token": w.token, "amount": w.amount }));
        transfer(&w.token, w.amount.0, w.to.clone()).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_execute_done(id, w),
        )
    }

    /// Reads `kizashi.era()`. At kaigen: removes recorded keys from `intents.near`, deletes every recorded
    /// classical key and cancels the queue. At warning: pauses `send_small`, `request_withdraw` and `execute`
    /// (keys and the queue stay, and the admin can still cancel a queued request).
    ///
    /// A full vault (8 + 8 keys) needs more than one trip at kaigen, because the cleanup costs more gas than
    /// one transaction carries (see `lock_down`). Repeat the trip until `intents_keys()` and `daily_keys()`
    /// are both empty; each pass logs `lockdown_partial` while keys are left. A vault with only a few keys
    /// finishes in one.
    pub fn trip(&self) -> Promise {
        ext_kizashi::ext(self.kizashi.clone())
            .with_static_gas(ERA_GAS)
            .era()
            .then(Self::ext(env::current_account_id()).with_static_gas(TRIP_CALLBACK_GAS).on_era())
    }

    // ---- callbacks ------------------------------------------------------------------------

    #[private]
    pub fn on_era(&mut self, #[callback_result] reported: Result<Era, PromiseError>) -> Era {
        let reported = reported.unwrap_or_else(|_| env::panic_str("kizashi unreachable"));
        // Production: the era only ever rises. Drill vaults follow Kizashi down after its `reset`.
        #[cfg(not(feature = "drill"))]
        let new_era = self.era.max(reported);
        #[cfg(feature = "drill")]
        let new_era = reported;

        let changed = new_era != self.era;
        self.era = new_era;
        emit("trip", serde_json::json!({ "era": self.era, "changed": changed }));
        if self.era == Era::Kaigen {
            // The fan-out gets its own receipt: if it runs out of gas it fails alone and the era cached
            // above stays. Every trip at kaigen schedules it again, which is what retries failed deletes.
            let _ = Self::ext(env::current_account_id())
                .with_static_gas(LOCK_DOWN_GAS)
                .with_unused_gas_weight(1)
                .lock_down();
        }
        self.era
    }

    /// Kaigen cleanup, scheduled by `on_era`: discards the queue (logging what it held), then removes
    /// recorded keys from `intents.near`, then forgets and deletes recorded classical keys.
    ///
    /// The order is deliberate. An intents key can sign on `intents.near` without ever calling Mamori; a
    /// daily key can do nothing once the era is cached, because `send_small` and `request_withdraw` refuse
    /// at kaigen. So the keys that can still act go first, and no daily key is started while an intents
    /// removal is left to start.
    ///
    /// All 8 + 8 keys cost more gas than one transaction carries, so a pass stops when the gas it was given
    /// runs low. Whatever is left stays recorded, `lockdown_partial` says what, and the next `trip`
    /// carries on. A keeper is done when `intents_keys()` and `daily_keys()` are both empty.
    #[private]
    pub fn lock_down(&mut self) {
        require!(self.era == Era::Kaigen, "lockdown only runs at kaigen");
        let me = env::current_account_id();
        let queued: Vec<u64> = self.queue.keys().copied().collect();
        let discarded = self.take_from_queue(queued);
        if !discarded.is_empty() {
            emit("queue_discarded", serde_json::json!({ "reason": "lockdown", "withdrawals": discarded }));
        }
        let intents: Vec<PublicKey> = self.intents_keys.iter().cloned().collect();
        for k in intents.into_iter().take_while(|_| has_fanout_gas()) {
            self.intents_keys.remove(&k);
            // One receipt per key, so a failure on one cannot cancel the removal of the others.
            // A dropped near-sdk promise is still scheduled; the callback re-records a failed key.
            let _ = intents_call("remove_public_key", &k)
                .then(Self::ext(me.clone()).with_static_gas(SMALL_CALLBACK_GAS).on_intents_removed(k));
        }
        let keys: Vec<PublicKey> = self.daily_keys.iter().cloned().collect();
        for k in keys.into_iter().take_while(|_| has_fanout_gas()) {
            self.daily_keys.remove(&k);
            let _ = Promise::new(me.clone())
                .delete_key(k.clone())
                .then(Self::ext(me.clone()).with_static_gas(SMALL_CALLBACK_GAS).on_key_removed(k));
        }
        // Last: keys the vault stopped serving earlier whose delete was never confirmed. Each gets one more try
        // and is then let go (a failure is logged by its callback, not recorded again): such a key can sign
        // nothing the contract accepts, and recording it again would keep lockdown from ever finishing.
        let revoked: Vec<PublicKey> = self.revoked_keys.iter().cloned().collect();
        for k in revoked.into_iter().take_while(|_| has_fanout_gas()) {
            self.revoked_keys.remove(&k);
            let _ = Promise::new(me.clone())
                .delete_key(k.clone())
                .then(Self::ext(me.clone()).with_static_gas(SMALL_CALLBACK_GAS).on_revoked_key_deleted(k));
        }
        let (daily_left, intents_left, revoked_left) = (self.daily_keys.len(), self.intents_keys.len(), self.revoked_keys.len());
        if daily_left + intents_left + revoked_left > 0 {
            emit(
                "lockdown_partial",
                serde_json::json!({ "daily_keys_left": daily_left, "intents_keys_left": intents_left, "revoked_keys_left": revoked_left }),
            );
        }
    }

    #[private]
    pub fn on_send_done(&mut self, token: Option<AccountId>, amount: U128, ts: U64) -> SendOutcome {
        if is_promise_success() {
            return SendOutcome::sent();
        }
        // The send failed, so the funds never left: give the spend back. A send folded into a full log has
        // no entry of its own: take it back from the first entry at or after its time, which holds it.
        if let Some(log) = self.window.get_mut(&token) {
            let at = log
                .iter()
                .position(|&(t, a)| t == ts.0 && a == amount.0)
                .or_else(|| log.iter().position(|&(t, a)| t >= ts.0 && a >= amount.0));
            if let Some(i) = at {
                log[i].1 -= amount.0;
                if log[i].1 == 0 {
                    log.remove(i);
                }
            }
        }
        SendOutcome { sent: false, refused: Some("the transfer failed and was refunded to the daily limit".to_string()), strikes: 0, burned: false }
    }

    #[private]
    pub fn on_execute_done(&mut self, id: U64, withdrawal: Withdrawal) {
        if is_promise_success() {
            return;
        }
        // The funds never left. Put the request back to retry or cancel, unless the vault has locked
        // down meanwhile (the queue was cleared on purpose), its key was removed or burned meanwhile (its
        // requests were cancelled on purpose), or newer requests took the slot or the pending headroom.
        let room = self.queue.len() < MAX_QUEUE && self.fits_pending(&withdrawal.token, withdrawal.amount.0);
        if self.era == Era::Kaigen || !room || !self.daily_keys.contains(&withdrawal.requested_by) {
            emit("execute_dropped", serde_json::json!({ "id": id, "to": withdrawal.to, "token": withdrawal.token, "amount": withdrawal.amount }));
        } else {
            self.queue.insert(id.0, withdrawal);
        }
    }

    /// If the AddKey failed (for example the key already exists on the account), forget it: a
    /// recorded key that is not really a daily key could later get a real key deleted.
    #[private]
    pub fn on_key_added(&mut self, public_key: PublicKey) {
        if !is_promise_success() {
            self.daily_keys.remove(&public_key);
            emit("add_daily_key_failed", serde_json::json!({ "public_key": public_key }));
        }
    }

    /// Lockdown deleted this key, or failed to. A failure re-records it so the next `trip` retries.
    #[private]
    pub fn on_key_removed(&mut self, public_key: PublicKey) {
        if !is_promise_success() {
            self.daily_keys.insert(public_key.clone());
            emit("delete_key_failed", serde_json::json!({ "public_key": public_key }));
        }
    }

    /// The account answered for the delete of a key the vault had stopped serving (removed or burned). Success
    /// clears it from `revoked_keys`. A failure leaves it there, still not served, and logs it: the admin can
    /// retry with `remove_daily_key`, and `lock_down` tries once more at kaigen. A delete most likely fails
    /// because the account no longer holds the key (unverified: the runtime also drops a function-call key
    /// whose gas allowance is used up). A retry then fails the same way, which is why `lock_down` tries each
    /// leftover once and lets it go rather than recording it again.
    #[private]
    pub fn on_revoked_key_deleted(&mut self, public_key: PublicKey) {
        if is_promise_success() {
            self.revoked_keys.remove(&public_key);
        } else {
            emit("delete_key_failed", serde_json::json!({ "public_key": public_key, "revoked": true }));
        }
    }

    /// Same for a key on `intents.near`.
    #[private]
    pub fn on_intents_removed(&mut self, public_key: PublicKey) {
        if !is_promise_success() {
            self.intents_keys.insert(public_key.clone());
            emit("intents_remove_failed", serde_json::json!({ "public_key": public_key }));
        }
    }

    // ---- views ----------------------------------------------------------------------------

    pub fn era(&self) -> Era {
        self.era
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            kizashi: self.kizashi.clone(),
            era: self.era,
            daily_limit: self.daily_limit.into(),
            delay_secs: self.delay_secs,
            effective_delay_secs: self.delay_secs,
            max_strikes: self.max_strikes,
            pending_limit: self.pending_limit_for(&None).into(),
            min_send: self.min_send.into(),
        }
    }

    pub fn daily_keys(&self) -> Vec<PublicKey> {
        self.daily_keys.iter().cloned().collect()
    }

    pub fn intents_keys(&self) -> Vec<PublicKey> {
        self.intents_keys.iter().cloned().collect()
    }

    /// Daily keys the vault has stopped serving whose deletion from the account is not confirmed yet.
    pub fn revoked_keys(&self) -> Vec<PublicKey> {
        self.revoked_keys.iter().cloned().collect()
    }

    pub fn allowlist(&self) -> AllowlistView {
        AllowlistView { enforced: self.allowlist_enforced, accounts: self.allowed.iter().cloned().collect() }
    }

    /// Refusals this key has in the current window.
    pub fn strikes_of(&self, public_key: PublicKey) -> u32 {
        let cutoff = env::block_timestamp().saturating_sub(DAY_NS);
        self.strikes.get(&public_key).filter(|s| s.since > cutoff).map_or(0, |s| s.count)
    }

    pub fn token_limit(&self, token: Option<AccountId>) -> U128 {
        self.limit_for(&token).into()
    }

    /// Most value of this token (`None` is NEAR) that may wait in the withdrawal queue at once, and be asked
    /// for in 24 h.
    pub fn pending_limit(&self, token: Option<AccountId>) -> U128 {
        self.pending_limit_for(&token).into()
    }

    pub fn queue(&self) -> Vec<QueuedView> {
        self.queue
            .iter()
            .map(|(id, w)| QueuedView { id: U64(*id), withdrawal: w.clone(), unlocks_at: U64(self.unlocks_at(w)) })
            .collect()
    }

    /// Amount already spent through `send_small` in the last 24 h.
    pub fn spent_24h(&self, token: Option<AccountId>) -> U128 {
        let cutoff = env::block_timestamp().saturating_sub(DAY_NS);
        self.window
            .get(&token)
            .map_or(0, |log| log.iter().filter(|(t, _)| *t > cutoff).map(|(_, a)| a).sum())
            .into()
    }
}

impl Mamori {
    fn assert_admin(&self) {
        require!(env::predecessor_account_id() == env::current_account_id(), "admin only");
    }

    fn assert_daily_key(&self) {
        let me = env::current_account_id();
        require!(
            env::predecessor_account_id() == me && env::signer_account_id() == me,
            "daily key only"
        );
        require!(self.daily_keys.contains(&env::signer_account_pk()), "not a recorded daily key");
    }

    fn limit_for(&self, token: &Option<AccountId>) -> u128 {
        match token {
            None => self.daily_limit,
            Some(t) => self.token_limits.get(t).copied().unwrap_or(0),
        }
    }

    /// Rolling 24 h cap: the sum of sends in the last 24 h plus this one must stay within the limit.
    fn spend(&mut self, token: &Option<AccountId>, amount: u128, now: u64) -> Result<(), &'static str> {
        let limit = self.limit_for(token);
        if Self::add_to_window(&mut self.window, token, amount, now, limit) {
            Ok(())
        } else {
            Err("over the 24 h limit")
        }
    }

    /// Adds `amount` to the token's log of (time, amount) and returns true when the last 24 h plus it stay
    /// within `limit`. Otherwise nothing is stored.
    fn add_to_window(
        windows: &mut LookupMap<Option<AccountId>, Vec<(u64, u128)>>,
        token: &Option<AccountId>,
        amount: u128,
        now: u64,
        limit: u128,
    ) -> bool {
        let cutoff = now.saturating_sub(DAY_NS);
        let mut log: Vec<(u64, u128)> =
            windows.get(token).map(|l| l.iter().copied().filter(|(t, _)| *t > cutoff).collect()).unwrap_or_default();
        let used: u128 = log.iter().map(|(_, a)| a).sum();
        if !used.checked_add(amount).is_some_and(|total| total <= limit) {
            return false;
        }
        let full = log.len() >= MAX_WINDOW_ENTRIES;
        match log.last_mut() {
            // Full: fold into the newest entry instead of refusing. Its time moves up to now, so the folded
            // sends expire later than they strictly need to, never earlier. Fits: used + amount <= limit.
            Some(newest) if full => {
                newest.0 = now;
                newest.1 += amount;
            }
            _ => log.push((now, amount)),
        }
        windows.insert(token.clone(), log);
        true
    }

    /// The most value of `token` that may wait in the queue: the admin's override, else a multiple of the
    /// token's 24 h limit (zero for a token without one).
    fn pending_limit_for(&self, token: &Option<AccountId>) -> u128 {
        self.pending_limits
            .get(token)
            .copied()
            .unwrap_or_else(|| self.limit_for(token).saturating_mul(PENDING_LIMIT_MULTIPLE))
    }

    /// Whether `amount` more of `token` would still fit under its pending limit.
    fn fits_pending(&self, token: &Option<AccountId>, amount: u128) -> bool {
        let queued = self.queue.values().filter(|w| &w.token == token).fold(0u128, |sum, w| sum.saturating_add(w.amount.0));
        queued.checked_add(amount).is_some_and(|total| total <= self.pending_limit_for(token))
    }

    /// Removes these queued requests and returns each as event data, so that nothing leaves the queue
    /// without a log line saying what it was.
    fn take_from_queue(&mut self, ids: Vec<u64>) -> Vec<serde_json::Value> {
        ids.into_iter()
            .filter_map(|id| {
                let w = self.queue.remove(&id)?;
                Some(serde_json::json!({
                    "id": U64(id), "token": w.token, "amount": w.amount, "to": w.to, "requested_by": w.requested_by
                }))
            })
            .collect()
    }

    /// A daily key that is gone (removed or burned) takes its queued requests with it. Other keys' stay.
    fn cancel_queued_by(&mut self, key: &PublicKey, reason: &str) {
        let ids: Vec<u64> = self.queue.iter().filter(|(_, w)| &w.requested_by == key).map(|(id, _)| *id).collect();
        let cancelled = self.take_from_queue(ids);
        if !cancelled.is_empty() {
            emit("queue_cancelled", serde_json::json!({ "public_key": key, "reason": reason, "withdrawals": cancelled }));
        }
    }

    /// Records that `key` is owed a deletion and schedules it, with a callback that clears the record once the
    /// account confirms. The caller has already stopped serving the key, so there is no window in which a key
    /// the admin (or the strikes) revoked still works while the delete is in flight. The record is made before
    /// the delete is scheduled and cleared only on success, so a delete that fails (or whose callback never
    /// runs) leaves the key on record. Idempotent: a second delete for the same key, or one racing a
    /// `lock_down` sweep, can only fail harmlessly and never re-records anything.
    fn delete_revoked_key(&mut self, key: &PublicKey) -> Promise {
        self.revoked_keys.insert(key.clone());
        let me = env::current_account_id();
        Promise::new(me.clone())
            .delete_key(key.clone())
            .then(Self::ext(me).with_static_gas(SMALL_CALLBACK_GAS).on_revoked_key_deleted(key.clone()))
    }

    /// A refusal that is not the key's fault (see `send_small`): reported, but not counted.
    fn refuse_uncounted(&self, key: &PublicKey, reason: &str) -> SendOutcome {
        let strikes = self.strikes_of(key.clone());
        emit("refused", serde_json::json!({ "public_key": key, "reason": reason, "strikes": strikes, "counted": false }));
        SendOutcome { sent: false, refused: Some(reason.to_string()), strikes, burned: false }
    }

    /// Records a refusal against `key`. At `max_strikes` inside the window the key is removed from the
    /// recorded set (so the contract stops serving it at once) and deleted from the account.
    fn refuse(&mut self, key: &PublicKey, reason: &str) -> SendOutcome {
        let now = env::block_timestamp();
        // A key with no record, or whose window has run out, starts a fresh window at this refusal.
        let mut record = match self.strikes.get(key) {
            Some(r) if now.saturating_sub(r.since) <= DAY_NS => *r,
            _ => Strikes { count: 0, since: now },
        };
        record.count += 1;
        emit("refused", serde_json::json!({ "public_key": key, "reason": reason, "strikes": record.count, "counted": true }));
        let burned = record.count >= self.max_strikes;
        if burned {
            self.strikes.remove(key);
            self.daily_keys.remove(key);
            self.cancel_queued_by(key, "key_burned");
            // Dropping the promise still schedules it. The key is unrecorded first, so the contract refuses it
            // at once whether or not the delete lands; `revoked_keys` keeps it on record until the account
            // confirms the delete, so a failed one is retried at kaigen rather than forgotten.
            let _ = self.delete_revoked_key(key);
            emit("key_burned", serde_json::json!({ "public_key": key, "reason": reason }));
        } else {
            self.strikes.insert(key.clone(), record);
        }
        SendOutcome { sent: false, refused: Some(reason.to_string()), strikes: record.count, burned }
    }

    fn unlocks_at(&self, w: &Withdrawal) -> u64 {
        w.requested_at.0.saturating_add(self.delay_secs.saturating_mul(1_000_000_000))
    }
}

/// Whether this receipt can still afford to start another key's fan-out.
fn has_fanout_gas() -> bool {
    env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas()) >= FANOUT_STEP_GAS.as_gas()
}

fn transfer(token: &Option<AccountId>, amount: u128, to: AccountId) -> Promise {
    match token {
        None => Promise::new(to).transfer(NearToken::from_yoctonear(amount)),
        // Daily keys cannot attach deposits, so the 1 yoctoNEAR NEP-141 needs comes from this balance.
        Some(t) => Promise::new(t.clone()).function_call(
            "ft_transfer".to_string(),
            serde_json::json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            FT_GAS,
        ),
    }
}

fn intents_call(method: &str, key: &PublicKey) -> Promise {
    Promise::new(INTENTS.parse().unwrap()).function_call(
        method.to_string(),
        serde_json::json!({ "public_key": key }).to_string().into_bytes(),
        NearToken::from_yoctonear(1),
        INTENTS_GAS,
    )
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "kaigen", "version": "1.0.0", "event": event, "data": data })
    ));
}

#[cfg(test)]
mod tests;
