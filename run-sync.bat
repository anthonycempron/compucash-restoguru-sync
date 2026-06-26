@echo off
:: Title the window for clarity
title CompuCash to Restoguru Sync Pipeline

:: Jump directly to your project directory on the C: drive
cd /d C:\compucash-sync

echo =======================================================
echo     LAUNCHING COMPUCASH RESTOGURU WEBHOOK MIDDLEWARE   
echo =======================================================
echo.

:: Run the script loading the .env file parameters
node --env-file=.env index.js

:: If the script crashes or closes, keep the window open so you can read why
echo.
echo [Warning] The script has stopped running.
pause