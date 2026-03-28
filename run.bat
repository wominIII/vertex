@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Please install Node.js first, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or not in PATH.
  echo Please install Node.js with npm, then run this file again.
  pause
  exit /b 1
)

echo Starting Vertex OpenAI Proxy...
call npm start
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Proxy exited with code %EXIT_CODE%.
  pause
)

endlocal
exit /b %EXIT_CODE%
