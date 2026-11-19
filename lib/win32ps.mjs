/**
 * The hands: one short-lived PowerShell process that captures, acts, captures.
 *
 * Why one process for the whole plan
 * ----------------------------------
 * The `Add-Type` of the user32 bindings costs ~250ms. Doing "capture" and "click"
 * as two spawns pays that twice and adds a second of latency to every step, so a
 * whole plan (before frame, N actions, after frame) runs inside a single
 * `powershell.exe`: the bindings compile once and the frames never leave the
 * process that measured the screen.
 *
 * Why PowerShell instead of a native addon: `SetCursorPos` / `SendInput` /
 * `EnumWindows` live in user32.dll. A native build step would make the plugin
 * uninstallable anywhere without a toolchain. The price is ~250ms per call.
 *
 * The DPI rule (copied from dsh-plugin-real-input, MIT): set
 * `SetProcessDpiAwarenessContext(-4)` BEFORE reading or writing any coordinate.
 * A DPI-virtualised process sees a 1707x1067 "screen" on this 2560x1600 display
 * and every click derived from it lands ~1.5x off target.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** user32 bindings + the parts of the plan that must run in C# (structs). */
const PS_CORE = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshNative
{
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    public class WinInfo
    {
        public long Handle { get; set; }
        public string Title { get; set; }
        public int Left { get; set; }
        public int Top { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
    }

    // Keyboard injection lives in C# on purpose: a struct property access in
    // PowerShell returns a COPY, so "$input.u.ki.wVk = 13" mutates a temporary
    // and SendInput receives an all-zero event the focused app ignores.
    public static uint SendVk(ushort vk, bool up)
    {
        var input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = (uint)(up ? 0x0002u : 0u);
        return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint SendUnicodeChar(ushort code)
    {
        var down = new INPUT();
        down.type = 1;
        down.u.ki.wVk = 0;
        down.u.ki.wScan = code;
        down.u.ki.dwFlags = 0x0004u;

        var up = new INPUT();
        up.type = 1;
        up.u.ki.wVk = 0;
        up.u.ki.wScan = code;
        up.u.ki.dwFlags = 0x0006u;

        return SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    // Enumeration in C#: a PowerShell scriptblock cast to this delegate does not
    // capture the enclosing scope, so a title filter silently matches everything.
    public static List<WinInfo> FindWindows(string needle)
    {
        var found = new List<WinInfo>();
        EnumWindows(new EnumProc((hWnd, param) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var buffer = new StringBuilder(512);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            var title = buffer.ToString();
            if (title.Length > 0 && title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                RECT rect;
                GetWindowRect(hWnd, out rect);
                found.Add(new WinInfo
                {
                    Handle = hWnd.ToInt64(),
                    Title = title,
                    Left = rect.Left,
                    Top = rect.Top,
                    Width = rect.Right - rect.Left,
                    Height = rect.Bottom - rect.Top,
                });
            }
            return true;
        }), IntPtr.Zero);
        return found;
    }

    // Find the top-level window owned by a pid. The see-now float window is
    // borderless (overrideredirect) so it has an EMPTY title: filtering on
    // GetWindowText would never find it. Size is the only usable discriminator.
    public static WinInfo FindWindowByPid(int pid)
    {
        WinInfo found = null;
        EnumWindows(new EnumProc((hWnd, param) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            uint windowPid = 0;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if (windowPid != (uint)pid) return true;
            RECT rect;
            GetWindowRect(hWnd, out rect);
            int w = rect.Right - rect.Left;
            int h = rect.Bottom - rect.Top;
            if (w < 60 || h < 40) return true;
            var buffer = new StringBuilder(512);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            found = new WinInfo
            {
                Handle = hWnd.ToInt64(),
                Title = buffer.ToString(),
                Left = rect.Left,
                Top = rect.Top,
                Width = w,
                Height = h,
            };
            return false;
        }), IntPtr.Zero);
        return found;
    }
}
'@

[void][DshNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:ScreenW = [DshNative]::GetSystemMetrics(0)
$script:ScreenH = [DshNative]::GetSystemMetrics(1)

# Which monitor to look at is part of the answer, not an implementation detail:
# the user usually runs the browser on one screen and the thing being automated
# on another, and a capture of the wrong screen shows an empty desktop. Screens
# are enumerated AFTER the DPI-awareness call, so the bounds are physical pixels.
Add-Type -AssemblyName System.Windows.Forms
$script:Mons = @()
try {
  $idx = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $idx++
    $script:Mons += @{
      index = $idx
      device = [string] $s.DeviceName
      primary = [bool] $s.Primary
      left = [int] $s.Bounds.X; top = [int] $s.Bounds.Y
      width = [int] $s.Bounds.Width; height = [int] $s.Bounds.Height
    }
  }
} catch { $script:Mons = @() }
if ($script:Mons.Count -eq 0) {
  $script:Mons = @(@{
    index = 1; device = 'primary'; primary = $true
    left = 0; top = 0; width = $script:ScreenW; height = $script:ScreenH
  })
}
$minX = 0; $minY = 0; $maxX = 0; $maxY = 0
foreach ($m in $script:Mons) {
  if ($m.left -lt $minX) { $minX = $m.left }
  if ($m.top -lt $minY) { $minY = $m.top }
  if (($m.left + $m.width) -gt $maxX) { $maxX = $m.left + $m.width }
  if (($m.top + $m.height) -gt $maxY) { $maxY = $m.top + $m.height }
}
$script:Virtual = @{ left = $minX; top = $minY; width = $maxX - $minX; height = $maxY - $minY }

$script:Vk = @{
  'ENTER' = 13; 'RETURN' = 13; 'TAB' = 9; 'ESC' = 27; 'ESCAPE' = 27; 'SPACE' = 32;
  'BACKSPACE' = 8; 'DELETE' = 46; 'INSERT' = 45; 'HOME' = 36; 'END' = 35;
  'PAGEUP' = 33; 'PAGEDOWN' = 34; 'UP' = 38; 'DOWN' = 40; 'LEFT' = 37; 'RIGHT' = 39;
  'CTRL' = 17; 'CONTROL' = 17; 'SHIFT' = 16; 'ALT' = 18; 'WIN' = 91; 'META' = 91;
  'CAPSLOCK' = 20; 'PRINTSCREEN' = 44
}
foreach ($c in 65..90) { $script:Vk[[string][char]$c] = $c }
foreach ($c in 48..57) { $script:Vk[[string][char]$c] = $c }
foreach ($n in 1..12) { $script:Vk["F$n"] = 111 + $n }

function Get-WindowTitle([IntPtr] $hWnd) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][DshNative]::GetWindowText($hWnd, $sb, 512)
  return $sb.ToString()
}

