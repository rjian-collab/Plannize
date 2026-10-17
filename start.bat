@echo off
cd /d "%~dp0"
start "" /min cmd /c "node_modules\.bin\electron.cmd . >nul 2>&1"
