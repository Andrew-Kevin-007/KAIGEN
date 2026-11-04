# KAIGEN v3: reproducible build of the four wasm files

Status: 2026-11-04. Measured on one Windows machine, one toolchain (rustc 1.99.1, cargo 1.99.1, x86_64-pc-windows-msvc), against commit af4df3e. Testnet only. No audit, no mainnet run. A second MACHINE has not been tested. Everything below that says "identical" means identical on this machine across the directories named in section 3, and nowhere else. The contracts are still being edited, so the hashes in this file belong to af4df3e and will change; the procedure does not.

This does not close ROADMAP.md item 5 ("same code hash on a second machine or container"): the script, the one-machine proof and the findings are here, the second-machine run is still open (section 6).

## 1. The problem and what was actually found

Two builds of the same Mamori commit differed by 59 bytes (373,093 vs 373,152). The brief's guess was that paths are embedded. Paths are embedded, but they are not what made those two files differ. Three separate causes, each measured:

| # | Cause | Embedded in the wasm? | Evidence (plain `cargo build`, no remap, commit af4df3e) |
|---|---|---|---|
| 1 | CARGO_HOME. Every panic location and `file!()` of a dependency carries its absolute source path, e.g. `D:\HACK-Projects\toolchain\cargo\registry\src\index.crates.io-1949cf8c6b5b557f\near-sdk-5.30.0\src\environment\env.rs` (23 such strings in mamori.wasm). | Yes. Changes the bytes. | Same checkout, CARGO_HOME moved to a path 19 characters longer: kizashi 259,318 -> 259,758 bytes and mamori 373,093 -> 373,525 bytes, both with different SHA-256 (section 3). |
| 2 | The repo root and the target directory. | No. Workspace members get workspace-relative paths (`contracts\mamori\src\lib.rs`), and the target directory appears nowhere. | Checkouts `repro-a` and `repro-b` with target directories of different length: the two plain builds are byte-identical. So is the plain build of the real tree `NEAR_Hack\kaigen` (a longer root, built earlier that morning, not by this run): kizashi 259,318 B, mamori 373,093 B for all three. |
| 3 | The package set named on the command line (not a path). Cargo unifies a dependency's features across every package named in one command. Kizashi enables near-sdk's `unstable`; mamori does not. `-p kizashi -p mamori` builds mamori's near-sdk WITH `unstable`, `-p mamori` alone builds it without. | Yes. Changes the bytes. | `cargo tree -e normal,build,features -i near-sdk`: mamori alone enables no near-sdk feature, kizashi alone and both together enable `unstable`. Plain `cargo build --release --target wasm32-unknown-unknown -p mamori` gives 373,152 bytes, sha256 A773D106..., byte-for-byte the file of the 3 Nov integration run (`m1-wasm\mamori-attest-A773D106.wasm`); `-p kizashi -p mamori` gives 373,093 bytes, sha256 12F5EF48.... Same commit, same paths, same CARGO_HOME: 59 bytes apart. |

So the 59 bytes were cause 3, not cause 1 or 2. The old integration wasm was built with `-p mamori`; `make build` builds `-p kizashi -p mamori`. Both are legitimate builds of the same source. Which one is deployed has to be one decision, and the script below makes it: each package is built alone.

## 2. The script

`scripts/repro-build.ps1` (Makefile target `repro-build`). PowerShell 7 or Windows PowerShell 5.1; both parse it. What it does:

