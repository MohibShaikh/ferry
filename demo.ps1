# ferry demo — run in a clean, maximized PowerShell window and screen-record for a sample video.
#
#   1. $env:ANTHROPIC_API_KEY = "sk-ant-..."   (set your key first)
#   2. powershell -ExecutionPolicy Bypass -File demo.ps1
#
# Makes ~10 small API calls (a few cents). Uses npx so no global install/PATH needed.

$ErrorActionPreference = "Stop"

function Line($cmd) {
  Write-Host ""
  Write-Host "PS> " -ForegroundColor DarkGray -NoNewline
  Write-Host $cmd -ForegroundColor Cyan
  Start-Sleep -Milliseconds 900
}

Clear-Host
Write-Host "  ferry — cost + quality delta for switching LLM models" -ForegroundColor Green
Write-Host "  ------------------------------------------------------" -ForegroundColor DarkGray
Start-Sleep -Seconds 2

# 1. the eval set — a few of your own prompts
$evals = @'
[
  { "id": "capital",  "prompt": "Capital of Australia? One word.", "expected": "Canberra" },
  { "id": "extract",  "prompt": "Extract the total as JSON: 'Widgets x3 @ $4, tax $1.20, TOTAL $13.20'. Reply {\"total\": <number>}.", "expected": "{\"total\": 13.20}" },
  { "id": "rewrite",  "prompt": "Rewrite politely, one sentence: 'send the report now, you forgot again'." }
]
'@
Set-Content -Path evals.json -Value $evals -Encoding utf8

Line "type evals.json      # your prompts: id, prompt, optional expected"
Get-Content evals.json
Start-Sleep -Seconds 2

# 2. run the comparison
Line 'ferry compare --from claude-sonnet-4-6 --to claude-haiku-4-5 --evals evals.json --traffic 500000 --json'
npx --yes @mohibzz/ferry compare --from claude-sonnet-4-6 --to claude-haiku-4-5 --evals evals.json --traffic 500000 --json
Start-Sleep -Seconds 2

# 3. the deliverable
Line "type ferry-report.md   # the report you hand your team"
Get-Content ferry-report.md
Start-Sleep -Seconds 2

# 4. machine-readable twin for CI
Line "type ferry-report.json | Select -First 12   # same numbers, for CI gates"
Get-Content ferry-report.json | Select-Object -First 12
Write-Host ""
Write-Host "  npm i -g @mohibzz/ferry" -ForegroundColor Green
Start-Sleep -Seconds 2
