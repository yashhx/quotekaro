@echo off
rem ==========================================================
rem  TrackRakho - background mode
rem  Double-click this ONCE on the Tally PC. After this the connector
rem  starts by itself every time the PC is switched on, with no window
rem  on screen. Rokna ho to: stop-connector.bat
rem ==========================================================

pushd "%~dp0"
title TrackRakho - background mode

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "config.json" goto NOCONFIG

echo.
echo  Connector ko background mode mein daala ja raha hai...
echo.

rem stop an already-running copy (anywhere on this PC) so the new one
rem takes over cleanly - the lock lives in TEMP, first line is the PID
set "LOCK=%TEMP%\trackrakho-connector.lock"
if not exist "%LOCK%" goto NOOLD
set /p OLDPID=<"%LOCK%"
if defined OLDPID taskkill /PID %OLDPID% /F >nul 2>nul
del "%LOCK%" >nul 2>nul
:NOOLD

wscript "%~dp0run-hidden.vbs" /install

echo  Ho gaya.
echo.
echo   - Ab ye PC on hote hi apne aap chalu ho jayega.
echo   - Koi window nahi dikhegi. Sab kuch yahan likha jaata hai:
echo       %~dp0connector.log
echo   - Band karna ho to: stop-connector.bat
echo.
echo  Tally khula rakhna (company ke saath) - tabhi sync hota hai.
echo.
popd
pause
exit /b 0

:NOCONFIG
echo.
echo  Pehle setup karna hai: start-connector.bat double-click karo,
echo  key paste karo, phir ye file chalao.
echo.
popd
pause
exit /b 1

:NONODE
echo.
echo  Node.js nahi mila. Pehle start-connector.bat double-click karo -
echo  wo Node install kar dega - phir ye file chalao.
echo.
popd
pause
exit /b 1
