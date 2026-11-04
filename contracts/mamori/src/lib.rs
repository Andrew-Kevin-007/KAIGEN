//! Mamori (守り, protection): the KAIGEN guard that runs on every vault account.
//!
//! Key model: one ML-DSA-65 full-access admin key (the only full-access key) plus classical
//! function-call "daily keys" limited to `send_small` and `request_withdraw`. Admin methods are
//! gated on `predecessor == current account`: only a full-access key can sign those calls, because
//! the runtime already stops a daily key from calling any other method. The contract therefore
//! never has to read the admin key, which matters because it is a post-quantum key.
//! When Kizashi reports `kaigen`, `trip` deletes every recorded classical key.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, is_promise_success, near, require, serde_json, AccountId, Allowance, Gas,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};

const DAY_NS: u64 = 86_400_000_000_000;
const MAX_DAILY_KEYS: u32 = 8;
const MAX_INTENTS_KEYS: u32 = 8;
/// Most keys the vault records at once as served (`daily_keys`) plus awaiting the account's confirmation of their
/// deletion (`revoked_keys`). `add_daily_key` refuses to record a new key past it, and nothing else grows the sum: a
/// key that is removed or burned only moves from one set to the other, so containment is never blocked by it.
/// Twice the daily-key limit, so a full set of served keys can all be burned with room left for as many again. It
/// keeps the one pass of `lock_down` that reads the revoked set, and `attest()`, bounded. See docs/v3/LOSS-BOUND.md.
const MAX_KEY_RECORDS: u32 = 2 * MAX_DAILY_KEYS;
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
/// Shape version of `attest()`'s answer (see `Attestation::attest_version`).
const ATTEST_VERSION: u32 = 1;
/// Carried in every `attest()` answer, so a raw reader sees what it is looking at.
const ATTEST_NOTE: &str = "informational: the state this contract records, not proof about the account. A full-access key can deploy a contract whose attest() says anything. Read the code hash and the key list from RPC (view_account, view_access_key_list).";

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
/// How long a queued request stays executable once it has unlocked: it expires at `unlocks_at` plus this.
/// A decision, not a copy of anyone's default. `execute` is permissionless and one call, so a day is far more
/// than any keeper needs. It equals the production delay floor, so a request lives at most `delay + 24 h`: an
/// owner who looks once per delay period (the cadence the 24 h delay already assumes) has seen it before it
/// can run, and one the owner missed does not stay armed for more than a day after it unlocks. A window of a
/// few hours would be shorter than the delay it follows and would punish an honest keeper that checks daily.
/// Expiry only ever removes requests from what can execute, so it cannot loosen the loss bound.
const EXECUTE_WINDOW_SECS: u64 = 86_400;
/// Most queue entries one purge looks at. The queue never holds more than `MAX_QUEUE` entries, expired ones
/// included (every insert first clears the expired ones, then checks for room), so this is the whole queue.
/// It is a guard: `purge_expired` can be called by anyone, and its gas must stay bounded even if that stopped
/// being true.
const PURGE_SCAN_LIMIT: usize = MAX_QUEUE as usize;
/// Most accounts the admin may name as watchers at once (`add_watcher`). A watcher can only call `sweep_to_safe`.
const MAX_WATCHERS: u32 = 4;
/// Longest emergency window the admin may declare in one call, in seconds: a week. Watchers can sweep only inside
/// one, so a stolen watcher is idle outside it, and an owner who leaves for longer than this has to declare again.
const MAX_EMERGENCY_SECS: u64 = 7 * 86_400;
/// Most proposals the policy account may have waiting at once. Expired ones are cleared before a new one is counted.
const MAX_PROPOSALS: u32 = 8;

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
    /// First instant (ns) at which the request can no longer execute: its unlock time plus
    /// `EXECUTE_WINDOW_SECS`. A request at or past this time is stale and never runs.
    pub expires_at: U64,
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

/// A change the policy account may propose. A closed list of the admin's loosening settings: each is applied, after the
/// delay, by the same private function the admin's own method uses, so a proposal can do nothing the admin could not.
/// Not here, on purpose: the NEAR cap (it has no setter at all), intents keys, the allowlist switch, the minimum send,
/// the strike limit, and everything about the policy account, the safe account, the watchers and the emergency window.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    AddDailyKey { public_key: PublicKey, allowance: Option<U128> },
    SetTokenLimit { token: AccountId, limit: U128 },
    SetPendingLimit { token: Option<AccountId>, limit: U128 },
    AllowRecipient { account: AccountId },
}

/// A change waiting for its delay. The admin can cancel it until `apply` runs it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub change: Change,
    pub proposed_at: U64,
    /// First instant (ns) at which `apply` may run it: `proposed_at` plus the withdrawal delay.
    pub executable_at: U64,
    /// First instant (ns) at which it can no longer run: `executable_at` plus `EXECUTE_WINDOW_SECS`.
    pub expires_at: U64,
}

#[near(serializers = [json])]
pub struct ProposalView {
    pub id: U64,
    #[serde(flatten)]
    pub proposal: Proposal,
}

/// A safe account the admin has named that is not in force yet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSafe {
    pub account: AccountId,
    /// First instant (ns) at which it replaces the current safe account: the change plus the withdrawal delay.
    pub effective_at: U64,
}

/// The safe account in force now, and the change waiting for its delay, if any.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafeAccountView {
    pub current: Option<AccountId>,
    pub pending: Option<PendingSafe>,
}

/// One recorded daily key in `attest()`.
#[near(serializers = [json])]
pub struct KeyAttestation {
    pub public_key: PublicKey,
    /// Refusals counted against it in the current window (what `strikes_of` returns).
    pub strikes: u32,
}

/// What `attest()` reports: the state this contract RECORDS, for cage-check to compare with the chain. It is
/// information from the contract's own books, not proof about the account: see `attest`.
#[near(serializers = [json])]
pub struct Attestation {
    /// Shape of this object. Raised when a field is removed or changes meaning; adding a field does not raise it.
    pub attest_version: u32,
    /// Always `"mamori"`, so a reader can tell it is not looking at some other contract's `attest`.
    pub contract: String,
    /// True in a drill build (`--features drill`): shorter delays are allowed and the era follows Kizashi down.
    /// A drill build does not keep the loss bound's delay condition (`docs/v3/LOSS-BOUND.md`).
    pub drill_build: bool,
    /// The account this contract answered as, for cage-check to compare with the account it asked about.
    pub account_id: AccountId,
    pub block_height: U64,
    /// Block time (ns) the answer is as of.
    pub block_timestamp: U64,
    /// Era, caps, delay and strike limit as configured now (NEAR only: per-token caps are read with `token_limit`).
    pub config: ConfigView,
    /// The least `delay_secs` a production `init` accepts. Reported so a reader does not hard-code it.
    pub min_delay_secs: u64,
    pub allowlist_enforced: bool,
    pub allowlist_len: u32,
    /// The daily keys the vault serves, with their strikes. Any function-call key on the account that is not
    /// listed here is outside the strike and cap accounting.
    pub daily_keys: Vec<KeyAttestation>,
    /// Keys recorded on `intents.near`. Each signs there with no cap from this contract.
    pub intents_keys: Vec<PublicKey>,
    /// Daily keys the vault stopped serving whose deletion from the account is not confirmed yet.
    pub revoked_keys: Vec<PublicKey>,
    /// Withdrawal requests waiting in the queue (expired ones included until purged).
    pub queue_len: u32,
    /// The one account whose `propose_*` calls the vault accepts (`None`: the policy path is off).
    pub policy_account: Option<AccountId>,
    /// Where `sweep_to_safe` sends value, and the change of it that is waiting for its delay.
    pub safe_account: SafeAccountView,
    /// The accounts that may call `sweep_to_safe`, while an emergency window is open.
    pub watchers: Vec<AccountId>,
    /// End (ns) of the emergency window; at or before the block time it is closed.
    pub emergency_until: U64,
    /// Changes the policy account proposed that have neither been applied nor cancelled (expired ones included until cleared).
    pub proposals: Vec<ProposalView>,
    /// Fixed text: what this answer is and is not.
    pub note: String,
}

