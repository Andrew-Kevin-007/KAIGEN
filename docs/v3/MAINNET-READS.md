# KAIGEN mainnet reads: protocol, ML-DSA and the intents.near methods (gates G4 and the mainnet rule)

Status: 2026-11-04. Read-only. Two public mainnet RPC hosts were asked five kinds of read question. No key was used or read, no transaction was signed or sent, nothing was written to any chain, no funds were involved. KAIGEN itself has not run on mainnet. Nothing here is audit evidence. This file answers two items of ROADMAP.md section 3: the mainnet rule ("confirm ML-DSA activation by RPC status before any mainnet statement") and gate G4 ("exact `intents.near` method names").

## 1. Answers

| Question | Answer from the RPC | What the RPC cannot show |
|---|---|---|
| Protocol and node version | Mainnet protocol 86. Both hosts run nearcore 2.14.0 (commit bc4e9e8c...), whose binary supports protocol 88 (`latest_protocol_version`). So the network is two versions below what its nodes can run. | Which validators have voted for a newer protocol, or when it changes. |
| Is ML-DSA active on mainnet? | Partly visible. At protocol 86 the runtime config carries `transaction_costs.ml_dsa_65_verification_cost` = 100000000000 gas (100 Ggas, the figure in LANDSCAPE.md) and the ML-DSA host-function costs. The nodes parse an `ml-dsa-65:` key of 1952 bytes (an invented key type is rejected by the same call, so the probe can fail). That is consistent with the nearcore 2.13.0 release note cited in ROADMAP.md, which says protocol 86 brings ML-DSA-65 keys. It is NOT a proof: a node binary parses the key type whatever the protocol, and a cost in the config does not say a transaction with such a key is accepted. | Whether an AddKey with an ML-DSA key, or a transaction signed by one, is accepted on mainnet. RPC `status` has no feature list, and the mapping from a protocol number to a feature lives in the node's source, not in any response. Gate G1 (a throwaway account, signed by Kevin) is still the only proof. Whether any mainnet account holds an ML-DSA key was not looked for: there is no RPC to list them and no known account to ask about. |
| Is the contract host function `ml_dsa_verify` on? | No, on mainnet at protocol 86: `runtime_config.wasm_config.ml_dsa_verify_host_fn` = false. On testnet at protocol 88 the same field is true (section 3). | When mainnet moves to 88. |
| Does `intents.near` export the methods KAIGEN calls? | Yes, both, as functions, on both hosts. Mamori calls `add_public_key` (from `register_intents_key`) and `remove_public_key` (from `lock_down`). The code was read through `view_code`: code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, 1,297,551 bytes, 97 exports (96 functions and `memory`), identical on both hosts. No mismatch. | Argument names and types, which calls are `#[payable]`, who is allowed to call them, and what `remove_public_key` does with a key that was not added through Mamori. A wasm export section holds names only. Gate G4 is answered for the names; it is not answered for the call shape (1 yoctoNEAR attached, `{"public_key": ...}` as the argument, signed by the vault itself). |

Two things seen in the export list that matter to the docs:

1. `intents.near` exports `upgrade` and `state_migrate` and a role system (`acl_*`). Its code can be replaced by whoever holds the right role, so the names above are true for the code hash read, `BtA1BEFN...`, and only for it. A gate that depends on them has to read the hash again at gate time.
2. It also exports `public_keys_of` and `has_public_key`. By name these look like views that list or test the keys registered on an account. README.md line 407 says cage-check does not look for keys on `intents.near` that were not recorded by `register_intents_key`; these two names are what such a check would use. Arguments and return types were not read, and nothing here uses them.

Where the call sites are, at the commit af4df3e (`git show af4df3e:contracts/mamori/src/lib.rs`): line 451 `intents_call("add_public_key", &public_key)` and line 732 `intents_call("remove_public_key", &k)`. The tables in section 4 give the line numbers of the working tree at the moment of the run, which are higher because the file is being edited.

## 2. What was run

```powershell
cd D:\HACK-Projects\NEAR_Hack\kaigen
node jobs/src/mainnet-reads.mjs --json     # raw result as JSON
node jobs/src/mainnet-reads.mjs            # the same, as the tables in section 4
node jobs/src/mainnet-reads.mjs --rpc https://rpc.mainnet.near.org --rpc https://free.rpc.fastnear.com   # choose the hosts
node --test jobs/test/mainnet-reads.test.mjs
```

