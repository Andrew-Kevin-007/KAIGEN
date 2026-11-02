# Stops the WSL sandbox node started by start.ps1 (safe to run when none is running).
param(
    [string]$Distro = 'kaigen-sandbox',
    [string]$RunDir = 'D:\HACK-Projects\toolchain\sandbox-run'
)
$pidFile = "$RunDir\node.pid"
if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}
# Killing wsl.exe does not always end the Linux process; make sure no node is left holding the ports.
wsl -d $Distro -u root -- bash -c "pkill -x near-sandbox; true" 2>$null | Out-Null
exit 0
