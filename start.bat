@echo off
chcp 65001 > nul
title カード検索システム

echo.
echo  起動中...
echo.

if not exist "node_modules" (
  echo  npm install を実行しています...
  npm install
  echo.
)

start "" /min cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3000"
npx tsx server.ts

pause
