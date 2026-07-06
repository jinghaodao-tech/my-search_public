Write-Host "== Typecheck =="
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== Test =="
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== Git status =="
git status

Write-Host "== Diff summary =="
git diff --stat

Write-Host ""
Write-Host "OK. Next steps:"
Write-Host "git add ."
Write-Host 'git commit -m "your message"'
Write-Host "git push"