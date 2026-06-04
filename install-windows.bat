@echo off
setlocal
cd /d "%~dp0"

:: Microsoft Store 安装位于 WindowsApps，写入需管理员权限；先提权再打开终端
net session >nul 2>&1
if not %errorLevel%==0 (
    echo.
    echo   Codex 汉化需要管理员权限（Store 版需写入 WindowsApps）
    echo   请在 UAC 窗口中点击「是」以继续...
    echo.
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b 0
)

title Codex Desktop 简体中文语言包
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_windows.ps1" -Action menu
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
