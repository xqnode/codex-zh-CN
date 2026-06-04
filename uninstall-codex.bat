@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:: Complete removal of Codex Desktop (Store), user data, and local launchers.
:: Requires Administrator for Microsoft Store package removal.

net session >nul 2>&1
if not %errorLevel%==0 (
    echo.
    echo   Administrator rights are required to uninstall Codex.
    echo   Click Yes in the UAC prompt to continue...
    echo.
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
    exit /b 0
)

title Codex Complete Uninstaller
chcp 65001 >nul

echo.
echo ========================================
echo    Codex Complete Uninstaller
echo ========================================
echo.
echo This will:
echo   - Stop Codex and related processes
echo   - Uninstall Microsoft Store package OpenAI.Codex
echo   - Delete user data under %%USERPROFILE%%\.codex
echo   - Delete %%APPDATA%%\Codex and %%LOCALAPPDATA%%\Codex
echo   - Remove local launcher scripts next to this folder
echo.
set /p CONFIRM=Type YES to continue, or anything else to cancel: 
if /i not "%CONFIRM%"=="YES" (
    echo Cancelled.
    pause
    exit /b 0
)

echo.
echo [1/5] Stopping Codex-related processes...
taskkill /F /IM codex-helper.exe /T >nul 2>&1
taskkill /F /IM Codex.exe /T >nul 2>&1
taskkill /F /IM codex.exe /T >nul 2>&1
powershell.exe -NoProfile -Command ^
  "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -match 'Codex|codex|zh-cn-patched|CodexHelper' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo [2/5] Uninstalling Microsoft Store package OpenAI.Codex...
echo        NOTE: This step often takes 2-5 minutes. It is NOT frozen.
echo        Windows may show a blue "Deployment operation progress" line - that is normal.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-codex-store.ps1"
set "STORE_EXIT=%ERRORLEVEL%"
if not "%STORE_EXIT%"=="0" (
    echo [warn] Store uninstall reported issues ^(exit %STORE_EXIT%^). Continuing with data cleanup...
)
if exist "%ProgramFiles%\WindowsApps\OpenAI.Codex_*" (
    echo [warn] WindowsApps folder may remain until reboot; Store uninstall was attempted.
)

echo [3/5] Removing launcher scripts...
if exist "%~dp0Codex 汉化版.vbs" del /f /q "%~dp0Codex 汉化版.vbs" >nul 2>&1
if exist "%~dp0Codex 汉化版.bat" del /f /q "%~dp0Codex 汉化版.bat" >nul 2>&1
if exist "%~dp0launch-codex-zh-cn.ps1" del /f /q "%~dp0launch-codex-zh-cn.ps1" >nul 2>&1
if exist "%~dp0launch-codex-zh-cn.bat" del /f /q "%~dp0launch-codex-zh-cn.bat" >nul 2>&1
if exist "%USERPROFILE%\Desktop\Codex 汉化版.vbs" del /f /q "%USERPROFILE%\Desktop\Codex 汉化版.vbs" >nul 2>&1
if exist "%USERPROFILE%\Desktop\Codex 汉化版.bat" del /f /q "%USERPROFILE%\Desktop\Codex 汉化版.bat" >nul 2>&1
if exist "%USERPROFILE%\Desktop\launch-codex-zh-cn.ps1" del /f /q "%USERPROFILE%\Desktop\launch-codex-zh-cn.ps1" >nul 2>&1

echo [4/5] Removing user data directories...
call :RemoveDir "%USERPROFILE%\.codex"
call :RemoveDir "%APPDATA%\Codex"
call :RemoveDir "%LOCALAPPDATA%\Codex"

echo [5/5] Scheduling cleanup after reboot (if any files are locked)...
call :ScheduleRebootCleanup

echo.
echo ========================================
if exist "%USERPROFILE%\.codex" (
    echo   Done with warnings
    echo   Folder still exists: %USERPROFILE%\.codex
    echo   Reboot your PC; leftover data will be removed on next logon.
) else (
    echo   Codex has been removed
)
echo ========================================
echo.
echo Notes:
echo   - Reinstall from Microsoft Store if you need Codex again.
echo   - Third-party tools e.g. Codex++ in D:\soft are NOT removed by this script.
echo.
pause
exit /b 0

:RemoveDir
set "TARGET=%~1"
if not exist "%TARGET%" (
    echo   [skip] Not found: %TARGET%
    exit /b 0
)
echo   [del] %TARGET%
takeown /f "%TARGET%" /r /d y >nul 2>&1
icacls "%TARGET%" /grant "%USERNAME%:(F)" /t /c >nul 2>&1
rmdir /s /q "%TARGET%" >nul 2>&1
if exist "%TARGET%" (
    echo   [warn] Could not fully delete: %TARGET%
)
exit /b 0

:ScheduleRebootCleanup
set "CLEANUP_BAT=%TEMP%\cleanup-codex-after-reboot.bat"
(
    echo @echo off
    echo taskkill /F /IM codex-helper.exe /T 2^>nul
    echo taskkill /F /IM Codex.exe /T 2^>nul
    echo taskkill /F /IM codex.exe /T 2^>nul
    echo rmdir /s /q "%USERPROFILE%\.codex" 2^>nul
    echo rmdir /s /q "%APPDATA%\Codex" 2^>nul
    echo rmdir /s /q "%LOCALAPPDATA%\Codex" 2^>nul
    echo reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v CleanupCodex /f 2^>nul
) > "%CLEANUP_BAT%"
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v CleanupCodex /t REG_SZ /d "%CLEANUP_BAT%" /f >nul 2>&1
if %errorLevel%==0 (
    echo   [ok] Registered RunOnce cleanup: %CLEANUP_BAT%
) else (
    echo   [warn] Could not register RunOnce cleanup.
)
exit /b 0
