@echo off
rem Run by the "Auto-update Awakened POE Trade f. Dio" scheduled task (see local-install.mjs)
cd /d "%~dp0..\.."
if not exist main\dist mkdir main\dist
node main\build\local-install.mjs --task >> main\dist\local-install.log 2>&1
