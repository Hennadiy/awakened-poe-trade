@echo off
rem Pulls the latest dio-ver from GitHub and reinstalls Awakened PoE Trade
cd /d "%~dp0"
node main\build\local-install.mjs --update
echo.
pause
