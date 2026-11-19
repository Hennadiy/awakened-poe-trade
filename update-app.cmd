@echo off
rem Pulls the latest dio-ver from GitHub and reinstalls Awakened POE Trade f. Dio
cd /d "%~dp0"
node main\build\local-install.mjs --update
echo.
pause
