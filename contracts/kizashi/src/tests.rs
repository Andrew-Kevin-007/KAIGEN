use super::*;
use ed25519_dalek::{Signer, SigningKey as EdKey};
use k256::ecdsa::SigningKey as SecpKey;
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use sha2::{Digest, Sha256};

fn ctx() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).block_height(100);
    testing_env!(b.build());
}

fn ed_key() -> EdKey {
    EdKey::from_bytes(&[7u8; 32])
}

fn secp_key() -> SecpKey {
    SecpKey::from_bytes((&[9u8; 32]).into()).unwrap()
}

fn secp_pub(k: &SecpKey) -> String {
    let point = k.verifying_key().to_encoded_point(false);
    hex::encode(&point.as_bytes()[1..])
}

/// Deploy-and-init is signed by the contract account itself.
fn ctx_init() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0)).block_height(100);
    testing_env!(b.build());
}

fn init(omens: Vec<(&str, Curve, Era, String)>) -> Kizashi {
    init_with(omens, None)
}

fn init_with(omens: Vec<(&str, Curve, Era, String)>, usdc: Option<AccountId>) -> Kizashi {
    ctx_init();
    let k = Kizashi::new(
        omens
            .into_iter()
            .map(|(id, curve, level, public_key)| OmenInit { id: id.into(), curve, level, public_key })
            .collect(),
        usdc,
    );
    ctx();
    k
}

fn standard() -> Kizashi {
    init(vec![
        ("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes())),
        ("secp256k1-omen", Curve::Secp256k1, Era::Kaigen, secp_pub(&secp_key())),
        ("small-curve-omen", Curve::Ed25519, Era::Warning, hex::encode(EdKey::from_bytes(&[3u8; 32]).verifying_key().to_bytes())),
    ])
}

fn msg(k: &Kizashi, omen: &str, claimant: &AccountId) -> String {
    k.claim_message(omen.into(), claimant.clone())
}

fn ed_sig(k: &Kizashi, omen: &str, claimant: &AccountId, key: &EdKey) -> Base64VecU8 {
    key.sign(msg(k, omen, claimant).as_bytes()).to_bytes().to_vec().into()
}

fn secp_sig(k: &Kizashi, omen: &str, claimant: &AccountId) -> Vec<u8> {
    let hash = Sha256::digest(msg(k, omen, claimant).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&hash).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rid.to_byte());
    out
}

#[test]
fn claim_message_is_domain_separated() {
    let k = standard();
    assert_eq!(
        k.claim_message("ed25519-omen".into(), accounts(2)),
        format!("KAIGEN/v1/claim\n{}\ned25519-omen\n{}", accounts(0), accounts(2))
    );
}

#[test]
fn ed25519_claim_raises_era_and_kills_omen_forever() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig.clone());
    assert_eq!(k.era(), Era::Kaigen);
    let omen = k.omens().into_iter().find(|o| o.id == "ed25519-omen").unwrap();
    let death = omen.death.unwrap();
    assert_eq!(death.claimant, accounts(2));
    assert_eq!(death.block.0, 100);
    // A second claim, even with the same valid signature, must fail.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    }));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "bad signature")]
fn copied_signature_cannot_redirect_the_bounty() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    // Attacker replays the signature naming themselves as claimant.
    let _ = k.claim("ed25519-omen".into(), accounts(3), sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn wrong_key_is_rejected() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &EdKey::from_bytes(&[1u8; 32]));
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn signature_for_another_omen_is_rejected() {
    let mut k = standard();
    // Valid ed25519 signature over the small-curve omen's message, submitted for ed25519-omen.
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
}

#[test]
#[should_panic(expected = "unknown omen")]
fn unknown_omen_is_rejected() {
    let mut k = standard();
    let _ = k.claim("nope".into(), accounts(2), vec![0u8; 64].into());
}

#[test]
fn secp256k1_claim_works() {
    let mut k = standard();
    let sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
    assert_eq!(k.era(), Era::Kaigen);
}

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_high_s_is_rejected() {
    let mut k = standard();
    let hash = Sha256::digest(msg(&k, "secp256k1-omen", &accounts(2)).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&hash).unwrap();
    // Flip to the malleable twin: s' = n - s, recovery parity flipped.
    let s_neg = -*sig.s().as_ref();
    let twin = k256::ecdsa::Signature::from_scalars(
        *sig.r().as_ref(),
        k256::NonZeroScalar::new(s_neg).unwrap().as_ref().to_owned(),
    )
    .unwrap();
    let mut bytes = twin.to_bytes().to_vec();
    bytes.push(rid.to_byte() ^ 1);
    let _ = k.claim("secp256k1-omen".into(), accounts(2), bytes.into());
}

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_bad_recovery_byte_is_rejected() {
    let mut k = standard();
    let mut sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    *sig.last_mut().unwrap() = 27;
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
}

#[test]
fn warning_omen_raises_to_warning_and_era_never_goes_back() {
    let mut k = standard();
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Warning);

    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);

    // A lower-level omen dying later cannot lower the era (fresh registry, kaigen first).
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let sig = ed_sig(&k, "small-curve-omen", &accounts(2), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
}

#[test]
fn init_validates_input() {
    let good = hex::encode(ed_key().verifying_key().to_bytes());
    for (omens, why) in [
        (vec![("a", Curve::Ed25519, Era::Kaigen, "zz".to_string())], "bad hex key"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, "00".to_string())], "bad key length"),
        (vec![("a", Curve::Secp256k1, Era::Kaigen, good.clone())], "bad key length"),
        (vec![("a", Curve::Ed25519, Era::Calm, good.clone())], "omen level"),
        (
            vec![("a", Curve::Ed25519, Era::Kaigen, good.clone()), ("a", Curve::Ed25519, Era::Kaigen, good.clone())],
            "duplicate omen id",
        ),
        (vec![], "1..=8 omens"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, "00".repeat(32))], "all-zero key"),
        (vec![("a", Curve::Secp256k1, Era::Kaigen, "00".repeat(64))], "all-zero key"),
        (
            vec![
                ("dup-a", Curve::Ed25519, Era::Kaigen, good.clone()),
                ("dup-b", Curve::Ed25519, Era::Warning, good.clone()),
            ],
            "duplicate omen key",
        ),
        (
            vec![
                ("dup-c", Curve::Secp256k1, Era::Kaigen, secp_pub(&secp_key())),
                ("dup-d", Curve::Secp256k1, Era::Warning, secp_pub(&secp_key())),
            ],
            "duplicate omen key",
        ),
        (vec![("a", Curve::Ed25519, Era::Kaigen, format!("{}7f", "ff".repeat(31)))], "non-canonical ed25519 key"),
        (vec![("a", Curve::Ed25519, Era::Kaigen, format!("ed{}7f", "ff".repeat(30)))], "non-canonical ed25519 key"),
    ] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            init(omens);
        }));
        let err = r.expect_err(why);
        let text = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(text.contains(why), "expected {why:?}, got {text:?}");
    }
}

#[test]
fn bounty_view_reports_spendable_balance() {
    let k = standard();
    let b = k.bounty();
    assert!(b.near.0 <= env::account_balance().as_yoctonear());
    assert!(b.usdc_token.is_none());
}

fn receipts_text() -> String {
    let raw = format!("{:?}", near_sdk::test_utils::get_created_receipts());
    let mut out = String::new();
    let mut rest = raw.as_str();
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find(']') else { break };
        let bytes: Option<Vec<u8>> =
            rest[start + 1..start + len].split(", ").map(|n| n.trim().parse::<u8>().ok()).collect();
        match bytes.filter(|b| b.len() >= 3 && b.iter().all(|c| (0x20..0x7f).contains(c))) {
            Some(b) => {
                out.push_str(&String::from_utf8_lossy(&b));
                rest = &rest[start + len + 1..];
            }
            None => {
                out.push('[');
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[test]
fn claim_with_usdc_configured_chains_payout_balance_read_and_callback() {
    // Regression: chaining the callback onto an already-chained promise made every claim panic.
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
    let r = receipts_text();
    assert!(r.contains("ft_balance_of"), "{r}");
    assert!(r.contains("on_usdc_balance"), "{r}");
}

#[test]
fn on_usdc_balance_pays_the_balance_with_one_yocto_and_ignores_zero_or_errors() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(0)));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "nothing to send");
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "a failed balance read sends nothing");
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(5_000_000)));
    let r = receipts_text();
    assert!(r.contains("ft_transfer") && r.contains("5000000") && r.contains("inner: 1 }"), "{r}");
}

#[test]
fn payout_always_leaves_the_storage_margin() {
    let k = standard();
    let reserve = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
    let balance = env::account_balance().as_yoctonear();
    assert!(k.bounty().near.0 + reserve + STORAGE_MARGIN.as_yoctonear() <= balance);
}

fn ctx_paying(deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).attached_deposit(deposit);
    testing_env!(b.build());
}

#[test]
fn register_usdc_pays_the_tokens_storage_deposit_for_this_contract() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_paying(NearToken::from_millinear(20));
    let _ = k.register_usdc();
    let r = receipts_text();
    assert!(r.contains("storage_deposit") && r.contains("usdc.token"), "{r}");
    assert!(r.contains(&accounts(0).to_string()) && r.contains("registration_only"), "registers this contract, nobody else: {r}");
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR")]
fn register_usdc_needs_a_real_deposit() {
    let mut k = init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    );
    ctx_paying(NearToken::from_yoctonear(1));
    let _ = k.register_usdc();
}

#[test]
#[should_panic(expected = "no USDC token configured")]
fn register_usdc_without_a_token_is_refused() {
    let mut k = standard();
    ctx_paying(NearToken::from_millinear(20));
    let _ = k.register_usdc();
}

// --- K1: the USDC payout registers the claimant, transfers, and reports ---

const PAID: u128 = 5_000_000;

fn usdc_registry() -> Kizashi {
    init_with(
        vec![("ed25519-omen", Curve::Ed25519, Era::Kaigen, hex::encode(ed_key().verifying_key().to_bytes()))],
        Some("usdc.token".parse().unwrap()),
    )
}

/// The contract calling itself back, with `result` as what the promise it waited on returned.
fn ctx_callback(result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0));
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// Anyone calling, with the contract holding `balance`.
fn ctx_with_balance(balance: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).account_balance(balance);
    testing_env!(b.build());
}

fn logged(event: &str) -> bool {
    get_logs().iter().any(|l| l.contains(&format!("\"event\":\"{event}\"")))
}

fn pos(text: &str, needle: &str) -> usize {
    text.find(needle).unwrap_or_else(|| panic!("{needle:?} missing in {text}"))
}

fn panic_text(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[test]
fn claim_chains_the_near_resolve_before_the_balance_read_and_the_usdc_callback() {
    let mut k = usdc_registry();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let r = receipts_text();
    assert!(pos(&r, "on_near_payout") < pos(&r, "ft_balance_of"), "{r}");
    assert!(pos(&r, "ft_balance_of") < pos(&r, "on_usdc_balance"), "{r}");
}

#[test]
fn claim_without_usdc_still_resolves_the_near_payout() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let r = receipts_text();
    assert!(r.contains("on_near_payout") && !r.contains("ft_balance_of"), "{r}");
}

