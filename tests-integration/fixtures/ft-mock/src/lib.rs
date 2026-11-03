//! Minimal NEP-141 look-alike for KAIGEN attack 7 (decimal misread). It has the three things Mamori's `send_small`
//! needs from a token: `ft_transfer(receiver_id, amount, memo)` that demands exactly 1 yoctoNEAR and a sufficient
//! balance, `ft_balance_of`, and a `decimals` the test can read back. Differences from a real NEP-141 token
//! (near-contract-standards): no storage registration (`storage_deposit`), no `ft_transfer_call`, no total supply,
//! and `ft_mint` is open to anyone. It is a fixture for a throwaway sandbox, not a token.
//!
//! Build (PowerShell, this directory; the wasm lands in `$env:CARGO_TARGET_DIR`, keep it on D:):
//!   cargo build --release --target wasm32-unknown-unknown --offline
//! then point `FT_MOCK_WASM` at `ft_mock.wasm`. The Cargo.lock is a copy of the repository's, so the same near-sdk 5.30 is used.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FtMock {
    decimals: u8,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl FtMock {
    #[init]
    pub fn new(decimals: u8) -> Self {
        Self { decimals, balances: LookupMap::new(b"b") }
    }

    /// Fixture only: anyone may mint.
    pub fn ft_mint(&mut self, account_id: AccountId, amount: U128) {
        let held = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, held.checked_add(amount.0).expect("balance overflow"));
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = memo;
        require!(env::attached_deposit().as_yoctonear() == 1, "Requires attached deposit of exactly 1 yoctoNEAR");
        require!(amount.0 > 0, "The amount should be a positive number");
        let sender = env::predecessor_account_id();
        let held = self.balances.get(&sender).copied().unwrap_or(0);
        require!(held >= amount.0, "The account doesn't have enough balance");
        self.balances.insert(sender, held - amount.0);
        let there = self.balances.get(&receiver_id).copied().unwrap_or(0);
        self.balances.insert(receiver_id, there.checked_add(amount.0).expect("balance overflow"));
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_decimals(&self) -> u8 {
        self.decimals
    }
}
