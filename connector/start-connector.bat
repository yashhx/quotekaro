@echo off
rem QuoteKaro Tally connector - Windows launcher.
rem Keep this file in the connector folder next to quotekaro-tally-connector.mjs.

cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this PC.
  echo Please download the LTS version from https://nodejs.org , install it,
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting the QuoteKaro Tally connector...
echo Keep this window open. Close it to stop syncing.
echo.

node quotekaro-tally-connector.mjs

echo.
echo The connector stopped. Read the lines above for the reason.
pause
