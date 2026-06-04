@echo off
chcp 65001 >nul
set "ACTIVE=%USERPROFILE%\.codex\zh-cn-patched-active.txt"

if not exist "%ACTIVE%" (
  echo [错误] 未找到汉化记录，请先运行 install-windows.bat 并选择 [1] 安装汉化。
  pause
  exit /b 1
)

set "PATCHED_ROOT="
set /p PATCHED_ROOT=<"%ACTIVE%"
if not exist "%PATCHED_ROOT%\app" (
  echo [错误] 汉化副本目录无效，请重新安装汉化。
  pause
  exit /b 1
)

set "APP_DIR=%PATCHED_ROOT%\app"
cd /d "%APP_DIR%"

if exist "%APP_DIR%\Codex.exe" (
  start "" "%APP_DIR%\Codex.exe"
  exit /b 0
)
if exist "%APP_DIR%\codex.exe" (
  start "" "%APP_DIR%\codex.exe"
  exit /b 0
)

echo [错误] 未找到 Codex.exe，请重新安装汉化。
pause
exit /b 1
