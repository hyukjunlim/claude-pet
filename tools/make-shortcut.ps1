# Creates "Claude Pet.lnk" in the project folder: double-click it to start the pet without a
# console window. Run with `npm run shortcut` after `npm install`.
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Error 'Electron is missing. Run npm install first.'
  exit 1
}
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $root 'Claude Pet.lnk'))
$shortcut.TargetPath = $electron
$shortcut.Arguments = "`"$root`""
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$electron,0"
$shortcut.Description = 'Claude Pet'
$shortcut.Save()
Write-Output "Created $(Join-Path $root 'Claude Pet.lnk')"
