param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $projectRoot 'server.mjs'
$healthUrl = 'http://127.0.0.1:4317/api/status'
$readerUrl = 'http://127.0.0.1:4317'
$pidFile = Join-Path $projectRoot '.reader.pid'

function Test-Reader {
  try {
    $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Get-ProcessCommandLine([int]$ProcessId) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) { return $null }
  return [string]$processInfo.CommandLine
}

try {
  $processIdsToStop = New-Object 'System.Collections.Generic.HashSet[int]'

  if (Test-Path -LiteralPath $pidFile) {
    $savedProcessId = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedProcessId)) {
      $savedCommandLine = Get-ProcessCommandLine -ProcessId $savedProcessId
      if ($savedCommandLine -and $savedCommandLine.Contains($serverPath)) {
        $null = $processIdsToStop.Add($savedProcessId)
      }
    }
  }

  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    $listenerProcessId = [int]$listener.OwningProcess
    $listenerCommandLine = Get-ProcessCommandLine -ProcessId $listenerProcessId
    if (-not $listenerCommandLine -or -not $listenerCommandLine.Contains($serverPath)) {
      throw 'Port 4317 is occupied by another application. Close it before starting Wordnov Reader.'
    }
    $null = $processIdsToStop.Add($listenerProcessId)
  }

  foreach ($readerProcessId in $processIdsToStop) {
    Stop-Process -Id $readerProcessId -ErrorAction Stop
  }

  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $remaining = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
    if (-not $remaining) { break }
    Start-Sleep -Milliseconds 100
  }
  if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) {
    throw 'The previous Wordnov Reader process did not stop cleanly.'
  }

  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeCommand.Source
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.Arguments = '"' + $serverPath + '" --production'
  $process = [System.Diagnostics.Process]::Start($startInfo)
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding UTF8

  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-Reader) {
      $ready = $true
      break
    }
    if ($process.HasExited) { break }
  }
  if (-not $ready) {
    throw 'The local reader did not start within 20 seconds. Run npm install and npm run build first.'
  }

  if (-not $NoBrowser) {
    $restartToken = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-Process ($readerUrl + '/?restart=' + $restartToken)
  }
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, 'Wordnov Reader', 'OK', 'Error') | Out-Null
  exit 1
}

