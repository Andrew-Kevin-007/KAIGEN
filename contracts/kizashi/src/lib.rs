//! Kizashi (兆し, omen): the KAIGEN omen registry.
//!
//! An omen is a public key nobody holds. A valid signature from one proves its curve can be broken.
//! `claim` verifies that signature on-chain, marks the omen dead forever, raises the era and pays
//! the bounty. There is no admin: after deploy and init every access key is deleted.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, serde_json, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

/// First line of every claim message, so a signature made for another purpose cannot be replayed here.
const CLAIM_DOMAIN: &str = "KAIGEN/v1/claim";
/// The token's `ft_balance_of`.
const FT_BALANCE_GAS: Gas = Gas::from_tgas(10);
/// The token's NEP-145 `storage_deposit`, which also refunds the excess.
const FT_STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
/// The token's `ft_transfer`.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
/// A resolve callback: one event, and on failure one write of the owed record.
const RESOLVE_GAS: Gas = Gas::from_tgas(5);
/// `on_usdc_balance` plus the chain it schedules (storage_deposit, ft_transfer, resolve). The prepaid
/// gas `claim` leaves unused is shared between its callbacks on top of this, so it is a floor.
const ON_USDC_BALANCE_GAS: Gas = Gas::from_tgas(55);
/// The most omens one registry holds.
const MAX_OMENS: usize = 8;
/// Attached to the token's `storage_deposit` for a claimant: 0.01 NEAR, many times any real token's
/// minimum. A registration-only deposit refunds the excess, or all of it if already registered.
const MIN_REGISTRATION_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Left on the contract at every payout (0.05 NEAR, about 5 KB of storage stake).
const STORAGE_MARGIN: NearToken = NearToken::from_millinear(50);
/// Every ed25519 encoding of a point of small order (the 8 points, with both sign bits where x = 0).
/// A key like these verifies signatures nobody had to make, so none can be an omen.
const SMALL_ORDER_ED25519: [&str; 10] = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000080",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Era {
    Calm,
    Warning,
    Kaigen,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Curve {
    Ed25519,
    Secp256k1,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Death {
    block: u64,
    claimant: AccountId,
    signature: Vec<u8>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Omen {
    curve: Curve,
    level: Era,
    /// ed25519: 32 bytes. secp256k1: 64 bytes, uncompressed x || y (what `ecrecover` returns).
    key: Vec<u8>,
    death: Option<Death>,
}

/// A payout that failed, held for its claimant until `retry_payout`. Amounts are yoctoNEAR / token units.
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
struct Owed {
    near: u128,
    usdc: u128,
    /// The USDC amount is not to be trusted, so what is owed is a fresh balance read, repeated: set when the
    /// read itself failed (no amount known), and when an `ft_transfer` failed (the amount may already have
    /// gone to another claimant whose read raced this one). `usdc` is then only a hold against sweeps.
    usdc_unread: bool,
}

/// One omen at init. `public_key` is hex.
#[near(serializers = [json])]
pub struct OmenInit {
    pub id: String,
    pub curve: Curve,
    pub level: Era,
    pub public_key: String,
}

#[near(serializers = [json])]
pub struct DeathView {
    pub block: U64,
    pub claimant: AccountId,
    pub signature: String,
}

#[near(serializers = [json])]
pub struct OmenView {
    pub id: String,
    pub curve: Curve,
    pub level: Era,
    pub public_key: String,
    pub death: Option<DeathView>,
}

#[near(serializers = [json])]
pub struct BountyView {
    /// Spendable NEAR on the contract (balance minus storage reserve and margin, and minus what is
    /// owed to claimants whose payout failed), in yoctoNEAR.
    pub near: U128,
    pub usdc_token: Option<AccountId>,
    /// True while at least one omen is alive, that is, while a claim can still pay out. Once the last
    /// omen is claimed nothing can claim again, so anything sent after that stays on the contract.
    pub claimable: bool,
}

#[near(serializers = [json])]
pub struct OwedView {
    pub near: U128,
    pub usdc: U128,
    /// True while `retry_payout` has to read the USDC balance again before it pays any USDC: after a failed
    /// balance read, or a failed USDC transfer (then `usdc` is held, and settled by that read).
    pub usdc_unread: bool,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kizashi {
    omens: IterableMap<String, Omen>,
    era: Era,
    usdc: Option<AccountId>,
    /// Failed payouts by claimant. One entry per claimant, so at most one per claim: 8 at most.
    owed: IterableMap<AccountId, Owed>,
    /// USDC committed to `ft_transfer`s that have been scheduled and have not reported back yet. The token
    /// balance still includes it until the transfer lands, so a second claim that reads the balance in that
    /// window must not pay it again: it takes the balance minus this, minus what is owed to others.
    /// Every scheduled transfer has a resolve callback (`RESOLVE_GAS`) that releases its share, whether the
    /// transfer worked or not; a callback that could not run would leave its share held, hiding that much
    /// USDC from later claims (the failed transfer would not have been recorded as owed either).
    usdc_in_flight: u128,
}

#[near]
impl Kizashi {
    /// Deploy and `new` must go in one transaction signed by this account, so nobody else can
    /// initialise it first with their own omens.
    ///
    /// Checked here: hex and length, level, unique ids, unique keys, no all-zero key, and for ed25519
    /// a canonical encoding that is not a small-order point. NOT checked on-chain: that a secp256k1
    /// key is a point on the curve (that needs 256-bit field arithmetic and a new dependency; an
    /// invalid key can never be claimed, so it silently removes an omen), that an ed25519 key lies in
    /// the prime-order subgroup, and that no key is a known drill key. The pre-deploy script in
    /// `scripts/` is where those are covered. The arguments are immutable once the keys are deleted.
    #[init]
    #[private]
    pub fn new(omens: Vec<OmenInit>, usdc: Option<AccountId>) -> Self {
        require!(!omens.is_empty() && omens.len() <= MAX_OMENS, "1..=8 omens");
        let mut map = IterableMap::new(b"o");
        let mut seen_keys: Vec<Vec<u8>> = Vec::new();
        for o in omens {
            let key = hex::decode(&o.public_key).unwrap_or_else(|_| env::panic_str("bad hex key"));
            let want = match o.curve {
                Curve::Ed25519 => 32,
                Curve::Secp256k1 => 64,
            };
            require!(key.len() == want, "bad key length for curve");
            require!(key.iter().any(|b| *b != 0), "all-zero key");
            if o.curve == Curve::Ed25519 {
                require_usable_ed25519(&key);
            }
            require!(o.level != Era::Calm, "omen level must be warning or kaigen");
            let duplicate_key = seen_keys.contains(&key);
            seen_keys.push(key.clone());
            let prev = map.insert(o.id, Omen { curve: o.curve, level: o.level, key, death: None });
            require!(prev.is_none(), "duplicate omen id");
            require!(!duplicate_key, "duplicate omen key");
        }
        Self { omens: map, era: Era::Calm, usdc, owed: IterableMap::new(b"w"), usdc_in_flight: 0 }
    }

    /// Prove an omen is dead. Anyone may call; the signature is the only authority.
    /// `signature`: ed25519 = 64 bytes; secp256k1 = 65 bytes r || s || v with v in {0, 1} and low s.
    /// secp256k1 signs the sha256 of the claim message, NOT its keccak256 (the Ethereum convention):
    /// a wallet or library that hashes with keccak produces a signature this rejects.
    ///
    /// The first claim takes the whole spendable balance: all the NEAR now, and all the USDC once the
    /// balance read lands. Later claims get only what was added since. Both legs report with a
    /// `payout_ok` or `payout_failed` event; a failed leg is held as owed and `retry_payout` pays it
    /// (a failed balance read is held as a read to repeat).
    ///
    /// Two claims close together cannot be paid the same money. NEAR: the runtime takes a transfer out of
    /// the balance when it creates the receipt, so the next claim sees what is left. USDC: the balance is
    /// only known in a later callback, so that callback reserves what it schedules (`usdc_in_flight`) and
    /// the next one takes the balance minus that, minus what is owed to others. A transfer that fails
    /// anyway (a read that was already stale) is held as an unverified amount that the retry re-reads, so it
    /// cannot become a debt that nothing can pay or hide a later top-up.
    pub fn claim(&mut self, omen_id: String, claimant: AccountId, signature: Base64VecU8) -> Promise {
        let omen = self.omens.get(&omen_id).unwrap_or_else(|| env::panic_str("unknown omen"));
        require!(omen.death.is_none(), "omen already dead");
        let message = build_claim_message(&env::current_account_id(), &omen_id, &claimant);
        require!(verify(omen, message.as_bytes(), &signature.0), "bad signature");

        let level = omen.level;
        let omen = self.omens.get_mut(&omen_id).unwrap();
        omen.death = Some(Death {
            block: env::block_height(),
            claimant: claimant.clone(),
            signature: signature.0.clone(),
        });
        if level > self.era {
            self.era = level;
        }
        emit(
            "claim",
            serde_json::json!({
                "omen": omen_id, "claimant": claimant, "era": self.era,
                "block": env::block_height(), "signature": hex::encode(&signature.0),
            }),
        );

        let payout = self.spendable_near();
        let mut p = Promise::new(claimant.clone());
        if payout > 0 {
            // The callback records the payout as owed if the transfer fails (an account that does not
            // exist, say); the refund of the failed transfer comes back to this contract.
            p = p
                .transfer(NearToken::from_yoctonear(payout))
                .then(near_resolve(&claimant, payout));
        }
        match &self.usdc {
            // One chain: pay NEAR, then read the USDC balance, then pay it. Each `then` takes a
            // promise that has not been scheduled after anything yet.
            Some(usdc) => usdc_read_steps(usdc.clone(), claimant).into_iter().fold(p, Promise::then),
            None => p,
        }
    }

    #[private]
    pub fn on_near_payout(&mut self, claimant: AccountId, amount: U128) {
        if previous_promise_succeeded() {
            emit_payout_ok("near", &claimant, amount.0);
        } else {
            self.record_owed(&claimant, amount.0, 0);
            emit_payout_failed("near", &claimant, Some(amount.0), "transfer failed");
        }
    }

    #[private]
    pub fn on_usdc_balance(
        &mut self,
        claimant: AccountId,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) {
        if self.usdc.is_none() {
            return;
        }
        let Ok(balance) = balance else {
            // Without the balance there is no amount to owe, so the read itself is held: if this was the
            // last omen no later claim sweeps the USDC, and `retry_payout` is then the only way to it.
            self.record_unread(&claimant);
            emit_payout_failed("usdc", &claimant, None, "ft_balance_of failed");
            return;
        };
        // This read settles whatever USDC this claimant had on record, so the record is spent here, whatever
        // happens below: the balance includes those tokens if they are still held, and the claimant is paid
        // from it. What the read may take is the balance minus what is held for OTHER claimants (their owed
        // records) and minus what other payouts have already scheduled (`usdc_in_flight`): a second claim
        // whose read landed before the first transfer did sees the same balance and must not pay it again.
        let recorded = self.take_usdc_record(&claimant);
        let held_back = self.owed_total().usdc.saturating_add(self.usdc_in_flight);
        let amount = balance.0.saturating_sub(held_back);
        if recorded > amount {
            // A recorded amount the token no longer holds is no debt (it was paid to someone else, or lost to
            // a stale read). It is dropped, and the drop is logged: nothing leaves the books silently.
            emit(
                "owed_reconciled",
                serde_json::json!({ "asset": "usdc", "claimant": claimant, "recorded": U128(recorded), "held": U128(amount) }),
            );
        }
        if amount == 0 {
            return;
        }
        match self.start_usdc_payout(&claimant, amount) {
            Some(steps) => drop(chain(steps)), // dropping a promise schedules it
            None => {
                self.record_owed(&claimant, 0, amount);
                emit_payout_failed("usdc", &claimant, Some(amount), "no spare NEAR for the registration deposit");
            }
        }
    }

    #[private]
    pub fn on_usdc_paid(&mut self, claimant: AccountId, amount: U128) {
        self.usdc_in_flight = self.usdc_in_flight.saturating_sub(amount.0);
        if previous_promise_succeeded() {
            emit_payout_ok("usdc", &claimant, amount.0);
        } else {
            // The token refused the transfer. Either for a real reason (the tokens are still here), or because
            // the balance this payout was computed from was already stale and someone else was paid them (then
            // nothing is owed). Nothing here can tell which. So the amount is held, which keeps it from a later
            // claimant's sweep, but marked unverified: `retry_payout` reads the balance again and pays what the
            // token really holds.
            self.record_owed(&claimant, 0, amount.0);
            self.record_unread(&claimant);
            emit_payout_failed("usdc", &claimant, Some(amount.0), "ft_transfer failed");
        }
    }

    /// Pay what a failed payout left owed. No key, no caller check: anyone may call it, and it only ever
    /// pays `claimant` what is on record for them. A paid amount is cleared from the record before anything
    /// is sent, so a second call cannot pay twice; a leg that fails again is put back by its resolve callback.
    /// NEAR is paid only down to the storage reserve and margin, so a part may stay owed.
    ///
    /// USDC is paid as recorded only when a balance read put the amount on record (the contract had no spare
    /// NEAR for the registration then). When `usdc_unread` is set, which a failed balance read or a failed
    /// `ft_transfer` does, nothing recorded is trusted: the balance is read again, last, and its callback pays
    /// the USDC the token really holds beyond what is owed to others. Until that callback lands the recorded
    /// amount stays held against other claimants' sweeps, and a repeat call only repeats the read. A recorded
    /// amount the token no longer holds (a payout that raced another one) is dropped there and logged as
    /// `owed_reconciled`.
    pub fn retry_payout(&mut self, claimant: AccountId) -> Promise {
        let owed = self.owed.get(&claimant).cloned().unwrap_or_else(|| env::panic_str("nothing owed to this account"));
        let near = owed.near.min(self.payable_near());
        require!(near > 0 || owed.usdc > 0 || owed.usdc_unread, "owed NEAR has not returned to the contract yet");
        let read_usdc = self.usdc.clone().filter(|_| owed.usdc_unread);
        let usdc_calls = (owed.usdc > 0 && !owed.usdc_unread).then(|| {
            self.start_usdc_payout(&claimant, owed.usdc)
                .unwrap_or_else(|| env::panic_str("the contract needs spare NEAR to register the claimant with the token"))
        });

        // A verified USDC amount has moved into `usdc_in_flight` above and leaves the record. An unverified
        // one stays, as the hold that keeps another claimant from sweeping it, until the balance callback
        // settles it. A second call before then repeats the read; it cannot pay, so it cannot pay twice.
        let (held, still_unread) = if owed.usdc > 0 && owed.usdc_unread { (owed.usdc, true) } else { (0, false) };
        let left = owed.near - near;
        if left > 0 || held > 0 {
            self.owed.insert(claimant.clone(), Owed { near: left, usdc: held, usdc_unread: still_unread });
        } else {
            self.owed.remove(&claimant);
        }
        let mut steps = Vec::new();
        if near > 0 {
            steps.push(Promise::new(claimant.clone()).transfer(NearToken::from_yoctonear(near)));
            steps.push(near_resolve(&claimant, near));
        }
        steps.extend(usdc_calls.into_iter().flatten());
        steps.extend(read_usdc.into_iter().flat_map(|usdc| usdc_read_steps(usdc, claimant.clone())));
        chain(steps).unwrap_or_else(|| env::panic_str("nothing to pay"))
    }

    /// A NEP-141 token only accepts transfers to a registered account, so before anyone tops up the USDC
    /// bounty this contract must be registered with the token. Anyone can pay for it, once, with the
    /// NEP-145 storage deposit. The token contract refunds any excess to this contract (which adds to
    /// the NEAR bounty).
    #[payable]
    pub fn register_usdc(&mut self) -> Promise {
        let usdc = self.usdc.clone().unwrap_or_else(|| env::panic_str("no USDC token configured"));
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_REGISTRATION_DEPOSIT, "attach at least 0.01 NEAR for the token's storage deposit");
        ext_ft::ext(usdc)
            .with_attached_deposit(deposit)
            .with_static_gas(FT_STORAGE_DEPOSIT_GAS)
            .storage_deposit(Some(env::current_account_id()), Some(true))
    }

    pub fn era(&self) -> Era {
        self.era
    }

    pub fn omens(&self) -> Vec<OmenView> {
        self.omens
            .iter()
            .map(|(id, o)| OmenView {
                id: id.clone(),
                curve: o.curve,
                level: o.level,
                public_key: hex::encode(&o.key),
                death: o.death.as_ref().map(|d| DeathView {
                    block: d.block.into(),
                    claimant: d.claimant.clone(),
                    signature: hex::encode(&d.signature),
                }),
            })
            .collect()
    }

    /// What the next claim would take: the whole spendable balance (see `claim`). Read-only.
    pub fn bounty(&self) -> BountyView {
        BountyView {
            near: self.spendable_near().into(),
            usdc_token: self.usdc.clone(),
            claimable: self.omens.values().any(|o| o.death.is_none()),
        }
    }

    /// What a failed payout left owed to `claimant`; `retry_payout` pays it.
    pub fn owed(&self, claimant: AccountId) -> OwedView {
        let owed = self.owed.get(&claimant).cloned().unwrap_or_default();
        OwedView { near: owed.near.into(), usdc: owed.usdc.into(), usdc_unread: owed.usdc_unread }
    }

    /// The exact bytes an omen holder signs for `claim`, for tooling and `make verify`. A secp256k1
    /// holder signs the sha256 of these bytes, not their keccak256 (see `claim`).
    pub fn claim_message(&self, omen_id: String, claimant: AccountId) -> String {
        build_claim_message(&env::current_account_id(), &omen_id, &claimant)
    }

    /// Drill twin only. Revives every omen and returns the era to calm so the weekly fire test can rerun.
    /// Refuses any account that is not a `.testnet` one, so a drill wasm deployed by mistake cannot be
    /// reset on mainnet. The production build does not enable the `drill` feature at all (see Cargo.toml).
    #[cfg(feature = "drill")]
    pub fn reset(&mut self) {
        require!(
            env::current_account_id().as_str().ends_with(".testnet"),
            "reset only runs on a .testnet drill twin"
        );
        let ids: Vec<String> = self.omens.keys().cloned().collect();
        for id in ids {
            self.omens.get_mut(&id).unwrap().death = None;
        }
        self.era = Era::Calm;
        emit("reset", serde_json::json!({}));
    }
}

impl Kizashi {
    /// NEAR a claim can take: what is payable, minus what is already owed to earlier claimants.
    fn spendable_near(&self) -> u128 {
        self.payable_near().saturating_sub(self.owed_total().near)
    }

    /// NEAR that can leave the contract: the balance minus the storage stake, minus a margin.
    ///
    /// `claim` writes the death record after this runs, so the stake it will need is not yet in
    /// `storage_usage`. Paying out down to the old reserve would leave the account unable to cover
    /// its own storage and revert the whole claim. The margin also covers the 1 yoctoNEAR the USDC
    /// transfer attaches, the token registration deposit and the owed records.
    fn payable_near(&self) -> u128 {
        env::account_balance().as_yoctonear().saturating_sub(storage_reserve()).saturating_sub(STORAGE_MARGIN.as_yoctonear())
    }

    fn owed_total(&self) -> Owed {
        self.owed.values().fold(Owed::default(), |sum, o| Owed {
            near: sum.near.saturating_add(o.near),
            usdc: sum.usdc.saturating_add(o.usdc),
            usdc_unread: false, // a read has no amount to add up
        })
    }

    fn record_owed(&mut self, claimant: &AccountId, near: u128, usdc: u128) {
        let mut owed = self.owed.get(claimant).cloned().unwrap_or_default();
        owed.near = owed.near.saturating_add(near);
        owed.usdc = owed.usdc.saturating_add(usdc);
        self.owed.insert(claimant.clone(), owed);
    }

    /// Marks the claimant's USDC as "read the balance before paying": set by a failed balance read and by a
    /// failed transfer. Anything recorded in `usdc` alongside it is held, not trusted.
    fn record_unread(&mut self, claimant: &AccountId) {
        let mut owed = self.owed.get(claimant).cloned().unwrap_or_default();
        owed.usdc_unread = true;
        self.owed.insert(claimant.clone(), owed);
    }

    /// Spends the claimant's USDC record (the amount and the unread mark) and returns the amount. The NEAR
    /// part of the record stays. Called by the balance callback, which pays from a fresh read instead.
    fn take_usdc_record(&mut self, claimant: &AccountId) -> u128 {
        let Some(mut owed) = self.owed.get(claimant).cloned() else { return 0 };
        let recorded = owed.usdc;
        owed.usdc = 0;
        owed.usdc_unread = false;
        if owed.near == 0 {
            self.owed.remove(claimant);
        } else {
            self.owed.insert(claimant.clone(), owed);
        }
        recorded
    }

    /// The three calls that pay `amount` USDC to `claimant`: register them with the token (a NEP-141
    /// token refuses an unregistered receiver), transfer, then resolve. Chain them in this order.
    /// None when the contract has no spare NEAR, beyond what it owes, to attach as the deposit.
    ///
    /// Reserves `amount` in `usdc_in_flight` until `on_usdc_paid` reports, so that no other payout is computed
    /// from tokens this one is already sending. Only call it when the steps are going to be scheduled.
    fn start_usdc_payout(&mut self, claimant: &AccountId, amount: u128) -> Option<Vec<Promise>> {
        let usdc = self.usdc.clone()?;
        let spare = env::account_balance().as_yoctonear().saturating_sub(storage_reserve()).saturating_sub(self.owed_total().near);
        if spare <= MIN_REGISTRATION_DEPOSIT.as_yoctonear() {
            return None; // the deposit plus the 1 yoctoNEAR of ft_transfer
        }
        self.usdc_in_flight = self.usdc_in_flight.saturating_add(amount);
        Some(vec![
            ext_ft::ext(usdc.clone())
                .with_attached_deposit(MIN_REGISTRATION_DEPOSIT)
                .with_static_gas(FT_STORAGE_DEPOSIT_GAS)
                .storage_deposit(Some(claimant.clone()), Some(true)),
            // ft_transfer needs exactly 1 yoctoNEAR; it comes from this contract's balance.
            ext_ft::ext(usdc)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(FT_TRANSFER_GAS)
                .ft_transfer(claimant.clone(), amount.into(), Some("KAIGEN bounty".to_string())),
            Self::ext(env::current_account_id())
                .with_static_gas(RESOLVE_GAS)
                .on_usdc_paid(claimant.clone(), amount.into()),
        ])
    }
}

/// Links the calls into one chain, each running after the one before. Every call must be fresh: a
/// promise that is already scheduled after another cannot be chained again.
fn chain(steps: Vec<Promise>) -> Option<Promise> {
    steps.into_iter().reduce(|first, next| first.then(next))
}

/// The USDC balance read and the callback that pays what it returned to `claimant`; chain them in this order.
fn usdc_read_steps(usdc: AccountId, claimant: AccountId) -> [Promise; 2] {
    [
        ext_ft::ext(usdc).with_static_gas(FT_BALANCE_GAS).ft_balance_of(env::current_account_id()),
        Kizashi::ext(env::current_account_id()).with_static_gas(ON_USDC_BALANCE_GAS).on_usdc_balance(claimant),
    ]
}

/// The callback that books the outcome of a NEAR transfer to `claimant`; chain it right after the transfer.
fn near_resolve(claimant: &AccountId, amount: u128) -> Promise {
    Kizashi::ext(env::current_account_id()).with_static_gas(RESOLVE_GAS).on_near_payout(claimant.clone(), amount.into())
}

fn storage_reserve() -> u128 {
    u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
}

/// Whether the one promise this callback waited on succeeded, whatever it returned.
fn previous_promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

/// Refuses an ed25519 key that is not a canonical encoding or is a small-order point. Both are cheap to
/// check and neither can be an omen nobody holds: a small-order key accepts signatures anyone can make.
fn require_usable_ed25519(key: &[u8]) {
    // Canonical: the 255-bit y coordinate is below p = 2^255 - 19. Above it is an alias of a smaller y.
    let y_is_below_p = key[31] & 0x7f != 0x7f || key[1..31].iter().any(|b| *b != 0xff) || key[0] < 0xed;
    require!(y_is_below_p, "non-canonical ed25519 key");
    require!(!SMALL_ORDER_ED25519.contains(&hex::encode(key).as_str()), "small-order ed25519 key");
}

fn build_claim_message(contract: &AccountId, omen_id: &str, claimant: &AccountId) -> String {
    format!("{CLAIM_DOMAIN}\n{contract}\n{omen_id}\n{claimant}")
}

fn verify(omen: &Omen, message: &[u8], signature: &[u8]) -> bool {
    match omen.curve {
        Curve::Ed25519 => {
            let (Ok(sig), Ok(key)) =
                (<&[u8; 64]>::try_from(signature), <&[u8; 32]>::try_from(omen.key.as_slice()))
            else {
                return false;
            };
            env::ed25519_verify(sig, message, key)
        }
        Curve::Secp256k1 => {
            if signature.len() != 65 || signature[64] > 1 {
                return false;
            }
            let hash = env::sha256_array(message);
            // `true`: reject high-s signatures, so each signature has one valid form.
            env::ecrecover(&hash, &signature[..64], signature[64], true)
                .is_some_and(|recovered| recovered.as_slice() == omen.key.as_slice())
        }
    }
}

fn emit_payout_ok(asset: &str, claimant: &AccountId, amount: u128) {
    emit("payout_ok", serde_json::json!({ "asset": asset, "claimant": claimant, "amount": U128(amount) }));
}

/// `amount` is None when it is not known (a failed balance read).
fn emit_payout_failed(asset: &str, claimant: &AccountId, amount: Option<u128>, reason: &str) {
    emit(
        "payout_failed",
        serde_json::json!({ "asset": asset, "claimant": claimant, "amount": amount.map(U128), "reason": reason }),
    );
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "kaigen", "version": "1.0.0", "event": event, "data": data })
    ));
}

#[cfg(test)]
mod tests;