#[test]
fn gas_constants_fit_the_chain_they_pay_for() {
    assert!(FT_BALANCE_GAS >= Gas::from_tgas(10), "ft_balance_of was starved at 5 Tgas");
    let children = FT_STORAGE_DEPOSIT_GAS.as_gas() + FT_TRANSFER_GAS.as_gas() + RESOLVE_GAS.as_gas();
    assert!(ON_USDC_BALANCE_GAS.as_gas() >= children + Gas::from_tgas(5).as_gas(), "callback cannot afford its own chain");
    // What `claim` reserves for its callbacks; whether the whole call fits is measured, not added up, in
    // `claim_with_usdc_fits_the_gas_a_caller_attaches`.
    let claim_static = RESOLVE_GAS.as_gas() + FT_BALANCE_GAS.as_gas() + ON_USDC_BALANCE_GAS.as_gas();
    assert!(claim_static < CLAIM_GAS_ATTACHED.as_gas(), "the callbacks alone would use up the claim");
    // retry_payout with every leg owed schedules the NEAR resolve, the three USDC calls, the balance
    // read and its callback; whoever calls it must be able to attach that on top of its own work.
    let retry_static = RESOLVE_GAS.as_gas() + children + FT_BALANCE_GAS.as_gas() + ON_USDC_BALANCE_GAS.as_gas();
    assert!(retry_static <= Gas::from_tgas(200).as_gas(), "a full retry would not fit the 300 Tgas cap");
}

/// What a caller must attach to `claim` (`CLAIM_GAS_TGAS` in jobs/src/chain.mjs): the measured need below, plus
/// 10% for the wasm the unit-test VM does not run, rounded up.
const CLAIM_GAS_ATTACHED: Gas = Gas::from_tgas(170);

#[test]
fn claim_with_usdc_fits_the_gas_a_caller_attaches() {
    // `used_gas` is what the call has used up, counting the gas it attaches to the calls it schedules, which is
    // the figure the runtime holds against the prepaid gas. Measured with the USDC leg, the longest `claim` there is.
    let mut k = usdc_registry();
    ctx();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let before = env::used_gas().as_gas();
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let used = env::used_gas().as_gas() - before;
    assert!(used * 11 / 10 <= CLAIM_GAS_ATTACHED.as_gas(), "claim used {used} gas, plus 10% must fit {}", CLAIM_GAS_ATTACHED.as_gas());
    assert!(CLAIM_GAS_ATTACHED <= Gas::from_tgas(300), "a transaction carries at most 300 Tgas");
}

#[test]
fn a_claim_that_releases_a_full_stale_list_still_fits_the_gas_a_caller_attaches() {
    // `claim` lets the stale reservations go before it orders its read: a full list, all of it stale, is the most it logs.
    let mut k = usdc_registry();
    for _ in 0..MAX_IN_FLIGHT {
        k.in_flight.push(InFlight { claimant: accounts(4), amount: 1, at: 0 });
    }
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let before = env::used_gas().as_gas();
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let used = env::used_gas().as_gas() - before;
    assert!(logged("in_flight_released") && k.in_flight.is_empty(), "the whole list was released");
    assert!(used * 11 / 10 <= CLAIM_GAS_ATTACHED.as_gas(), "claim used {used} gas, plus 10% must fit {}", CLAIM_GAS_ATTACHED.as_gas());
}

#[test]
fn the_longest_retry_fits_a_transaction() {
    // NEAR and a balance read together are the longest chain `retry_payout` schedules (a verified USDC amount is
    // shorter: it skips the read and its 90 Tgas callback). Whoever calls it has to attach this much.
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), NearToken::from_near(1).as_yoctonear(), PAID);
    k.record_unread(&accounts(2));
    ctx();
    let before = env::used_gas().as_gas();
    let _ = k.retry_payout(accounts(2));
    let used = env::used_gas().as_gas() - before;
    assert!(used * 11 / 10 <= Gas::from_tgas(300).as_gas(), "retry used {used} gas, plus 10% must fit a transaction");
}

#[test]
fn usdc_payout_registers_the_claimant_then_transfers_then_resolves() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    let r = receipts_text();
    let (register, transfer, resolve) = (pos(&r, "storage_deposit"), pos(&r, "ft_transfer"), pos(&r, "on_usdc_paid"));
    assert!(register < transfer && transfer < resolve, "{r}");
    assert!(r.contains("registration_only") && r.contains(&accounts(2).to_string()), "registers the claimant: {r}");
    assert!(r.contains(&format!("inner: {} }}", MIN_REGISTRATION_DEPOSIT.as_yoctonear())), "{r}");
    assert!(r.contains("\"amount\":\"5000000\"") && r.contains("inner: 1 }"), "{r}");
}

#[test]
fn failed_usdc_balance_read_is_reported_not_swallowed() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    assert!(logged("payout_failed"), "{:?}", get_logs());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn usdc_payout_the_contract_cannot_fund_is_recorded_not_lost() {
    let mut k = usdc_registry();
    // 0.001 NEAR above the reserve: not enough for the 0.01 NEAR registration deposit.
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + 1_000_000_000_000_000_000_000));
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "no registration deposit to attach");
    assert!(logged("payout_failed"));
    assert_eq!(k.owed(accounts(2)).usdc.0, PAID);
}

#[test]
fn the_registration_deposit_is_not_taken_from_the_near_owed_to_another_claimant() {
    // The deposit leaves the balance when the payout is scheduled and the token refunds it later, so while it is out the
    // contract holds less than it owes. It may only come out of what is spare beyond what is owed.
    let mut k = usdc_registry();
    let owed_near: u128 = 3_000_000_000_000_000_000_000_000; // 3 NEAR, owed to accounts(4)
    k.record_owed(&accounts(4), owed_near, 0);
    k.record_owed(&accounts(2), 0, PAID);
    // The reserve, what is owed and 0.005 NEAR: not enough for the 0.01 NEAR deposit.
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + owed_near + 5_000_000_000_000_000_000_000));
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("spare NEAR"), "a retry that cannot attach the deposit says so: {text}");
    // With 0.02 NEAR above what is owed the same retry goes through.
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + owed_near + 20_000_000_000_000_000_000_000));
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    assert!(r.contains("storage_deposit") && r.contains("ft_transfer"), "{r}");
}

#[test]
fn usdc_owed_to_an_earlier_claimant_is_not_swept_by_a_later_one() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, 3_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID)));
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"2000000\"") && !r.contains("\"amount\":\"5000000\""), "only the unowed part moves: {r}");
}

#[test]
fn usdc_resolve_reports_success_and_records_nothing() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert!(logged("payout_ok"), "{:?}", get_logs());
    assert_eq!(k.owed(accounts(2)).usdc.0, 0);
}

#[test]
fn usdc_resolve_reports_failure_and_records_the_amount_as_owed() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert!(logged("payout_failed"), "{:?}", get_logs());
    assert_eq!(k.owed(accounts(2)).usdc.0, PAID);
}

// --- K3: a failed payout is owed, and anyone can retry it, to the recorded claimant only ---

#[test]
fn near_resolve_reports_success_and_records_nothing() {
    let mut k = standard();
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_near_payout(accounts(2), U128(1_000));
    assert!(logged("payout_ok"));
    assert_eq!(k.owed(accounts(2)).near.0, 0);
}

#[test]
fn near_resolve_failure_is_recorded_and_amounts_add_up() {
    let mut k = standard();
    ctx_callback(PromiseResult::Failed);
    k.on_near_payout(accounts(2), U128(1_000));
    k.on_near_payout(accounts(2), U128(500));
    assert!(logged("payout_failed"));
    assert_eq!(k.owed(accounts(2)).near.0, 1_500);
    assert_eq!(k.owed(accounts(3)).near.0, 0, "only the recorded claimant is owed");
}

#[test]
fn bounty_view_leaves_out_near_that_is_owed() {
    let mut k = standard();
    let before = k.bounty().near.0;
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    assert_eq!(k.bounty().near.0, before - one_near);
}

#[test]
fn retry_pays_the_recorded_claimant_the_recorded_amount_and_clears_the_record() {
    let mut k = standard();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    ctx(); // accounts(1) calls: anyone may
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    assert!(r.contains(&accounts(2).to_string()) && !r.contains(&accounts(3).to_string()), "{r}");
    assert!(r.contains(&format!("inner: {one_near} }}")) && r.contains("on_near_payout"), "{r}");
    assert_eq!(k.owed(accounts(2)).near.0, 0, "cleared before sending, so a second retry cannot double pay");
    let again = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(again.contains("nothing owed"), "{again}");
}

#[test]
fn retry_for_an_account_that_is_owed_nothing_is_refused() {
    let mut k = standard();
    k.record_owed(&accounts(2), 1_000, 0);
    ctx();
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(3));
    });
    assert!(text.contains("nothing owed"), "{text}");
}

#[test]
fn retry_pays_only_what_the_contract_can_spare_and_keeps_the_rest_owed() {
    let mut k = standard();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    let spare = 400_000_000_000_000_000_000_000; // 0.4 NEAR above the reserve and the margin
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + STORAGE_MARGIN.as_yoctonear() + spare));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains(&format!("inner: {spare} }}")));
    assert_eq!(k.owed(accounts(2)).near.0, one_near - spare);
}

#[test]
fn retry_with_nothing_payable_yet_is_refused() {
    let mut k = standard();
    k.record_owed(&accounts(2), NearToken::from_near(1).as_yoctonear(), 0);
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("has not returned"), "{text}");
}

#[test]
fn retry_of_the_usdc_leg_registers_transfers_and_resolves() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID);
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let (register, transfer, resolve) = (pos(&r, "storage_deposit"), pos(&r, "ft_transfer"), pos(&r, "on_usdc_paid"));
    assert!(register < transfer && transfer < resolve && r.contains("\"amount\":\"5000000\""), "{r}");
    assert_eq!(k.owed(accounts(2)).usdc.0, 0);
}

#[test]
fn retry_of_both_legs_is_one_ordered_chain() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, PAID);
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let order = ["Transfer", "on_near_payout", "storage_deposit", "ft_transfer", "on_usdc_paid"].map(|n| pos(&r, n));
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.near.0, owed.usdc.0), (0, 0));
}

#[test]
fn retry_of_usdc_without_spare_near_for_the_registration_is_refused() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID);
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("spare NEAR"), "{text}");
}

// --- K3: a failed ft_balance_of read is owed too, as a read to repeat, because no amount is known ---

#[test]
fn failed_usdc_balance_read_is_held_so_the_claimant_can_retry_it() {
    // Regression: the failure was only logged. If that claim killed the last omen, no later claim
    // could ever sweep the USDC, and with no keys on the account it was stranded for good.
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    let owed = k.owed(accounts(2));
    assert!(owed.usdc_unread, "the read is what is owed");
    assert_eq!((owed.near.0, owed.usdc.0), (0, 0), "no amount is known, so none is recorded");
    assert!(!k.owed(accounts(3)).usdc_unread, "only the claimant whose read failed");
}

#[test]
fn retry_of_a_failed_usdc_balance_read_reads_again_and_pays_in_the_callback() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    ctx(); // accounts(1) calls: anyone may
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    let (read, callback) = (pos(&r, "ft_balance_of"), pos(&r, "on_usdc_balance"));
    assert!(read < callback && r.contains("usdc.token") && r.contains(&accounts(2).to_string()), "{r}");
    assert!(!r.contains(&accounts(3).to_string()), "{r}");
    assert!(!k.owed(accounts(2)).usdc_unread, "cleared before sending, so a second retry cannot double pay");
    let again = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(again.contains("nothing owed"), "{again}");
}

#[test]
fn retry_of_a_failed_usdc_balance_read_needs_no_payable_near() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve()));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains("ft_balance_of"));
}

#[test]
fn retry_of_all_three_legs_is_one_ordered_chain() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, PAID);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    // With a balance read pending nothing recorded in USDC is paid blind: the read settles all of it, so the
    // chain is the NEAR transfer and its resolve, then the read and its callback.
    let order = ["Transfer", "on_near_payout", "ft_balance_of", "on_usdc_balance"].map(|n| pos(&r, n));
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{r}");
    assert!(!r.contains("ft_transfer") && !r.contains("storage_deposit"), "{r}");
    let owed = k.owed(accounts(2));
    // The NEAR is on its way; the unverified USDC stays held until the read settles it.
    assert_eq!((owed.near.0, owed.usdc.0, owed.usdc_unread), (0, PAID, true));
}

