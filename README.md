# Codex Desktop 简体中文语言包

> Windows 版 Codex Desktop 简体中文语言包，一键安装汉化。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.1.0-green.svg)](https://github.com/xqnode/codex-zh-CN/releases/tag/v0.1.0)

一键将 [Codex Desktop](https://github.com/openai/codex) 界面切换为**简体中文**，面向 Windows 用户，操作简单。

参考了 [claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn) 的补丁思路，针对 Codex 内置中文资源做了适配，并补全了**顶部菜单**（文件 / 编辑 / 查看 / 窗口 / 帮助）、**内置插件 metadata** 等仍可能显示英文的部分。

## 快速开始

1. 下载 [Release v0.1.0](https://github.com/xqnode/codex-zh-CN/releases/tag/v0.1.0) 并解压，或克隆本仓库
2. **完全退出** Codex Desktop（任务栏右键退出，不要只关窗口）
3. 双击 `install-windows.bat`（会打开 PowerShell 窗口）
4. 在交互菜单中选择 **[1] 安装汉化**

若界面仍是英文，打开 **Settings → General → Language**，选择 **中文（中国）**。

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

`uninstall-windows.bat` 也会打开同一交互菜单，可在其中选择 **[2] 恢复英文 / 重置**。

## 环境要求

- Windows 10 / 11
- 已安装 Codex Desktop（已测试版本：`26.519.81530`）
- 已安装 [Node.js](https://nodejs.org/) 18+

## 汉化范围

- 顶部菜单及子项（文件、编辑、查看、窗口、帮助）
- 主进程硬编码菜单与对话框文案
- Webview 缺失的中文词条补充
- 内置插件显示名称与描述（Browser / Chrome / LaTeX 等）
- 语言配置：`localeOverride = "zh-CN"`

## 脚本会做什么

1. 自动查找 Codex 安装目录（运行中的进程 / 常见安装路径）
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
| `install-windows.bat` | 入口：打开 PowerShell 交互菜单 |
| `uninstall-windows.bat` | 同上，用于恢复英文 |
| `scripts/install_windows.ps1` | 交互式安装器 |
| `scripts/patch-codex-zh-cn.mjs` | 补丁核心逻辑 |
| `resources/native-menu-zh-CN.json` | 原生菜单中文翻译 |
| `resources/menu-hardcoded-zh-CN.json` | 主进程硬编码菜单替换表 |
| `resources/bundled-plugins-zh-CN.json` | 内置插件显示名称与描述 |

## 命令行（可选）

```powershell
# 环境检测
powershell -File scripts\install_windows.ps1 -Action status

# 非交互安装
powershell -File scripts\install_windows.ps1 -Action install -CodexPath "D:\path\to\Codex"

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