1. Builds prod (`cargo build --release --locked --target wasm32-unknown-unknown -p <pkg>`) and drill (`... --features drill`) for kizashi and mamori, one cargo invocation per package (cause 3), into one target directory (default `<repo>\target\repro`, or `CARGO_TARGET_DIR`, or `-TargetDir`).
2. Passes `--cfg near --remap-path-prefix=<repo root>=/kaigen --remap-path-prefix=<target dir>=/target --remap-path-prefix=<CARGO_HOME>=/cargo-home --remap-path-prefix=<RUSTUP_HOME>=/rustup-home` through `CARGO_ENCODED_RUSTFLAGS`. It is used instead of `RUSTFLAGS` because cargo ranks it above `RUSTFLAGS` and above `.cargo/config.toml`, and because it survives spaces in paths (tested, section 3). A consequence: flags given this way REPLACE the `--cfg near` that `.cargo/config.toml` sets for wasm32 (without it near-sdk compiles every refusal to a bare abort). The script repeats `--cfg near` and stops with an error if the config ever asks for any other rustflags.
3. Removes `RUSTFLAGS`, `CARGO_BUILD_*`, `CARGO_PROFILE_*`, `CARGO_TARGET_*`, `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER` and `CARGO_INCREMENTAL` from the build's environment (restored afterwards), so a stray variable in the shell cannot change the bytes. `--locked` makes a Cargo.lock that does not match the manifests an error.
4. Reads every finished wasm back and fails if it still contains the repo root, the target directory, CARGO_HOME or RUSTUP_HOME (either slash direction, any case), a drive path such as `X:\dir\`, or a `/home/`, `/Users/` or `/root/` path. On a failure it deletes the four wasm files and prints no hash. This checks the artifact, not cargo's exit code.
5. Writes `<OutDir>\{prod,drill}\{kizashi,mamori}.wasm` (default `out\repro`), `SHA256SUMS` (`sha256sum -c` format) and `repro-manifest.json` (rustc and cargo versions, Cargo.lock SHA-256, the flags with placeholders instead of paths, sizes and hashes, the git commit and whether `contracts` is dirty). The manifest contains no path, so two machines can compare it with a plain diff.

`-Offline` adds `--offline`. The other output directories used by the repo are untouched: `make build` still writes `out\prod`, the testnet rehearsal still reads `out\drill`, and `make verify` and `make predeploy` still read `out\prod`. To run them against the reproducible files, copy `out\repro\prod\*.wasm` into `out\prod` and `out\repro\drill\*.wasm` into `out\drill` yourself; this change does not do it for you. The reproducible files are the ones to hash and deploy; the `make build` files depend on cause 1 and cause 3.

## 3. The proof run (one machine)

Setup used for every build:

```powershell
$env:PATH = "D:\HACK-Projects\toolchain\cargo\bin;$env:PATH"
$env:AWS_LC_SYS_PREBUILT_NASM = '1'     # as in the Makefile; not needed by the two wasm crates
```

Three checkouts of commit af4df3e made with `git archive` (the script is not in that commit, so it was copied into each checkout's `scripts\` before the run):

```powershell
git archive af4df3e | tar -x -C D:\HACK-Projects\toolchain\repro-a                 # after creating the folder
git archive af4df3e | tar -x -C D:\HACK-Projects\toolchain\repro-b
git archive af4df3e | tar -x -C 'D:\HACK-Projects\toolchain\repro c with spaces'
```

Builds, all from empty target directories:

| Build | Checkout | CARGO_TARGET_DIR | CARGO_HOME | RUSTUP_HOME | Other |
|---|---|---|---|---|---|
| A | `...\toolchain\repro-a` | `...\toolchain\tgt-A2` | `...\toolchain\cargo` | `...\toolchain\rustup` | |
| B | `...\toolchain\repro-b` | `...\toolchain\a-much-longer-target-directory-name-B2` | `...\toolchain\cargo` | `...\toolchain\rustup` | run at the same time as A and C |
| C | `...\toolchain\repro c with spaces` | `...\toolchain\tgt C2` | `...\toolchain\alt-cargo-home-for-repro` (copy of `cargo\registry\cache` and `index`) | `...\toolchain\alt-rustup-home-for-repro` (copy of the 1.99.1 toolchain folder) | `-Offline`; spaces in two paths |

```powershell
& D:\HACK-Projects\toolchain\repro-a\scripts\repro-build.ps1 -TargetDir D:\HACK-Projects\toolchain\tgt-A2
& D:\HACK-Projects\toolchain\repro-b\scripts\repro-build.ps1 -TargetDir D:\HACK-Projects\toolchain\a-much-longer-target-directory-name-B2
$env:CARGO_HOME  = 'D:\HACK-Projects\toolchain\alt-cargo-home-for-repro'
$env:RUSTUP_HOME = 'D:\HACK-Projects\toolchain\alt-rustup-home-for-repro'
& 'D:\HACK-Projects\toolchain\repro c with spaces\scripts\repro-build.ps1' -TargetDir 'D:\HACK-Projects\toolchain\tgt C2' -Offline
```

Result, identical in A, B and C (`cmp` of the four wasm files, `SHA256SUMS` and `repro-manifest.json` in the final `out\repro` folders of `repro-a`, `repro-b` and `repro c with spaces`: no difference; `repro-a` and `repro-b` hold the output of their later default-parameters runs, which gave the same bytes):

| File | Bytes | SHA-256 | NEAR code hash (base58 of the SHA-256) |
|---|---|---|---|
| prod/kizashi.wasm | 258,838 | 14fad1434d21902a6218f6c2b8931f394ea5ae948f5e130a708fc4491119b477 | 2QtyjYf3zw39qvuRgQyFj4RhVwyxcGTdHz2yt4RYdZUA |
| prod/mamori.wasm | 372,664 | d64e0c4f923b99a30761005ca63ea622a8792cd8c3eb5e5174f93cfcb174f90b | FRZGrsiY9Tz8t2GMwqChZ4AXBpA8Td8fTKF8AvQdSMc6 |
| drill/kizashi.wasm | 260,265 | c47ca71ce071f5ba0ccbe8ce434c24e2e93e33241935834e28319d3222dd5b82 | EE19qPc5MHayhACpyLyFQWqaQcxwKqYHQkXS95YxNucm |
| drill/mamori.wasm | 372,507 | 81e6b84665b289fdd2537227140ace1291048c1856fd28006389746093f5e701 | 9k5eHMgv71vLJ2CwffSDjMAmmDRUqrXqXTmYo1CvBXEQ |

Cargo.lock SHA-256 fb841c831d1c679a3843c80f2e3801688fcad740b36115fb363d58cc90dc5c73. Compiler: rustc 1.99.1 (58cf8f9c3 2026-10-13), LLVM 23.1.1. These are smaller than the plain builds of section 1 (mamori 372,664 against 373,093 or 373,152) because the remapped paths are shorter; the two sets of numbers are not comparable.

Two more runs of the script, to check the parts the proof did not cover:

| Run | What it checks | Result |
|---|---|---|
| Default parameters in `repro-a` (no `-TargetDir`, started from `C:\Windows`) | The target directory defaults to `<repo>\target\repro` and sits inside the repo root; the script does not depend on the working directory. | Passed: the four SHA-256 values above, unchanged. The flags show `--remap-path-prefix=...\repro-a\target\repro=/target` after the repo root's. |
| Same script with the CARGO_HOME mapping deleted, in `repro-b` | The leak scan really fires: with `D:\HACK-Projects\toolchain\cargo` left unmapped the script must refuse. | Refused, as it must: for each of the four files "still contains the path D:\HACK-Projects\toolchain\cargo" and "contains a drive path", then the script threw. No hash was printed, the four wasm files were deleted and no `SHA256SUMS` was left. (The process exit code of this run was not captured.) |

Baselines that the table in section 1 rests on (plain `cargo build --release --locked --target wasm32-unknown-unknown -p kizashi -p mamori`, `.cargo\config.toml` as committed, no remap):

| Checkout | Target dir | CARGO_HOME | kizashi bytes / SHA-256 | mamori bytes / SHA-256 |
|---|---|---|---|---|
| the real tree, `NEAR_Hack\kaigen` | `toolchain\target-prod` | `toolchain\cargo` | 259,318 / 6310e2530dfaea607911f5f6f9057b62b0bd0581798527320a84ae1532c44cf2 | 373,093 / 12f5ef4860e515471e963edcbed82bff7d9f5eee760d250a14b89c81b5c3335f |
| `repro-a` | `toolchain\rt-a` | `toolchain\cargo` | same | same |
| `repro-b` | `toolchain\repro-target-b-longer-name` | `toolchain\cargo` | same | same |
| `repro-a` | `toolchain\rt-alt-baseline` | `toolchain\alt-cargo-home-for-repro` | 259,758 / 7bba45a9cf25b6a43d38d0277d2ac0764de9faa36f6ce6030d3f617435d723fb | 373,525 / fd78bb46ea090e49fbc73914997853e54b6a0a3c63d70f6366cacbf0ea8710a4 |
| `repro-a`, `-p mamori` alone | `toolchain\rt-a` | `toolchain\cargo` | not built | 373,152 / a773d106050567a18c93f79d9a062c8e8030ea239e3f41f0e30ff6fbe3f471d2 (equals the whole of `m1-wasm\mamori-attest-A773D106.wasm`) |

## 4. Check it yourself

```powershell
# Build, then compare against a manifest from another directory or machine:
& .\scripts\repro-build.ps1
Get-Content out\repro\SHA256SUMS
# Another machine: copy its SHA256SUMS next to this one and compare byte for byte.
fc.exe out\repro\SHA256SUMS D:\elsewhere\SHA256SUMS
# Or, from a POSIX shell with the files in place:  cd out/repro && sha256sum -c SHA256SUMS