#[test]
fn retry_with_part_of_the_near_still_owed_keeps_that_part_and_hands_the_read_on() {
    let mut k = usdc_registry();
    let one_near = NearToken::from_near(1).as_yoctonear();
    k.record_owed(&accounts(2), one_near, 0);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Err(PromiseError::Failed));
    let spare = 400_000_000_000_000_000_000_000; // 0.4 NEAR above the reserve and the margin
    ctx_with_balance(NearToken::from_yoctonear(storage_reserve() + STORAGE_MARGIN.as_yoctonear() + spare));
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains("ft_balance_of"));
    let owed = k.owed(accounts(2));
    assert_eq!((owed.near.0, owed.usdc.0, owed.usdc_unread), (one_near - spare, 0, false));
}

// --- K2: reset exists only in the drill build, and only on a .testnet account ---

#[test]
fn reset_is_gated_by_the_drill_feature() {
    let lines: Vec<&str> = include_str!("lib.rs").lines().collect();
    let at: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.trim_start().starts_with("pub fn reset")).map(|(i, _)| i).collect();
    assert_eq!(at.len(), 1, "exactly one reset");
    let gate = lines[..at[0]].iter().rev().find(|l| !l.trim_start().starts_with("///")).unwrap().trim();
    assert_eq!(gate, "#[cfg(feature = \"drill\")]");
}

#[test]
fn drill_is_not_a_default_feature() {
    let features: Vec<&str> = include_str!("../Cargo.toml")
        .lines()
        .skip_while(|l| l.trim() != "[features]")
        .skip(1)
        .take_while(|l| !l.trim_start().starts_with('['))
        .collect();
    assert!(features.iter().any(|l| l.trim() == "drill = []"));
    assert!(!features.iter().any(|l| l.trim_start().starts_with("default")), "a default feature set could pull drill in");
}

#[cfg(not(feature = "drill"))]
#[test]
fn production_feature_set_has_no_reset() {
    // `reset` is behind `#[cfg(feature = "drill")]` (see reset_is_gated_by_the_drill_feature), and a
    // production build does not enable it. The wasm export list is checked at deploy time as well.
    assert!(!cfg!(feature = "drill"));
}

#[cfg(feature = "drill")]
#[test]
#[should_panic(expected = ".testnet")]
fn reset_refuses_an_account_that_is_not_a_testnet_twin() {
    let mut k = standard();
    k.reset();
}

#[cfg(feature = "drill")]
#[test]
fn reset_revives_the_omens_on_a_testnet_twin() {
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    assert_eq!(k.era(), Era::Kaigen);
    let mut b = VMContextBuilder::new();
    b.current_account_id("kizashi.testnet".parse().unwrap()).predecessor_account_id(accounts(1));
    testing_env!(b.build());
    k.reset();
    assert_eq!(k.era(), Era::Calm);
    assert!(k.omens().iter().all(|o| o.death.is_none()));
}

// --- K4: bounty() says whether a claim can still pay out ---

#[test]
fn bounty_view_reports_whether_any_omen_is_still_claimable() {
    let mut k = standard();
    assert!(k.bounty().claimable);
    let json = near_sdk::serde_json::to_string(&k.bounty()).unwrap();
    assert!(json.contains("\"claimable\":true"), "{json}");
    for (id, key) in [("ed25519-omen", ed_key()), ("small-curve-omen", EdKey::from_bytes(&[3u8; 32]))] {
        let sig = ed_sig(&k, id, &accounts(2), &key);
        let _ = k.claim(id.into(), accounts(2), sig);
    }
    assert!(k.bounty().claimable, "one omen is still alive");
    let sig = secp_sig(&k, "secp256k1-omen", &accounts(2));
    let _ = k.claim("secp256k1-omen".into(), accounts(2), sig.into());
    assert!(!k.bounty().claimable);
}

// --- K5: init refuses keys that can never be a real omen ---

#[test]
fn init_refuses_every_small_order_ed25519_key() {
    for key in SMALL_ORDER_ED25519.iter().filter(|k| k.bytes().any(|b| b != b'0')) {
        let text = panic_text(|| {
            init(vec![("a", Curve::Ed25519, Era::Kaigen, key.to_string())]);
        });
        assert!(text.contains("small-order ed25519 key"), "{key}: {text}");
    }
}

#[test]
fn small_order_list_is_exactly_the_encodings_dalek_calls_weak() {
    // The curve has 8 points of small order. Each of the six with x != 0 has one encoding with y < p;
    // identity and (0, -1) have x = 0 and so two (sign bit clear or set). Non-canonical aliases (y >= p)
    // are refused separately. That is 6 + 2 * 2 = 10 encodings, and the list must be those.
    let mut seen = std::collections::BTreeSet::new();
    for h in SMALL_ORDER_ED25519 {
        let bytes: [u8; 32] = hex::decode(h).unwrap().try_into().unwrap();
        let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).unwrap_or_else(|e| panic!("{h} does not decode: {e}"));
        assert!(key.is_weak(), "{h} is not a small-order point");
        assert!(seen.insert(h), "{h} listed twice");
    }
    assert_eq!(seen.len(), 10);
}

// --- K7: secp256k1 signs sha256(message), not keccak ---

#[test]
#[should_panic(expected = "bad signature")]
fn secp256k1_signature_over_keccak_is_rejected() {
    let mut k = standard();
    let digest = env::keccak256_array(msg(&k, "secp256k1-omen", &accounts(2)).as_bytes());
    let (sig, rid) = secp_key().sign_prehash_recoverable(&digest).unwrap();
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(rid.to_byte());
    let _ = k.claim("secp256k1-omen".into(), accounts(2), bytes.into());
}

// --- K8: two claims close together cannot be paid the same balance, and a failed transfer is no debt until verified ---
//
// `claim` reads the token balance and a LATER callback pays it, so two claims whose reads land before the first
// transfer does both see the full balance. The contract reserves what it has scheduled (`in_flight`), and a
// transfer that fails is held as an UNVERIFIED amount: the retry reads the balance again and pays what the token
// really holds, so a phantom debt (tokens already paid to someone else) clears instead of hiding later top-ups.

const TOP_UP: u128 = 750_000;

fn receiver_is(text: &str, who: &AccountId) -> bool {
    text.contains(&format!("\"receiver_id\":\"{who}\""))
}

#[test]
fn two_payouts_close_together_cannot_both_be_paid_the_same_balance() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID))); // read before the first transfer landed: the same balance
    let r = receipts_text();
    assert_eq!(r.matches("ft_transfer").count(), 1, "only one transfer may be scheduled: {r}");
    assert!(receiver_is(&r, &accounts(2)) && !r.contains(&accounts(3).to_string()), "{r}");
    assert_eq!(k.in_flight_total(), PAID);
}

#[test]
fn owed_and_in_flight_usdc_both_stay_out_of_reach_of_a_later_claim() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, 3_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID))); // 2 000 000 is free, and goes in flight
    k.on_usdc_balance(accounts(4), U64(k.usdc_epoch), Ok(U128(PAID))); // nothing is free any more
    let r = receipts_text();
    assert_eq!(r.matches("ft_transfer").count(), 1, "{r}");
    assert!(r.contains("\"amount\":\"2000000\"") && !r.contains(&accounts(4).to_string()), "{r}");
    assert_eq!(k.in_flight_total(), 2_000_000);
}

#[test]
fn a_settled_payout_releases_its_reservation_whether_it_succeeded_or_not() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert_eq!(k.in_flight_total(), PAID);
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert_eq!(k.in_flight_total(), 0, "paid");
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert_eq!(k.in_flight_total(), PAID);
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(3), U128(PAID));
    assert_eq!(k.in_flight_total(), 0, "failed: it is owed now, not in flight");
}

#[test]
fn a_transfer_that_fails_is_held_as_unverified_debt() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    let owed = k.owed(accounts(2));
    assert_eq!(owed.usdc.0, PAID, "still protected from a later claimant's sweep");
    assert!(owed.usdc_unread, "but not trusted: the retry must look at the token balance first");
}

#[test]
fn retrying_an_unverified_amount_reads_the_balance_and_does_not_pay_it_blind() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    ctx();
    let _ = k.retry_payout(accounts(2));
    let r = receipts_text();
    assert!(r.contains("ft_balance_of") && r.contains("on_usdc_balance"), "{r}");
    assert!(!r.contains("ft_transfer") && !r.contains("storage_deposit"), "nothing is sent before the read: {r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (PAID, true), "still held against sweeps until the read settles it");
    // A second call before the read lands only repeats the read: it has no way to pay.
    ctx();
    let _ = k.retry_payout(accounts(2));
    let again = receipts_text();
    assert!(!again.contains("ft_transfer") && !again.contains("storage_deposit"), "{again}");
}

#[test]
fn a_transfer_that_failed_for_a_real_reason_is_paid_after_the_re_read() {
    let mut k = usdc_registry();
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // say the token refused for a while: the USDC is still here
    ctx();
    let _ = k.retry_payout(accounts(2));
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID))); // the read confirms it
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"5000000\"") && receiver_is(&r, &accounts(2)), "{r}");
    let owed = k.owed(accounts(2));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (0, false), "the record is spent by the payout it triggered");
    assert_eq!(k.in_flight_total(), PAID);
}

#[test]
fn a_phantom_debt_clears_at_the_re_read_and_hides_no_later_top_up() {
    let mut k = usdc_registry();
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID)); // the first payout landed: the token holds nothing now
    // A transfer for tokens the token no longer holds. A read from before the first payout landed no longer gets
    // this far (see K10), but a payout whose reservation timed out and which landed late still can.
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(3), U128(PAID)); // the token had nothing to send
    assert_eq!(k.owed(accounts(3)).usdc.0, PAID, "recorded, as unverified");

    ctx();
    let _ = k.retry_payout(accounts(3));
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(0))); // the token holds nothing
    let o = k.owed(accounts(3));
    assert_eq!((o.near.0, o.usdc.0, o.usdc_unread), (0, 0, false), "the phantom is gone");
    assert!(logged("owed_reconciled"), "{:?}", get_logs());
    assert!(get_created_receipts().is_empty());

    ctx_init();
    k.on_usdc_balance(accounts(4), U64(k.usdc_epoch), Ok(U128(TOP_UP))); // a top-up arrives and the next claim takes all of it
    let r = receipts_text();
    assert!(r.contains(&format!("\"amount\":\"{TOP_UP}\"")) && receiver_is(&r, &accounts(4)), "{r}");
}

#[test]
fn a_re_read_never_pays_more_than_the_token_holds_beyond_what_others_are_owed() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(3), 0, 1_000_000); // a real, verified debt to someone else
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // unverified: the token now holds 4 000 000 in total
    ctx();
    let _ = k.retry_payout(accounts(2));
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(4_000_000)));
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"3000000\""), "4 000 000 held minus 1 000 000 owed to the other claimant: {r}");
    assert!(logged("owed_reconciled"), "the recorded 5 000 000 was more than there was: {:?}", get_logs());
    assert_eq!(k.owed(accounts(3)).usdc.0, 1_000_000, "the other claimant's debt is untouched");
}

#[test]
fn a_verified_retry_reserves_its_amount_while_it_is_in_flight() {
    let mut k = usdc_registry();
    k.record_owed(&accounts(2), 0, PAID); // recorded from a balance read, not from a failed transfer
    ctx();
    let _ = k.retry_payout(accounts(2));
    assert_eq!(k.in_flight_total(), PAID);
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "the amount being retried is not free for another claim");
}

