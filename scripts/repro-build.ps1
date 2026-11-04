<#
.SYNOPSIS
  Builds the production and drill wasm of kizashi and mamori so the bytes do not depend on where the build ran.

.DESCRIPTION
  A plain `cargo build` embeds the absolute path of every dependency's source file in the wasm (panic locations
  and `file!()`), for example `<CARGO_HOME>\registry\src\index.crates.io-...\near-sdk-5.30.0\src\env.rs`. Two
  machines with different CARGO_HOME paths therefore build different bytes and different code hashes from the
  same commit. This script maps those prefixes to fixed names with `--remap-path-prefix` (the repo root, the
  target directory, CARGO_HOME and the rustup home), builds with `--locked`, then scans each wasm and refuses to
  report a hash if any of those paths is still inside it.

  A second source of difference is not a path at all: cargo unifies the features of a dependency across every
  package named in one command, so `-p kizashi -p mamori` gives mamori a different near-sdk feature set than
  `-p mamori` alone (kizashi turns on near-sdk's `unstable`), and the two mamori wasm files differ by 59 bytes
  with every path identical. This script therefore builds each package with its own cargo invocation, so a
  contract's bytes depend on its own manifest and not on which other package was named beside it.

  What it does NOT make equal: a different compiler (the toolchain is pinned by rust-toolchain.toml and the exact
  rustc/cargo versions go into the manifest), a different operating system (Windows puts `\` into the path
  remainder that follows a mapped prefix, Linux `/`), or a different Cargo.lock (the lock file's hash is in the
  manifest).

  The flags go in through CARGO_ENCODED_RUSTFLAGS, which cargo ranks above RUSTFLAGS and above the rustflags in
  .cargo/config.toml, and which survives spaces in paths. Because of that ranking the repo's `--cfg near` (see
  .cargo/config.toml) is repeated here, and the script stops if the config ever asks for anything else.

  Output: <OutDir>\prod\{kizashi,mamori}.wasm, <OutDir>\drill\{kizashi,mamori}.wasm, <OutDir>\SHA256SUMS and
  <OutDir>\repro-manifest.json (tool versions, flags with placeholders instead of paths, sizes and hashes), so the
  manifest itself is also comparable between machines.

.PARAMETER OutDir
  Where the four wasm files and the manifest go. Default: <repo>\out\repro.

.PARAMETER TargetDir
  Cargo target directory. Default: CARGO_TARGET_DIR if set, else <repo>\target\repro (a separate directory, so
  the ordinary build cache in <repo>\target is not invalidated by the different flags).

.PARAMETER Offline
  Pass --offline to cargo (the crates must already be in CARGO_HOME).

.EXAMPLE
  $env:PATH = "D:\HACK-Projects\toolchain\cargo\bin;$env:PATH"
  pwsh -NoProfile -File scripts\repro-build.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$TargetDir,
  [switch]$Offline
)
$ErrorActionPreference = 'Stop'

$Triple = 'wasm32-unknown-unknown'
$Packages = @('kizashi', 'mamori')
# Same as [target.wasm32-unknown-unknown] rustflags in .cargo/config.toml. It has to be repeated here: flags in
# CARGO_ENCODED_RUSTFLAGS replace the config's rustflags, they are not added to them.
$BaseRustflags = @('--cfg', 'near')

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$userHome = [Environment]::GetFolderPath('UserProfile')

function Resolve-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-Sha256([string]$File) {
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ConfigRustflags([string]$ConfigFile) {
  # Quoted strings inside the first `rustflags = [ ... ]` array, comments removed. Enough for this repo's config.
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return @() }
  $text = (Get-Content -LiteralPath $ConfigFile -Raw) -replace '(?m)^\s*#.*$', ''
  $m = [regex]::Match($text, 'rustflags\s*=\s*\[(?<body>[^\]]*)\]')
  if (-not $m.Success) { return @() }
  return @([regex]::Matches($m.Groups['body'].Value, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
}

# --- the three roots, plus the target directory ---------------------------------------------------------------
$cargoHome = $env:CARGO_HOME
if (-not $cargoHome) { $cargoHome = Join-Path $userHome '.cargo' }
$rustupHome = $env:RUSTUP_HOME
if (-not $rustupHome) { $rustupHome = Join-Path $userHome '.rustup' }
if (-not (Test-Path -LiteralPath $cargoHome)) { throw "CARGO_HOME does not exist: $cargoHome" }
if (-not (Test-Path -LiteralPath $rustupHome)) { throw "RUSTUP_HOME does not exist: $rustupHome" }
$cargoHome = (Resolve-Path -LiteralPath $cargoHome).Path
$rustupHome = (Resolve-Path -LiteralPath $rustupHome).Path

if (-not $TargetDir) { $TargetDir = $env:CARGO_TARGET_DIR }
if (-not $TargetDir) { $TargetDir = Join-Path $RepoRoot 'target\repro' }
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'out\repro' }
$TargetDir = Resolve-Dir $TargetDir
$OutDir = Resolve-Dir $OutDir
# A manifest left over from an earlier run must not sit beside this run's files.
foreach ($stale in @('SHA256SUMS', 'repro-manifest.json')) { Remove-Item -LiteralPath (Join-Path $OutDir $stale) -ErrorAction SilentlyContinue }

# Refuse to run if the repo's cargo config wants flags this script would silently drop.
$configured = Get-ConfigRustflags (Join-Path $RepoRoot '.cargo\config.toml')
if (($configured -join ' ') -ne ($BaseRustflags -join ' ')) {
  throw "the rustflags in .cargo/config.toml are [$($configured -join ' ')], this script builds with [$($BaseRustflags -join ' ')]. Update `$BaseRustflags in scripts/repro-build.ps1 to match, then rebuild."
}

# rustc uses the LAST matching --remap-path-prefix, so a more specific root must come after a broader one.
$maps = @(
  @{ From = $RepoRoot; To = '/kaigen' },
  @{ From = $TargetDir; To = '/target' },
  @{ From = $cargoHome; To = '/cargo-home' },
  @{ From = $rustupHome; To = '/rustup-home' }
)
$flags = @($BaseRustflags)
foreach ($m in $maps) { $flags += "--remap-path-prefix=$($m.From)=$($m.To)" }

# --- a clean environment: nothing from the caller's shell may change the bytes -----------------------------------
$sep = [char]0x1f
$envNames = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(CARGO_PROFILE_|CARGO_BUILD_|CARGO_TARGET_|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|CARGO_INCREMENTAL$)' } | ForEach-Object { $_.Name })
$saved = @{}
foreach ($n in $envNames) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$savedTarget = $env:CARGO_TARGET_DIR

$sums = [ordered]@{}
try {
  foreach ($n in $envNames) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
  $env:CARGO_ENCODED_RUSTFLAGS = ($flags -join $sep)
  $env:CARGO_TARGET_DIR = $TargetDir
  $env:CARGO_INCREMENTAL = '0'

  if ($saved.ContainsKey('RUSTFLAGS')) { Write-Host 'note: RUSTFLAGS in your shell is ignored by this script on purpose.' }
  Write-Host "repo root   : $RepoRoot"
  Write-Host "target dir  : $TargetDir"
  Write-Host "CARGO_HOME  : $cargoHome"
  Write-Host "RUSTUP_HOME : $rustupHome"
  Write-Host "flags       : $($flags -join ' ')"

  Push-Location $RepoRoot
  try {
    $rustcV = (& rustc -vV) -join "`n"
    $cargoV = (& cargo --version) -join ''
    if ($LASTEXITCODE -ne 0) { throw 'cargo is not on PATH (for the pinned toolchain: $env:PATH = "<toolchain>\cargo\bin;$env:PATH")' }

    foreach ($profile in @('prod', 'drill')) {
      $dest = Resolve-Dir (Join-Path $OutDir $profile)
      # One cargo invocation per package, on purpose: cargo unifies the features of a dependency across every package
      # named in the same command. `-p kizashi -p mamori` builds near-sdk with kizashi's `unstable` feature for mamori
      # too, and mamori's wasm then differs by 59 bytes from `-p mamori` alone. Built alone, each contract's bytes are
      # a function of its own manifest, not of which other package was named beside it.
      foreach ($p in $Packages) {
        $cargoArgs = @('build', '--release', '--locked', '--target', $Triple, '-p', $p)
        if ($profile -eq 'drill') { $cargoArgs += @('--features', 'drill') }
        if ($Offline) { $cargoArgs += '--offline' }

        # A stale file from an earlier build must never be mistaken for this build's output.
        $built = Join-Path $TargetDir "$Triple\release"
        Remove-Item -LiteralPath (Join-Path $built "$p.wasm") -ErrorAction SilentlyContinue

        Write-Host "`n== $profile $p : cargo $($cargoArgs -join ' ')"
        & cargo @cargoArgs
        if ($LASTEXITCODE -ne 0) { throw "cargo build ($profile $p) failed with exit code $LASTEXITCODE" }

        $src = Join-Path $built "$p.wasm"
        if (-not (Test-Path -LiteralPath $src)) { throw "cargo reported success but $src does not exist" }
        Copy-Item -LiteralPath $src -Destination (Join-Path $dest "$p.wasm") -Force
        $sums["$profile/$p.wasm"] = $null
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  # Put the caller's environment back.
  foreach ($n in $envNames) { if ($null -ne $saved[$n]) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
  Remove-Item -LiteralPath 'Env:CARGO_ENCODED_RUSTFLAGS' -ErrorAction SilentlyContinue
  if ($null -ne $savedTarget) { $env:CARGO_TARGET_DIR = $savedTarget } else { Remove-Item -LiteralPath 'Env:CARGO_TARGET_DIR' -ErrorAction SilentlyContinue }
}

# --- verify the artifacts, not the exit code: no local path may survive inside any wasm ---------------------------
$leakRoots = @($RepoRoot, $TargetDir, $cargoHome, $rustupHome) | Select-Object -Unique
$problems = @()
foreach ($rel in @($sums.Keys)) {
  $file = Join-Path $OutDir $rel
  $bytes = [IO.File]::ReadAllBytes($file)
  $text = [Text.Encoding]::GetEncoding(28591).GetString($bytes) # latin1: one char per byte, nothing is lost or invented
  foreach ($root in $leakRoots) {
    foreach ($form in @($root, $root.Replace('\', '/'))) {
      if ($text.IndexOf($form, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $problems += "$rel still contains the path $form" }
    }
  }
  $drive = [regex]::Match($text, '[A-Za-z]:\\[A-Za-z0-9_.-]{2,}\\')
  if ($drive.Success) { $problems += "$rel contains a drive path: $($drive.Value)" }
  $unix = [regex]::Match($text, '/(?:home|Users|root)/[A-Za-z0-9_.-]{2,}/')
  if ($unix.Success) { $problems += "$rel contains a home-directory path: $($unix.Value)" }
  $sums[$rel] = [pscustomobject]@{ bytes = $bytes.Length; sha256 = (Get-Sha256 $file) }
}
if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Error $_ -ErrorAction Continue }
  # Leave nothing behind that could be mistaken for a reproducible build.
  foreach ($rel in @($sums.Keys)) { Remove-Item -LiteralPath (Join-Path $OutDir $rel) -ErrorAction SilentlyContinue }
  throw 'path leak: the build is not path-independent, so no hashes are reported and the wasm files were removed. Add the missing prefix to $maps.'
}

# --- manifest and sums ---------------------------------------------------------------------------------------------
$commit = $null
$dirty = $null
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
  Push-Location $RepoRoot
  try {
    $commit = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $commit = $null } else { $dirty = [bool](& git status --porcelain -- contracts Cargo.toml Cargo.lock rust-toolchain.toml .cargo 2>$null) }
  } finally { Pop-Location }
}
$manifest = [ordered]@{
  rustc = $rustcV
  cargo = $cargoV
  target = $Triple
  cargo_lock_sha256 = (Get-Sha256 (Join-Path $RepoRoot 'Cargo.lock'))
  rustflags = @($BaseRustflags + @('--remap-path-prefix=<repo root>=/kaigen', '--remap-path-prefix=<target dir>=/target', '--remap-path-prefix=<CARGO_HOME>=/cargo-home', '--remap-path-prefix=<RUSTUP_HOME>=/rustup-home'))
  git_commit = $commit
  contracts_dirty = $dirty
  files = $sums
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'repro-manifest.json') -Encoding utf8
($sums.Keys | ForEach-Object { "$($sums[$_].sha256) *$_" }) -join "`n" | Set-Content -LiteralPath (Join-Path $OutDir 'SHA256SUMS') -Encoding ascii

Write-Host "`nSHA-256 (no local path inside any of these files):"
foreach ($k in $sums.Keys) { Write-Host ('{0}  {1,8} B  {2}' -f $sums[$k].sha256, $sums[$k].bytes.ToString([Globalization.CultureInfo]::InvariantCulture), $k) }
Write-Host "`nwritten: $OutDir (SHA256SUMS, repro-manifest.json)"
# `git` above exits non-zero outside a work tree (a `git archive` checkout); a caller using `&` must not see that as ours.
$global:LASTEXITCODE = 0