# The NEAR code hash of a file:
node -e "import('./scripts/predeploy.mjs').then(m=>console.log(m.codeHash(require('fs').readFileSync('out/repro/prod/mamori.wasm'))))"
```

The script's own scan (step 4 in section 2) is the check that no local path is left. What the remapped files do still contain are the two machine-independent path families: `/rustc/58cf8f9c35b355199727627d07ae34a4e2846d67/library/...` (the standard library's own mapping, fixed by the compiler version) and `/cargo-home\registry\src\index.crates.io-1949cf8c6b5b557f\<crate>\src\...` for dependencies. The first line of the manifest therefore has to match on both machines.

## 5. What the script does not make equal

| Left over | Why | Status |
|---|---|---|
| A different compiler or LLVM | The channel is pinned to 1.99.1 in `rust-toolchain.toml`, but `/rustc/<commit>` and the generated code come from the installed build. | Pinned, the versions are in the manifest. Not varied in any run. |
| A different operating system | A remapped path keeps the separators of whatever follows the prefix: the Windows build has `contracts\mamori\src\lib.rs` and `/cargo-home\registry\src\...`, a Linux build would have `/` throughout. The wasm bytes then differ. | Inferred from the strings in the Windows build. Not tested on Linux. Reproducing across operating systems would need the same container image on both sides. |
| A different Cargo.lock | `--locked` refuses a stale lock, but a different lock that is still consistent builds different code. | Hash in the manifest. |
| A different cargo/registry source of the same crate version | A crate re-published or a mirror serving different bytes under one version. | Cargo checks the lock's checksums; not otherwise tested. |
| Hash-seed or thread-count effects | Three builds ran at the same time on 16 cores (A, B, C) and gave identical bytes, with `codegen-units = 1`, LTO and `panic = "abort"` from the workspace profile. | Observed, not proven. |
| NEAR's own route | `cargo near build reproducible-wasm` builds inside a pinned Docker image. | Not used, not tested here. |

## 6. Still open

1. Run `repro-build.ps1` on a second machine (another user account, another drive letter, another CARGO_HOME, ideally another PC) from `git archive` of the same commit and compare `SHA256SUMS` and `repro-manifest.json`. The first mismatch, if any, is the finding.
2. Decide whether `make build` (and with it `make verify` and `make predeploy`, which read `out\prod`) should build each package alone and with the remap, so there is one recipe. Today there are two and their mamori bytes differ.
3. Re-run section 3 once the Kizashi and Mamori edits that are in progress are committed, and record the new hashes here.