#[test]
fn the_balance_callback_costs_the_same_gas_however_many_records_are_owed() {
    // The callback sums the owed records (at most 8, one per claimant) and spends the claimant's own. Measured
    // in the unit-test VM, which charges the real fees: the cost must not grow with the records, and it must
    // fit the gas `claim` reserves for it. `used_gas` counts the gas attached to the calls the callback
    // schedules (45 Tgas of them), which that budget also has to cover, so the absolute figure IS what
    // `ON_USDC_BALANCE_GAS` is compared with.
    let mut k = usdc_registry();
    let one_call = |k: &mut Kizashi, claimant: AccountId| {
        let before = env::used_gas().as_gas();
        k.on_usdc_balance(claimant, U64(k.usdc_epoch), Ok(U128(PAID * 100)));
        assert!(
            get_created_receipts().iter().any(|r| format!("{:?}", r.actions).contains("FunctionCall")),
            "a transfer was scheduled, so the figure includes the calls it attaches gas to"
        );
        env::used_gas().as_gas() - before
    };
    ctx_init();
    let alone = one_call(&mut k, accounts(2));
    for n in 3..=5 {
        k.record_owed(&accounts(n), 1, 1_000);
    }
    k.in_flight.clear(); // the first call's reservation would leave nothing free for the second
    ctx_init();
    let with_records = one_call(&mut k, accounts(2));
    assert!(with_records < alone + Gas::from_tgas(1).as_gas(), "{alone} gas alone, {with_records} with three records owed");
    assert!(alone <= ON_USDC_BALANCE_GAS.as_gas(), "used {alone} gas, given {}", ON_USDC_BALANCE_GAS.as_gas());
    assert!(with_records <= ON_USDC_BALANCE_GAS.as_gas(), "used {with_records} gas, given {}", ON_USDC_BALANCE_GAS.as_gas());
    // The VM does not run the wasm, so what it reports is a floor: keep 10% of the budget free for that.
    assert!(with_records * 11 / 10 <= ON_USDC_BALANCE_GAS.as_gas(), "{with_records} gas leaves no room for the wasm");
}

#[test]
fn the_balance_callback_fits_its_gas_in_the_fullest_state_it_can_meet() {
    // Eight claimants owed (the most there can be), the in-flight list one short of full, and the claimant's own
    // record to spend. Two shapes of it: every entry still reserved (the callback pays, and has the longest list to
    // add up), and every entry stale (the callback releases and logs them all, and refuses the read it was given:
    // the release moves the epoch, so it schedules nothing).
    let full = |at: u64| {
        let mut k = usdc_registry();
        for n in 3..=9 {
            let other: AccountId = format!("claimant{n}.near").parse().unwrap();
            k.record_owed(&other, 1, 1_000);
        }
        k.record_owed(&accounts(2), 1, PAID);
        for _ in 0..MAX_IN_FLIGHT - 1 {
            k.in_flight.push(InFlight { claimant: accounts(4), amount: 1, at });
        }
        k
    };
    let scheduled = || get_created_receipts().iter().any(|r| format!("{:?}", r.actions).contains("FunctionCall"));

    let mut k = full(IN_FLIGHT_TIMEOUT_NS);
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS);
    let before = env::used_gas().as_gas();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID * 100)));
    let paying = env::used_gas().as_gas() - before;
    assert!(!logged("in_flight_released") && scheduled(), "nothing was stale, and the payout was scheduled");
    assert!(paying <= ON_USDC_BALANCE_GAS.as_gas(), "used {paying} gas, given {}", ON_USDC_BALANCE_GAS.as_gas());
    assert!(paying * 11 / 10 <= ON_USDC_BALANCE_GAS.as_gas(), "{paying} gas leaves no room for the wasm");

    let mut k = full(0);
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS);
    let before = env::used_gas().as_gas();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID * 100)));
    let releasing = env::used_gas().as_gas() - before;
    assert!(logged("in_flight_released") && !scheduled(), "the stale entries were released and nothing was scheduled");
    assert!(releasing < paying, "{releasing} gas to release and refuse, {paying} to pay: the budget is set by paying");
}

#[test]
fn the_resolve_callback_fits_its_gas_in_the_fullest_state_it_can_meet() {
    // `on_usdc_paid` is what releases a reservation. A callback that cannot afford itself fails, rolls its state
    // back, and leaves the reservation held until the timeout, so its gas is part of "never stuck". Fullest
    // state: the list full with the payout's own entry last (the longest scan and shift), seven other claimants
    // owed, and a failed transfer (the path that books a debt and logs it). The VM does not run the wasm or
    // load the state, so what it reports is a floor: keep 10% of the budget free for that.
    let mut k = usdc_registry();
    for n in 3..=9 {
        let other: AccountId = format!("claimant{n}.near").parse().unwrap();
        k.record_owed(&other, 1, 1_000);
    }
    for _ in 0..MAX_IN_FLIGHT - 1 {
        k.in_flight.push(InFlight { claimant: accounts(4), amount: 1, at: 0 });
    }
    k.in_flight.push(InFlight { claimant: accounts(2), amount: PAID, at: 0 });
    ctx_callback_at(1, PromiseResult::Failed);
    let before = env::used_gas().as_gas();
    k.on_usdc_paid(accounts(2), U128(PAID));
    let used = env::used_gas().as_gas() - before;
    assert_eq!(k.in_flight.len(), MAX_IN_FLIGHT - 1, "its own entry went, the others stayed");
    assert!(logged("payout_failed"), "the failure path ran");
    assert!(used <= RESOLVE_GAS.as_gas(), "used {used} gas, given {}", RESOLVE_GAS.as_gas());
    assert!(used * 11 / 10 <= RESOLVE_GAS.as_gas(), "{used} gas leaves no room for the wasm");
}

#[test]
fn a_second_claim_right_after_the_first_cannot_pay_out_the_same_near() {
    // The runtime takes a transfer out of the contract's balance when it creates the receipt, so a second
    // claim in the same or the next block sees only what is left. This pins that the NEAR leg relies on it.
    let mut k = standard();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let pays = |who: AccountId| {
        get_created_receipts().iter().filter(|x| x.receiver_id == who && format!("{:?}", x.actions).contains("Transfer")).count()
    };
    assert_eq!(pays(accounts(2)), 1, "the first claim pays");
    assert_eq!(k.spendable_near(), 0, "and takes everything that could be spent");
    let sig = ed_sig(&k, "small-curve-omen", &accounts(3), &EdKey::from_bytes(&[3u8; 32]));
    let _ = k.claim("small-curve-omen".into(), accounts(3), sig);
    assert_eq!(pays(accounts(3)), 0, "the second claim has nothing left to pay out");
}


// --- K9: a payout whose callback never reports cannot hide USDC for ever ---
//
// `on_usdc_paid` is the only thing that releases a reservation. If it never runs (out of gas, a shard that
// dropped it) the reservation used to stay, and `saturating_sub` hid the drift. Now every reservation is its own
// entry with the time it was scheduled; anyone can release the ones older than `IN_FLIGHT_TIMEOUT_NS`, every
// payout does so first, and a callback that finds no entry says so instead of freeing something else's share.

/// The contract calling itself at `ts` ns, as its own callbacks do.
fn ctx_init_at(ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0)).block_height(100).block_timestamp(ts);
    testing_env!(b.build());
}

/// A stranger calling at `ts` ns.
fn ctx_at(ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1)).block_height(100).block_timestamp(ts);
    testing_env!(b.build());
}

/// The contract calling itself at `ts` ns, with `result` as what the promise it waited on returned.
fn ctx_callback_at(ts: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(0)).block_timestamp(ts);
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

#[test]
fn a_reservation_whose_callback_never_came_back_is_released_after_the_timeout() {
    let mut k = usdc_registry();
    ctx_init_at(0);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID))); // scheduled; its on_usdc_paid never runs
    assert_eq!(k.in_flight_total(), PAID);

    ctx_init_at(IN_FLIGHT_TIMEOUT_NS - 1);
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "inside the timeout the reservation holds, so nothing is free");
    assert_eq!(k.in_flight_total(), PAID);

    // A claim at the timeout lets the stale reservation go before it orders its read, and its callback is paid from.
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    let sig = ed_sig(&k, "ed25519-omen", &accounts(3), &ed_key());
    let _ = k.claim("ed25519-omen".into(), accounts(3), sig);
    assert!(logged("in_flight_released"), "{:?}", get_logs());
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS);
    k.on_usdc_balance(accounts(3), U64(k.usdc_epoch), Ok(U128(PAID)));
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"5000000\"") && receiver_is(&r, &accounts(3)), "at the timeout it is let go and the USDC is paid out: {r}");
    assert_eq!(k.in_flight_total(), PAID, "only the new payout is reserved now");
}

/// What `claim` and `retry_payout` do before they order a balance read at `ts` ns: let the stale reservations go.
/// Returns the epoch that read is ordered under.
fn release_then_order_a_read(k: &mut Kizashi, ts: u64) -> U64 {
    ctx_at(ts);
    let _ = k.release_stale_in_flight();
    U64(k.usdc_epoch)
}

#[test]
fn anyone_can_release_a_stale_reservation_and_a_fresh_one_is_left_alone() {
    let mut k = usdc_registry();
    ctx_init_at(1_000);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert_eq!((k.usdc_in_flight().usdc.0, k.usdc_in_flight().payouts), (PAID, 1));

    ctx_at(1_000 + IN_FLIGHT_TIMEOUT_NS - 1);
    assert_eq!(k.release_stale_in_flight().0, 0);
    assert_eq!(k.in_flight_total(), PAID);
    assert!(!logged("in_flight_released"));

    ctx_at(1_000 + IN_FLIGHT_TIMEOUT_NS);
    assert_eq!(k.release_stale_in_flight().0, PAID);
    assert_eq!((k.usdc_in_flight().usdc.0, k.usdc_in_flight().payouts), (0, 0));
    assert!(logged("in_flight_released"));
    let event = get_logs().into_iter().find(|l| l.contains("in_flight_released")).unwrap();
    assert!(event.contains("\"released\":\"5000000\"") && event.contains(&accounts(2).to_string()), "{event}");
}

#[test]
fn a_late_callback_after_the_release_frees_nothing_that_belongs_to_a_newer_payout() {
    let mut k = usdc_registry();
    ctx_init_at(0);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID))); // payout A, whose callback is very late
    let ordered = release_then_order_a_read(&mut k, IN_FLIGHT_TIMEOUT_NS); // A is released ...
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS);
    k.on_usdc_balance(accounts(3), ordered, Ok(U128(PAID))); // ... and payout B takes the same amount
    assert_eq!(k.in_flight_total(), PAID);

    ctx_callback_at(IN_FLIGHT_TIMEOUT_NS + 1, PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID)); // A's callback finally arrives
    assert_eq!(k.in_flight_total(), PAID, "B's reservation is not A's to release");
    assert!(logged("in_flight_unknown"), "the drift is reported, not hidden: {:?}", get_logs());

    ctx_callback_at(IN_FLIGHT_TIMEOUT_NS + 2, PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(3), U128(PAID));
    assert_eq!(k.in_flight_total(), 0, "B's own callback releases B");
    assert!(!logged("in_flight_unknown"));
}

#[test]
fn a_late_failure_after_the_release_is_still_held_as_unverified_debt() {
    let mut k = usdc_registry();
    ctx_init_at(0);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    let _ = k.release_stale_in_flight();
    ctx_callback_at(IN_FLIGHT_TIMEOUT_NS + 1, PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID)); // the transfer did fail: the tokens are still on the contract
    let owed = k.owed(accounts(2));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (PAID, true), "so retry_payout re-reads the balance and pays it");
    assert_eq!(k.in_flight_total(), 0);
}