#[near(serializers = [json])]
pub struct AllowlistView {
    pub enforced: bool,
    pub accounts: Vec<AccountId>,
}

/// Why a proposed `send_small` goes through, is refused or is rejected. The snake_case name (`code`) is the stable
/// machine-readable code, in `check`'s answer and in the `reason_code` of the events; the text (`text`) is what
/// `send_small` has always returned in `SendOutcome::refused` and in panics. Table: docs/v3/ATTEST-CHECK.md.
#[near(serializers = [json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// `send_small` would go through now.
    Ok,
    /// Refused, counted: the recipient is not on the enforced allowlist.
    NotAllowlisted,
    /// Refused, counted: more than the WHOLE 24 h limit, which no window can ever hold.
    OverCapTotal,
    /// Refused, not counted: fits the limit but not what is left of it (the window is account-wide).
    CapExhausted,
    /// Refused, not counted: the token has no 24 h limit (NEAR with limit zero too).
    NoLimit,
    /// Refused, not counted: a NEAR amount below the minimum send.
    BelowMinSend,
    /// Rejected (a panic): the key is not a recorded daily key (never added, removed or burned).
    NotADailyKey,
    /// Rejected (a panic): the era is not calm.
    EraNotCalm,
    /// Rejected (a panic): a zero amount.
    ZeroAmount,
    /// Not a decision about a call: the transfer `send_small` made failed and its spend was given back.
    TransferFailed,
}

impl Reason {
    /// The stable code. Written out rather than taken from serde, and a test ties the two together.
    pub fn code(self) -> &'static str {
        match self {
            Reason::Ok => "ok",
            Reason::NotAllowlisted => "not_allowlisted",
            Reason::OverCapTotal => "over_cap_total",
            Reason::CapExhausted => "cap_exhausted",
            Reason::NoLimit => "no_limit",
            Reason::BelowMinSend => "below_min_send",
            Reason::NotADailyKey => "not_a_daily_key",
            Reason::EraNotCalm => "era_not_calm",
            Reason::ZeroAmount => "zero_amount",
            Reason::TransferFailed => "transfer_failed",
        }
    }

    /// The human text, unchanged from before the codes existed (callers and tests match on it).
    pub fn text(self) -> &'static str {
        match self {
            Reason::Ok => "ok",
            Reason::NotAllowlisted => "recipient is not on the allowlist",
            Reason::OverCapTotal | Reason::CapExhausted => "over the 24 h limit",
            Reason::NoLimit => NO_LIMIT_REASON,
            Reason::BelowMinSend => BELOW_MIN_REASON,
            Reason::NotADailyKey => "not a recorded daily key",
            Reason::EraNotCalm => "paused: era is not calm",
            Reason::ZeroAmount => "amount must be > 0",
            Reason::TransferFailed => "the transfer failed and was refunded to the daily limit",
        }
    }
}

/// What `send_small` would do with a call, as `check` reports it.
#[near(serializers = [json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// It would go through.
    Allow,
    /// It would be refused: the call succeeds, nothing moves, and it may count as a strike.
    Refuse,
    /// It would abort (a panic): nothing is recorded, no strike.
    Reject,
}

/// `check`'s answer. Advisory only: see `Mamori::check`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CheckView {
    pub verdict: Verdict,
    pub reason: Reason,
    /// True when `send_small` would count the refusal as a strike against the key.
    pub counted: bool,
    /// True when that strike would be the key's last one: the vault would burn (delete) the key.
    pub would_burn: bool,
    /// What is left of the asset's 24 h limit now, in its smallest unit (zero for an asset without a limit).
    pub headroom: U128,
}

/// The call a refusal is about, carried to the event that logs it.
struct Attempt<'a> {
    token: &'a Option<AccountId>,
    amount: u128,
    to: &'a AccountId,
}

/// The decision about one `send_small` call. One function makes it (`judge_send`) and both `send_small` and
/// `check` use it, so the advice cannot drift from the enforcement.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Judgement {
    Allow,
    /// Refused as a recorded outcome; the flag says whether it counts as a strike.
    Refuse(Reason, bool),
    /// Aborts the call.
    Reject(Reason),
}

#[ext_contract(ext_kizashi)]
#[allow(dead_code)]
trait KizashiView {
    fn era(&self) -> Era;
}

/// The key of `requested_by_key`: a daily key, and the token it asked in (`None` is NEAR).
type RequestedByKeyId = (PublicKey, Option<AccountId>);

