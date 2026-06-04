## Codex Desktop 简体中文语言包 v0.1.2

在 v0.1.1 基础上修复启动器稳定性，改用 PowerShell 拉起汉化版 Codex 并持久化中文语言配置。**建议所有用户升级到此版本。**

### 新增

- **PowerShell 启动脚本** `launch-codex-zh-cn.ps1`：启动前自动写入 `localeOverride = "zh-CN"`，解决重启后界面变回英文
- **备用启动入口** `launch-codex-zh-cn.bat`（纯英文文件名，路径兼容性更好）

### 修复

- 移除 VBS 启动器（UTF-8 中文在 Windows Script Host 下报 800A0408 无效字符）
- 修复 `Codex 汉化版.bat` 双击无法拉起 Codex（中文路径/文件名嵌套引号问题）
- 安装完成后优先通过启动脚本拉起，确保语言配置生效

### 下载

- **`codex-zh-CN-v0.1.2.zip`**：解压后运行 `install-windows.bat`
- 安装汉化后使用同目录 **`Codex 汉化版.bat`** 启动（无 cmd 黑窗）

### 使用

1. 完全退出 Codex（含托盘 codex-helper）
2. 解压后双击 **`install-windows.bat`** → 选 **[1] 安装汉化**
3. 日常使用同目录 **`Codex 汉化版.bat`**（或备用 **`launch-codex-zh-cn.bat`**）

卸载：以管理员运行 **`uninstall-codex.bat`**，输入 `YES` 确认。

---

MIT License | 非官方补丁，与 OpenAI 无关
