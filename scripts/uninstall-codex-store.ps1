# Uninstall Microsoft Store package OpenAI.Codex
# Remove-AppxPackage is slow (often 2-5 min); not frozen.

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

Write-Host "[info] Removing Store package OpenAI.Codex..."
Write-Host "[info] This usually takes 2-5 minutes. Please wait; do not close the window."
Write-Host "[info] A blue 'Deployment operation progress' line from Windows is normal."

$packages = @(Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue)
if ($packages.Count -eq 0) {
    Write-Host "[ok] Store package not found (already removed)."
    exit 0
}

foreach ($pkg in $packages) {
    Write-Host "[info] Removing: $($pkg.PackageFullName)"
    $started = Get-Date
    try {
        Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop
        $sec = [int]((Get-Date) - $started).TotalSeconds
        Write-Host "[ok] Removed $($pkg.PackageFullName) (${sec}s)"
    } catch {
        Write-Host "[warn] Remove-AppxPackage failed: $($_.Exception.Message)"
        Write-Host "[info] Trying winget uninstall..."
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            & winget uninstall --id "OpenAI.Codex" --silent --accept-source-agreements 2>&1 | ForEach-Object { Write-Host $_ }
        }
    }
}

try {
    $prov = Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "OpenAI.Codex" }
    foreach ($p in $prov) {
        Write-Host "[info] Removing provisioned package for new users..."
        Remove-AppxProvisionedPackage -Online -PackageName $p.PackageName -ErrorAction SilentlyContinue | Out-Null
    }
} catch {
    # optional; may require admin
}

$still = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue
if ($still) {
    Write-Host "[warn] Package may still be registered. Reboot and run this script again, or uninstall from Microsoft Store app."
    exit 1
}

Write-Host "[ok] Microsoft Store package OpenAI.Codex is gone."
exit 0