/// Nothing is deployed to mainnet yet and the testnet drill vaults are throwaway, so these fields may still
/// change. From the first mainnet deploy on, a layout change makes every deployed vault fail to read its
/// state, `trip` included: it then needs a `migrate` that reads the old layout. The test
/// `the_state_layout_is_pinned_so_a_change_cannot_brick_a_deployed_vault_unnoticed` fails on any change.
///
/// The first v3 rules (`add_daily_key` refusing a key still in `revoked_keys`, `lock_down` keeping a key there
/// until its delete is confirmed, and a refusal because the cap is used up earning no strike) added no field and
/// changed no stored value's meaning. The queue rules after them did change the layout, in two places: every
/// queued `Withdrawal` gained `expires_at`, and the vault gained `requested_by_key`. This code cannot read the
/// state the v2 code (tag `v2-testnet`) wrote, so moving a deployed v2 vault onto it needs a `migrate` (only
/// testnet drill vaults exist, and they are throwaway: redeploy them instead).
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
    /// Each daily key's own part of `requested`: value that key asked for through `request_withdraw` in the
    /// last 24 h, per token, against its share of the pending limit (see `request_withdraw`). The account-wide
    /// `requested` stays the bound on the sum. A removed key's logs stay until they age out or the key is
    /// recorded again; each is at most `MAX_WINDOW_ENTRIES` long.
    requested_by_key: LookupMap<RequestedByKeyId, Vec<(u64, u128)>>,
    /// The stretch items (docs/v3/STRETCH-DESIGN.md), all appended after the v3 core so that its layout is a prefix.
    /// The only account whose `propose_*` calls are accepted. Never the vault itself: every key of the vault has the
    /// vault as predecessor, so that would make every key a policy key.
    policy_account: Option<AccountId>,
    /// What the policy account has proposed and the delay has not yet run or the admin cancelled, by id.
    proposals: IterableMap<u64, Proposal>,
    next_proposal: u64,
    /// Where `sweep_to_safe` sends value. Set by the admin only, never the vault itself, and a new one takes effect only
    /// after `safe_pending` has waited the withdrawal delay.
    safe_account: Option<AccountId>,
    safe_pending: Option<PendingSafe>,
    /// Accounts (not keys of the vault) that may call `sweep_to_safe` while `emergency_until` is in the future.
    watchers: IterableSet<AccountId>,
    /// Block time (ns) until which watchers may sweep; 0 when no window was ever declared.
    emergency_until: u64,
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
            requested_by_key: LookupMap::new(b"k"),
            policy_account: None,
            proposals: IterableMap::new(b"o"),
            next_proposal: 0,
            safe_account: None,
            safe_pending: None,
            watchers: IterableSet::new(b"t"),
            emergency_until: 0,
        }
    }

    // ---- admin ----------------------------------------------------------------------------

    /// Adds a classical function-call key limited to `send_small` and `request_withdraw`, and records it.
    pub fn add_daily_key(&mut self, public_key: PublicKey, allowance: Option<U128>) -> Promise {
        self.assert_admin();
        self.record_daily_key(public_key, allowance)
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

    /// Admin. Stops waiting for the account to confirm the deletion of a key the vault no longer serves: the key
    /// leaves `revoked_keys()` and may be added again. It schedules nothing and moves no value.
    ///
    /// For a delete that can never be confirmed. The account answers a `DeleteKey` for a key it does not hold with
    /// a failure, and the callback cannot tell that from any other failure, so such a key (for example one the runtime
    /// dropped when its gas allowance ran out: unverified in nearcore) would stay recorded, and block its own re-adding,
    /// for ever; `remove_daily_key` retries the delete but cannot clear it. The contract cannot see the account's keys, so this
    /// is the admin's word: check `view_access_key_list` first. Forgetting a key the account still holds changes
    /// nothing a daily key can do (the contract serves it no more) and only costs the retry at the next kaigen
    /// pass; forgetting one whose delete is still in flight lets the admin add it back inside that race.
    pub fn forget_revoked_key(&mut self, public_key: PublicKey) {
        self.assert_admin();
        require!(self.revoked_keys.remove(&public_key), "not a revoked key");
        // Logged under the removal's event name so the events table stays as documented: `forgotten` is the new field.
        emit("remove_daily_key", serde_json::json!({ "public_key": public_key, "retry": false, "forgotten": true }));
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
        self.put_pending_limit(token, limit);
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
        self.put_allowed(account);
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

    /// Cancels every queued request, expired ones too, logs what it removed and returns how many. An empty queue
    /// is not an error. Like `cancel`, it frees queue room but gives no request budget back: what was asked for
    /// in the last 24 h stays counted. The queue holds at most `MAX_QUEUE` entries, so one call is enough.
    pub fn cancel_all(&mut self) -> u32 {
        self.assert_admin();
        let ids: Vec<u64> = self.queue.keys().copied().collect();
        let cancelled = self.take_from_queue(ids);
        if !cancelled.is_empty() {
            emit(
                "queue_cancelled",
                serde_json::json!({ "reason": "cancel_all", "count": cancelled.len(), "withdrawals": cancelled }),
            );
        }
        cancelled.len() as u32
    }

    // ---- policy account, safe account, watchers: the stretch items (docs/v3/STRETCH-DESIGN.md) ------------------

    /// Admin. Names the one account whose `propose_*` calls the vault accepts, or `None` to switch the policy path
    /// off. Every proposal still waiting is dropped in the same call and logged: a proposal is only as good as the
    /// account that made it, so replacing a policy account that may be stolen also takes back what it asked for,
    /// with no race against `apply`. Never the vault itself: every key of the vault has the vault as predecessor, so
    /// that would make every key a policy key (the same reason `assert_admin` must not be given to a function-call key).
    pub fn set_policy_account(&mut self, account: Option<AccountId>) {
        self.assert_admin();
        if let Some(a) = &account {
            require!(*a != env::current_account_id(), "the policy account cannot be the vault itself");
        }
        let ids: Vec<u64> = self.proposals.keys().copied().collect();
        let dropped = self.take_proposals(ids);
        self.policy_account = account.clone();
        emit("set_policy_account", serde_json::json!({ "account": account, "dropped": dropped.len(), "proposals": dropped }));
    }

    /// Admin. Throws one waiting proposal away, whether or not its delay has passed.
    pub fn cancel_proposal(&mut self, id: U64) {
        self.assert_admin();
        let p = self.proposals.remove(&id.0).unwrap_or_else(|| env::panic_str("no such proposal"));
        emit("proposal_cancelled", serde_json::json!({ "id": id, "change": p.change }));
    }

    /// Admin. Names the account `sweep_to_safe` sends to. Not in force at once: it replaces the current one only after
    /// the withdrawal delay, and `cancel_safe_account_change` can take it back until then. A second call before that
    /// replaces the waiting one and starts the delay again. Never the vault itself (a sweep would then move nothing
    /// anywhere and look like protection). The first one waits too: the rule is the same for every change.
    pub fn set_safe_account(&mut self, account: AccountId) {
        self.assert_admin();
        require!(account != env::current_account_id(), "the safe account cannot be the vault itself");
        let now = env::block_timestamp();
        self.settle_safe_account(now);
        let effective_at = U64(self.unlock_time(now));
        emit("set_safe_account", serde_json::json!({ "account": account, "effective_at": effective_at }));
        self.safe_pending = Some(PendingSafe { account, effective_at });
    }

    /// Admin. Withdraws a safe-account change that has not taken effect yet. One that has is in force: set another.
    pub fn cancel_safe_account_change(&mut self) {
        self.assert_admin();
        self.settle_safe_account(env::block_timestamp());
        let p = self.safe_pending.take().unwrap_or_else(|| env::panic_str("no safe account change is waiting"));
        emit("safe_account_change_cancelled", serde_json::json!({ "account": p.account }));
    }

    /// Admin. Names an account that may call `sweep_to_safe` while an emergency window is open. A watcher is an
    /// ACCOUNT, identified by the predecessor of its call, not a key of the vault: the vault grows no new access key,
    /// and no code path reads the signer's key. Never the vault itself (every key of the vault would then be a watcher).
    pub fn add_watcher(&mut self, account: AccountId) {
        self.assert_admin();
        require!(account != env::current_account_id(), "a watcher cannot be the vault itself");
        require!(self.watchers.len() < MAX_WATCHERS, "too many watchers");
        require!(self.watchers.insert(account.clone()), "already a watcher");
        emit("add_watcher", serde_json::json!({ "account": account }));
    }

    pub fn remove_watcher(&mut self, account: AccountId) {
        self.assert_admin();
        require!(self.watchers.remove(&account), "not a watcher");
        emit("remove_watcher", serde_json::json!({ "account": account }));
    }

    /// Admin. Opens an emergency window of `secs` seconds from now, in which the watchers may call `sweep_to_safe`; it
    /// replaces any window already open. Zero closes it. At most `MAX_EMERGENCY_SECS` (7 days). The admin never needs a
    /// window to sweep.
    pub fn set_emergency(&mut self, secs: u64) {
        self.assert_admin();
        require!(secs <= MAX_EMERGENCY_SECS, "an emergency window lasts at most 7 days");
        let until = if secs == 0 { 0 } else { env::block_timestamp().saturating_add(secs.saturating_mul(1_000_000_000)) };
        self.emergency_until = until;
        emit("set_emergency", serde_json::json!({ "secs": secs, "until": U64(until) }));
    }

    // ---- daily keys -----------------------------------------------------------------------

    /// Sends within the 24 h limit, to allowed recipients. Paused once the era is warning.
    ///
    /// A request that breaks the policy (a recipient not on the allowlist, or more than the WHOLE 24 h limit)
    /// is REFUSED, not reverted: the call succeeds, nothing moves, and the refusal counts as a strike against
    /// the key that made it. At `max_strikes` inside 24 hours the vault deletes that key. A hijacked agent
    /// therefore gets a handful of attempts, not an unlimited number of tries or an unlimited gas bill.
    ///
    /// Three refusals are returned the same way but earn NO strike, because they say nothing about the key:
    /// a token with no 24 h limit (an honest first send of a new token must not burn a key), a NEAR amount
    /// below the minimum send (dust), and an amount that fits the limit but not what is left of it. The 24 h
    /// window is account-wide, so a hijacked or griefing key that spends the cap makes an honest key's
    /// legitimate send fail; counting that would burn the honest key after a few tries. A refusal counts only
    /// if it could never succeed for any key: a recipient off the allowlist, or an amount above the whole
    /// limit, which no window can ever hold. None of the three moves anything; the key's gas allowance
    /// bounds them.
    ///
    /// What earns no strike, all of it on purpose, so nobody has to re-derive it: those three refusals; every
    /// panic (a zero amount, an era that is not calm, a caller that is not a recorded daily key), because a
    /// panic rolls its own strike back; and every refusal of `request_withdraw` (see there). Each still costs
    /// the caller gas from the key's allowance, and the runtime deletes a function-call key whose allowance
    /// is used up, so none of them is unbounded. Counting dust or an unlisted token would burn the honest key
    /// that retries a new token before the admin lists it; counting `request_withdraw` refusals needs a new
    /// return type for that method.
    pub fn send_small(&mut self, token: Option<AccountId>, amount: U128, to: AccountId) -> PromiseOrValue<SendOutcome> {
        self.assert_daily_key();
        let key = env::signer_account_pk();
        let now = env::block_timestamp();
        // The decision is `judge_send`'s, the same one `check` reports. Here it is acted on.
        match self.judge_send(&key, &token, amount.0, &to, now) {
            Judgement::Reject(reason) => env::panic_str(reason.text()),
            Judgement::Refuse(reason, true) => {
                return PromiseOrValue::Value(self.refuse(&key, reason, &Attempt { token: &token, amount: amount.0, to: &to }))
            }
            Judgement::Refuse(reason, false) => {
                return PromiseOrValue::Value(self.refuse_uncounted(&key, reason, &Attempt { token: &token, amount: amount.0, to: &to }))
            }
            Judgement::Allow => {}
        }
        self.record_spend(&token, amount.0, now);
        emit(
            "send_small",
            serde_json::json!({
                "public_key": key, "token": token, "amount": amount, "to": to,
                "spent_after": U128(self.spent_in_window(&token, now)),
            }),
        );
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
    /// One key cannot crowd the others out. The queue's room and the request budget are split between the
    /// recorded daily keys: with `n` of them (at least 1), each may hold `MAX_QUEUE / n` requests at once, and
    /// its queued value and its value asked for in 24 h may each reach `pending_limit / n` per token. A vault
    /// with one key gets all of it, as before. The account-wide limits above still apply on top, and the shares
    /// are recomputed from the keys recorded now, so adding a key shrinks everyone's share from that moment
    /// (what a key already holds stays, it just cannot ask for more until it is under its new share).
    ///
    /// Refusals here are panics, not recorded outcomes, so they earn no strike (a panic rolls the strike back).
    /// That covers an amount over the pending limit or the 24 h request budget (the account's or this key's
    /// share), and a full queue or no slots left for this key. Turning them into recorded refusals would change
    /// this method's return type (a public contract), and a full queue or a spent budget is as likely an honest
    /// key as a hijacked one; what bounds a key that keeps trying is the gas allowance of its access key,
    /// which each failed call spends.
    pub fn request_withdraw(&mut self, token: Option<AccountId>, amount: U128, to: AccountId) -> U64 {
        self.assert_daily_key();
        require!(self.era != Era::Kaigen, "lockdown");
        require!(self.era == Era::Calm, "paused: era is not calm");
        require!(amount.0 > 0, "amount must be > 0");
        // Expired requests are not in the way: clear them first, so the count and the pending sum below see only
        // live ones and the queue never holds more than `MAX_QUEUE` entries, however long nobody purged it.
        self.remove_expired("request_withdraw");
        let requested_by = env::signer_account_pk();
        let requested_at = env::block_timestamp();
        self.queue_room(&requested_by, &token, amount.0).unwrap_or_else(|reason| env::panic_str(reason));
        self.take_request_budget(&requested_by, &token, amount.0, requested_at).unwrap_or_else(|reason| env::panic_str(reason));
        let id = self.next_id;
        self.next_id += 1;
        let expires_at = U64(self.unlock_time(requested_at).saturating_add(EXECUTE_WINDOW_SECS.saturating_mul(1_000_000_000)));
        let w = Withdrawal { token, amount, to, requested_at: U64(requested_at), expires_at, requested_by };
        emit(
            "request_withdraw",
            serde_json::json!({ "id": id, "token": w.token, "amount": w.amount, "to": w.to, "expires_at": w.expires_at }),
        );
        self.queue.insert(id, w);
        U64(id)
    }

    // ---- the policy account ----------------------------------------------------------------

    /// Policy account. Proposes adding a daily key. Nothing happens now: anyone may `apply` it once the withdrawal
    /// delay has passed (and before it expires), and the admin may `cancel_proposal` until then. The only checks here are
    /// the cheap ones; `apply` makes the real ones, on the state of that moment.
    ///
    /// The gas allowance may not exceed the default (0.25 NEAR; none means the default): a bigger one is the admin's to
    /// give. An allowance is gas the key can burn from the vault's balance outside every cap (docs/v3/LOSS-BOUND.md A3), so
    /// this is the one place the policy path is narrower than the admin's call, and a stolen policy account that nobody
    /// cancels in time gets a key worth at most the default, not a key that can burn the balance.
    pub fn propose_add_daily_key(&mut self, public_key: PublicKey, allowance: Option<U128>) -> U64 {
        self.assert_policy();
        require!(allowance.is_none_or(|a| a.0 > 0), "allowance must be > 0");
        require!(allowance.is_none_or(|a| a.0 <= DEFAULT_ALLOWANCE.as_yoctonear()), "an allowance above the default is the admin's to give");
        self.propose(Change::AddDailyKey { public_key, allowance })
    }

    /// Policy account. Proposes a 24 h cap for a NEP-141 token (see `propose_add_daily_key` for the rest).
    pub fn propose_set_token_limit(&mut self, token: AccountId, limit: U128) -> U64 {
        self.assert_policy();
        self.propose(Change::SetTokenLimit { token, limit })
    }

    /// Policy account. Proposes a pending limit for a token (`None` is NEAR).
    pub fn propose_set_pending_limit(&mut self, token: Option<AccountId>, limit: U128) -> U64 {
        self.assert_policy();
        self.propose(Change::SetPendingLimit { token, limit })
    }

    /// Policy account. Proposes adding a recipient to the allowlist.
    pub fn propose_allow_recipient(&mut self, account: AccountId) -> U64 {
        self.assert_policy();
        self.propose(Change::AllowRecipient { account })
    }

    // ---- anyone ---------------------------------------------------------------------------

    /// Sends a queued request once the delay has passed AND the era is calm. Both are needed, always. It must
    /// also not have expired: from `expires_at` (unlock time plus `EXECUTE_WINDOW_SECS`) on, a request never runs.
    ///
    /// What a warning does to a queued request: nothing leaves through it. It stays in the queue, frozen,
    /// whether or not its delay has passed, and the admin can `cancel` it at any time (cancel is never paused).
    /// The era only rises in production, so a request still queued when a warning arrives never executes;
    /// at kaigen `lock_down` discards the queue and logs what it held. (A drill vault follows Kizashi back
    /// down after its `reset`, and then its frozen requests can run once the era is calm and they are unlocked.)
    pub fn execute(&mut self, id: U64) -> Promise {
        require!(self.era == Era::Calm, "paused: era is not calm");
        let w = self.queue.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        let now = env::block_timestamp();
        require!(now >= self.unlocks_at(&w), "still locked");
        // A stale request never runs. It stays in the queue until `purge_expired` (or the next request) clears it.
        require!(now < w.expires_at.0, "expired");
        self.queue.remove(&id.0);
        emit("execute", serde_json::json!({ "id": id, "to": w.to, "token": w.token, "amount": w.amount }));
        transfer(&w.token, w.amount.0, w.to.clone()).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_execute_done(id, w, U64(self.next_id)),
        )
    }

    /// Anyone. Removes the requests that have expired (they can never run), logs them and returns how many. The
    /// queue clears them by itself whenever a request is made, so this only tidies up after a quiet spell; it
    /// reads at most `PURGE_SCAN_LIMIT` entries, so its gas is bounded whatever the queue holds. Nothing that
    /// has not expired is touched. (By the time a request expires, its 24 h of request budget has aged out on its
    /// own, so purging neither gives budget back nor needs to.)
    pub fn purge_expired(&mut self) -> u32 {
        self.remove_expired("purge_expired")
    }

    /// Anyone. Runs a proposal once its delay has passed and before it expires, through the same private function the
    /// admin's own method uses, so it refuses what the admin's call would refuse (a refusal rolls the whole call back and
    /// the proposal waits for the next try, until it expires). The delay is the withdrawal delay: the policy account
    /// cannot loosen anything faster than a queued withdrawal could leave, and the admin looks at the same cadence.
    pub fn apply(&mut self, id: U64) -> PromiseOrValue<()> {
        let p = self.proposals.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        let now = env::block_timestamp();
        require!(now >= p.executable_at.0, "still locked");
        require!(now < p.expires_at.0, "expired");
        // The change runs first and the proposal is taken out only after it has not refused, so a refusal leaves the
        // proposal where it was whatever the caller's view of the state (on the chain a panic discards every write anyway).
        let done = match p.change.clone() {
            Change::AddDailyKey { public_key, allowance } => PromiseOrValue::Promise(self.record_daily_key(public_key, allowance)),
            Change::SetTokenLimit { token, limit } => {
                self.token_limits.insert(token, limit.0);
                PromiseOrValue::Value(())
            }
            Change::SetPendingLimit { token, limit } => {
                self.put_pending_limit(token, limit);
                PromiseOrValue::Value(())
            }
            Change::AllowRecipient { account } => {
                self.put_allowed(account);
                PromiseOrValue::Value(())
            }
        };
        self.proposals.remove(&id.0);
        emit("proposal_applied", serde_json::json!({ "id": id, "change": p.change }));
        done
    }

    /// The admin, or a watcher inside an emergency window. Moves one queued request out of harm's way: it leaves the
    /// queue and its amount of its token goes to the safe account, and to nowhere else (there is no destination
    /// argument; the request's own payee is ignored). It can only lower what a daily key could still send: it takes an
    /// entry out of the queue and touches no cap, budget, strike, key or setting. An expired request is refused (it can
    /// never run, so nothing is at risk), and so is any call while no safe account is in force. A transfer that fails
    /// leaves the value in the vault and the request gone, like `cancel`; it is logged (`sweep_failed`), not put back,
    /// because a put-back is exactly the path that once carried 1.5 pending limits out of one window.
    pub fn sweep_to_safe(&mut self, id: U64) -> Promise {
        let by = self.assert_sweeper();
        let now = env::block_timestamp();
        let safe = self.effective_safe(now).unwrap_or_else(|| env::panic_str("no safe account is in force"));
        let w = self.queue.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such request"));
        require!(now < w.expires_at.0, "expired");
        self.queue.remove(&id.0);
        emit(
            "sweep_to_safe",
            serde_json::json!({ "id": id, "by": by, "safe": safe, "token": w.token, "amount": w.amount, "was_to": w.to }),
        );
        transfer(&w.token, w.amount.0, safe.clone()).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_sweep_done(id, w.token, w.amount, safe),
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
    /// carries on. A keeper is done when `intents_keys()` and `daily_keys()` are both empty (and, to be sure the
    /// account no longer holds a key the vault stopped serving, `revoked_keys()` too).
    #[private]
    pub fn lock_down(&mut self) {
        require!(self.era == Era::Kaigen, "lockdown only runs at kaigen");
        let me = env::current_account_id();
        let queued: Vec<u64> = self.queue.keys().copied().collect();
        let discarded = self.take_from_queue(queued);
        if !discarded.is_empty() {
            emit(
                "queue_discarded",
                serde_json::json!({ "reason": "lockdown", "count": discarded.len(), "withdrawals": discarded }),
            );
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
        // Last: keys the vault stopped serving earlier whose delete was never confirmed. Each gets another try, and
        // stays in `revoked_keys` until the account confirms the delete (`on_revoked_key_deleted`), so a try that
        // fails, or whose callback never runs, is not forgotten: the next `trip` tries it again. Such a key can
        // sign nothing the contract accepts, so one that never deletes costs only a delete per pass; it shows in
        // `revoked_keys_left`, and `daily_keys()` and `intents_keys()` alone say whether the keys that can act are gone.
        // `add_daily_key` keeps the set within `MAX_KEY_RECORDS`; the `take` is a guard so that this read, which runs
        // before any gas check, cannot grow with a set that something else let grow. Reading it all would fail the
        // whole receipt, and with it the intents and daily deletes scheduled above.
        let revoked: Vec<PublicKey> = self.revoked_keys.iter().take(MAX_KEY_RECORDS as usize).cloned().collect();
        for k in revoked.into_iter().take_while(|_| has_fanout_gas()) {
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
        //
        // Only while the send is still inside the 24 h window (`live_log`'s own test). Once it has left, nothing
        // counts it, so there is nothing to give back; and the next send may already have pruned its entry, so a
        // refund would find the first later entry that is big enough and take the amount out of ANOTHER send's, and
        // the window would say less than has been sent. A receipt takes seconds, not a day; this keeps the bound
        // whatever the delay (docs/v3/LOSS-BOUND.md, A5).
        let mut refunded = false;
        let still_in_window = ts.0 > env::block_timestamp().saturating_sub(DAY_NS);
        let log = if still_in_window { self.window.get_mut(&token) } else { None };
        if let Some(log) = log {
            let at = log
                .iter()
                .position(|&(t, a)| t == ts.0 && a == amount.0)
                .or_else(|| log.iter().position(|&(t, a)| t >= ts.0 && a >= amount.0));
            if let Some(i) = at {
                log[i].1 -= amount.0;
                if log[i].1 == 0 {
                    log.remove(i);
                }
                refunded = true;
            }
        }
        // `refunded` false means nothing was given back: the send had left the window, or no entry held it any more.
        emit(
            "send_failed",
            serde_json::json!({
                "reason_code": Reason::TransferFailed.code(), "token": token, "amount": amount, "refunded": refunded,
                "spent_after": U128(self.spent_in_window(&token, env::block_timestamp())),
            }),
        );
        SendOutcome { sent: false, refused: Some(Reason::TransferFailed.text().to_string()), strikes: 0, burned: false }
    }

    /// `requests_before` is `next_id` as `execute` saw it: how many requests had been made when this one went out.
    #[private]
    pub fn on_execute_done(&mut self, id: U64, withdrawal: Withdrawal, requests_before: U64) {
        if is_promise_success() {
            return;
        }
        // The funds never left. Put the request back to retry or cancel, unless the vault has locked
        // down meanwhile (the queue was cleared on purpose), its key was removed or burned meanwhile (its
        // requests were cancelled on purpose), it expired meanwhile (a stale request does not come back), a request
        // was made while it was out, or newer requests took the slot or the pending headroom. Expired entries do not
        // count as taking either.
        //
        // The request is in no collection while its transfer is in flight, so the queue's sum cannot see its value.
        // A new request can take the room it held, an `execute` of another request can then free room again, and the
        // failed one comes back into that: the same room has carried value out twice inside one 24 h window, and a
        // window can see 1.5 pending limits leave the queue instead of one (the test
        // `a_failed_execute_is_not_put_back_after_a_request_was_made_while_it_was_out` scripts it). With no request
        // made in between, only requests from before this one went out can be queued, so it fits where it was
        // (`queue_room` then fails only if the admin changed a limit or the key set meanwhile). With one, it is not
        // put back, and its key asks again.
        let expired = env::block_timestamp() >= withdrawal.expires_at.0;
        self.remove_expired("execute_failed");
        let room = self.queue_room(&withdrawal.requested_by, &withdrawal.token, withdrawal.amount.0).is_ok();
        // Why it is not coming back, in the order the reasons are weighed: the first that applies is the one logged.
        let dropped_because = if self.era == Era::Kaigen {
            Some("lockdown")
        } else if expired {
            Some("expired")
        } else if !self.daily_keys.contains(&withdrawal.requested_by) {
            Some("key_gone")
        } else if self.next_id != requests_before.0 {
            Some("request_made")
        } else if !room {
            Some("no_room")
        } else {
            None
        };
        if let Some(reason) = dropped_because {
            emit(
                "execute_dropped",
                serde_json::json!({
                    "id": id, "reason": reason, "to": withdrawal.to, "token": withdrawal.token, "amount": withdrawal.amount
                }),
            );
        } else {
            self.queue.insert(id.0, withdrawal);
        }
    }

    /// A sweep's transfer failed: the value is still in the vault and the request is gone (see `sweep_to_safe`). Logged so
    /// the owner sees it; nothing is put back.
    #[private]
    pub fn on_sweep_done(&self, id: U64, token: Option<AccountId>, amount: U128, safe: AccountId) {
        if !is_promise_success() {
            emit("sweep_failed", serde_json::json!({ "id": id, "token": token, "amount": amount, "safe": safe }));
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
    /// retry with `remove_daily_key`, and `lock_down` tries it again at every kaigen pass. A delete most likely
    /// fails because the account no longer holds the key (unverified: the runtime also drops a function-call
    /// key whose gas allowance is used up). A retry then fails the same way and the key stays on record:
    /// harmless, since the contract serves it no more, and visible rather than silently dropped.
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

    /// Informational. What this contract RECORDS about itself: its configuration, the daily keys it serves with
    /// their strikes, the keys it recorded on `intents.near`, and the revoked keys whose deletion is not confirmed.
    /// For cage-check to compare with the chain; it is never the source of truth about the account.
    ///
    /// It does NOT return the code hash or the account's key list, and nothing here can: the contract never reads
    /// its admin key (see the module note), and the host gives a contract no way to read its own code hash or
    /// the keys on its account (no such function in `near-sys` 0.4.0). A full-access key can also deploy code
    /// whose `attest()` returns whatever it likes. So the code hash and the key list come from RPC
    /// (`view_account`, `view_access_key_list`), and this answer is a cross-check, not a proof.
    pub fn attest(&self) -> Attestation {
        Attestation {
            attest_version: ATTEST_VERSION,
            contract: "mamori".to_string(),
            drill_build: cfg!(feature = "drill"),
            account_id: env::current_account_id(),
            block_height: U64(env::block_height()),
            block_timestamp: U64(env::block_timestamp()),
            config: self.config(),
            min_delay_secs: MIN_DELAY_SECS,
            allowlist_enforced: self.allowlist_enforced,
            allowlist_len: self.allowed.len(),
            daily_keys: self
                .daily_keys
                .iter()
                .map(|k| KeyAttestation { public_key: k.clone(), strikes: self.strikes_of(k.clone()) })
                .collect(),
            intents_keys: self.intents_keys.iter().cloned().collect(),
            revoked_keys: self.revoked_keys.iter().cloned().collect(),
            queue_len: self.queue.len(),
            policy_account: self.policy_account(),
            safe_account: self.safe_account(),
            watchers: self.watchers(),
            emergency_until: self.emergency_until(),
            proposals: self.proposals(),
            note: ATTEST_NOTE.to_string(),
        }
    }

    /// ADVISORY ONLY. What `send_small(asset, amount, to)` would do if `key` called it in the block this view runs
    /// in: go through, be refused (and whether that would be a strike, and the key's last), or abort. A view has
    /// no signer, so the key is a parameter. `asset` is `send_small`'s `token` (`None` is NEAR).
    ///
    /// It is not a promise and not a control. The real enforcement is in `send_small` and `execute`, which decide
    /// again when they run, on the state of that block: another call can use the cap up between this view and the
    /// send. It uses the same decision function as `send_small`, so it is right for the state it reads, but it
    /// reads state that can change. It does not model `request_withdraw` (its refusals are panics) or `execute`.
    ///
    /// It also hands anyone, a hijacked key included, the exact headroom for free, so a caller that stays inside it
    /// is never refused and never struck: the refusal counter catches only a clumsy attacker (ARCHITECTURE.md 2.7).
    pub fn check(&self, key: PublicKey, asset: Option<AccountId>, amount: U128, to: AccountId) -> CheckView {
        let now = env::block_timestamp();
        let (verdict, reason, counted) = match self.judge_send(&key, &asset, amount.0, &to, now) {
            Judgement::Allow => (Verdict::Allow, Reason::Ok, false),
            Judgement::Refuse(reason, counted) => (Verdict::Refuse, reason, counted),
            Judgement::Reject(reason) => (Verdict::Reject, reason, false),
        };
        // The same arithmetic `refuse` ends with: this strike is the last when it reaches `max_strikes`.
        let would_burn = counted && self.open_strikes(&key, now).count.saturating_add(1) >= self.max_strikes;
        CheckView { verdict, reason, counted, would_burn, headroom: self.headroom(&asset, now).into() }
    }

    /// The one account whose `propose_*` calls are accepted; `None` when the policy path is off.
    pub fn policy_account(&self) -> Option<AccountId> {
        self.policy_account.clone()
    }

    /// The safe account in force now, and a change still waiting for its delay.
    pub fn safe_account(&self) -> SafeAccountView {
        let now = env::block_timestamp();
        SafeAccountView { current: self.effective_safe(now), pending: self.safe_pending.clone().filter(|p| now < p.effective_at.0) }
    }

    pub fn watchers(&self) -> Vec<AccountId> {
        self.watchers.iter().cloned().collect()
    }

    /// End (ns) of the emergency window; at or before the block time it is closed.
    pub fn emergency_until(&self) -> U64 {
        U64(self.emergency_until)
    }

    /// Proposals waiting (expired ones too, until the next proposal clears them), with the instants they run and lapse.
    pub fn proposals(&self) -> Vec<ProposalView> {
        self.proposals.iter().map(|(id, p)| ProposalView { id: U64(*id), proposal: p.clone() }).collect()
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

    /// Everything `add_daily_key` does once the caller is allowed: the admin's call and a policy proposal that has
    /// waited out its delay (`apply`) both come here, so they refuse and record exactly the same.
    fn record_daily_key(&mut self, public_key: PublicKey, allowance: Option<U128>) -> Promise {
        require!(self.era != Era::Kaigen, "lockdown: classical keys can no longer be added");
        // A key the vault stopped serving (removed or burned) may still be on the account until its delete is
        // confirmed. Adding it back now would race that delete, and a delete that landed after the add would
        // take the new key away. The admin can re-add it as soon as the account confirms the delete.
        require!(!self.revoked_keys.contains(&public_key), "revoked key: its deletion is not confirmed yet");
        require!(self.daily_keys.len() < MAX_DAILY_KEYS, "too many daily keys");
        // The one place the records can grow. Removing or burning a key moves it from one set to the other, so
        // refusing here, and only here, bounds both sets and leaves every containment path free to run. The way
        // out is `forget_revoked_key` (after the admin has seen the key is off the account) or a delete that lands.
        require!(
            self.daily_keys.len() + self.revoked_keys.len() < MAX_KEY_RECORDS,
            "too many keys awaiting deletion: confirm or forget some first"
        );
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

    /// Who may call `sweep_to_safe`, and so who `by` is in its log: the admin always (predecessor is the vault, as for
    /// every admin method), a watcher only inside an emergency window. Identified by the predecessor alone, so it is the
    /// same for an ML-DSA admin and a classical one, and no key is read.
    fn assert_sweeper(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        if caller == env::current_account_id() {
            return caller;
        }
        require!(self.watchers.contains(&caller), "admin or watcher only");
        require!(env::block_timestamp() < self.emergency_until, "no emergency: watchers can sweep only in a declared window");
        caller
    }

    /// Only the policy account, and only while one is named. The vault itself can never be it (`set_policy_account`).
    fn assert_policy(&self) {
        let policy = self.policy_account.as_ref().unwrap_or_else(|| env::panic_str("no policy account is set"));
        require!(&env::predecessor_account_id() == policy, "policy account only");
    }

    /// The safe account in force at `now`: the waiting one once its delay has passed, else the current one.
    fn effective_safe(&self, now: u64) -> Option<AccountId> {
        match &self.safe_pending {
            Some(p) if now >= p.effective_at.0 => Some(p.account.clone()),
            _ => self.safe_account.clone(),
        }
    }

    /// Makes a waiting safe account whose delay has passed the current one. Called before the admin changes the setting.
    fn settle_safe_account(&mut self, now: u64) {
        if let Some(p) = self.safe_pending.clone().filter(|p| now >= p.effective_at.0) {
            self.safe_account = Some(p.account);
            self.safe_pending = None;
        }
    }

    /// Queues a proposal: clears the expired ones, checks there is room, and times it by the withdrawal delay.
    fn propose(&mut self, change: Change) -> U64 {
        let now = env::block_timestamp();
        let stale: Vec<u64> = self.proposals.iter().filter(|(_, p)| now >= p.expires_at.0).map(|(id, _)| *id).collect();
        let cleared = self.take_proposals(stale);
        if !cleared.is_empty() {
            emit("proposal_expired", serde_json::json!({ "count": cleared.len(), "proposals": cleared }));
        }
        require!(self.proposals.len() < MAX_PROPOSALS, "too many proposals waiting");
        let id = self.next_proposal;
        self.next_proposal += 1;
        let executable_at = self.unlock_time(now);
        let expires_at = executable_at.saturating_add(EXECUTE_WINDOW_SECS.saturating_mul(1_000_000_000));
        let p = Proposal { change, proposed_at: U64(now), executable_at: U64(executable_at), expires_at: U64(expires_at) };
        emit(
            "propose",
            serde_json::json!({ "id": U64(id), "change": p.change, "executable_at": p.executable_at, "expires_at": p.expires_at }),
        );
        self.proposals.insert(id, p);
        U64(id)
    }

    /// Removes these proposals and returns each as event data, so nothing leaves the table without a log line.
    fn take_proposals(&mut self, ids: Vec<u64>) -> Vec<serde_json::Value> {
        ids.into_iter()
            .filter_map(|id| {
                let p = self.proposals.remove(&id)?;
                Some(serde_json::json!({ "id": U64(id), "change": p.change, "executable_at": p.executable_at }))
            })
            .collect()
    }

    /// `set_pending_limit` without the caller check: the admin's call and a proposal that has waited out its delay.
    fn put_pending_limit(&mut self, token: Option<AccountId>, limit: U128) {
        emit("set_pending_limit", serde_json::json!({ "token": token, "limit": limit }));
        self.pending_limits.insert(token, limit.0);
    }

    /// `allow_recipient` without the caller check, for the same two callers.
    fn put_allowed(&mut self, account: AccountId) {
        require!(self.allowed.len() < MAX_ALLOWED, "allowlist is full");
        require!(self.allowed.insert(account.clone()), "already allowed");
        emit("allow_recipient", serde_json::json!({ "account": account }));
    }

    fn limit_for(&self, token: &Option<AccountId>) -> u128 {
        match token {
            None => self.daily_limit,
            Some(t) => self.token_limits.get(t).copied().unwrap_or(0),
        }
    }

    /// What `send_small` does with this call, decided without changing anything. The order is the order the
    /// checks have always had: the key, the era, the amount, the allowlist, the limit, the minimum, the window.
    /// `key` is the signer (a view has none, so `check` passes it in).
    fn judge_send(&self, key: &PublicKey, token: &Option<AccountId>, amount: u128, to: &AccountId, now: u64) -> Judgement {
        if !self.daily_keys.contains(key) {
            return Judgement::Reject(Reason::NotADailyKey);
        }
        if self.era != Era::Calm {
            return Judgement::Reject(Reason::EraNotCalm);
        }
        if amount == 0 {
            return Judgement::Reject(Reason::ZeroAmount);
        }
        if self.allowlist_enforced && !self.allowed.contains(to) {
            return Judgement::Refuse(Reason::NotAllowlisted, true);
        }
        let limit = self.limit_for(token);
        if limit == 0 {
            return Judgement::Refuse(Reason::NoLimit, false);
        }
        if token.is_none() && amount < self.min_send {
            return Judgement::Refuse(Reason::BelowMinSend, false);
        }
        if !self.fits_window(token, amount, now) {
            // Above the whole limit it can never fit; otherwise the window is only used up for now.
            return if amount > limit {
                Judgement::Refuse(Reason::OverCapTotal, true)
            } else {
                Judgement::Refuse(Reason::CapExhausted, false)
            };
        }
        Judgement::Allow
    }

    /// Rolling 24 h cap: whether the sum of sends in the last 24 h plus this one stays within the limit.
    fn fits_window(&self, token: &Option<AccountId>, amount: u128, now: u64) -> bool {
        Self::fits_in(&Self::live_log(&self.window, token, now), amount, self.limit_for(token))
    }

    /// What is left of the token's 24 h limit.
    fn headroom(&self, token: &Option<AccountId>, now: u64) -> u128 {
        self.limit_for(token).saturating_sub(self.spent_in_window(token, now))
    }

    /// What `send_small` has sent of the token in the 24 h before `now` (what `spent_24h` shows).
    fn spent_in_window(&self, token: &Option<AccountId>, now: u64) -> u128 {
        Self::live_log(&self.window, token, now).iter().map(|(_, a)| a).sum()
    }

    /// Adds a send to the token's log of (time, amount). The caller has just judged that it fits.
    fn record_spend(&mut self, token: &Option<AccountId>, amount: u128, now: u64) {
        let mut log = Self::live_log(&self.window, token, now);
        Self::push_amount(&mut log, amount, now);
        self.window.insert(token.clone(), log);
    }

    /// What `windows` holds under `key` that is still inside the 24 h before `now`.
    fn live_log<K: BorshSerialize + Ord + Clone>(windows: &LookupMap<K, Vec<(u64, u128)>>, key: &K, now: u64) -> Vec<(u64, u128)> {
        let cutoff = now.saturating_sub(DAY_NS);
        windows.get(key).map(|l| l.iter().copied().filter(|(t, _)| *t > cutoff).collect()).unwrap_or_default()
    }

    /// Whether the log plus `amount` stays within `limit`.
    fn fits_in(log: &[(u64, u128)], amount: u128, limit: u128) -> bool {
        let used: u128 = log.iter().map(|(_, a)| a).sum();
        used.checked_add(amount).is_some_and(|total| total <= limit)
    }

    /// Adds `amount` to the log (the caller has checked that it fits). A log that is full folds it into the
    /// newest entry instead of refusing.
    fn push_amount(log: &mut Vec<(u64, u128)>, amount: u128, now: u64) {
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
    }

    /// How many daily keys the room and the budget are shared between: the recorded ones, at least one.
    fn key_count(&self) -> u32 {
        self.daily_keys.len().max(1)
    }

    /// How many requests `key` holds in the queue, and how much of `token` they add up to.
    fn held_by(&self, key: &PublicKey, token: &Option<AccountId>) -> (u32, u128) {
        self.queue.values().filter(|w| &w.requested_by == key).fold((0, 0u128), |(count, sum), w| {
            (count + 1, if &w.token == token { sum.saturating_add(w.amount.0) } else { sum })
        })
    }

    /// Whether `key` may put `amount` of `token` in the queue now, as a refusal reason if not: there is a free
    /// slot and the pending limit has room, and so does the key's own share of both (see `request_withdraw`).
    /// Only live requests are in the queue by now (`remove_expired`). The cheap account-wide checks go first, so
    /// a vault with one key, whose share is the whole, gets the same refusals as before the shares existed.
    fn queue_room(&self, key: &PublicKey, token: &Option<AccountId>, amount: u128) -> Result<(), &'static str> {
        if self.queue.len() >= MAX_QUEUE {
            return Err("queue full");
        }
        let keys = self.key_count();
        let (held, queued) = self.held_by(key, token);
        if held >= MAX_QUEUE / keys {
            return Err("this key's queue slots are used up");
        }
        if !self.fits_pending(token, amount) {
            return Err("over the pending limit for this token");
        }
        let share = self.pending_limit_for(token) / u128::from(keys);
        if !queued.checked_add(amount).is_some_and(|total| total <= share) {
            return Err("over this key's share of the pending limit for this token");
        }
        Ok(())
    }

    /// Spends `amount` of `token` from the 24 h request budget: the account's and `key`'s share of it. Nothing is
    /// recorded unless both have room. Neither `execute` nor `cancel` gives any of it back.
    fn take_request_budget(&mut self, key: &PublicKey, token: &Option<AccountId>, amount: u128, now: u64) -> Result<(), &'static str> {
        let limit = self.pending_limit_for(token);
        let share = limit / u128::from(self.key_count());
        let mut account_log = Self::live_log(&self.requested, token, now);
        if !Self::fits_in(&account_log, amount, limit) {
            return Err("over the 24 h pending limit for this token");
        }
        let slot = (key.clone(), token.clone());
        let mut key_log = Self::live_log(&self.requested_by_key, &slot, now);
        if !Self::fits_in(&key_log, amount, share) {
            return Err("over this key's share of the 24 h pending limit for this token");
        }
        Self::push_amount(&mut account_log, amount, now);
        self.requested.insert(token.clone(), account_log);
        Self::push_amount(&mut key_log, amount, now);
        self.requested_by_key.insert(slot, key_log);
        Ok(())
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

    /// Removes the expired requests among the first `PURGE_SCAN_LIMIT` entries, logs them and returns how many.
    /// `trigger` says which call cleared them (`purge_expired`, `request_withdraw`, or `execute_failed` for the
    /// failed-execute callback), so the log shows whether anyone tidied up or a new request did.
    fn remove_expired(&mut self, trigger: &str) -> u32 {
        let now = env::block_timestamp();
        let ids: Vec<u64> =
            self.queue.iter().take(PURGE_SCAN_LIMIT).filter(|(_, w)| now >= w.expires_at.0).map(|(id, _)| *id).collect();
        let expired = self.take_from_queue(ids);
        if !expired.is_empty() {
            emit(
                "queue_expired",
                serde_json::json!({ "reason": "expired", "trigger": trigger, "count": expired.len(), "withdrawals": expired }),
            );
        }
        expired.len() as u32
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
            emit(
                "queue_cancelled",
                serde_json::json!({ "public_key": key, "reason": reason, "count": cancelled.len(), "withdrawals": cancelled }),
            );
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

    /// The `refused` event. `reason` is the text callers have always seen; `reason_code` is the stable code
    /// (docs/v3/ATTEST-CHECK.md). It names the call and says what the window holds, so the log alone shows what was
    /// asked, why it was refused and where the cap stood. Nothing moved, so `spent_after` is what was spent already.
    fn emit_refused(&self, key: &PublicKey, reason: Reason, strikes: u32, counted: bool, call: &Attempt) {
        emit(
            "refused",
            serde_json::json!({
                "public_key": key, "reason": reason.text(), "reason_code": reason.code(), "strikes": strikes, "counted": counted,
                "token": call.token, "amount": U128(call.amount), "to": call.to,
                "spent_after": U128(self.spent_in_window(call.token, env::block_timestamp())),
            }),
        );
    }

    /// A refusal that is not the key's fault (see `send_small`): reported, but not counted.
    fn refuse_uncounted(&self, key: &PublicKey, reason: Reason, call: &Attempt) -> SendOutcome {
        let strikes = self.strikes_of(key.clone());
        self.emit_refused(key, reason, strikes, false, call);
        SendOutcome { sent: false, refused: Some(reason.text().to_string()), strikes, burned: false }
    }

    /// The key's strike record as the next refusal builds on it: a key with no record, or whose window has run
    /// out, starts a fresh window at `now`.
    fn open_strikes(&self, key: &PublicKey, now: u64) -> Strikes {
        match self.strikes.get(key) {
            Some(r) if now.saturating_sub(r.since) <= DAY_NS => *r,
            _ => Strikes { count: 0, since: now },
        }
    }

    /// Records a refusal against `key`. At `max_strikes` inside the window the key is removed from the
    /// recorded set (so the contract stops serving it at once) and deleted from the account.
    fn refuse(&mut self, key: &PublicKey, reason: Reason, call: &Attempt) -> SendOutcome {
        let now = env::block_timestamp();
        let mut record = self.open_strikes(key, now);
        record.count += 1;
        self.emit_refused(key, reason, record.count, true, call);
        let burned = record.count >= self.max_strikes;
        if burned {
            self.strikes.remove(key);
            self.daily_keys.remove(key);
            self.cancel_queued_by(key, "key_burned");
            // Dropping the promise still schedules it. The key is unrecorded first, so the contract refuses it
            // at once whether or not the delete lands; `revoked_keys` keeps it on record until the account
            // confirms the delete, so a failed one is retried at kaigen rather than forgotten.
            let _ = self.delete_revoked_key(key);
            emit(
                "key_burned",
                serde_json::json!({
                    "public_key": key, "reason": reason.text(), "reason_code": reason.code(),
                    "strikes": record.count, "max_strikes": self.max_strikes,
                }),
            );
        } else {
            self.strikes.insert(key.clone(), record);
        }
        SendOutcome { sent: false, refused: Some(reason.text().to_string()), strikes: record.count, burned }
    }

    fn unlocks_at(&self, w: &Withdrawal) -> u64 {
        self.unlock_time(w.requested_at.0)
    }

    fn unlock_time(&self, requested_at: u64) -> u64 {
        requested_at.saturating_add(self.delay_secs.saturating_mul(1_000_000_000))
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
