@echo off
rem ==========================================================
rem  TrackRakho - stop the background connector
rem  Chalu connector ko rokta hai AUR auto-start bhi hata deta hai.
rem  Dobara chalu karna ho to: install-autostart.bat
rem ==========================================================

pushd "%~dp0"
title TrackRakho - stop connector

rem 1. remove the logon entry so it does not come back after a restart
wscript "%~dp0run-hidden.vbs" /uninstall

rem 2. stop the copy running right now. The lock lives in TEMP (machine-wide,
rem    so it is found even if the running copy sits in a different folder);
rem    its first line is the PID.
set "LOCK=%TEMP%\trackrakho-connector.lock"
if not exist "%LOCK%" goto NOTRUNNING

set /p PID=<"%LOCK%"
if not defined PID goto NOTRUNNING

taskkill /PID %PID% /F >nul 2>nul
if errorlevel 1 goto GONE
del "%LOCK%" >nul 2>nul
echo.
echo  Connector band ho gaya, aur auto-start bhi hata diya.
echo  Dobara chalu karne ke liye: install-autostart.bat
echo.
popd
pause
exit /b 0

:GONE
del "%LOCK%" >nul 2>nul
echo.
echo  Connector pehle se band tha. Auto-start hata diya gaya hai.
echo.
popd
pause
exit /b 0

:NOTRUNNING
echo.
echo  Koi connector chal nahi raha tha. Auto-start hata diya gaya hai.
echo.
popd
pause
exit /b 0
