# Codex Desktop 简体中文语言包

> Windows 版 Codex Desktop 简体中文语言包，一键安装汉化。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.1.0-green.svg)](https://github.com/xqnode/codex-zh-CN/releases/tag/v0.1.0)

一键将 [Codex Desktop](https://github.com/openai/codex) 界面切换为**简体中文**，面向 Windows 用户，操作简单。

## 快速开始

1. 下载 [Release v0.1.0](https://github.com/xqnode/codex-zh-CN/releases/tag/v0.1.0) 并解压，或克隆本仓库
2. **完全退出** Codex Desktop（任务栏右键退出，不要只关窗口）
3. 双击 `install-windows.bat`（会先弹出 **UAC 管理员授权**，请点击「是」）
4. 在交互菜单中选择 **[1] 安装汉化**（若 Codex 正在运行会先自动关闭，汉化完成后自动重启）
5. **Microsoft Store 版**：日常使用请在与 `install-windows.bat` **同一目录**双击 **「Codex 汉化版.vbs」**（无 cmd 黑窗；不要用开始菜单里的 Store 原版快捷方式）

> Store 版 `WindowsApps` 目录受系统保护，无法原地修改。汉化会复制到 `%USERPROFILE%\.codex\zh-cn-patched\`，并在安装目录生成 `Codex 汉化版.vbs` / `.bat`（推荐 `.vbs`）。

若界面仍是英文，打开 **Settings → General → Language**，选择 **中文（中国）**。

若提示 `app.asar 缺失`，请在 Microsoft Store 中对 Codex 执行 **修复/重置** 后重新安装汉化。

## 交互菜单

运行 `install-windows.bat` 后会先显示**环境检测报告**，再进入菜单：

| 选项 | 说明 |
|------|------|
| **1** | 安装汉化 |
| **2** | 恢复英文 / 重置 |
| **3** | 验证补丁结果 |
| **4** | 重新检测环境 |
| **5** | 手动指定 / 清除 Codex 安装路径 |
| **Q** | 退出 |

恢复英文：在同一菜单中选择 **[2] 恢复英文 / 重置**。

## 汉化范围

- 顶部菜单及子项（文件、编辑、查看、窗口、帮助）
- 主进程硬编码菜单与对话框文案
- Webview 缺失的中文词条补充
- 内置插件显示名称与描述（Browser / Chrome / LaTeX 等）
- 语言配置：`localeOverride = "zh-CN"`

## 脚本会做什么

1. 自动查找 Codex 安装目录（见下方「安装目录识别」）
2. 备份 `resources/app.asar` 和 `Codex.exe`
3. 写入完整 `native-menu-locales/zh-CN.json`
4. 汉化主进程硬编码菜单
5. 补充 webview 中文词条
6. 汉化 `%USERPROFILE%\.codex` 中内置插件 metadata
7. 写入 `%USERPROFILE%\.codex\config.toml`：`localeOverride = "zh-CN"`
8. 同步 `Codex.exe` 内嵌的 asar 完整性哈希
9. 安装完成后尝试启动 Codex

## 更新 Codex 后

Codex 更新可能覆盖 `app.asar` 或插件缓存。若界面变回英文，**重新运行** `install-windows.bat` 即可。

## 项目结构

| 文件 | 说明 |
|------|------|
| `install-windows.bat` | 唯一入口：打开 PowerShell 交互菜单（安装 / 重置 / 验证等） |
| `Codex 汉化版.vbs` | 安装后生成于本目录，无黑窗启动汉化版 |
| `Codex 汉化版.bat` | 安装后生成的备用启动脚本 |
| `launchers/` | 启动脚本模板（安装时复制到项目根目录） |
| `scripts/install_windows.ps1` | 交互式安装器 |
| `scripts/patch-codex-zh-cn.mjs` | 补丁核心逻辑 |
| `resources/native-menu-zh-CN.json` | 原生菜单中文翻译 |
| `resources/menu-hardcoded-zh-CN.json` | 主进程硬编码菜单替换表 |
| `resources/bundled-plugins-zh-CN.json` | 内置插件显示名称与描述 |

## 安装目录识别

只要目录结构满足以下任一形式即可识别（与安装位置无关）：

| 布局 | 示例 |
|------|------|
| 便携版 / 解压版 | `...\resources\app.asar` |
| Microsoft Store (MSIX) | `...\OpenAI.Codex_*\app\resources\app.asar` |

自动检测顺序（由高到低）：

1. 命令行 `--codex-path` 或菜单 **[5] 手动指定**（会保存到 `%USERPROFILE%\.codex\codex-desktop-path.txt`）
2. 环境变量 `CODEX_DESKTOP_PATH` / `CODEX_ZH_CN_PATH`
3. 正在运行的 `Codex` / `codex` 进程路径（向上查找 `app.asar`）
4. Microsoft Store：`WindowsApps\OpenAI.Codex_*`（含 `Get-AppxPackage`）
5. 注册表卸载项中的 `InstallLocation`（显示名为 Codex 的官方安装）
6. 常见父目录下名为 `Codex*` / `OpenAI.Codex*` 的子目录：`%LOCALAPPDATA%\Programs`、`%ProgramFiles%\Codex`、`D:\soft`、`E:\soft`、桌面、下载目录等

自定义路径可填 **MSIX 包根目录**（含 `app` 子目录的那一层）或 **含 `resources\app.asar` 的 app 目录**。

## 命令行（可选）

```powershell
# 环境检测
powershell -File scripts\install_windows.ps1 -Action status

# 非交互安装（便携目录或 MSIX 包根目录均可）
powershell -File scripts\install_windows.ps1 -Action install -CodexPath "D:\path\to\Codex-win-x64-xxx"
powershell -File scripts\install_windows.ps1 -Action install -CodexPath "C:\Program Files\WindowsApps\OpenAI.Codex_26.xxx_x64__2p2nqsd0c76g0"

# 环境变量（当前终端会话）
$env:CODEX_DESKTOP_PATH = "D:\tools\Codex-win-x64-xxx"

# 非交互重置
powershell -File scripts\install_windows.ps1 -Action uninstall -CodexPath "D:\path\to\Codex"
```

## 交流与反馈

使用中遇到问题、或有汉化遗漏，欢迎扫码加入交流群反馈：

<p align="center">
  <img src="docs/wechat-group-qrcode.png" alt="Codex 中文交流群二维码" width="240" />
</p>

<p align="center">微信扫码加入交流群</p>

也可以直接在 [GitHub Issues](https://github.com/xqnode/codex-zh-CN/issues) 提交问题。

## 免责声明

本项目为**非官方**中文补丁，仅修改本机 Codex Desktop 的本地资源文件，与 OpenAI 无关。使用风险自负。

## License

[MIT](LICENSE)
