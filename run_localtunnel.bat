@echo off
title Scruge Localtunnel Launcher
echo ===================================================
echo   Starting Scruge Product Finder + Localtunnel     
echo ===================================================
echo.
echo 1. Starting backend on http://localhost:3000 ...
start "Scruge Backend" cmd /k "node backend/server.js"
timeout /t 2 >nul

echo.
echo 2. Launching Localtunnel...
npx localtunnel --port 3000
pause
