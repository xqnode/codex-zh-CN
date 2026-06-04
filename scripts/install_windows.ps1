param(
    [ValidateSet("install", "uninstall", "status", "verify", "menu")]
    [string]$Action = "menu",
    [string]$CodexPath = "",
    [switch]$Interactive,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$projectRoot = Split-Path -Parent $scriptDir
$patchScript = Join-Path $scriptDir "patch-codex-zh-cn.mjs"
$verifyScript = Join-Path $scriptDir "verify-patch.mjs"

function Write-Title {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "   Codex Desktop 简体中文语言包" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host $Message -ForegroundColor Yellow
}

function Write-Ok([string]$Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarnLine([string]$Message) {
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

function Write-Bad([string]$Message) {
    Write-Host "  [X] $Message" -ForegroundColor Red
}

function Write-InfoLine([string]$Message) {
    Write-Host "  [i] $Message" -ForegroundColor DarkGray
}

function Test-NodeAvailable {
    return [bool](Get-Command node -ErrorAction SilentlyContinue)
}

function Test-IsAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-ElevatedInstaller {
    param(
        [string[]]$ExtraArgs = @()
    )

    $psArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`""
    ) + $ExtraArgs

    Write-Host ""
    Write-Host "  需要管理员权限，正在请求 UAC 提升..." -ForegroundColor Yellow
    Write-Host "  请在弹窗中点击「是」。" -ForegroundColor DarkGray
    Write-Host ""

    Start-Process -FilePath "powershell.exe" `
        -Verb RunAs `
        -WorkingDirectory $projectRoot `
        -ArgumentList $psArgs
    exit 0
}

function Ensure-Administrator {
    if (Test-IsAdministrator) { return }
    $extra = @("-Action", $Action)
    if ($CodexPath) { $extra += @("-CodexPath", $CodexPath) }
    if ($NoPause) { $extra += "-NoPause" }
    Invoke-ElevatedInstaller -ExtraArgs $extra
}

function Get-StatusReport {
    param([string]$CustomCodexPath = "")

    if (-not (Test-Path $patchScript)) {
        throw "缺少补丁脚本: $patchScript"
    }
    if (-not (Test-NodeAvailable)) {
        throw "未找到 Node.js。请先安装 Node.js 后再运行。"
    }

    $argsList = @($patchScript, "status", "--json")
    if ($CustomCodexPath) {
        $argsList += @("--codex-path", $CustomCodexPath)
    }

    $output = & node @argsList 2>&1
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) {
        throw "环境检测失败，退出码 $LASTEXITCODE`n$output"
    }

    $jsonLine = ($output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
    if (-not $jsonLine) {
        throw "无法读取环境检测报告。`n$output"
    }

    return ($jsonLine | ConvertFrom-Json)
}

function Show-StatusReport {
    param($Report)

    Write-Host ""
    Write-Host "【环境检测】" -ForegroundColor Cyan
    Write-Host ""

    if ($Report.nodeOk) {
        Write-Ok "Node.js $($Report.nodeVersion)"
    } else {
        Write-Bad "未安装 Node.js"
    }

    if ($Report.codexFound) {
        Write-Ok "Codex 安装目录: $($Report.codexPath)"
    } else {
        Write-Bad "未找到 Codex Desktop 安装目录"
    }

    if ($Report.codexRunning) {
        Write-WarnLine "Codex 正在运行（安装汉化时会自动关闭，完成后自动重启）"
    } else {
        Write-InfoLine "Codex 当前未运行（汉化完成后将自动启动）"
    }

    if ($Report.asarLocalized) {
        Write-Ok "应用资源已汉化 (app.asar)"
    } else {
        Write-WarnLine "应用资源尚未汉化"
    }

    if ($Report.localeZhCn) {
        Write-Ok "语言配置: zh-CN"
    } else {
        Write-WarnLine "语言配置: $($Report.localeOverride)"
    }

    if ($Report.pluginsTotal -gt 0) {
        if ($Report.pluginsLocalized -eq $Report.pluginsTotal) {
            Write-Ok "内置插件 metadata: $($Report.pluginsLocalized)/$($Report.pluginsTotal)"
        } else {
            Write-WarnLine "内置插件 metadata: $($Report.pluginsLocalized)/$($Report.pluginsTotal)"
        }
        foreach ($plugin in $Report.plugins) {
            if ($plugin.localized) {
                Write-InfoLine "$($plugin.name): $($plugin.displayName)"
            } else {
                Write-WarnLine "$($plugin.name): $($plugin.displayName)"
            }
        }
    } else {
        Write-WarnLine "尚未检测到内置插件缓存"
    }

    if ($Report.asarBackup) {
        Write-InfoLine "已存在 app.asar 备份，可安全重置"
    } else {
        Write-WarnLine "尚无 app.asar 备份，首次汉化后会自动创建"
    }

    Write-Host ""
    if ($Report.patchInstalled) {
        Write-Host "  总体状态: 汉化已生效" -ForegroundColor Green
    } elseif ($Report.codexFound) {
        Write-Host "  总体状态: 尚未完全汉化" -ForegroundColor Yellow
    } else {
        Write-Host "  总体状态: 环境未就绪" -ForegroundColor Red
    }

    foreach ($message in $Report.messages) {
        Write-InfoLine $message
    }
}

function Invoke-PatchAction {
    param(
        [ValidateSet("install", "uninstall")]
        [string]$PatchAction,
        [string]$CustomCodexPath = "",
        [switch]$LaunchCodex
    )

    $argsList = @($patchScript, $PatchAction)
    if ($CustomCodexPath) {
        $argsList += @("--codex-path", $CustomCodexPath)
    }

    Write-InfoLine "安装进度将实时显示在下方，复制文件时可能需 2–5 分钟，请勿关闭窗口。"
    $patchLines = [System.Collections.Generic.List[string]]::new()
    & node @argsList 2>&1 | ForEach-Object {
        $line = "$_"
        if ($line -match '^\[progress-bar\]') {
            Write-Host $line -ForegroundColor Magenta
        } elseif ($line -match '^\[step \d+/\d+\]' -or $line -match '^\[progress\]') {
            Write-Host $line -ForegroundColor Cyan
        } elseif ($line -match '^\[ok\]' -or $line -match '^\[OK\]') {
            Write-Host $line -ForegroundColor Green
        } elseif ($line -match '^\[warn\]' -or $line -match '^\[error\]' -or $line -match '^\[X\]') {
            Write-Host $line -ForegroundColor Yellow
        } else {
            Write-Host $line
        }
        [void]$patchLines.Add($line)
    }
    if ($LASTEXITCODE -ne 0) {
        throw "操作失败，退出码 $LASTEXITCODE"
    }

    if ($PatchAction -eq "install" -and $LaunchCodex) {
        $launched = $false
        foreach ($line in $patchLines) {
            if ($line -match '^\[codex-launch\]\s+(.+)$') {
                Write-Ok "已重新启动 Codex: $($Matches[1].Trim())"
                $launched = $true
                break
            }
        }
        if (-not $launched) {
            Write-InfoLine "汉化已完成；若 Codex 未自动打开，请双击与 install-windows.bat 同目录下的「Codex 汉化版.bat」启动。"
        }
    }
}

function Invoke-VerifyPatch {
    param([string]$CustomCodexPath = "")

    $report = Get-StatusReport -CustomCodexPath $CustomCodexPath
    if (-not $report.codexFound) {
        throw "未找到 Codex，无法验证补丁。"
    }

    $asarPath = $report.asarPath
    if (-not $asarPath) {
        throw "未找到 app.asar 路径。"
    }

    Write-Step "【验证补丁】"
    & node $verifyScript $report.asarPath
    if ($LASTEXITCODE -ne 0) {
        throw "验证脚本执行失败，退出码 $LASTEXITCODE"
    }
}

function Confirm-Action {
    param([string]$Prompt)

    while ($true) {
        $answer = (Read-Host $Prompt).Trim()
        switch -Regex ($answer) {
            '^[Yy]$' { return $true }
            '^[Nn]$' { return $false }
            default { Write-WarnLine "请输入 Y 或 N。" }
        }
    }
}

function Read-MenuChoice {
    param([string]$CustomCodexPath = "")

    Write-Host ""
    Write-Host "【操作菜单】" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [1] 安装汉化"
    Write-Host "  [2] 恢复英文 / 重置"
    Write-Host "  [3] 验证补丁"
    Write-Host "  [4] 重新检测环境"
    if ($CustomCodexPath) {
        Write-Host "  [5] 清除自定义 Codex 路径"
    } else {
        Write-Host "  [5] 手动指定 Codex 路径"
    }
    Write-Host "  [Q] 退出"
    Write-Host ""

    while ($true) {
        $choice = (Read-Host "请选择 [1/2/3/4/5/Q]").Trim()
        switch -Regex ($choice) {
            '^[1]$' { return "install" }
            '^[2]$' { return "uninstall" }
            '^[3]$' { return "verify" }
            '^[4]$' { return "refresh" }
            '^[5]$' { return "path" }
            '^[Qq]$' { return "quit" }
            default { Write-WarnLine "请输入 1、2、3、4、5 或 Q。" }
        }
    }
}

function Start-InteractiveMenu {
    $customCodexPath = $CodexPath

    while ($true) {
        Clear-Host
        Write-Title

        if ($customCodexPath) {
            Write-InfoLine "当前指定 Codex 路径: $customCodexPath"
        }

        $report = Get-StatusReport -CustomCodexPath $customCodexPath
        Show-StatusReport -Report $report

        $choice = Read-MenuChoice -CustomCodexPath $customCodexPath
        switch ($choice) {
            "install" {
                if (-not $report.readyToInstall) {
                    Write-Bad "环境未就绪，请先解决上面的问题。"
                    if (-not $NoPause) { Read-Host "按 Enter 继续" | Out-Null }
                    continue
                }
                Write-Step "【安装汉化】"
                if ($report.codexRunning) {
                    Write-WarnLine "检测到 Codex 正在运行，将先自动关闭，汉化后再自动重启。"
                } else {
                    Write-InfoLine "Codex 未运行；汉化完成后将自动启动。"
                }
                try {
                    Write-InfoLine "正在执行汉化，请稍候…"
                    Invoke-PatchAction -PatchAction "install" -CustomCodexPath $customCodexPath -LaunchCodex
                    Write-Ok "汉化安装完成"
                } catch {
                    Write-Bad $_.Exception.Message
                }
                if (-not $NoPause) { Read-Host "按 Enter 返回菜单" | Out-Null }
            }
            "uninstall" {
                if (-not $report.codexFound) {
                    Write-Bad "未找到 Codex，无法重置。"
                    if (-not $NoPause) { Read-Host "按 Enter 继续" | Out-Null }
                    continue
                }
                if (-not (Confirm-Action "确认恢复英文并重置汉化？(Y/N)")) {
                    continue
                }
                Write-Step "【恢复英文 / 重置】"
                try {
                    Invoke-PatchAction -PatchAction "uninstall" -CustomCodexPath $customCodexPath
                    Write-Ok "已恢复英文，请手动重新启动 Codex"
                } catch {
                    Write-Bad $_.Exception.Message
                }
                if (-not $NoPause) { Read-Host "按 Enter 返回菜单" | Out-Null }
            }
            "verify" {
                Write-Step "【验证补丁】"
                try {
                    Invoke-VerifyPatch -CustomCodexPath $customCodexPath
                    Write-Ok "验证完成"
                } catch {
                    Write-Bad $_.Exception.Message
                }
                if (-not $NoPause) { Read-Host "按 Enter 返回菜单" | Out-Null }
            }
            "refresh" {
                continue
            }
            "path" {
                if ($customCodexPath) {
                    $customCodexPath = ""
                    & node @($patchScript, "clear-path") | Out-Null
                    Write-Ok "已清除自定义 Codex 路径，将自动检测。"
                } else {
                    $inputPath = (Read-Host "请输入 Codex 安装目录（MSIX 包根目录或 app 子目录，例如 C:\Program Files\WindowsApps\OpenAI.Codex_...）").Trim('"')
                    $asarOk = $false
                    $resolvedPath = $inputPath
                    if ($inputPath) {
                        if (Test-Path (Join-Path $inputPath "resources\app.asar")) {
                            $asarOk = $true
                        } elseif (Test-Path (Join-Path $inputPath "app\resources\app.asar")) {
                            $asarOk = $true
                            $resolvedPath = Join-Path $inputPath "app"
                        }
                    }
                    if ($asarOk) {
                        $customCodexPath = $resolvedPath
                        & node @($patchScript, "save-path", "--codex-path", $customCodexPath) | Out-Null
                        if ($LASTEXITCODE -ne 0) {
                            Write-WarnLine "路径已用于本次会话，但未能写入持久化配置"
                        } else {
                            Write-Ok "已设置 Codex 路径（已保存，下次自动识别）: $customCodexPath"
                        }
                    } else {
                        Write-Bad "路径无效，或未找到 resources\app.asar（或 app\resources\app.asar）"
                    }
                }
                if (-not $NoPause) { Read-Host "按 Enter 返回菜单" | Out-Null }
            }
            "quit" {
                Write-Host ""
                Write-Host "已退出。" -ForegroundColor DarkGray
                return
            }
        }
    }
}

if (-not (Test-Path $patchScript)) {
    throw "缺少补丁脚本: $patchScript"
}

if ($Interactive -or $Action -eq "menu") {
    Ensure-Administrator
    Start-InteractiveMenu
    exit 0
}

if ($Action -in @("install", "uninstall", "verify")) {
    Ensure-Administrator
}

switch ($Action) {
    "status" {
        $report = Get-StatusReport -CustomCodexPath $CodexPath
        Show-StatusReport -Report $report
    }
    "verify" {
        Invoke-VerifyPatch -CustomCodexPath $CodexPath
    }
    "install" {
        Write-Step "【安装汉化】"
        Invoke-PatchAction -PatchAction "install" -CustomCodexPath $CodexPath -LaunchCodex
    }
    "uninstall" {
        Write-Step "【恢复英文 / 重置】"
        Invoke-PatchAction -PatchAction "uninstall" -CustomCodexPath $CodexPath
    }
}

if (-not $NoPause) {
    Write-Host ""
    Read-Host "按 Enter 退出"
}
