#Requires -Version 5.1
<#
.SYNOPSIS
  Launch patched Codex Desktop and ensure zh-CN locale is persisted.
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Show-LauncherError {
    param([string]$Message)

    if ($Quiet) {
        Write-Error $Message
        return
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, 0, 'Codex zh-CN', 16)
    } catch {
        Write-Error $Message
    }
}

function Set-CodexLocaleZhCn {
    $configPath = Join-Path -Path $env:USERPROFILE -ChildPath '.codex\config.toml'
    $codexHome = Split-Path -Parent $configPath

    if (-not (Test-Path -LiteralPath $codexHome)) {
        New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
    }

    $content = ''
    if (Test-Path -LiteralPath $configPath) {
        $content = [System.IO.File]::ReadAllText($configPath)
    }

    $block = "[desktop]`r`nlocaleOverride = `"zh-CN`"`r`n"
    if ($content -match '(?m)^\[desktop\]') {
        if ($content -match 'localeOverride\s*=') {
            $content = [regex]::Replace(
                $content,
                'localeOverride\s*=\s*"[^"]*"',
                'localeOverride = "zh-CN"'
            )
        } else {
            $content = [regex]::Replace($content, '(?m)^\[desktop\]\s*\r?\n?', $block)
        }
    } elseif ($content.TrimEnd().Length -gt 0) {
        $content = $content.TrimEnd() + "`r`n`r`n" + $block
    } else {
        $content = $block
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, $content, $utf8NoBom)
}

function Get-PatchedCodexExe {
    param([Parameter(Mandatory = $true)][string]$AppDir)

    foreach ($name in @('Codex.exe', 'codex.exe')) {
        $candidate = Join-Path -Path $AppDir -ChildPath $name
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

try {
    $activeFile = Join-Path -Path $env:USERPROFILE -ChildPath '.codex\zh-cn-patched-active.txt'
    if (-not (Test-Path -LiteralPath $activeFile)) {
        Show-LauncherError @(
            "Patched Codex record not found.`n`nRun install-windows.bat and choose [1] Install."
        )
        exit 1
    }

    $patchedRoot = (
        Get-Content -LiteralPath $activeFile -Encoding UTF8 |
            Where-Object { $_.Trim().Length -gt 0 } |
            Select-Object -First 1
    ).Trim()

    if ([string]::IsNullOrWhiteSpace($patchedRoot) -or -not (Test-Path -LiteralPath $patchedRoot)) {
        Show-LauncherError @(
            "Patched copy folder is missing or invalid.`n`nRun install-windows.bat and choose [1] Install again."
        )
        exit 1
    }

    $appDir = Join-Path -Path $patchedRoot -ChildPath 'app'
    if (-not (Test-Path -LiteralPath $appDir)) {
        Show-LauncherError @(
            "Patched copy is missing the app folder.`n`nRun install-windows.bat and choose [1] Install again."
        )
        exit 1
    }

    $exePath = Get-PatchedCodexExe -AppDir $appDir
    if (-not $exePath) {
        Show-LauncherError @(
            "Codex.exe was not found in the patched copy.`n`nRun install-windows.bat and choose [1] Install again."
        )
        exit 1
    }

    Set-CodexLocaleZhCn

    Start-Process -FilePath $exePath -WorkingDirectory $appDir | Out-Null
    exit 0
} catch {
    Show-LauncherError ("Failed to launch Codex:`n`n{0}" -f $_.Exception.Message)
    exit 1
}
