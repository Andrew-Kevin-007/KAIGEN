# Starts a throwaway NEAR sandbox node (nearcore 2.14.0, protocol 88) inside WSL and leaves it running.
# nearcore has no Windows build, so the Linux node runs in the WSL distro `kaigen-sandbox` and the tests,
# built on Windows, attach to it over localhost RPC (see the header of tests/burn_key.rs).
#
# Everything lives on D:. The node's chain state is wiped on every start. The validator key is the node's own
# throwaway genesis key (account test.near); it is copied OUTSIDE the repo, to $RunDir, and never committed.
#
# One-time setup of the distro (already done on this machine, see docs/internal/V3-M1-PROGRESS.md):
#   wsl --install Ubuntu-24.04 --no-launch --web-download --name kaigen-sandbox --location D:\HACK-Projects\toolchain\wsl\kaigen-sandbox
#   unpack near-sandbox-2.14.0 (Linux-x86_64) to /opt/near-sandbox-2.14.0 inside it
param(
    [int]$Port = 3030,
    [string]$Distro = 'kaigen-sandbox',
    [string]$RunDir = 'D:\HACK-Projects\toolchain\sandbox-run'
)
$ErrorActionPreference = 'Stop'
$bin = '/opt/near-sandbox-2.14.0/Linux-x86_64/near-sandbox'
$home_ = '/opt/kaigen-home'

& "$PSScriptRoot\stop.ps1" -Distro $Distro -RunDir $RunDir
New-Item -ItemType Directory -Force $RunDir | Out-Null

# Fresh chain every time. `--fast` is the sandbox's own fast-block config (about 120 ms blocks).
wsl -d $Distro -u root -- bash -c "rm -rf $home_ && $bin --home $home_ init --fast > /dev/null 2>&1 && test -f $home_/validator_key.json"
if ($LASTEXITCODE -ne 0) { throw "sandbox init failed (is $bin present in $Distro?)" }
wsl -d $Distro -u root -- cat "$home_/validator_key.json" | Set-Content -Encoding ascii "$RunDir\validator_key.json"

# Keep a wsl.exe session open for the node's whole life, otherwise WSL stops the distro and kills it.
$p = Start-Process -FilePath wsl.exe -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$RunDir\node.out.log" -RedirectStandardError "$RunDir\node.err.log" `
    -ArgumentList "-d $Distro -u root -- bash -c `"exec $bin --home $home_ run --rpc-addr 0.0.0.0:$Port --network-addr 127.0.0.1:24567`""
Set-Content -Encoding ascii "$RunDir\node.pid" $p.Id

$rpc = "http://127.0.0.1:$Port"
for ($i = 0; $i -lt 120; $i++) {
    try {
        $s = Invoke-RestMethod -Uri "$rpc/status" -TimeoutSec 2
        if ($s.sync_info.latest_block_height -ge 1) {
            Write-Host "sandbox up: $rpc  version=$($s.version.version)  protocol=$($s.protocol_version)  height=$($s.sync_info.latest_block_height)"
            Write-Host "run the tests with:"
            Write-Host "  `$env:KAIGEN_SANDBOX_RPC='$rpc'; `$env:KAIGEN_SANDBOX_KEY_FILE='$RunDir\validator_key.json'"
            return
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw "sandbox did not answer on $rpc within 60 s; see $RunDir\node.err.log"
