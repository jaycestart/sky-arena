# Creates a "SKY ARENA" shortcut on the Desktop.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and would
# mangle non-ASCII text into a parse error.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$icoPath = Join-Path $root 'public\icons\skyarena.ico'

Add-Type -AssemblyName System.Drawing
$png = Join-Path $root 'public\icons\icon-192.png'
if (Test-Path $png) {
  $src = [System.Drawing.Image]::FromFile($png)
  $bmp = New-Object System.Drawing.Bitmap($src, 64, 64)
  $hicon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hicon)
  $fs = [System.IO.File]::Create($icoPath)
  $icon.Save($fs)
  $fs.Close(); $icon.Dispose(); $bmp.Dispose(); $src.Dispose()
}

$linkPath = Join-Path $desktop 'SKY ARENA.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($linkPath)
$lnk.TargetPath = Join-Path $root 'play.bat'
$lnk.WorkingDirectory = $root
$lnk.Description = 'SKY ARENA - realtime multiplayer dogfight'
$lnk.WindowStyle = 7                      # start minimized
if (Test-Path $icoPath) { $lnk.IconLocation = $icoPath }
$lnk.Save()

Write-Output ('shortcut created: ' + $linkPath)