function Get-WindowRectSafe([IntPtr] $hWnd) {
  $rect = New-Object DshNative+RECT
  [void][DshNative]::GetWindowRect($hWnd, [ref] $rect)
  return @{
    left = $rect.Left; top = $rect.Top
    width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
  }
}

function Send-Vk([int] $vk, [bool] $isUp) {
  $sent = [DshNative]::SendVk([uint16] $vk, $isUp)
  if ($sent -ne 1) { throw "SendInput rejected the key event for VK $vk (returned $sent)" }
}

function Send-Unicode([string] $text, [int] $delayMs) {
  foreach ($ch in $text.ToCharArray()) {
    $sent = [DshNative]::SendUnicodeChar([uint16] [int] $ch)
    if ($sent -ne 2) { throw "SendInput rejected the character '$ch' (returned $sent)" }
    Start-Sleep -Milliseconds $delayMs
  }
}

function Send-Combo([string] $combo, [int] $repeat) {
  $parts = @($combo -split '\+' | Where-Object { $_.Trim() -ne '' })
  if ($parts.Count -eq 0) { throw 'empty key combo' }
  $keyName = $parts[$parts.Count - 1].Trim().ToUpper()
  $modNames = @()
  if ($parts.Count -gt 1) {
    $modNames = $parts[0..($parts.Count - 2)] | ForEach-Object { $_.Trim().ToUpper() }
  }
  if (-not $script:Vk.ContainsKey($keyName)) { throw "unknown key: $keyName" }
  $modVks = @()
  foreach ($m in $modNames) {
    if (-not $script:Vk.ContainsKey($m)) { throw "unknown modifier: $m" }
    $modVks += $script:Vk[$m]
  }
  $keyVk = $script:Vk[$keyName]
  for ($r = 0; $r -lt $repeat; $r++) {
    foreach ($mv in $modVks) { Send-Vk $mv $false; Start-Sleep -Milliseconds 18 }
    Send-Vk $keyVk $false
    Start-Sleep -Milliseconds 28
    Send-Vk $keyVk $true
    foreach ($mv in $modVks) { Start-Sleep -Milliseconds 18; Send-Vk $mv $true }
    Start-Sleep -Milliseconds 55
  }
}

function Invoke-Click([int] $x, [int] $y, [string] $button, [bool] $double) {
  $flagsDown = 0x0002; $flagsUp = 0x0004
  if ($button -eq 'right') { $flagsDown = 0x0008; $flagsUp = 0x0010 }
  elseif ($button -eq 'middle') { $flagsDown = 0x0020; $flagsUp = 0x0040 }
  # approach move first: a teleport followed by mousedown looks synthetic and
  # some apps only arm their hover handlers on a real move
  [void][DshNative]::SetCursorPos($x - 45, $y - 10)
  Start-Sleep -Milliseconds 70
  [void][DshNative]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 90
  $times = 1
  if ($double) { $times = 2 }
  for ($i = 0; $i -lt $times; $i++) {
    [DshNative]::mouse_event($flagsDown, 0, 0, 0, [IntPtr]::Zero)
    # Keep the press-to-release gap short: a focused page can scroll between the
    # halves and the browser then drops the click entirely.
    Start-Sleep -Milliseconds 12
    [DshNative]::mouse_event($flagsUp, 0, 0, 0, [IntPtr]::Zero)
    if ($double) { Start-Sleep -Milliseconds 80 }
  }
}

function Invoke-Focus([string] $needle, [int64] $handle) {
  $target = [IntPtr]::Zero
  if ($handle -gt 0) { $target = [IntPtr] $handle }
  elseif ($needle) {
    $matches = @([DshNative]::FindWindows($needle))
    if ($matches.Count -eq 0) { throw "no visible window matching $needle" }
    $target = [IntPtr] $matches[0].Handle
  }
  if ($target -eq [IntPtr]::Zero) { throw 'focus needs a needle or a handle' }

  # A minimised window still enumerates but its rect collapses, so every derived
  # coordinate would be wrong. Restore before asking for the foreground.
  [void][DshNative]::ShowWindow($target, 9)
  Start-Sleep -Milliseconds 120

  # Windows refuses SetForegroundWindow to a process that did not receive the
  # last input event; sharing the target thread's input queue lifts that.
  $targetPid = 0
  $targetThread = [DshNative]::GetWindowThreadProcessId($target, [ref] $targetPid)
  $thisThread = [DshNative]::GetCurrentThreadId()
  $attached = $false
  if ($targetThread -ne 0 -and $targetThread -ne $thisThread) {
    $attached = [DshNative]::AttachThreadInput($thisThread, $targetThread, $true)
  }
  try {
    [void][DshNative]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 200
  } finally {
    if ($attached) { [void][DshNative]::AttachThreadInput($thisThread, $targetThread, $false) }
  }
  if ([DshNative]::GetForegroundWindow().ToInt64() -ne $target.ToInt64()) {
    # Last resort: a synthetic ALT tap marks this process as the input source.
    [DshNative]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [DshNative]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [void][DshNative]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 200
  }
  return [DshNative]::GetForegroundWindow().ToInt64() -eq $target.ToInt64()
}

function Capture-Screen([int] $x, [int] $y, [int] $w, [int] $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size) } finally { $g.Dispose() }
  return $bmp
}

