@echo off

where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  call npm install --cache .npm-cache --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
pause