#[test]
fn a_late_success_after_the_release_leaves_the_books_as_they_are() {
    let mut k = usdc_registry();
    ctx_init_at(0);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    let _ = k.release_stale_in_flight();
    ctx_callback_at(IN_FLIGHT_TIMEOUT_NS + 1, PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert_eq!(k.owed(accounts(2)).usdc.0, 0);
    assert!(logged("payout_ok") && logged("in_flight_unknown"), "{:?}", get_logs());
}

#[test]
fn with_the_in_flight_list_full_a_payout_is_held_as_owed_instead_of_scheduled() {
    let mut k = usdc_registry();
    for _ in 0..MAX_IN_FLIGHT {
        k.in_flight.push(InFlight { claimant: accounts(4), amount: 1, at: 0 });
    }
    ctx_init_at(1);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "nothing is scheduled while MAX_IN_FLIGHT payouts are unreported");
    let owed = k.owed(accounts(2));
    assert_eq!(owed.usdc.0, PAID - MAX_IN_FLIGHT as u128, "what the claimant is owed is held for them, minus what is reserved");
    assert!(logged("payout_failed"), "{:?}", get_logs());
    ctx_at(1);
    let text = panic_text(|| {
        let _ = k.retry_payout(accounts(2));
    });
    assert!(text.contains("in flight"), "a retry says why it cannot start yet: {text}");
    assert_eq!(k.owed(accounts(2)).usdc.0, PAID - MAX_IN_FLIGHT as u128, "and the refused retry changed nothing");
    // Once the old entries age out, the same retry goes through.
    ctx_at(IN_FLIGHT_TIMEOUT_NS + 1);
    let _ = k.retry_payout(accounts(2));
    assert!(receipts_text().contains("ft_transfer"));
    assert_eq!(k.in_flight.len(), 1);
}

#[test]
fn a_successful_callback_removes_exactly_one_entry() {
    let mut k = usdc_registry();
    k.in_flight.push(InFlight { claimant: accounts(2), amount: PAID, at: 5 });
    k.in_flight.push(InFlight { claimant: accounts(3), amount: PAID, at: 5 });
    k.in_flight.push(InFlight { claimant: accounts(2), amount: PAID, at: 6 }); // an identical twin of the first
    ctx_callback_at(7, PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert_eq!(k.in_flight.len(), 2, "one of the two identical entries went, the other claimant's stayed");
    assert!(k.in_flight.iter().any(|p| p.claimant == accounts(3)));
    assert!(k.in_flight.iter().any(|p| p.claimant == accounts(2) && p.at == 6), "the oldest of the twins went first");
}


// --- K10: a balance read from before another payout landed is not paid from ---
//
// `claim` (and `retry_payout` of an unread amount) reads the token's balance and a LATER callback pays from it.
// The read is a snapshot. A payout that is in flight is subtracted from it, but once that payout has landed and
// reported, nothing is subtracted any more, while a read taken before it landed still counts those tokens. Paying
// from that read pays the same tokens twice: either out of tokens held for another claimant, or of tokens that are
// no longer there (the token refuses, and the amount is held as a phantom debt). Every read now carries `usdc_epoch`
// as it was when the read was ordered, and the callback refuses one ordered under an older value.

/// The first payout's transfer has landed and `on_usdc_paid` has heard of it.
fn first_payout_lands_and_reports(k: &mut Kizashi, claimant: AccountId, amount: u128) {
    ctx_callback(PromiseResult::Successful(vec![]));
    k.on_usdc_paid(claimant, U128(amount));
    assert_eq!(k.in_flight_total(), 0, "the reservation is gone, as it should be once the payout reported");
}

#[test]
fn a_balance_read_from_before_a_payout_landed_cannot_pay_out_tokens_held_for_another_claimant() {
    // The token holds 10 000 000; 5 000 000 of it are held for accounts(4). Two claims read it while it held all of it.
    let mut k = usdc_registry();
    k.record_owed(&accounts(4), 0, 5_000_000);
    let ordered = k.usdc_epoch;
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(ordered), Ok(U128(10_000_000))); // the first claim: 5 000 000 go in flight
    assert_eq!(k.in_flight_total(), 5_000_000);
    first_payout_lands_and_reports(&mut k, accounts(2), 5_000_000);
    // The second claim's callback, with the read it took before that transfer landed. The token now holds only
    // the 5 000 000 held for accounts(4), so nothing may be sent to accounts(3).
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(10_000_000)));
    let r = receipts_text();
    assert!(!r.contains("ft_transfer"), "a transfer was scheduled from a read older than the payout that landed: {r}");
    assert_eq!(k.owed(accounts(4)).usdc.0, 5_000_000, "and the tokens held for accounts(4) are still held");
    assert!(k.owed(accounts(3)).usdc_unread, "accounts(3) is paid by a retry, which reads the balance again");
    assert!(logged("payout_failed"), "the refusal is reported: {:?}", get_logs());
}

#[test]
fn a_balance_read_from_before_a_retry_paid_cannot_pay_those_tokens_again() {
    // claim x retry_payout: accounts(4) is owed 5 000 000 on a verified read, and a claim has read the full 10 000 000.
    let mut k = usdc_registry();
    k.record_owed(&accounts(4), 0, 5_000_000);
    let ordered = k.usdc_epoch;
    ctx();
    let _ = k.retry_payout(accounts(4)); // 5 000 000 in flight for accounts(4)
    assert_eq!(k.in_flight_total(), 5_000_000);
    first_payout_lands_and_reports(&mut k, accounts(4), 5_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(ordered), Ok(U128(10_000_000))); // the claim read it before the retry landed
    let r = receipts_text();
    assert!(!r.contains("ft_transfer"), "10 000 000 were scheduled; the token holds 5 000 000: {r}");
    assert!(k.owed(accounts(2)).usdc_unread);
}

#[test]
fn a_retry_balance_read_from_before_a_payout_landed_cannot_pay_that_payout_again() {
    // retry_payout (unread) x claim: the amount held for accounts(4) is not trusted, so its retry reads the balance
    // again. That read is taken while a claim's payout of 5 000 000 is in flight and comes back after it reported.
    let mut k = usdc_registry();
    k.record_owed(&accounts(4), 0, 5_000_000);
    k.record_unread(&accounts(4));
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(10_000_000))); // the claim: 10 000 000 less 5 000 000 held
    assert_eq!(k.in_flight_total(), 5_000_000);
    ctx();
    let _ = k.retry_payout(accounts(4)); // its read sees 10 000 000: the claim's transfer has not landed yet
    let ordered = k.usdc_epoch;
    first_payout_lands_and_reports(&mut k, accounts(2), 5_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(4), U64(ordered), Ok(U128(10_000_000)));
    let r = receipts_text();
    assert!(!r.contains("ft_transfer"), "10 000 000 were scheduled; the token holds 5 000 000: {r}");
    let owed = k.owed(accounts(4));
    assert_eq!((owed.usdc.0, owed.usdc_unread), (5_000_000, true), "still held, and still to be read again");
}

#[test]
fn a_balance_read_ordered_after_the_payout_landed_is_paid_from() {
    // The same sequence, but the second read is ordered once the first payout has reported: it is a fresh read.
    let mut k = usdc_registry();
    k.record_owed(&accounts(4), 0, 5_000_000);
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(10_000_000)));
    first_payout_lands_and_reports(&mut k, accounts(2), 5_000_000);
    let ordered = k.usdc_epoch;
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(7_000_000))); // the 5 000 000 held for accounts(4), and 2 000 000 more
    let r = receipts_text();
    assert!(r.contains("\"amount\":\"2000000\"") && receiver_is(&r, &accounts(3)), "only the top-up is free: {r}");
}

#[test]
fn a_transfer_that_failed_does_not_make_earlier_reads_stale() {
    // A failed transfer moved no tokens, so no read is older than it in a way that matters.
    let mut k = usdc_registry();
    let ordered = k.usdc_epoch;
    ctx_init();
    k.on_usdc_balance(accounts(2), U64(ordered), Ok(U128(PAID)));
    ctx_callback(PromiseResult::Failed);
    k.on_usdc_paid(accounts(2), U128(PAID));
    assert_eq!(k.usdc_epoch, ordered);
    ctx_init();
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(PAID + TOP_UP)));
    let r = receipts_text();
    assert!(r.contains(&format!("\"amount\":\"{TOP_UP}\"")) && receiver_is(&r, &accounts(3)), "paid from the read: {r}");
}

#[test]
fn releasing_a_timed_out_reservation_makes_earlier_reads_stale_and_releasing_nothing_does_not() {
    let mut k = usdc_registry();
    let ordered = k.usdc_epoch;
    ctx_init_at(1_000);
    k.on_usdc_balance(accounts(2), U64(ordered), Ok(U128(PAID))); // a payout whose callback never comes back
    ctx_at(1_000 + IN_FLIGHT_TIMEOUT_NS - 1);
    assert_eq!(k.release_stale_in_flight().0, 0);
    assert_eq!(k.usdc_epoch, ordered, "nothing was released, so nothing moved");
    ctx_at(1_000 + IN_FLIGHT_TIMEOUT_NS);
    assert_eq!(k.release_stale_in_flight().0, PAID);
    assert_eq!(k.usdc_epoch, ordered + 1, "what became of that payout is not known");
    ctx_init_at(1_000 + IN_FLIGHT_TIMEOUT_NS);
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(PAID)));
    assert!(get_created_receipts().is_empty(), "a read ordered before the release is not paid from");
    assert!(k.owed(accounts(3)).usdc_unread);
}

#[test]
fn claim_and_retry_order_their_reads_under_the_current_epoch() {
    let mut k = usdc_registry();
    k.usdc_epoch = 7;
    let sig = ed_sig(&k, "ed25519-omen", &accounts(2), &ed_key());
    ctx();
    let _ = k.claim("ed25519-omen".into(), accounts(2), sig);
    let r = receipts_text();
    assert!(pos(&r, "on_usdc_balance") < pos(&r, "\"epoch\":\"7\""), "claim passes the epoch to its callback: {r}");
    k.record_owed(&accounts(4), 0, PAID);
    k.record_unread(&accounts(4));
    k.usdc_epoch = 9;
    ctx();
    let _ = k.retry_payout(accounts(4));
    let r = receipts_text();
    assert!(r.contains("\"epoch\":\"9\""), "retry passes the epoch to its callback: {r}");
}


// --- K11: a reservation released while its transfer is still on the way ---
//
// `release_stale` lets a reservation go after `IN_FLIGHT_TIMEOUT_NS` without knowing what became of its transfer: if its
// callback was lost the transfer settled long ago, but if the transfer is only very late the tokens have not left yet.
// From then on nothing subtracts them, and the callback that finally reports has no entry. What this contract can still
// guarantee is about the reads that were ordered before the transfer landed: they are older than it, and
// `usdc_epoch` has to say so however the landing reaches the contract.

/// accounts(4) is owed 5 000 000 on a verified read and the token holds 10 000 000. accounts(2)'s payout of the
/// other 5 000 000 was scheduled at time 0 and has not reported back.
fn payout_in_flight_beside_a_held_amount() -> Kizashi {
    let mut k = usdc_registry();
    k.record_owed(&accounts(4), 0, 5_000_000);
    ctx_init_at(0);
    k.on_usdc_balance(accounts(2), U64(k.usdc_epoch), Ok(U128(10_000_000)));
    assert_eq!(k.in_flight_total(), 5_000_000);
    k
}

#[test]
fn a_late_success_after_the_release_makes_the_reads_ordered_before_it_stale() {
    let mut k = payout_in_flight_beside_a_held_amount();
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    assert_eq!(k.release_stale_in_flight().0, 5_000_000); // the transfer is still on its way
    let ordered = k.usdc_epoch; // accounts(3)'s balance read is ordered now and sees all 10 000 000
    ctx_callback_at(IN_FLIGHT_TIMEOUT_NS + 1, PromiseResult::Successful(vec![]));
    k.on_usdc_paid(accounts(2), U128(5_000_000)); // the transfer lands and is reported before that read comes back
    assert_eq!(k.usdc_epoch, ordered + 1, "a landed transfer makes every earlier read stale, entry or no entry");
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS + 2);
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(10_000_000)));
    let r = receipts_text();
    assert!(!r.contains("ft_transfer"), "5 000 000 were scheduled out of the 5 000 000 held for accounts(4): {r}");
    assert!(k.owed(accounts(3)).usdc_unread, "accounts(3) is paid by a retry, which reads the balance again");
    assert_eq!(k.owed(accounts(4)).usdc.0, 5_000_000, "and what is held for accounts(4) is still held");
}