function Get-Signature([System.Drawing.Bitmap] $bmp, [int] $cols, [int] $rows) {
  $small = New-Object System.Drawing.Bitmap $cols, $rows
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
  try { $sg.DrawImage($bmp, 0, 0, $cols, $rows) } finally { $sg.Dispose() }
  $sig = New-Object 'int[]' ($cols * $rows)
  $max = 0
  try {
    for ($yy = 0; $yy -lt $rows; $yy++) {
      for ($xx = 0; $xx -lt $cols; $xx++) {
        $c = $small.GetPixel($xx, $yy)
        $lum = [int](($c.R * 299 + $c.G * 587 + $c.B * 114) / 1000)
        $sig[$yy * $cols + $xx] = $lum
        if ($lum -gt $max) { $max = $lum }
      }
    }
  } finally { $small.Dispose() }
  return @{ cells = $sig; max = $max }
}

function Compare-Signature($prev, $next, [int] $cols, [int] $rows, [int] $threshold) {
  $changed = 0
  $minX = $cols; $minY = $rows; $maxX = -1; $maxY = -1
  for ($yy = 0; $yy -lt $rows; $yy++) {
    for ($xx = 0; $xx -lt $cols; $xx++) {
      $d = [math]::Abs($prev[$yy * $cols + $xx] - $next[$yy * $cols + $xx])
      if ($d -gt $threshold) {
        $changed++
        if ($xx -lt $minX) { $minX = $xx }
        if ($xx -gt $maxX) { $maxX = $xx }
        if ($yy -lt $minY) { $minY = $yy }
        if ($yy -gt $maxY) { $maxY = $yy }
      }
    }
  }
  $box = $null
  if ($maxX -ge 0) {
    $box = @{
      nx = [math]::Round($minX / $cols, 3); ny = [math]::Round($minY / $rows, 3)
      nw = [math]::Round(($maxX - $minX + 1) / $cols, 3); nh = [math]::Round(($maxY - $minY + 1) / $rows, 3)
    }
  }
  return @{ changed = [math]::Round($changed / ($cols * $rows), 4); box = $box }
}

# A point is either normalized inside the captured region (nx/ny, the form the
# model should use: it cannot drift when the image is resized) or an absolute
# virtual-screen pixel (x/y, for coordinates quoted back from a previous reply).
function Resolve-Point($p, $region) {
  if ($null -eq $p) { return $null }
  if ($null -eq $region) {
    $region = @{ left = 0; top = 0; width = $script:ScreenW; height = $script:ScreenH }
  }
  if ($null -ne $p.nx -or $null -ne $p.ny) {
    $nx = 0.5; $ny = 0.5
    if ($null -ne $p.nx) { $nx = [double] $p.nx }
    if ($null -ne $p.ny) { $ny = [double] $p.ny }
    if ($nx -lt 0) { $nx = 0 }; if ($nx -gt 1) { $nx = 1 }
    if ($ny -lt 0) { $ny = 0 }; if ($ny -gt 1) { $ny = 1 }
    return @{
      x = [int][math]::Round($region.left + $nx * ($region.width - 1))
      y = [int][math]::Round($region.top + $ny * ($region.height - 1))
    }
  }
  return @{ x = [int] $p.x; y = [int] $p.y }
}

# Annotation happens on a bitmap that only covers the region, so every absolute
# coordinate is shifted into that bitmap's own space before drawing.
function To-Local($p, $region) {
  if ($null -eq $p -or $null -eq $region) { return $null }
  return @{ x = ([int] $p.x - [int] $region.left); y = ([int] $p.y - [int] $region.top) }
}

function To-LocalRect($rect, $region) {
  if ($null -eq $rect -or $null -eq $region) { return $null }
  $l = [int][math]::Max([int] $rect.left, [int] $region.left)
  $t = [int][math]::Max([int] $rect.top, [int] $region.top)
  $r = [int][math]::Min([int] $rect.left + [int] $rect.width, [int] $region.left + [int] $region.width)
  $b = [int][math]::Min([int] $rect.top + [int] $rect.height, [int] $region.top + [int] $region.height)
  if ($r -le $l -or $b -le $t) { return $null }
  return @{ left = ($l - $region.left); top = ($t - $region.top); width = ($r - $l); height = ($b - $t) }
}

# "Which screen" is resolved from what the user is actually looking at: the
# monitor holding most of the foreground window, else the cursor's monitor,
# else the primary one. 'all' composites every monitor into one image.
function Resolve-Region($plan) {
  $want = 'foreground'
  if ($null -ne $plan -and $null -ne $plan.screen) { $want = ([string] $plan.screen).Trim().ToLowerInvariant() }
  if ($want -eq 'all' -or $want -eq 'virtual') {
    return @{
      left = $script:Virtual.left; top = $script:Virtual.top
      width = $script:Virtual.width; height = $script:Virtual.height
      index = 0; label = ('all ' + $script:Mons.Count + ' screens')
    }
  }
  if ($want -eq 'primary') {
    $m = $script:Mons[0]
    foreach ($c in $script:Mons) { if ($c.primary) { $m = $c } }
    return @{
      left = $m.left; top = $m.top; width = $m.width; height = $m.height
      index = $m.index; label = ('primary ' + $m.width + 'x' + $m.height + ' @ ' + $m.left + ',' + $m.top)
    }
  }
  if ($want -match '^\d+$') {
    $n = [int] $want
    if ($n -ge 1 -and $n -le $script:Mons.Count) {
      $m = $script:Mons[$n - 1]
      return @{
        left = $m.left; top = $m.top; width = $m.width; height = $m.height
        index = $m.index; label = ('monitor ' + $m.index + '  ' + $m.width + 'x' + $m.height + ' @ ' + $m.left + ',' + $m.top)
      }
    }
  }
  if ($want -eq 'foreground') {
    $hWnd = [DshNative]::GetForegroundWindow()
    if ($hWnd -ne [IntPtr]::Zero) {
      $rect = Get-WindowRectSafe $hWnd
      $best = $null; $bestArea = 0
      foreach ($m in $script:Mons) {
        $ix = [int][math]::Max([int] $rect.left, $m.left)
        $iy = [int][math]::Max([int] $rect.top, $m.top)
        $ax = [int][math]::Min([int] $rect.left + [int] $rect.width, $m.left + $m.width)
        $ay = [int][math]::Min([int] $rect.top + [int] $rect.height, $m.top + $m.height)
        if ($ax -gt $ix -and $ay -gt $iy) {
          $area = ($ax - $ix) * ($ay - $iy)
          if ($area -gt $bestArea) { $bestArea = $area; $best = $m }
        }
      }
      if ($null -ne $best) {
        return @{
          left = $best.left; top = $best.top; width = $best.width; height = $best.height
          index = $best.index
          label = ('monitor ' + $best.index + '  ' + $best.width + 'x' + $best.height + ' @ ' + $best.left + ',' + $best.top)
        }
      }
    }
  }
  $pt = New-Object DshNative+POINT
  [void][DshNative]::GetCursorPos([ref] $pt)
  foreach ($m in $script:Mons) {
    if (Test-InRect $pt.X $pt.Y $m 0) {
      return @{
        left = $m.left; top = $m.top; width = $m.width; height = $m.height
        index = $m.index; label = ('monitor ' + $m.index + '  ' + $m.width + 'x' + $m.height + ' @ ' + $m.left + ',' + $m.top)
      }
    }
  }
  $m = $script:Mons[0]
  return @{
    left = $m.left; top = $m.top; width = $m.width; height = $m.height
    index = $m.index; label = ('fallback ' + $m.width + 'x' + $m.height)
  }
}

