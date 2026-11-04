# Windows has no make by default; every target is a plain command you can paste.
export AWS_LC_SYS_PREBUILT_NASM := 1

.PHONY: test build repro-build verify verify-prelock predeploy
test:
	cargo test --workspace
	cd scripts && node --test omens.test.mjs predeploy.test.mjs
	cd jobs && node --test test/*.test.mjs

build:
	cargo build --release --locked --target wasm32-unknown-unknown -p kizashi -p mamori
	mkdir -p out/prod && cp target/wasm32-unknown-unknown/release/kizashi.wasm target/wasm32-unknown-unknown/release/mamori.wasm out/prod/

# Reproducible build of the prod and drill wasm: the same bytes whatever the checkout, target-dir, CARGO_HOME or rustup-home paths
# (and whichever package is named beside it). Writes out/repro/{prod,drill}/*.wasm, SHA256SUMS and repro-manifest.json.
# Read docs/v3/REPRODUCIBLE-BUILD.md first: `make build` above is the quick dev build and its bytes depend on those paths.
# Needs PowerShell (pwsh, or powershell.exe) and the pinned toolchain on PATH. Add -Offline to the script call to forbid network access.
repro-build:
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/repro-build.ps1

# Release verification against mainnet (two independent RPC hosts, one block, gate file written under data/gates).
# Needs deployments.json (copy deployments.example.json). Exits non-zero, having checked nothing, when it is missing.
verify:
	@test -f deployments.json || { echo "make verify: there is no deployments.json, so NOTHING was verified. Copy deployments.example.json to deployments.json and fill in the mainnet accounts, then run again."; exit 1; }
	$(MAKE) build
	node jobs/src/bin.mjs verify --release

# The same, for the moment before the lock: Kizashi still holds its keys. Its gate file is what `mainnet lock` reads.
verify-prelock:
	@test -f deployments.json || { echo "make verify-prelock: there is no deployments.json, so NOTHING was verified. Copy deployments.example.json to deployments.json first."; exit 1; }
	$(MAKE) build
	node jobs/src/bin.mjs verify --release --pre-lock

# Pre-deploy checks of the Kizashi init configuration: omens equal the derived set exactly, no drill key, the USDC id,
# the wasm exports no `reset`, and the code hash. Offline unless RPC and KIZASHI are given (then USDC registration too).
#   make predeploy INIT=init.json DRILL_KEYS=drill-public-keys.json USDC=<token account> [RPC=<url> KIZASHI=<account>]
predeploy:
	@test -n "$(INIT)" -a -n "$(DRILL_KEYS)" -a -n "$(USDC)" || { echo "usage: make predeploy INIT=<init.json> DRILL_KEYS=<drill public keys .json> USDC=<token account> [RPC=<url> KIZASHI=<account>]"; exit 2; }
	$(MAKE) build
	node scripts/predeploy.mjs --init "$(INIT)" --wasm out/prod/kizashi.wasm --drill-keys "$(DRILL_KEYS)" --usdc "$(USDC)" $(if $(RPC),--rpc "$(RPC)" --kizashi "$(KIZASHI)")
