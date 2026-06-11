@echo off
setlocal
cd /d "%~dp0"

echo.
echo ====================================
echo  Lat Media Ideation Tool - Installation
echo ====================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Please install Node.js 20+ from https://nodejs.org/
  echo Then run this script again.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo Detected Node.js %NODE_VERSION%
echo.

echo Installing dependencies. This may take 2-5 minutes...
echo (If you see a Python error, install Python 3 from the Microsoft Store
echo  and run this script again.)
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. See messages above.
  echo.
  echo Common fixes:
  echo   - Install Python 3 from the Microsoft Store
  echo   - Delete the node_modules folder and run install.bat again
  echo   - Make sure you have a stable internet connection
  pause
  exit /b 1
)

echo.
echo ====================================
echo  Installation complete!
echo  Run start.bat to launch the app.
echo ====================================
echo.
pause
