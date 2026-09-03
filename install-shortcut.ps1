$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherPath = Join-Path $projectRoot 'start-reader.ps1'
$iconPath = Join-Path $projectRoot 'assets\wordnov-reader.ico'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutName = ([string][char]0x8BCD) + ([char]0x95F4) + ([char]0x9605) + ([char]0x8BFB) + ([char]0x5668) + '.lnk'
$shortcutPath = Join-Path $desktopPath $shortcutName

$powerShell7 = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (Test-Path -LiteralPath $powerShell7) {
  $shellPath = $powerShell7
} else {
  $shellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $shellPath
$shortcut.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $iconPath + ',0'
$shortcut.Description = 'Start Wordnov Reader'
$shortcut.Save()

Write-Output $shortcutPath