Hosts: `https://free.rpc.fastnear.com` and `https://rpc.mainnet.near.org`, from `deployments.example.json`. Each host was asked: `status`; `EXPERIMENTAL_protocol_config` (finality final); `query` with `request_type` `view_access_key` twice (an `ml-dsa-65:` key of 1952 bytes nobody holds, and a control with an invented key type), on the account `near`; and `query` with `request_type` `view_code` on `intents.near` (finality final). The tool refuses any other request before it leaves the machine (`isReadOnlyRequest`, tested), identifies itself as `kaigen-readonly-check/1.0` and sends nothing about the person running it. The export section of the downloaded wasm is parsed by `wasmExports` from `scripts/predeploy.mjs`; the code hash is recomputed from the downloaded bytes and compared with the one the node returned (it matched). The `intents.near` dependencies are read out of `contracts/mamori/src/lib.rs` by scanning for `intents_call("<method>"`, so the list cannot drift from the source. Twelve unit tests cover the allowlist, the parsing, the comparison and the reporting of a mismatch and of an unreachable host.

## 3. One-off comparison with testnet (not part of the script)

Asked with `curl -A kaigen-readonly-check/1.0 -d '{"jsonrpc":"2.0","id":"kaigen","method":"EXPERIMENTAL_protocol_config","params":{"finality":"final"}}' https://rpc.testnet.fastnear.com`, at 2026-11-04 about 02:23 UTC, against the same call on mainnet made at about 02:10 UTC. Testnet was at protocol 88 (node 2.14.0-rc.5). Eight values of `runtime_config` differ between the two:

| `runtime_config` field | mainnet (protocol 86) | testnet (protocol 88) |
|---|---|---|
| `wasm_config.ml_dsa_verify_host_fn` | false | true |
| `wasm_config.sha3_host_fns` | false | true |
| `wasm_config.universal_accounts` | false | true |
| `wasm_config.limit_config.max_state_init_entries` | 4294967295 | 1500 |
| `wasm_config.limit_config.min_contract_size_per_local` | absent | 2 |
| `wasm_config.ext_costs.universal_state_init_to_account_id_base` | 8520000000 | 8900000000 |
| `wasm_config.ext_costs.universal_state_init_to_account_id_byte` | 21471105 | 83100000 |
| `transaction_costs.burnt_gas_reward` | [3, 10] | [0, 1] |

ML-DSA transaction signature verification cost (`ml_dsa_65_verification_cost`) is the same on both, 100000000000. What this means for KAIGEN: everything the testnet rehearsal proved ran on protocol 88, and the sandbox attacks ran on a local nearcore 2.14.0 at protocol 88 ([V3-W2-CAGE-PROGRESS.md](evidence/V3-W2-CAGE-PROGRESS.md)), while mainnet is on 86 with three feature flags off. Whether any KAIGEN result depends on one of those three flags was not checked; `docs/v3/ROADMAP.md` already says the ML-DSA admin flow was "proven on testnet protocol 88 only". The contracts do not call `ml_dsa_verify` (no use in `contracts/`), so the host-function flag does not matter to them; the docs that say "near-sdk 5.30 has `env::ml_dsa_verify`" (ARCHITECTURE.md, CHANGES-V2-TO-V3.md) are about the SDK; the flag says the runtime does not enable the function on mainnet at protocol 86.

## 4. Raw results (generated by the script, unedited)

Times are UTC on this machine's clock. "Where" is the line in the working tree at run time.

### https://free.rpc.fastnear.com