function Test-InRect([int] $x, [int] $y, $rect, [int] $pad) {
  if ($null -eq $rect) { return $false }
  return ($x -ge ($rect.left - $pad) -and $x -le ($rect.left + $rect.width + $pad) -and
          $y -ge ($rect.top - $pad) -and $y -le ($rect.top + $rect.height + $pad))
}

# --------------------------------------------------------------- annotation --
# Everything the model needs in order to trust a coordinate lives in the image:
# a normalized grid, a crosshair exactly on the resolved pixel, and a 3x inset of
# the neighbourhood. Reading a pixel NUMBER off a downscaled image is unreliable,
# so numbers are decorative; the crossing point and the inset are the evidence.

function New-FontPx([string] $name, [single] $size, [System.Drawing.FontStyle] $style) {
  return New-Object System.Drawing.Font ($name, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Draw-Label($g, [string] $text, [single] $x, [single] $y, $font, $brush, $back) {
  $size = $g.MeasureString($text, $font)
  $g.FillRectangle($back, $x - 2, $y - 1, $size.Width + 4, $size.Height + 2)
  $g.DrawString($text, $font, $brush, $x, $y)
}

function Save-Annotated {
  param(
    [System.Drawing.Bitmap] $Src,
    [string] $OutPath,
    [int] $TargetWidth = 1280,
    [bool] $Grid = $true,
    $Crosshair = $null,
    $Inset = $null,
    $Overlay = $null,
    [string] $CrosshairText = '',
    [string] $Label = '',
    [int] $CropX = 0,
    [int] $CropY = 0,
    [int] $CropW = 0,
    [int] $CropH = 0,
    [int] $Zoom = 1
  )
  if ($CropW -le 0) { $CropW = $Src.Width }
  if ($CropH -le 0) { $CropH = $Src.Height }

  # A zoom frame is already a crop: 1 image pixel must be 1 physical pixel times
  # the factor, so it is scaled UP with nearest-neighbour (crisp edges, no blur).
  if ($Zoom -gt 1) {
    $outW = [int][math]::Round($CropW * $Zoom)
    $outH = [int][math]::Round($CropH * $Zoom)
  } else {
    $outW = $TargetWidth
    if ($outW -gt $CropW) { $outW = $CropW }
    $outH = [int][math]::Round($CropH * $outW / $CropW)
  }
  if ($outW -lt 64) { $outW = 64 }
  if ($outH -lt 64) { $outH = 64 }

  $bmp = New-Object System.Drawing.Bitmap $outW, $outH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.Clear([System.Drawing.Color]::Black)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    if ($Zoom -gt 1) {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    } else {
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    }
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $srcRect = New-Object System.Drawing.Rectangle $CropX, $CropY, $CropW, $CropH
    $dstRect = New-Object System.Drawing.Rectangle 0, 0, $outW, $outH
    $g.DrawImage($Src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

    $font = New-FontPx 'Consolas' 13 ([System.Drawing.FontStyle]::Bold)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 245, 245, 245))
    $back = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(190, 0, 0, 0))
    $red = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 255, 60, 60)), 2
    $whitePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 255, 255, 255)), 3

    try {
      if ($Grid) {
        $gridPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)), 1
        try {
          for ($i = 1; $i -lt 10; $i++) {
            $gx = [single]($outW * $i / 10)
            $gy = [single]($outH * $i / 10)
            $g.DrawLine($gridPen, $gx, 0, $gx, $outH)
            $g.DrawLine($gridPen, 0, $gy, $outW, $gy)
          }
          for ($i = 0; $i -le 10; $i++) {
            $tx = [single]([math]::Min([math]::Max($outW * $i / 10 + 3, 2), $outW - 42))
            $ty = [single]([math]::Min([math]::Max($outH * $i / 10 + 2, 2), $outH - 20))
            if ($i -eq 0 -or $i -eq 5 -or $i -eq 10) {
              Draw-Label $g ("x=" + ($i / 10)) $tx 2 $font $white $back
              Draw-Label $g ("y=" + ($i / 10)) 2 $ty $font $white $back
            }
          }
        } finally { $gridPen.Dispose() }
      }

      if ($null -ne $Overlay) {
        $ox = [single](($Overlay.left - $CropX) * $outW / $CropW)
        $oy = [single](($Overlay.top - $CropY) * $outH / $CropH)
        $ow = [single]($Overlay.width * $outW / $CropW)
        $oh = [single]($Overlay.height * $outH / $CropH)
        $g.DrawRectangle($red, $ox, $oy, $ow, $oh)
        Draw-Label $g 'see-now float (always-on-top)' $ox ($oy + 3) $font $white $back
      }

      if ($null -ne $Crosshair) {
        $cx = [single](($Crosshair.x - $CropX) * $outW / $CropW)
        $cy = [single](($Crosshair.y - $CropY) * $outH / $CropH)
        $g.DrawEllipse($whitePen, $cx - 21, $cy - 21, 42, 42)
        $g.DrawEllipse($red, $cx - 20, $cy - 20, 40, 40)
        $g.DrawLine($whitePen, $cx - 34, $cy, $cx - 22, $cy)
        $g.DrawLine($whitePen, $cx + 22, $cy, $cx + 34, $cy)
        $g.DrawLine($whitePen, $cx, $cy - 34, $cx, $cy - 22)
        $g.DrawLine($whitePen, $cx, $cy + 22, $cx, $cy + 34)
        $g.DrawLine($red, $cx - 34, $cy, $cx - 22, $cy)
        $g.DrawLine($red, $cx + 22, $cy, $cx + 34, $cy)
        $g.DrawLine($red, $cx, $cy - 34, $cx, $cy - 22)
        $g.DrawLine($red, $cx, $cy + 22, $cx, $cy + 34)
        $chText = $CrosshairText
        if (-not $chText) { $chText = ("target x=" + $Crosshair.x + " y=" + $Crosshair.y) }
        Draw-Label $g $chText ($cx + 14) ($cy + 14) $font $white $back

        if ($null -ne $Inset) {
          $factor = [int] $Inset.factor
          if ($factor -lt 2) { $factor = 2 }
          # The inset is honest only if its crop is exactly box/factor pixels:
          # pick the box first, then let the crop size follow.
          $want = [int][math]::Min($outW * 0.28, 340)
          $boxW = $want - ($want % $factor)
          if ($boxW -lt (60 * $factor)) { $boxW = 60 * $factor }
          $size = [int]($boxW / $factor)
          $sx = [int]($Inset.x - [math]::Floor($size / 2))
          $sy = [int]($Inset.y - [math]::Floor($size / 2))
          if ($sx -lt 0) { $sx = 0 }
          if ($sy -lt 0) { $sy = 0 }
          if (($sx + $size) -gt $Src.Width) { $sx = [int]($Src.Width - $size) }
          if (($sy + $size) -gt $Src.Height) { $sy = [int]($Src.Height - $size) }
          if ($sx -lt 0) { $sx = 0 }
          if ($sy -lt 0) { $sy = 0 }
          $boxH = $boxW
          $insetBmp = New-Object System.Drawing.Bitmap $boxW, $boxH
          $ig = [System.Drawing.Graphics]::FromImage($insetBmp)
          try {
            $ig.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $ig.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $sr = New-Object System.Drawing.Rectangle $sx, $sy, $size, $size
            $dr = New-Object System.Drawing.Rectangle 0, 0, $boxW, $boxH
            $ig.DrawImage($Src, $dr, $sr, [System.Drawing.GraphicsUnit]::Pixel)
          } finally { $ig.Dispose() }
          # Put the inset in the corner the crosshair is furthest from, so it
          # never covers the thing it is magnifying.
          $dx = [int]($outW - $boxW - 12)
          $dy = [int]($outH - $boxH - 12)
          if ($Inset.x -gt ($Src.Width / 2)) { $dx = 12 }
          if ($Inset.y -gt ($Src.Height / 2)) { $dy = 12 }
          if ($dx -lt 4) { $dx = 4 }
          if ($dy -lt 4) { $dy = 4 }
          $g.DrawImage($insetBmp, $dx, $dy, $boxW, $boxH)
          $insetBmp.Dispose()
          $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 200, 40)), 2
          try { $g.DrawRectangle($borderPen, $dx, $dy, $boxW, $boxH) } finally { $borderPen.Dispose() }
          $icx = [single]($dx + $boxW * ($Crosshair.x - $sx) / $size)
          $icy = [single]($dy + $boxH * ($Crosshair.y - $sy) / $size)
          $g.DrawLine($red, $icx - 12, $icy, $icx + 12, $icy)
          $g.DrawLine($red, $icx, $icy - 12, $icx, $icy + 12)
          Draw-Label $g ($factor.ToString() + 'x zoom') ($dx + 4) ($dy + 4) $font $white $back
        }
      }

      if ($Label) {
        $band = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 0, 0))
        try { $g.FillRectangle($band, 0, $outH - 22, $outW, 22) } finally { $band.Dispose() }
        Draw-Label $g $Label 6 ($outH - 20) $font $white $back
      }
    } finally {
      $font.Dispose(); $white.Dispose(); $back.Dispose(); $red.Dispose(); $whitePen.Dispose()
    }
  } finally {
    $g.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  return @{ width = $outW; height = $outH }
}

