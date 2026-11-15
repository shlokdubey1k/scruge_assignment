@echo off
title Scruge Live Launcher
echo ===================================================
echo   Starting Scruge Product Finder (Local + Public)  
echo ===================================================
echo.
echo 1. Starting backend on http://localhost:3000 ...
start "Scruge Backend" cmd /k "node backend/server.js"
timeout /t 2 >nul

echo.
echo 2. Creating Instant Public HTTPS URL via OpenSSH...
echo    (Your public link will appear below)
echo ===================================================
echo.
ssh -p 443 -R0:localhost:3000 -o StrictHostKeyChecking=no a.pinggy.io
pause
