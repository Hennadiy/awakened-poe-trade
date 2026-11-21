@echo off
rem Runs local-install.mjs hidden (started via conhost --headless), logging to main\dist\local-install.log.
rem Used by the "Auto-update Awakened POE Trade f. Dio" task and, with --update, the Start menu shortcut.
cd /d "%~dp0..\.."
if not exist main\dist mkdir main\dist
node main\build\local-install.mjs --task %* >> main\dist\local-install.log 2>&1
