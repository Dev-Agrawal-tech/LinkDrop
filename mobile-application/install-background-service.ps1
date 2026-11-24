$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $projectRoot 'run-background-service.ps1'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$startupFolder = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $startupFolder 'LinkDrop backend.vbs'
$taskName = 'LinkDrop backend service'

if (-not (Test-Path -LiteralPath $runnerPath)) { throw "LinkDrop runner was not found at $runnerPath." }

# Earlier Task Scheduler versions could remain Ready after sign-in. The Startup
# launcher runs the same hidden backend for the signed-in Windows user instead.
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$runnerForVbs = $runnerPath.Replace('"', '""')
$nodeForVbs = $nodePath.Replace('"', '""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$runnerForVbs"" -NodePath ""$nodeForVbs""", 0, False
"@
Set-Content -LiteralPath $launcherPath -Value $vbs -Encoding ascii

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"{0}"' -f $launcherPath) -WindowStyle Hidden

Write-Host 'LinkDrop will now start automatically when you sign in to Windows.'
Write-Host 'It starts in the background and does not open a command window.'
Write-Host "Startup launcher: $launcherPath"
