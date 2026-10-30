@echo off
setlocal
if not "%~1"=="" (
  set "SYNREX_GROUP_ROOT=%~f1"
) else (
  for %%I in ("%~dp0..\..") do set "SYNREX_GROUP_ROOT=%%~fI"
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-group-stack.ps1" -PlatformRoot "%SYNREX_GROUP_ROOT%"
set "SYNREX_RC=%ERRORLEVEL%"
if not "%SYNREX_RC%"=="0" pause
exit /b %SYNREX_RC%
