@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Please install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Dependencies not found. Running installation first...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo ====================================
echo  Starting Eric YT Channel AI...
echo  The app will open in your browser.
echo  Close this window to stop the server.
echo ====================================
echo.

REM Open the browser a few seconds after `npm run dev` boots, not before.
REM PowerShell handles the delay + browser launch in one detached process.
REM (Earlier attempts using nested `cmd /c "... start \"\" \"...\""` blew up
REM with `\\` being interpreted as a UNC root — "Windows cannot find '\\'"
REM plus an "Access is denied." message in the terminal.)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 5; Start-Process 'http://localhost:3000'"
call npm run dev