# -------------------------------------------------------------------- frames --

function Get-OverlayRect([int] $pidValue) {
  if ($pidValue -le 0) { return $null }
  $info = [DshNative]::FindWindowByPid($pidValue)
  if ($null -eq $info) { return $null }
  return @{
    handle = $info.Handle
    left = $info.Left; top = $info.Top
    width = $info.Width; height = $info.Height
  }
}

function Get-Stamp { return (Get-Date).ToString('HH:mm:ss.fff') }

# ---------------------------------------------------------------------- plan --

function Invoke-Step($step, $region) {
  $kind = [string] $step.do
  $p = Resolve-Point $step.at $region
  switch ($kind) {
    'click' { Invoke-Click $p.x $p.y 'left' $false }
    'double' { Invoke-Click $p.x $p.y 'left' $true }
    'right' { Invoke-Click $p.x $p.y 'right' $false }
    'middle' { Invoke-Click $p.x $p.y 'middle' $false }
    'move' { [void][DshNative]::SetCursorPos($p.x, $p.y) }
    'scroll' {
      if ($null -ne $p) { [void][DshNative]::SetCursorPos($p.x, $p.y); Start-Sleep -Milliseconds 60 }
      $notches = [int] $step.wheel
      if ($notches -eq 0) { $notches = 3 }
      $unit = 120
      $code = 0x0800
      if ($notches -lt 0) { $unit = -120; $code = 0x0800 }
      for ($i = 0; $i -lt [math]::Abs($notches); $i++) {
        [DshNative]::mouse_event($code, 0, 0, [uint32]$unit, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 30
      }
    }
    'drag' {
      $to = Resolve-Point $step.to $region
      if ($null -eq $to) { throw 'drag needs a destination (to)' }
      [void][DshNative]::SetCursorPos($p.x, $p.y)
      Start-Sleep -Milliseconds 100
      [DshNative]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 90
      for ($k = 1; $k -le 6; $k++) {
        $mx = [int]($p.x + ($to.x - $p.x) * $k / 6)
        $my = [int]($p.y + ($to.y - $p.y) * $k / 6)
        [void][DshNative]::SetCursorPos($mx, $my)
        Start-Sleep -Milliseconds 40
      }
      [DshNative]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 80
    }
    'type' {
      $delay = 30
      if ($step.delayMs) { $delay = [int] $step.delayMs }
      Send-Unicode ([string] $step.text) $delay
      if ($step.enter) { Start-Sleep -Milliseconds 180; Send-Combo 'ENTER' 1 }
    }
    'key' {
      $repeat = 1
      if ($step.repeat) { $repeat = [int] $step.repeat }
      Send-Combo ([string] $step.keys) $repeat
    }
    'wait' {
      $ms = [int] $step.ms
      if ($ms -lt 1) { $ms = 300 }
      Start-Sleep -Milliseconds $ms
    }
    'focus' {
      $handle = 0
      if ($step.handle) { $handle = [int64] $step.handle }
      [void](Invoke-Focus ([string] $step.needle) $handle)
    }
    default { throw "unknown step kind: $kind" }
  }
  return $p
}

function Invoke-Plan($plan) {
  $warnings = @()
  $region = Resolve-Region $plan
  $regionW = [int] $region.width
  $regionH = [int] $region.height
  $overlay = Get-OverlayRect ([int] $plan.overlayPid)
  $overlayLocal = To-LocalRect $overlay $region
  $outDir = [string] $plan.outDir
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

  $label = [string] $plan.label
  $targetWidth = [int] $plan.targetWidth
  if ($targetWidth -le 0) { $targetWidth = 1280 }
  $zoomInset = [bool] $plan.zoomInset

  $capture = {
    param([int] $x, [int] $y, [int] $w, [int] $h)
    Capture-Screen $x $y $w $h
  }

  $beforeBmp = & $capture $region.left $region.top $regionW $regionH
  $beforeSig = Get-Signature $beforeBmp 64 40
  $cursorPt = New-Object DshNative+POINT
  [void][DshNative]::GetCursorPos([ref] $cursorPt)
  $foreground = [DshNative]::GetForegroundWindow()
  $fgRect = Get-WindowRectSafe $foreground
  $fg = @{ handle = $foreground.ToInt64(); title = (Get-WindowTitle $foreground) }

  $frames = New-Object System.Collections.ArrayList
  $stepResults = New-Object System.Collections.ArrayList
  $dodged = $false
  $hidden = $null
  $restored = $false
  $overall = @{ changed = 0; box = $null }

  try {
    if ($plan.crosshairBefore) {
      $chBefore = Resolve-Point $plan.crosshairBefore $region
    } elseif ($plan.steps -and $plan.steps.Count -gt 0) {
      $chBefore = Resolve-Point $plan.steps[0].at $region
    } else {
      $chBefore = $null
    }

    # Hide the float window only when a point really lands inside it: hiding it
    # for every click would make the user's view flicker for no reason.
    if ($plan.dodge -eq 'hide' -and $null -ne $overlay) {
      $hit = $false
      foreach ($st in $plan.steps) {
        $pt = Resolve-Point $st.at $region
        if ($null -ne $pt -and (Test-InRect $pt.x $pt.y $overlay 6)) { $hit = $true }
      }
      if ($hit) {
        $hidden = [IntPtr] $overlay.handle
        [void][DshNative]::ShowWindow($hidden, 0)
        Start-Sleep -Milliseconds 160
        $dodged = $true
      }
    }

    $shots = [string] $plan.shots
    if ($shots -ne 'none' -and $shots -ne 'after') {
      $p1 = Join-Path $outDir 'before.png'
      $optsBefore = @{
        Src = $beforeBmp; OutPath = $p1; TargetWidth = $targetWidth; Grid = $true
        Crosshair = (To-Local $chBefore $region); Inset = $null; Overlay = $overlayLocal
        CrosshairText = $(if ($null -ne $chBefore) { 'intended x=' + $chBefore.x + ' y=' + $chBefore.y } else { '' })
        Label = ('BEFORE ' + (Get-Stamp) + '  screen ' + $region.label)
      }
      $meta = Save-Annotated @optsBefore
      [void]$frames.Add(@{
        role = 'before'; path = $p1; width = $meta.width; height = $meta.height
        label = 'BEFORE'
      })
    }

    $prevSig = $beforeSig.cells
    $afterBmp = $beforeBmp
    $lastPoint = $null
    $settle = [int] $plan.settleMs
    if ($settle -lt 0) { $settle = 0 }
    $i = 0
    foreach ($st in $plan.steps) {
      $t0 = [DateTime]::Now
      $pt = Invoke-Step $st $region
      if ($null -ne $pt) { $lastPoint = $pt }
      Start-Sleep -Milliseconds $settle
      $shot = & $capture $region.left $region.top $regionW $regionH
      $sig = Get-Signature $shot 64 40
      $diff = Compare-Signature $prevSig $sig.cells 64 40 18
      $prevSig = $sig.cells
      if ($afterBmp -ne $beforeBmp) { $afterBmp.Dispose() }
      $afterBmp = $shot
      $ms = [int](([DateTime]::Now) - $t0).TotalMilliseconds
      [void]$stepResults.Add(@{
        i = $i; do = [string] $st.do
        x = $(if ($null -ne $pt) { $pt.x } else { $null })
        y = $(if ($null -ne $pt) { $pt.y } else { $null })
        changed = $diff.changed; ms = $ms
      })
      $i++
    }

    # Put the float back *before* the after frame: the model decides its next move
    # from that frame, and a window that silently vanished would mislead it. The
    # re-capture is the real final state, so the changed% compares like with like.
    if ($null -ne $hidden) {
      [void][DshNative]::ShowWindow($hidden, 4)
      Start-Sleep -Milliseconds 60
      if (-not [DshNative]::IsWindowVisible($hidden)) { [void][DshNative]::ShowWindow($hidden, 5) }
      Start-Sleep -Milliseconds 200
      $restored = $true
      $shotRestored = & $capture $region.left $region.top $regionW $regionH
      $sigRestored = Get-Signature $shotRestored 64 40
      if ($afterBmp -ne $beforeBmp) { $afterBmp.Dispose() }
      $afterBmp = $shotRestored
      $prevSig = $sigRestored.cells
    }

    $overall = Compare-Signature $beforeSig.cells $prevSig 64 40 18
    if ($plan.steps.Count -gt 0 -and $overall.changed -eq 0) {
      $warnings += 'nothing on screen changed since the first frame'
    }

    if ($shots -ne 'none') {
      $p2 = Join-Path $outDir 'after.png'
      $inset = $null
      $chLocal = To-Local $lastPoint $region
      if ($zoomInset -and $null -ne $chLocal) {
        $inset = @{ x = $chLocal.x; y = $chLocal.y; factor = 3 }
      }
      $optsAfter = @{
        Src = $afterBmp; OutPath = $p2; TargetWidth = $targetWidth; Grid = $true
        Crosshair = $chLocal; Inset = $inset; Overlay = $overlayLocal
        CrosshairText = $(if ($null -ne $lastPoint) { 'done x=' + $lastPoint.x + ' y=' + $lastPoint.y } else { '' })
        Label = ('AFTER ' + (Get-Stamp) + '  changed=' + $overall.changed)
      }
      $meta2 = Save-Annotated @optsAfter
      [void]$frames.Add(@{
        role = 'after'; path = $p2; width = $meta2.width; height = $meta2.height
        label = 'AFTER'
      })
    }
  } finally {
    if ($null -ne $hidden -and -not $restored) {
      [void][DshNative]::ShowWindow($hidden, 4)
      Start-Sleep -Milliseconds 60
      if (-not [DshNative]::IsWindowVisible($hidden)) { [void][DshNative]::ShowWindow($hidden, 5) }
      Start-Sleep -Milliseconds 120
    }
    if ($afterBmp -ne $beforeBmp) { $afterBmp.Dispose() }
    $beforeBmp.Dispose()
  }

  return @{
    ok = $true
    kind = 'act'
    screens = @($script:Mons)
    virtual = $script:Virtual
    region = $region
    screen = @{ width = $regionW; height = $regionH }
    cursor = @{ x = $cursorPt.X; y = $cursorPt.Y }
    foreground = $fg
    foregroundRect = $fgRect
    overlay = $overlay
    dodged = $dodged
    frames = @($frames)
    steps = @($stepResults)
    changed = $overall.changed
    changedBox = $overall.box
    blackScreen = ($beforeSig.max -lt 12)
    warnings = @($warnings)
  }
}

function Invoke-Look($plan) {
  $outDir = [string] $plan.outDir
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
  $region = Resolve-Region $plan
  $overlay = Get-OverlayRect ([int] $plan.overlayPid)
  $bmp = Capture-Screen $region.left $region.top $region.width $region.height
  try {
    $sig = Get-Signature $bmp 64 40
    $cursorPt = New-Object DshNative+POINT
    [void][DshNative]::GetCursorPos([ref] $cursorPt)
    $foreground = [DshNative]::GetForegroundWindow()
    $fgRect = Get-WindowRectSafe $foreground
    $ch = $null
    if ($plan.crosshair) { $ch = Resolve-Point $plan.crosshair $region }
    $chLocal = To-Local $ch $region
    $p1 = Join-Path $outDir 'look.png'
    $insetLook = $null
    if ($null -ne $chLocal) { $insetLook = @{ x = $chLocal.x; y = $chLocal.y; factor = 3 } }
    $optsLook = @{
      Src = $bmp; OutPath = $p1; TargetWidth = [int] $plan.targetWidth; Grid = $true
      Crosshair = $chLocal; Inset = $insetLook; Overlay = (To-LocalRect $overlay $region)
      CrosshairText = $(if ($null -ne $ch) { 'at x=' + $ch.x + ' y=' + $ch.y } else { '' })
      Label = ('LOOK ' + (Get-Stamp) + '  screen ' + $region.label)
    }
    $meta = Save-Annotated @optsLook
    return @{
      ok = $true
      kind = 'look'
      screens = @($script:Mons)
      virtual = $script:Virtual
      region = $region
      screen = @{ width = $region.width; height = $region.height }
      cursor = @{ x = $cursorPt.X; y = $cursorPt.Y }
      foreground = @{ handle = $foreground.ToInt64(); title = (Get-WindowTitle $foreground) }
      foregroundRect = $fgRect
      overlay = $overlay
      frames = @(@{ role = 'look'; path = $p1; width = $meta.width; height = $meta.height; label = 'LOOK' })
      blackScreen = ($sig.max -lt 12)
      warnings = @()
    }
  } finally { $bmp.Dispose() }
}

function Invoke-Zoom($plan) {
  $outDir = [string] $plan.outDir
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
  $region = Resolve-Region $plan
  $factor = [int] $plan.factor
  if ($factor -lt 2) { $factor = 2 }
  if ($factor -gt 8) { $factor = 8 }
  $size = [int] $plan.size
  if ($size -lt 80) { $size = 80 }
  if ($size -gt 1200) { $size = 1200 }

  $pt = Resolve-Point $plan.at $region
  if ($null -eq $pt) { throw 'zoom needs a point (at)' }
  # The crop lives inside the region, in region-local pixels.
  $lx = $pt.x - $region.left
  $ly = $pt.y - $region.top
  $sx = [int]($lx - [math]::Floor($size / 2))
  $sy = [int]($ly - [math]::Floor($size / 2))
  if ($sx -lt 0) { $sx = 0 }
  if ($sy -lt 0) { $sy = 0 }
  if (($sx + $size) -gt $region.width) { $sx = [int]($region.width - $size) }
  if (($sy + $size) -gt $region.height) { $sy = [int]($region.height - $size) }
  if ($sx -lt 0) { $sx = 0 }
  if ($sy -lt 0) { $sy = 0 }
  $chLocal = @{ x = $lx; y = $ly }

  $bmp = Capture-Screen $region.left $region.top $region.width $region.height
  try {
    $p1 = Join-Path $outDir 'zoom.png'
    $optsZoom = @{
      Src = $bmp; OutPath = $p1; Grid = $false; Crosshair = $chLocal; Inset = $null
      CrosshairText = ('at x=' + $pt.x + ' y=' + $pt.y)
      Label = ('ZOOM ' + $factor + 'x ' + $size + 'px @ ' + $pt.x + ',' + $pt.y + '  ' + (Get-Stamp))
      CropX = $sx; CropY = $sy; CropW = $size; CropH = $size; Zoom = $factor
    }
    $meta = Save-Annotated @optsZoom
    return @{
      ok = $true
      kind = 'zoom'
      screens = @($script:Mons)
      region = $region
      at = @{ x = $pt.x; y = $pt.y }
      crop = @{ x = ($sx + $region.left); y = ($sy + $region.top); width = $size; height = $size }
      factor = $factor
      frames = @(@{ role = 'zoom'; path = $p1; width = $meta.width; height = $meta.height; label = 'ZOOM' })
      warnings = @()
    }
  } finally { $bmp.Dispose() }
}

function Invoke-SeePlan($plan) {
  switch ([string] $plan.action) {
    'act' { return Invoke-Plan $plan }
    'look' { return Invoke-Look $plan }
    'zoom' { return Invoke-Zoom $plan }
    'probe' {
      $cursorPt = New-Object DshNative+POINT
      [void][DshNative]::GetCursorPos([ref] $cursorPt)
      $foreground = [DshNative]::GetForegroundWindow()
      $region = Resolve-Region $plan
      return @{
        ok = $true
        kind = 'probe'
        screens = @($script:Mons)
        virtual = $script:Virtual
        region = $region
        screen = @{ width = $script:ScreenW; height = $script:ScreenH }
        cursor = @{ x = $cursorPt.X; y = $cursorPt.Y }
        foreground = @{ handle = $foreground.ToInt64(); title = (Get-WindowTitle $foreground) }
        foregroundRect = (Get-WindowRectSafe $foreground)
        overlay = (Get-OverlayRect ([int] $plan.overlayPid))
        warnings = @()
      }
    }
    default { throw "unknown action: $($plan.action)" }
  }
}

$__PLAN__ = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PLAN_B64__')) | ConvertFrom-Json
$__RESULT__ = Invoke-SeePlan $__PLAN__
$__RESULT__ | ConvertTo-Json -Compress -Depth 10
`

/**
 * Run one see-act plan (capture / act+two frames / zoom) in a throwaway
 * PowerShell process and return its JSON reply.
 *
 * @param {object} plan - action plus its parameters.
 * @param {{timeoutMs?: number}} [options]
 */
export async function runSeePlan(plan, { timeoutMs = 60000 } = {}) {
  const planB64 = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')
  const script = PS_CORE.replace('__PLAN_B64__', planB64)

  // -EncodedCommand would push this past the ~32k command-line limit (the C#
  // block alone is large), so the script goes to a temp file. It is written as
  // UTF-8 WITH a BOM: Windows PowerShell 5.1 reads a BOM-less file as ANSI and
  // mangles every non-ASCII character in a window title (or in typed text).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-see-act-'))
  const scriptPath = path.join(dir, 'run.ps1')
  await fs.writeFile(scriptPath, `\uFEFF${script}`, 'utf8')

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, out, err) => {
          if (error) {
            const detail = String(err || out || error.message).trim().split(/\r?\n/).slice(-20).join(' ')
            reject(new Error(`see-act ${plan.action} failed: ${detail}`))
            return
          }
          resolve(out)
        },
      )
    })

    const text = String(stdout).trim()
    if (!text) throw new Error(`see-act ${plan.action} returned no output`)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < start) throw new Error(`see-act ${plan.action} returned non-JSON: ${text.slice(0, 300)}`)
    return JSON.parse(text.slice(start, end + 1))
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Screen metrics, cursor, foreground window and the see-now float rect. */
export function probeDesktop({ overlayPid = 0, screen = null, timeoutMs = 30000 } = {}) {
  return runSeePlan({ action: 'probe', overlayPid, screen }, { timeoutMs })
}

/** One annotated look at the screen. */
export function lookScreen({ outDir, targetWidth = 1280, crosshair = null, overlayPid = 0, screen = null, timeoutMs = 40000 }) {
  return runSeePlan({ action: 'look', outDir, targetWidth, crosshair, overlayPid, screen }, { timeoutMs })
}

/** A 1:1-cropped, factor-times magnified crop around a point. */
export function zoomScreen({ outDir, at, factor = 3, size = 320, screen = null, timeoutMs = 40000 }) {
  return runSeePlan({ action: 'zoom', outDir, at, factor, size, screen }, { timeoutMs })
}

/** Run a step plan in one process: before frame -> steps -> after frame. */
export function actOnScreen(plan, { timeoutMs = 90000 } = {}) {
  return runSeePlan({ action: 'act', ...plan }, { timeoutMs })
}
