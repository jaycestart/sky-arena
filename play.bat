@echo off
chcp 65001 >nul
rem SKY ARENA launcher: start the server only if it is not already running,
rem then open the browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$up = $false; try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 8080); $up = $true; $c.Close() } catch {};" ^
  "if (-not $up) { Start-Process -WindowStyle Minimized python -ArgumentList '%~dp0server\app.py','--port','8080' -WorkingDirectory '%~dp0'; Start-Sleep -Milliseconds 1600 };" ^
  "Start-Process 'http://localhost:8080'"
