# Installs the caveman reply style for Claude Code and Codex. Extra arguments pass through, e.g. .\install.ps1 --dry-run
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js 18+ is required (https://nodejs.org). Install it, then run this again.'
  exit 1
}
& $node.Source (Join-Path $PSScriptRoot 'caveman.mjs') install @args
exit $LASTEXITCODE