#[test]
fn a_read_in_hand_when_its_callback_releases_a_stale_reservation_is_not_paid_from() {
    let mut k = payout_in_flight_beside_a_held_amount();
    let ordered = k.usdc_epoch; // accounts(3)'s read was ordered while that reservation was still good
    // The 10 minutes pass; the read comes back with the 10 000 000 it saw, which still count the payout's tokens.
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS);
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(10_000_000)));
    let r = receipts_text();
    assert!(!r.contains("ft_transfer"), "the release in this very callback took away what protected those tokens: {r}");
    assert!(logged("in_flight_released"), "{:?}", get_logs());
    assert!(k.owed(accounts(3)).usdc_unread);
    assert_eq!(k.in_flight_total(), 0);
}

#[test]
fn claim_releases_stale_reservations_before_it_orders_its_read() {
    let mut k = payout_in_flight_beside_a_held_amount();
    let sig = ed_sig(&k, "ed25519-omen", &accounts(3), &ed_key());
    ctx_at(IN_FLIGHT_TIMEOUT_NS);
    let _ = k.claim("ed25519-omen".into(), accounts(3), sig);
    assert!(logged("in_flight_released"), "{:?}", get_logs());
    let ordered = k.usdc_epoch;
    assert_eq!(ordered, 1, "the release moved the epoch");
    assert!(receipts_text().contains("\"epoch\":\"1\""), "the read is ordered under the epoch after the release");
    // So its callback is paid from, instead of being refused for a release it caused itself.
    ctx_init_at(IN_FLIGHT_TIMEOUT_NS + 1);
    k.on_usdc_balance(accounts(3), U64(ordered), Ok(U128(10_000_000)));
    let r = receipts_text();
    assert!(r.contains("ft_transfer") && r.contains("\"amount\":\"5000000\"") && receiver_is(&r, &accounts(3)), "{r}");
}

// --- M2 part A: the paths matrix. Every pair of payout paths, in both orders ---
//
// The unit-test VM runs one call at a time, so what a chain does between two receipts has to be played by hand.
// `World` is a small model of the chain around the contract: its NEAR balance, the token's balance, and the
// receipts the contract has scheduled and nobody has delivered yet. Each scheduled call becomes a `Chain`: its steps
// run in order, but steps of different chains run in any order, and a new transaction (an `Op`) can arrive between
// any two of them. `explore` tries every such schedule (merging the ones that reach the same state) and checks the
// books after every step.
//
// What the model assumes of the runtime, and has not checked against nearcore: a callback runs after the receipt
// it waits for, and, unless a fixture turns `refund_may_come_first` on, the refund of a failed transfer reaches the
// contract after that callback (the contract's own `retry_payout` message, "owed NEAR has not returned yet", relies on
// the same order). With the refund free to come first the contract fails (see
// `a_refund_that_reaches_the_contract_before_its_callback_is_swept_by_the_next_claim`). A storage deposit's refund is
// a receipt of its own in any order when `deposit_refunds_come_late` is on, and cost-free otherwise.

use near_sdk::mock::MockAction;
use std::collections::{BTreeMap, HashSet, VecDeque};

/// NEAR the model contract holds above its storage reserve and margin.
const POT_NEAR: u128 = 10_000_000_000_000_000_000_000_000;
/// USDC the model token holds for the contract.
const POT_USDC: u128 = 10_000_000;

fn omen_key(i: usize) -> (&'static str, EdKey) {
    [("omen-a", ed_key()), ("omen-b", EdKey::from_bytes(&[3u8; 32]))].into_iter().nth(i).unwrap()
}

#[derive(Clone, Debug, PartialEq)]
enum Step {
    /// A NEAR transfer to `to`. If it fails, its refund is a receipt of its own (`Refund`).
    NearPay { to: AccountId, amount: u128 },
    /// The contract's `on_near_payout`, with what the transfer before it returned.
    NearResolve { to: AccountId, amount: u128 },
    /// The refund of a failed transfer, a receipt of its own: it may reach the contract before or after the callback.
    Refund(u128),
    /// The token's `ft_balance_of`: the balance is read when this is delivered.
    Read,
    /// The contract's `on_usdc_balance`, with the balance the read before it returned and the epoch it was ordered under.
    Balance { claimant: AccountId, epoch: u64 },
    /// The token's `storage_deposit` for the claimant, with `amount` attached. It works, and the token refunds the
    /// whole deposit as a receipt of its own, which may reach the contract at any time after.
    Register(u128),
    /// The token's `ft_transfer`.
    FtSend { to: AccountId, amount: u128 },
    /// The contract's `on_usdc_paid`, with what `ft_transfer` returned.
    Paid { claimant: AccountId, amount: u128 },
}

#[derive(Clone, Debug)]
struct Chain {
    steps: VecDeque<Step>,
    /// What the last `Read` of this chain saw.
    snapshot: u128,
    /// Whether the last `FtSend` of this chain worked.
    last_ok: bool,
    /// How many landings had been reported to the contract, and reservations released, when that `Read` was taken.
    news_at_read: u32,
}

impl Chain {
    fn new(steps: impl Into<VecDeque<Step>>) -> Self {
        Self { steps: steps.into(), snapshot: 0, last_ok: true, news_at_read: 0 }
    }
}

#[derive(Clone, Debug)]
enum Op {
    Claim { omen: usize, by: AccountId },
    Retry(AccountId),
    Release,
    /// The clock reaches `IN_FLIGHT_TIMEOUT_NS`: a reservation made at time 0 turns stale between two other steps.
    TimeOut,
}

#[derive(Clone, Copy, Debug)]
enum Move {
    /// The next transaction of the schedule arrives.
    Start,
    /// The next step of chain `i` is delivered.
    Deliver(usize),
}

/// The contract's books, kept to undo what a call did before it panicked (a unit-test panic rolls nothing back).
struct Books {
    in_flight: Vec<InFlight>,
    owed: Vec<(AccountId, Owed)>,
}

impl Books {
    fn of(k: &Kizashi) -> Self {
        Self { in_flight: k.in_flight.clone(), owed: k.owed.iter().map(|(a, o)| (a.clone(), o.clone())).collect() }
    }

    fn restore(self, k: &mut Kizashi) {
        k.in_flight = self.in_flight;
        k.owed.clear();
        for (a, o) in self.owed {
            k.owed.insert(a, o);
        }
    }
}

struct World {
    k: Kizashi,
    near: u128,
    tok: u128,
    now: u64,
    /// NEAR transfers to these accounts fail (the account does not exist).
    dead: Vec<AccountId>,
    /// The token refuses USDC once for each of these accounts although it holds enough (the next transfer works).
    refuse: Vec<AccountId>,
    chains: Vec<Chain>,
    /// USDC transfers the token has completed and `on_usdc_paid` has not heard of yet.
    landed: Vec<u128>,
    paid_near: BTreeMap<AccountId, u128>,
    paid_usdc: BTreeMap<AccountId, u128>,
    /// `ft_transfer`s the token refused for want of tokens.
    short: u32,
    /// Pays out from every balance read, however old. Only to show the model sees the race the epoch closes.
    trust_stale_reads: bool,
    /// Landings reported to the contract plus reservations it has released: the news that makes a balance read
    /// older than it. A read that has seen less news than the contract has when its callback pays is stale.
    news: u32,
    /// Whether the token's refund of a storage deposit is a receipt of its own that may reach the contract at any
    /// time (on), or comes back at once (off: the deposit is taken to cost nothing). On multiplies the states to
    /// explore, so only the fixtures that are about it turn it on.
    deposit_refunds_come_late: bool,
    /// Whether the refund of a failed NEAR transfer may reach the contract BEFORE the callback that waits for that
    /// transfer. Off: the refund is made once the callback has run, the order the contract's own retry message
    /// ("owed NEAR has not returned to the contract yet") assumes and nobody has checked against nearcore.
    refund_may_come_first: bool,
    /// For a reservation released while its transfer was still on the way: the contract cannot know, so it may
    /// schedule tokens that transfer is about to take. The token then refuses whichever comes second (`short`), and
    /// the checks that forbid exactly that are off. Everything else is still checked.
    overbooking_tolerated: bool,
    /// Things that went wrong in a transaction, found as it was made.
    errors: Vec<String>,
    trace: Vec<String>,
}

thread_local! {
    /// `test_vm_config()` takes 20 ms to build and every step of the model needs one, so it is built once.
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

fn set_env(predecessor: &AccountId, balance: u128, ts: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0))
        .predecessor_account_id(predecessor.clone())
        .account_balance(NearToken::from_yoctonear(balance))
        .block_height(100)
        .block_timestamp(ts);
    testing_env!(b.build(), vm_config!(), RuntimeFeesConfig::test(), Default::default(), results);
}

/// An environment with empty storage. `testing_env!` keeps the storage of the one before it, which a model that
/// builds many contracts in one test must not.
fn fresh_env() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0)).predecessor_account_id(accounts(1));
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        vm_config!(),
        RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
}

fn json_of(args: &[u8]) -> near_sdk::serde_json::Value {
    near_sdk::serde_json::from_slice(args).expect("receipt arguments are JSON")
}

fn account_of(v: &near_sdk::serde_json::Value, key: &str) -> AccountId {
    v[key].as_str().unwrap_or_else(|| panic!("{key} missing in {v}")).parse().unwrap()
}

fn amount_of(v: &near_sdk::serde_json::Value, key: &str) -> u128 {
    v[key].as_str().unwrap_or_else(|| panic!("{key} missing in {v}")).parse().unwrap()
}

/// The receipts the last call created, as the steps they become, and the NEAR they take out of the balance.
fn scheduled() -> (Vec<Step>, u128) {
    let (mut steps, mut leaves) = (Vec::new(), 0u128);
    for r in get_created_receipts() {
        for a in &r.actions {
            match a {
                MockAction::Transfer { deposit, .. } => {
                    leaves += deposit.as_yoctonear();
                    steps.push(Step::NearPay { to: r.receiver_id.clone(), amount: deposit.as_yoctonear() });
                }
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                    leaves += attached_deposit.as_yoctonear();
                    let v = json_of(args);
                    match method_name.as_slice() {
                        b"storage_deposit" => steps.push(Step::Register(attached_deposit.as_yoctonear())),
                        b"on_near_payout" => steps.push(Step::NearResolve {
                            to: account_of(&v, "claimant"),
                            amount: amount_of(&v, "amount"),
                        }),
                        b"ft_balance_of" => steps.push(Step::Read),
                        b"on_usdc_balance" => steps.push(Step::Balance {
                            claimant: account_of(&v, "claimant"),
                            epoch: v["epoch"].as_str().expect("the epoch").parse().unwrap(),
                        }),
                        b"ft_transfer" => {
                            steps.push(Step::FtSend { to: account_of(&v, "receiver_id"), amount: amount_of(&v, "amount") })
                        }
                        b"on_usdc_paid" => steps.push(Step::Paid {
                            claimant: account_of(&v, "claimant"),
                            amount: amount_of(&v, "amount"),
                        }),
                        other => panic!("the model does not know {}", String::from_utf8_lossy(other)),
                    }
                }
                _ => {}
            }
        }
    }
    (steps, leaves)
}

fn panic_message(e: Box<dyn std::any::Any + Send>) -> String {
    let text = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    text.split("panic_msg: \"").nth(1).and_then(|t| t.split('"').next()).unwrap_or(&text).to_string()
}

