param(
  [string]$InputPath = (Join-Path $PSScriptRoot 'step5a-private\step5a-local-manifest.json'),
  [string]$OutputPath = (Join-Path $PSScriptRoot 'step5a-results\step5a-redacted-report.json'),
  [string]$TargetSha = '08e0a6d1176d15dee1d6576967ffa9f481ab0f5c'
)
$ErrorActionPreference = 'Stop'
$command = Get-Command node -ErrorAction Stop
$version = & $command.Source --version
Write-Host "Local Node runtime: $version"
$script = Join-Path $PSScriptRoot 'scripts\step5a-measure.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw 'Step 5A offline tool not found in extracted folder.' }
if (-not (Test-Path -LiteralPath $InputPath)) {
  Write-Host 'NO_REAL_SAMPLES: private manifest has not been created on this computer.'
  exit 2
}
& $command.Source $script --input $InputPath --output $OutputPath --target-sha $TargetSha
$exitCode = $LASTEXITCODE
if ($exitCode -eq 0) { Write-Host 'Redacted measurements created. Independent business signoff still required.' }
elseif ($exitCode -eq 2) { Write-Host 'No real acceptance has been established.' }
elseif ($exitCode -eq 3) { Write-Host 'Real measurement has gaps or unresolved issues. Not accepted.' }
else { Write-Host 'Input validation failed without printing customer content.' }
exit $exitCode
