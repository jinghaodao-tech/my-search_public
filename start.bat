@echo off
chcp 65001 > nul
title カード索引システム
echo.
echo  ╔══════════════════════════════════╗
echo  ║    カード索引システム 起動中...    ║
echo  ╚══════════════════════════════════╝
echo.

:: .env がなければ警告
if not exist ".env" (
  echo  [警告] .env ファイルがありません。
  echo  ANTHROPIC_API_KEY を設定してください。
  echo.
)

:: 依存インストール（初回のみ時間がかかります）
if not exist "node_modules" (
  echo  [初回] npm install を実行します...
  npm install
  echo.
)

echo  ブラウザが開いたらそちらで操作してください。
echo  終了: このウィンドウを閉じるか Ctrl+C
echo.

:: サーバー起動後にブラウザを開く
start "" timeout /t 2 /nobreak > nul & start http://localhost:3000

npx tsx server.ts

pause