impl World {
    fn new() -> Self {
        fresh_env();
        set_env(&accounts(0), 10u128.pow(27), 0, vec![]);
        let omens = vec![
            OmenInit {
                id: "omen-a".into(),
                curve: Curve::Ed25519,
                level: Era::Kaigen,
                public_key: hex::encode(ed_key().verifying_key().to_bytes()),
            },
            OmenInit {
                id: "omen-b".into(),
                curve: Curve::Ed25519,
                level: Era::Warning,
                public_key: hex::encode(EdKey::from_bytes(&[3u8; 32]).verifying_key().to_bytes()),
            },
        ];
        let k = Kizashi::new(omens, Some("usdc.token".parse().unwrap()));
        set_env(&accounts(1), 10u128.pow(27), 0, vec![]);
        Self {
            k,
            near: storage_reserve() + STORAGE_MARGIN.as_yoctonear() + POT_NEAR,
            tok: POT_USDC,
            now: 0,
            dead: Vec::new(),
            refuse: Vec::new(),
            chains: Vec::new(),
            landed: Vec::new(),
            paid_near: BTreeMap::new(),
            paid_usdc: BTreeMap::new(),
            short: 0,
            trust_stale_reads: false,
            news: 0,
            deposit_refunds_come_late: false,
            refund_may_come_first: false,
            overbooking_tolerated: false,
            errors: Vec::new(),
            trace: Vec::new(),
        }
    }

    /// Runs one call of the contract. `result` is what the promise the callback waits on returned, if it is one.
    fn call<R>(&mut self, predecessor: &AccountId, result: Option<bool>, f: impl FnOnce(&mut Kizashi) -> R) -> R {
        let results = result
            .map(|ok| vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }])
            .unwrap_or_default();
        set_env(predecessor, self.near, self.now, results);
        let out = f(&mut self.k);
        self.news += u32::from(logged("in_flight_released"));
        let (mut steps, mut leaves) = scheduled();
        if !self.deposit_refunds_come_late {
            steps.retain(|s| match s {
                Step::Register(amount) => {
                    leaves -= amount;
                    false
                }
                _ => true,
            });
        }
        self.near = self.near.checked_sub(leaves).expect("the contract scheduled more NEAR than it holds");
        if !steps.is_empty() {
            self.chains.push(Chain::new(steps));
        }
        out
    }

    /// A transaction. One the contract refuses changes nothing, as on the chain.
    fn start(&mut self, op: &Op) {
        self.trace.push(format!("{op:?}"));
        let saved = Books::of(&self.k);
        let dead_before = match op {
            Op::Claim { omen, .. } => self.k.omens.get(&omen_key(*omen).0.to_string()).is_some_and(|o| o.death.is_some()),
            _ => false,
        };
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match op {
            Op::Claim { omen, by } => {
                let (id, key) = omen_key(*omen);
                self.call(&accounts(1), None, |k| {
                    let sig = ed_sig(k, id, by, &key);
                    let _ = k.claim(id.into(), by.clone(), sig);
                });
            }
            Op::Retry(who) => self.call(&accounts(1), None, |k| {
                let _ = k.retry_payout(who.clone());
            }),
            Op::Release => self.call(&accounts(1), None, |k| {
                let _ = k.release_stale_in_flight();
            }),
            Op::TimeOut => self.now = IN_FLIGHT_TIMEOUT_NS,
        }));
        match run {
            Err(e) => {
                saved.restore(&mut self.k);
                self.trace.push(format!("(refused: {})", panic_message(e)));
            }
            Ok(()) if dead_before => self.errors.push(format!("{op:?} claimed an omen that was already dead")),
            Ok(()) => {}
        }
    }

    fn deliver(&mut self, i: usize) {
        let step = self.chains[i].steps.pop_front().expect("a chain with nothing left");
        self.trace.push(format!("{step:?}"));
        match step {
            Step::NearPay { to, amount } => {
                let ok = !self.dead.contains(&to);
                if ok {
                    *self.paid_near.entry(to).or_default() += amount;
                } else if self.refund_may_come_first {
                    // The refund and the callback are both made when the failed transfer is processed; with this on,
                    // either may reach the contract first, and the explorer tries both.
                    self.chains.push(Chain::new([Step::Refund(amount)]));
                }
                self.chains[i].last_ok = ok;
            }
            Step::NearResolve { to, amount } => {
                let ok = self.chains[i].last_ok;
                self.call(&accounts(0), Some(ok), |k| k.on_near_payout(to, U128(amount)));
                if !ok && !self.refund_may_come_first {
                    self.chains.push(Chain::new([Step::Refund(amount)])); // after the callback
                }
            }
            Step::Register(amount) => self.chains.push(Chain::new([Step::Refund(amount)])),
            Step::Refund(amount) => self.near += amount,
            Step::Read => {
                self.chains[i].snapshot = self.tok;
                self.chains[i].news_at_read = self.news;
            }
            Step::Balance { claimant, epoch } => {
                let (seen, news_at_read) = (self.chains[i].snapshot, self.chains[i].news_at_read);
                // `trust_stale_reads` hands the callback the epoch it has now, as if the guard were not there.
                let epoch = if self.trust_stale_reads { self.k.usdc_epoch } else { epoch };
                let chains_before = self.chains.len();
                self.call(&accounts(0), None, |k| k.on_usdc_balance(claimant.clone(), U64(epoch), Ok(U128(seen))));
                let pays = self.chains[chains_before..].iter().any(|c| c.steps.iter().any(|s| matches!(s, Step::FtSend { .. })));
                if pays && self.news != news_at_read {
                    self.errors.push(format!(
                        "{claimant} was paid from a balance read taken before news the contract had by then: a landing it was told of, or a release"
                    ));
                }
            }
            Step::FtSend { to, amount } => {
                let ok = if let Some(at) = self.refuse.iter().position(|a| *a == to) {
                    self.refuse.remove(at);
                    false
                } else if self.tok >= amount {
                    true
                } else {
                    self.short += 1;
                    false
                };
                if ok {
                    self.tok -= amount;
                    *self.paid_usdc.entry(to).or_default() += amount;
                    self.landed.push(amount);
                }
                self.chains[i].last_ok = ok;
            }
            Step::Paid { claimant, amount } => {
                let ok = self.chains[i].last_ok;
                if ok {
                    let at = self.landed.iter().position(|a| *a == amount).expect("a landed transfer for this callback");
                    self.landed.remove(at);
                }
                self.call(&accounts(0), Some(ok), |k| k.on_usdc_paid(claimant, U128(amount)));
                self.news += u32::from(ok);
            }
        }
    }

    fn moves(&self, started: usize, total: usize) -> Vec<Move> {
        let mut moves = Vec::new();
        if started < total {
            moves.push(Move::Start);
        }
        moves.extend(self.chains.iter().enumerate().filter(|(_, c)| !c.steps.is_empty()).map(|(i, _)| Move::Deliver(i)));
        moves
    }

    /// Everything that decides what happens next, so that schedules reaching the same state are explored once.
    fn key(&self, started: usize) -> String {
        let mut owed: Vec<String> =
            self.k.owed.iter().map(|(a, o)| format!("{a}:{}:{}:{}", o.near, o.usdc, o.usdc_unread)).collect();
        owed.sort();
        let in_flight: Vec<String> =
            self.k.in_flight.iter().map(|p| format!("{}:{}:{}", p.claimant, p.amount, p.at)).collect();
        let mut omens: Vec<String> = self.k.omens.iter().map(|(id, o)| format!("{id}:{}", o.death.is_some())).collect();
        omens.sort();
        let mut chains: Vec<String> =
            self.chains.iter().filter(|c| !c.steps.is_empty()).map(|c| format!("{c:?}")).collect();
        chains.sort();
        format!(
            "{started}|{}|{}|{}|{owed:?}|{in_flight:?}|{}|{omens:?}|{chains:?}|{:?}|{:?}|{:?}|{}|{:?}|{}|{}",
            self.near,
            self.tok,
            self.now,
            self.k.usdc_epoch,
            self.landed,
            self.paid_near,
            self.paid_usdc,
            self.short,
            self.refuse,
            self.errors.len(),
            self.news
        )
    }

    /// What must hold after every step.
    fn broken(&self) -> Vec<String> {
        let mut out = self.errors.clone();
        let (near_out, usdc_out) = (self.paid_near.values().sum::<u128>(), self.paid_usdc.values().sum::<u128>());
        if near_out > POT_NEAR || usdc_out > POT_USDC {
            out.push(format!("paid out more than there was: {near_out} NEAR of {POT_NEAR}, {usdc_out} USDC of {POT_USDC}"));
        }
        // USDC the contract has promised away (scheduled and unreported, or owed on a verified read) cannot be
        // more than the token holds, counting what it has already sent and the contract has not heard of.
        let verified: u128 = self.k.owed.values().filter(|o| !o.usdc_unread).map(|o| o.usdc).sum();
        let promised = self.k.in_flight_total() + verified;
        let held = self.tok + self.landed.iter().sum::<u128>();
        if promised > held && !self.overbooking_tolerated {
            out.push(format!(
                "USDC promised twice: {promised} promised (in flight {}, owed {verified}), the token holds {held}",
                self.k.in_flight_total()
            ));
        }
        out
    }

    /// The end of a schedule: nothing is on its way. The NEAR owed must be backed by NEAR, and what is left owed
    /// must be payable by the retries anyone may make, without the token ever refusing a transfer for want of tokens.
    fn broken_at_rest(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        set_env(&accounts(1), self.near, self.now, vec![]);
        let owed_near: u128 = self.k.owed.values().map(|o| o.near).sum();
        let backing = self.near.saturating_sub(storage_reserve());
        if owed_near > backing {
            out.push(format!("NEAR owed twice: {owed_near} owed, the contract holds {backing} above its storage reserve"));
        }
        for _ in 0..4 {
            let who: Vec<AccountId> = self.k.owed.iter().map(|(a, _)| a.clone()).collect();
            if who.is_empty() {
                break;
            }
            for a in who {
                self.start(&Op::Retry(a));
            }
            while let Some(i) = self.chains.iter().position(|c| !c.steps.is_empty()) {
                self.deliver(i);
            }
        }
        if self.short > 0 && !self.overbooking_tolerated {
            out.push(format!("the token refused {} transfer(s) for want of tokens", self.short));
        }
        for (a, o) in self.k.owed.iter() {
            if o.usdc > 0 || o.usdc_unread {
                out.push(format!("USDC still owed to {a} after every retry: {} (unread {})", o.usdc, o.usdc_unread));
            }
        }
        out.extend(self.broken());
        out
    }
}

/// One move of a schedule.
fn apply(w: &mut World, ops: &[Op], started: &mut usize, m: Move) {
    match m {
        Move::Start => {
            w.start(&ops[*started]);
            *started += 1;
        }
        Move::Deliver(i) => w.deliver(i),
    }
}

fn replay(make: &dyn Fn() -> World, ops: &[Op], prefix: &[Move]) -> (World, usize) {
    let (mut w, mut started) = (make(), 0);
    for m in prefix {
        apply(&mut w, ops, &mut started, *m);
    }
    (w, started)
}

/// Every schedule of `ops` (started in this order) and of the steps they leave behind. Returns what broke, each
/// with the schedule that broke it, at most `limit` of them; and the number of distinct states visited.
fn explore(make: &dyn Fn() -> World, ops: &[Op], limit: usize) -> (Vec<String>, usize) {
    let (mut seen, mut bad) = (HashSet::new(), Vec::new());
    let mut stack: Vec<(Vec<Move>, Option<(World, usize)>)> = vec![(vec![], None)];
    while let Some((prefix, live)) = stack.pop() {
        let (mut w, started) = live.unwrap_or_else(|| replay(make, ops, &prefix));
        if !seen.insert(w.key(started)) {
            continue;
        }
        let moves = w.moves(started, ops.len());
        let mut broken = w.broken();
        if moves.is_empty() {
            let schedule = w.trace.join(" > ");
            broken.extend(w.broken_at_rest().into_iter().map(|b| format!("{b} [at rest, schedule: {schedule}]")));
        }
        for b in broken {
            bad.push(format!("{b}\n    after: {}", w.trace.join(" > ")));
        }
        if bad.len() >= limit {
            break;
        }
        // The first move carries on in this world; the others start again from the beginning.
        let mut rest = moves.into_iter();
        let first = rest.next();
        for next in rest {
            stack.push((prefix.iter().copied().chain([next]).collect(), None));
        }
        if let Some(next) = first {
            let (mut w, mut started) = (w, started);
            apply(&mut w, ops, &mut started, next);
            stack.push((prefix.iter().copied().chain([next]).collect(), Some((w, started))));
        }
    }
    (bad, seen.len())
}

