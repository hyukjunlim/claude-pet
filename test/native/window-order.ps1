param([ValidateSet('snapshot','demote','cover')][string]$Mode, [long]$PetHandle, [long]$CoverHandle, [uint32]$TestProcess)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TopmostProbe {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  public static bool IsAbove(IntPtr pet, IntPtr cover) {
    IntPtr current = pet;
    for (int i = 0; i < 10000; i++) {
      current = GetWindow(current, 2);
      if (current == cover) return true;
      if (current == IntPtr.Zero) return false;
    }
    throw new Exception("Window traversal did not finish");
  }
}
'@
$pet = [IntPtr]$PetHandle
$cover = [IntPtr]$CoverHandle
foreach ($handle in @($pet,$cover)) {
  $owner=[uint32]0
  [void][TopmostProbe]::GetWindowThreadProcessId($handle,[ref]$owner)
  if ($TestProcess -eq 0 -or $owner -ne $TestProcess) { throw 'Refusing to change a window outside the test process' }
}
if ($Mode -eq 'demote') {
  if (-not [TopmostProbe]::SetWindowPos($pet, [IntPtr]1, 0, 0, 0, 0, 0x13)) { throw 'Could not demote probe window' }
}
if ($Mode -eq 'cover') {
  if (-not [TopmostProbe]::SetWindowPos($cover, [IntPtr](-1), 0, 0, 0, 0, 0x13)) { throw 'Could not raise cover window' }
}
@{
  topmost = ([TopmostProbe]::GetWindowLong($pet, -20) -band 8) -ne 0
  visible = [TopmostProbe]::IsWindowVisible($pet)
  above = [TopmostProbe]::IsAbove($pet, $cover)
  foreground = [TopmostProbe]::GetForegroundWindow().ToInt64().ToString()
} | ConvertTo-Json -Compress
