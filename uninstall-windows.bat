@echo off
setlocal
cd /d "%~dp0"
start "Codex zh-CN" /D "%~dp0" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_windows.ps1" -Action menu
exit /b 0
