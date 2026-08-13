@echo off
rem ==========================================================
rem  TrackRakho - Tally connector launcher (Windows)
rem  Double-click this file. It installs what it needs, asks
rem  two questions the first time, then keeps syncing.
rem  Keep this file next to quotekaro-tally-connector.mjs.
rem ==========================================================

rem pushd (not cd /d) so this also works when the folder sits on a network
rem share or a mapped Mac folder - cmd.exe cannot "cd" into a \\server\path
pushd "%~dp0"
title TrackRakho Tally connector

where node >nul 2>nul
if not errorlevel 1 goto RUN

echo.
echo  Node.js is not on this PC yet - it is free and takes about 2 minutes.
echo  (One time only. Nothing else changes on this computer.)
echo.

where winget >nul 2>nul
if errorlevel 1 goto MANUAL

echo  Installing Node.js ...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
rem winget installs into a fresh PATH - add the usual spots to THIS window
set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LOCALAPPDATA%\Programs\nodejs"

where node >nul 2>nul
if errorlevel 1 goto RESTART
echo  Node.js installed.
goto RUN

:RESTART
echo.
echo  Node.js install ho gaya, par ye window purane settings par hai.
echo  Is window ko band karke start-connector.bat dobara double-click karo.
echo.
pause
exit /b 0

:MANUAL
echo  Is PC par automatic install available nahi hai.
echo  Browser khul raha hai - "LTS" wala Windows Installer download karke
echo  install karo, phir start-connector.bat dobara double-click karo.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:RUN
echo.
echo  Connector chalu ho raha hai. Ye window khuli rehne do.
echo  (Band karne se sync ruk jaata hai.)
echo.
node quotekaro-tally-connector.mjs %*

echo.
echo  Connector ruk gaya. Upar ki lines mein wajah likhi hai.
echo  Setting badalni ho to:  start-connector.bat --setup
popd
pause