// The fixtures. Each is a registry with two omens (`omen-a`, `omen-b`) holding POT_NEAR and POT_USDC, and the
// pool of transactions that may arrive. `matrix` runs every ordered pair of the pool, every schedule of each.

fn x() -> AccountId {
    accounts(2) // claims omen-a
}

fn y() -> AccountId {
    accounts(3) // claims omen-b
}

fn w() -> AccountId {
    accounts(4) // was owed something before the pair starts
}

/// Fresh registry. Its pool also has a second claim of omen-a, which must always be refused, and a release with nothing to release.
fn fresh() -> World {
    World::new()
}

/// w is owed 5 000 000 USDC on a verified read: held for w, and not free for a claim.
fn w_owed_verified_usdc() -> World {
    let mut m = World::new();
    m.k.record_owed(&w(), 0, 5_000_000);
    m
}

/// w is owed 5 000 000 USDC that is not trusted (a failed transfer): its retry reads the balance again.
fn w_owed_unread_usdc() -> World {
    let mut m = World::new();
    m.k.record_owed(&w(), 0, 5_000_000);
    m.k.record_unread(&w());
    m
}

/// w is owed 3 NEAR, backed by the balance.
fn w_owed_near() -> World {
    let mut m = World::new();
    m.k.record_owed(&w(), 3_000_000_000_000_000_000_000_000, 0);
    m
}

/// x does not exist as an account: the NEAR sent to it fails and comes back as owed.
fn x_cannot_receive_near() -> World {
    let mut m = World::new();
    m.dead.push(x());
    m
}

/// w is owed 5 000 000 USDC on a verified read, and the token's refund of each storage deposit is a receipt of its
/// own that may reach the contract at any time.
fn w_owed_verified_usdc_deposit_refund_late() -> World {
    let mut m = w_owed_verified_usdc();
    m.deposit_refunds_come_late = true;
    m
}

/// The same, but the refund of the failed transfer may reach the contract before the callback that books it.
fn x_cannot_receive_near_refund_first() -> World {
    let mut m = x_cannot_receive_near();
    m.refund_may_come_first = true;
    m
}

/// The token refuses the first USDC transfer to y although it holds enough.
fn token_refuses_y_once() -> World {
    let mut m = World::new();
    m.refuse.push(y());
    m
}

/// A payout of w's whose transfer landed but whose `on_usdc_paid` never came, 10 minutes ago.
fn w_payout_never_reported() -> World {
    let mut m = World::new();
    m.k.record_owed(&w(), 0, 3_000_000); // held for w as well, so that a retry of w has something to pay
    m.k.in_flight.push(InFlight { claimant: w(), amount: 4_000_000, at: 0 });
    m.tok -= 4_000_000;
    m.landed.push(4_000_000);
    m.now = IN_FLIGHT_TIMEOUT_NS;
    m
}

/// The same, but its `on_usdc_paid` is still on its way.
fn w_payout_reports_late() -> World {
    let mut m = w_payout_never_reported();
    let late = Step::Paid { claimant: w(), amount: 4_000_000 };
    m.chains.push(Chain::new([late]));
    m
}

/// A payout of w's whose `ft_transfer` is still on its way when its reservation times out: the tokens have not left
/// the token contract, and the `on_usdc_paid` that would book it is behind the transfer. `ok` is whether that transfer
/// will work. The reservation is already `now` ns old (the timeout, or 1 ns: then `Op::TimeOut` ages it).
fn w_payout_still_in_transit(ok: bool, now: u64) -> World {
    let mut m = World::new();
    m.k.record_owed(&w(), 0, 3_000_000); // held for w as well, so that a retry of w has something to pay
    m.k.in_flight.push(InFlight { claimant: w(), amount: 4_000_000, at: 0 });
    let steps = VecDeque::from([
        Step::FtSend { to: w(), amount: 4_000_000 },
        Step::Paid { claimant: w(), amount: 4_000_000 },
    ]);
    m.chains.push(Chain::new(steps));
    if !ok {
        m.refuse.push(w());
    }
    m.now = now;
    m.overbooking_tolerated = true;
    m
}

fn w_payout_in_transit_will_land() -> World {
    w_payout_still_in_transit(true, IN_FLIGHT_TIMEOUT_NS)
}

fn w_payout_in_transit_will_fail() -> World {
    w_payout_still_in_transit(false, IN_FLIGHT_TIMEOUT_NS)
}

fn w_payout_in_transit_times_out_later_and_lands() -> World {
    w_payout_still_in_transit(true, 1)
}

fn w_payout_in_transit_times_out_later_and_fails() -> World {
    w_payout_still_in_transit(false, 1)
}

fn claim_a(by: AccountId) -> Op {
    Op::Claim { omen: 0, by }
}

fn claim_b(by: AccountId) -> Op {
    Op::Claim { omen: 1, by }
}

/// Every ordered pair of `pool`, started in that order, with every schedule of the steps they leave behind. Panics with
/// the schedules that broke the books.
fn matrix(make: fn() -> World, pool: &[Op]) {
    let (mut broken, mut states) = (Vec::new(), 0);
    for (i, first) in pool.iter().enumerate() {
        for (j, second) in pool.iter().enumerate().filter(|(j, _)| *j != i) {
            let (bad, seen) = explore(&make, &[first.clone(), second.clone()], 2);
            states += seen;
            broken.extend(bad.into_iter().map(|b| format!("{first:?} then {second:?}: {b}")));
            assert!(seen > 1, "pair {i}/{j} explored nothing");
        }
    }
    assert!(broken.is_empty(), "{} schedule(s) broke the books:\n{}", broken.len(), broken.join("\n"));
    assert!(states >= pool.len() * (pool.len() - 1) * 3, "only {states} states: the model is not running the paths");
}

/// Two claims of different omens and `more`.
fn pool(more: &[Op]) -> Vec<Op> {
    let mut all = vec![claim_a(x()), claim_b(y())];
    all.extend(more.iter().cloned());
    all
}

#[test]
fn matrix_fresh_registry() {
    matrix(fresh, &pool(&[claim_a(y()), Op::Release]));
}

#[test]
fn matrix_verified_usdc_owed_to_another_claimant() {
    matrix(w_owed_verified_usdc, &pool(&[Op::Retry(w())]));
}

#[test]
fn matrix_unread_usdc_owed_to_another_claimant() {
    matrix(w_owed_unread_usdc, &pool(&[Op::Retry(w())]));
}

#[test]
fn matrix_near_owed_to_another_claimant() {
    matrix(w_owed_near, &pool(&[Op::Retry(w())]));
}

#[test]
fn matrix_a_claimants_near_payout_fails_and_comes_back_owed() {
    matrix(x_cannot_receive_near, &pool(&[Op::Retry(x())]));
}

#[test]
fn matrix_the_storage_deposit_refund_is_a_receipt_of_its_own() {
    // The 0.01 NEAR attached to each `storage_deposit` leaves the balance when the payout is scheduled and comes
    // back whenever the token's refund arrives: a window in which a claim or a retry sees less NEAR than there is.
    // That can only make a payout smaller, and the model checks nothing is paid beyond the pot, the owed NEAR is
    // backed, and everything settles once the refunds are in.
    matrix(w_owed_verified_usdc_deposit_refund_late, &pool(&[Op::Retry(w())]));
}

#[test]
fn a_refund_that_reaches_the_contract_before_its_callback_is_swept_by_the_next_claim() {
    // KNOWN GAP, pinned. `on_near_payout` books a failed NEAR transfer as owed, and the refund that gives the money
    // back is a receipt of its own. If the refund lands first, a claim that starts before the callback sees the
    // refunded NEAR as free and pays it to someone else, and the callback then books a debt nothing backs. The
    // contract is only right if the callback runs first; the model shows both orders and the contract passes one.
    // When this contract is changed to hold the NEAR from the moment it is scheduled, this test must start failing,
    // and `matrix_a_claimants_near_payout_fails_and_comes_back_owed` is then to be run with the refund free to come
    // first (`x_cannot_receive_near_refund_first`).
    let ops = [claim_a(x()), claim_b(y())];
    let (bad, _) = explore(&x_cannot_receive_near_refund_first, &ops, 5);
    assert!(
        bad.iter().any(|b| b.contains("NEAR owed twice")),
        "the model did not find the debt that nothing backs: {bad:?}"
    );
    let (bad, _) = explore(&x_cannot_receive_near, &ops, 5);
    assert!(bad.is_empty(), "with the refund after the callback the same two claims break nothing: {bad:?}");
}

#[test]
fn matrix_the_token_refuses_one_usdc_transfer() {
    matrix(token_refuses_y_once, &pool(&[Op::Retry(y())]));
}

#[test]
fn matrix_a_payout_that_never_reported_is_released() {
    matrix(w_payout_never_reported, &pool(&[Op::Retry(w()), Op::Release]));
}

#[test]
fn matrix_a_payout_reports_after_its_timeout() {
    matrix(w_payout_reports_late, &pool(&[Op::Retry(w()), Op::Release]));
}

#[test]
fn matrix_a_reservation_released_while_its_transfer_is_on_the_way_and_lands() {
    matrix(w_payout_in_transit_will_land, &pool(&[Op::Retry(w()), Op::Release]));
}

#[test]
fn matrix_a_reservation_released_while_its_transfer_is_on_the_way_and_fails() {
    matrix(w_payout_in_transit_will_fail, &pool(&[Op::Retry(w()), Op::Release]));
}

#[test]
fn matrix_a_reservation_that_times_out_between_two_steps_while_its_transfer_lands() {
    matrix(w_payout_in_transit_times_out_later_and_lands, &pool(&[Op::Retry(w()), Op::TimeOut]));
}

#[test]
fn matrix_a_reservation_that_times_out_between_two_steps_while_its_transfer_fails() {
    matrix(w_payout_in_transit_times_out_later_and_fails, &pool(&[Op::Retry(w()), Op::TimeOut]));
}

#[test]
fn the_model_still_sees_a_stale_read_paid_from_when_overbooking_is_tolerated() {
    // The in-transit fixtures turn off the checks that the release itself makes unavoidable (the contract cannot
    // know the tokens are about to go). A payout from a read older than news the contract had is not among them.
    let trusting = || {
        let mut m = w_payout_in_transit_will_land();
        m.trust_stale_reads = true;
        m
    };
    let (bad, _) = explore(&trusting, &[claim_a(x()), Op::Release], 5);
    assert!(bad.iter().any(|b| b.contains("balance read taken before news")), "the model did not see it: {bad:?}");
    let (bad, _) = explore(&w_payout_in_transit_will_land, &[claim_a(x()), Op::Release], 5);
    assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn the_model_sees_the_race_the_epoch_closes() {
    // Same claims, but every balance read is paid from however old it is: the books break, which shows the
    // matrix would notice it. (With the epoch check in place the same two claims break nothing.)
    let trusting = || {
        let mut m = World::new();
        m.trust_stale_reads = true;
        m
    };
    let ops = [claim_a(x()), claim_b(y())];
    let (bad, _) = explore(&trusting, &ops, 5);
    assert!(bad.iter().any(|b| b.contains("USDC promised twice")), "the model did not see it: {bad:?}");
    let (bad, _) = explore(&World::new, &ops, 5);
    assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn the_model_sees_nothing_wrong_with_a_single_claim() {
    // Guards the checks themselves against flagging a healthy run: one claim, every schedule of its callbacks.
    let (bad, seen) = explore(&World::new, &[claim_a(x())], 5);
    assert!(bad.is_empty(), "{bad:?}");
    assert!(seen > 3);
}
