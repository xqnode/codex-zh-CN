## Codex Desktop 简体中文语言包 v0.1.1

在 v0.1.0 基础上修复 Store 版安装、菜单汉化与安装体验问题。**建议所有用户升级到此版本。**

### 新增

- **Microsoft Store 版完整支持**：在 `%USERPROFILE%\.codex\zh-cn-patched\` 维护可写副本，无需修改 `WindowsApps`
- **`uninstall-codex.bat`**：纯英文脚本，彻底卸载 Store 包与用户数据目录
- **安装进度实时输出**：分步日志与进度条，避免长时间无响应
- **可移植启动器**：安装后在 `install-windows.bat` 同目录生成 `Codex 汉化版.vbs` / `.bat`（不再放到桌面）

### 修复

- 编辑 / 窗口菜单可点击且子项显示中文（保留菜单 `id`）
- 安装前正确检测并关闭 Codex / codex-helper 进程
- 旧汉化副本占用时自动切换新目录继续安装
- Webview 汉化性能优化（单次读取 `app.asar`）

### 下载

- **Source code (zip)** / **tar.gz**：GitHub 自动生成，解压后运行 `install-windows.bat`
- 安装汉化后使用同目录下的 **`Codex 汉化版.vbs`** 启动（无 cmd 黑窗）

### 使用

1. 完全退出 Codex（含托盘 codex-helper）
2. 解压后双击 **`install-windows.bat`** → 选 **[1] 安装汉化**
3. 日常使用同目录 **`Codex 汉化版.vbs`**

卸载：以管理员运行 **`uninstall-codex.bat`**，输入 `YES` 确认。

---

MIT License | 非官方补丁，与 OpenAI 无关
