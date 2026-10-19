param([long]$WindowHandle, [int]$ParentProcess)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
public static class PetWindowProbe {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  delegate bool EnumWindowProc(IntPtr hwnd, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint type);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT bounds);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attr, out int value, int size);
  static WinEventProc keep;
  static IntPtr target;
  static string previous;
  static bool queued;
  static uint messageThread;
  static bool Cloaked(IntPtr hwnd) { int value; return DwmGetWindowAttribute(hwnd, 14, out value, 4) == 0 && value != 0; }
  static object Describe(IntPtr hwnd) {
    var name=new StringBuilder(256); GetClassName(hwnd,name,name.Capacity);
    return new { windowClass=name.ToString(), topmost=(GetWindowLong(hwnd,-20)&8)!=0 };
  }
  static void Report(string reason) {
    RECT pet; if (!GetWindowRect(target, out pet)) return;
    var above = new List<object>();
    var windows = new List<IntPtr>();
    // GetWindow traversal can loop back to the target while the order changes.
    // Enumerate the handles first, then inspect the part preceding the pet.
    bool enumerated=EnumWindows((hwnd,data) => { windows.Add(hwnd); return true; },IntPtr.Zero);
    bool found=false;
    var ordinaryAbove=new List<string>();
    foreach (IntPtr current in windows) {
      if (current == target) { found=true; break; }
      RECT bounds;
      if (!IsWindowVisible(current) || IsIconic(current) || Cloaked(current) || !GetWindowRect(current,out bounds)) continue;
      if (bounds.right>pet.left && bounds.left<pet.right && bounds.bottom>pet.top && bounds.top<pet.bottom) {
        above.Add(Describe(current));
        if ((GetWindowLong(current,-20)&8)==0) ordinaryAbove.Add(current.ToInt64().ToString());
      }
    }
    var state=new {
      orderComplete=enumerated && found,
      topmost=(GetWindowLong(target,-20)&8)!=0, visible=IsWindowVisible(target), minimized=IsIconic(target), cloaked=Cloaked(target),
      overlappingAbove=above
    };
    var serializer=new JavaScriptSerializer();
    string signature=serializer.Serialize(new {
      state.orderComplete,state.topmost,state.visible,state.minimized,state.cloaked,ordinaryAbove
    });
    if (signature == previous) return;
    previous=signature;
    Console.Out.WriteLine(serializer.Serialize(new { reason=reason, state=state }));
    Console.Out.Flush();
  }
  public static void Run(long hwnd, int parent) {
    target=new IntPtr(hwnd);
    messageThread=GetCurrentThreadId();
    var watch=new Thread(() => {
      // Wait on the parent handle; there is no periodic window-state polling.
      try { using (var process=Process.GetProcessById(parent)) process.WaitForExit(); } catch { }
      Environment.Exit(0);
    });
    watch.IsBackground=true; watch.Start();
    keep=(hook,ev,eventWindow,obj,child,thread,time) => {
      bool topLevel=obj==0 && child==0 && (ev==0x8001 || GetAncestor(eventWindow,2)==eventWindow);
      bool relevant=ev==3 || ev==0x20 || (ev==0x8004 && (obj==0 || eventWindow==GetDesktopWindow())) || (topLevel &&
        (ev<=0x8003 || (eventWindow==target && ev==0x800a)));
      if (!relevant) return;
      if (!queued) queued=PostThreadMessage(messageThread,0x8001,IntPtr.Zero,IntPtr.Zero);
    };
    var foreground=SetWinEventHook(3,3,IntPtr.Zero,keep,0,0,0);
    var desktops=SetWinEventHook(0x20,0x20,IntPtr.Zero,keep,0,0,0);
    var windowEvents=SetWinEventHook(0x8000,0x800b,IntPtr.Zero,keep,0,0,0);
    if (foreground == IntPtr.Zero || desktops == IntPtr.Zero || windowEvents == IntPtr.Zero) throw new Exception("Could not install window-order event hooks");
    Report("attached");
    MSG message;
    while (GetMessage(out message,IntPtr.Zero,0,0)>0) {
      if (message.message==0x8001) { queued=false; Report("window-event"); }
    }
    UnhookWinEvent(foreground); UnhookWinEvent(desktops); UnhookWinEvent(windowEvents);
  }
}
'@
[PetWindowProbe]::Run($WindowHandle, $ParentProcess)