Fetched 2026-11-04T02:23:39.839Z (UTC, this machine's clock).

| `status` field | value |
|---|---|
| chain_id | mainnet |
| protocol_version | 86 |
| latest_protocol_version (highest this node binary supports) | 88 |
| node version / build | 2.14.0 / 2.14.0 |
| node commit | bc4e9e8cfb03d9e82f027883055624e18576993e |
| rustc the node was built with | 1.95.0 |
| latest block | 222957593 at 2026-11-04T02:23:39.991139077Z |

ML-DSA entries in `EXPERIMENTAL_protocol_config` (finality final, protocol 86; the table has 100 host-function costs, and `ed25519_verify_base` is 210000000000):

- `runtime_config.transaction_costs.ml_dsa_65_verification_cost` = 100000000000
- `runtime_config.wasm_config.ext_costs.ml_dsa_verify_base` = 540000000000
- `runtime_config.wasm_config.ext_costs.ml_dsa_verify_byte` = 11000000
- `runtime_config.wasm_config.ml_dsa_verify_host_fn` = false

Key parsing, `view_access_key` on account `near` with a key nobody holds:

- `ml-dsa-65:` key of 1952 bytes: PARSED. Node said: access key ml-dsa-65:<probe key> does not exist while viewing
- control, invented key type: rejected. Node said: Failed parsing args: unknown key type 'kaigen-not-a-key-type'

`intents.near` via `view_code`: code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, 1,297,551 bytes, read at block 222957592 (GaPoNwu9JnXk3tuLKYuetUZHuPZbZGW59X76U82QXSeN). Hash recomputed from the received bytes matches.

Exported functions (96): `__contract_abi`, `acl_add_admin`, `acl_add_super_admin`, `acl_get_admins`, `acl_get_grantees`, `acl_get_permissioned_accounts`, `acl_get_super_admins`, `acl_grant_role`, `acl_has_any_role`, `acl_has_role`, `acl_init_super_admin`, `acl_is_admin`, `acl_is_super_admin`, `acl_renounce_admin`, `acl_renounce_role`, `acl_revoke_admin`, `acl_revoke_role`, `acl_revoke_super_admin`, `acl_role_variants`, `acl_storage_prefix`, `acl_transfer_super_admin`, `add_full_access_key`, `add_public_key`, `add_relayer_key`, `admin_call`, `cleanup_nonces`, `contract_source_metadata`, `current_salt`, `delete_key`, `delete_relayer_key`, `disable_auth_by_predecessor_id`, `do_add_relayer_key`, `do_auth_call`, `do_ft_withdraw`, `do_mt_withdraw`, `do_native_withdraw`, `do_nft_withdraw`, `do_storage_deposit`, `execute_intents`, `fee`, `fee_collector`, `force_disable_auth_by_predecessor_ids`, `force_enable_auth_by_predecessor_ids`, `force_lock_account`, `force_unlock_account`, `ft_force_withdraw`, `ft_on_transfer`, `ft_resolve_deposit`, `ft_resolve_withdraw`, `ft_withdraw`, `has_public_key`, `invalidate_salts`, `is_account_locked`, `is_auth_by_predecessor_id_enabled`, `is_nonce_used`, `is_valid_salt`, `mt_balance_of`, `mt_batch_balance_of`, `mt_batch_supply`, `mt_batch_transfer`, `mt_batch_transfer_call`, `mt_force_batch_transfer`, `mt_force_batch_transfer_call`, `mt_force_transfer`, `mt_force_transfer_call`, `mt_force_withdraw`, `mt_on_transfer`, `mt_resolve_deposit`, `mt_resolve_transfer`, `mt_resolve_withdraw`, `mt_supply`, `mt_token`, `mt_tokens`, `mt_tokens_for_owner`, `mt_transfer`, `mt_transfer_call`, `mt_withdraw`, `new`, `nft_force_withdraw`, `nft_on_transfer`, `nft_resolve_deposit`, `nft_resolve_withdraw`, `nft_withdraw`, `pa_all_paused`, `pa_is_paused`, `pa_pause_feature`, `pa_storage_key`, `pa_unpause_feature`, `public_keys_of`, `remove_public_key`, `set_fee`, `set_fee_collector`, `simulate_intents`, `state_migrate`, `update_current_salt`, `upgrade`

| method KAIGEN calls | where | exported by intents.near |
|---|---|---|
| `add_public_key` | contracts/mamori/src/lib.rs:482 | yes |
| `remove_public_key` | contracts/mamori/src/lib.rs:763 | yes |

### https://rpc.mainnet.near.org

Fetched 2026-11-04T02:23:42.805Z (UTC, this machine's clock).

| `status` field | value |
|---|---|
| chain_id | mainnet |
| protocol_version | 86 |
| latest_protocol_version (highest this node binary supports) | 88 |
| node version / build | 2.14.0 / 2.14.0 |
| node commit | bc4e9e8cfb03d9e82f027883055624e18576993e |
| rustc the node was built with | 1.95.0 |
| latest block | 222957603 at 2026-11-04T02:23:45.567741609Z |

ML-DSA entries in `EXPERIMENTAL_protocol_config` (finality final, protocol 86; the table has 100 host-function costs, and `ed25519_verify_base` is 210000000000):

- `runtime_config.transaction_costs.ml_dsa_65_verification_cost` = 100000000000
- `runtime_config.wasm_config.ext_costs.ml_dsa_verify_base` = 540000000000
- `runtime_config.wasm_config.ext_costs.ml_dsa_verify_byte` = 11000000
- `runtime_config.wasm_config.ml_dsa_verify_host_fn` = false

Key parsing, `view_access_key` on account `near` with a key nobody holds:

- `ml-dsa-65:` key of 1952 bytes: PARSED. Node said: access key ml-dsa-65:<probe key> does not exist while viewing
- control, invented key type: rejected. Node said: Failed parsing args: unknown key type 'kaigen-not-a-key-type'

`intents.near` via `view_code`: code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, 1,297,551 bytes, read at block 222957619 (6FMqYdEnCvMUvzSiT9XhktzNawmMoSFRbvGBAdU6YSpu). Hash recomputed from the received bytes matches.

Exported functions (96): `__contract_abi`, `acl_add_admin`, `acl_add_super_admin`, `acl_get_admins`, `acl_get_grantees`, `acl_get_permissioned_accounts`, `acl_get_super_admins`, `acl_grant_role`, `acl_has_any_role`, `acl_has_role`, `acl_init_super_admin`, `acl_is_admin`, `acl_is_super_admin`, `acl_renounce_admin`, `acl_renounce_role`, `acl_revoke_admin`, `acl_revoke_role`, `acl_revoke_super_admin`, `acl_role_variants`, `acl_storage_prefix`, `acl_transfer_super_admin`, `add_full_access_key`, `add_public_key`, `add_relayer_key`, `admin_call`, `cleanup_nonces`, `contract_source_metadata`, `current_salt`, `delete_key`, `delete_relayer_key`, `disable_auth_by_predecessor_id`, `do_add_relayer_key`, `do_auth_call`, `do_ft_withdraw`, `do_mt_withdraw`, `do_native_withdraw`, `do_nft_withdraw`, `do_storage_deposit`, `execute_intents`, `fee`, `fee_collector`, `force_disable_auth_by_predecessor_ids`, `force_enable_auth_by_predecessor_ids`, `force_lock_account`, `force_unlock_account`, `ft_force_withdraw`, `ft_on_transfer`, `ft_resolve_deposit`, `ft_resolve_withdraw`, `ft_withdraw`, `has_public_key`, `invalidate_salts`, `is_account_locked`, `is_auth_by_predecessor_id_enabled`, `is_nonce_used`, `is_valid_salt`, `mt_balance_of`, `mt_batch_balance_of`, `mt_batch_supply`, `mt_batch_transfer`, `mt_batch_transfer_call`, `mt_force_batch_transfer`, `mt_force_batch_transfer_call`, `mt_force_transfer`, `mt_force_transfer_call`, `mt_force_withdraw`, `mt_on_transfer`, `mt_resolve_deposit`, `mt_resolve_transfer`, `mt_resolve_withdraw`, `mt_supply`, `mt_token`, `mt_tokens`, `mt_tokens_for_owner`, `mt_transfer`, `mt_transfer_call`, `mt_withdraw`, `new`, `nft_force_withdraw`, `nft_on_transfer`, `nft_resolve_deposit`, `nft_resolve_withdraw`, `nft_withdraw`, `pa_all_paused`, `pa_is_paused`, `pa_pause_feature`, `pa_storage_key`, `pa_unpause_feature`, `public_keys_of`, `remove_public_key`, `set_fee`, `set_fee_collector`, `simulate_intents`, `state_migrate`, `update_current_salt`, `upgrade`

| method KAIGEN calls | where | exported by intents.near |
|---|---|---|
| `add_public_key` | contracts/mamori/src/lib.rs:482 | yes |
| `remove_public_key` | contracts/mamori/src/lib.rs:763 | yes |

## 5. Not checked

| Item | Why |
|---|---|
| Argument types, payable and access rules of `add_public_key` and `remove_public_key` | Not in a wasm export section. Would need the contract source for this exact code hash, or a transaction. Neither was read or sent. |
| That the code hash read is the one `intents.near` has when the gate runs | The contract is upgradable (section 1). Read it again at gate time. |
| Archival or other hosts | Only the two hosts above. They agree with each other, but both are hosted infrastructure and neither is the chain. |
| ML-DSA on a real mainnet transaction (G1), global-contract publishing and its cost (G2) | Need keys and funds. Out of scope for read-only. |
