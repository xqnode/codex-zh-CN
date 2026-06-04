@echo off
setlocal EnableExtensions

set "PS1=%~dp0launch-codex-zh-cn.ps1"
if not exist "%PS1%" (
  echo [ERROR] Missing launch-codex-zh-cn.ps1. Run install-windows.bat first.
  pause
  exit /b 1
)

if /i "%~1"=="internal" goto launch

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath \"%~f0\" -ArgumentList internal -WindowStyle Hidden"
exit /b 0

:launch
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PS1%"
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
