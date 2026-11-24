param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'

$backendRoot = Join-Path $PSScriptRoot 'backend'
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node.js was not found at $NodePath." }
while ($true) {
  Push-Location $backendRoot
  try {
    & $NodePath '--env-file-if-exists=.env' 'server.js'
  }
  catch {
    # The hidden launcher retries after a short delay.
  }
  finally {
    Pop-Location
  }
  Start-Sleep -Seconds 5
}
