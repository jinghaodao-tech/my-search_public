@echo off
cd /d "C:\Users\jingh\my-search-app_public"
set PORT=3001

if not exist "node_modules" (
  call npm.cmd install
)

start "" /min cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3001"
call npx.cmd tsx server.ts

pause
