@echo off
chcp 65001 >nul
title SKY ARENA server
cd /d "%~dp0"
python server\app.py --port 8080
pause
