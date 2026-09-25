param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Size = 256
)
$ErrorActionPreference = "Stop"

try {
  $resolvedPath = $Path

  # .lnk が Windowsストアアプリ（UWP/Appx、例：LINEやMicrosoft 365版PowerPoint）や
  # 「App実行エイリアス」（%LOCALAPPDATA%\Microsoft\WindowsApps\ 内の中身のない実体）を
  # 指している場合、TargetPathは実際のアイコンを持たない代理のパスになっており、
  # Electron標準のapp.getFileIcon()や、TargetPathをそのまま渡す方法では
  # 実アイコンを取得できず、汎用の「アイコンなしショートカット」画像になってしまう。
  #
  # 一方、エクスプローラーやスタートメニューに表示される「本物のアイコン」は、
  # ショートカット自体が持つ IconLocation プロパティ（アイコン専用のファイルパスと
  # インデックス）を参照して決まっていることが多い。TargetPathとは別に保持されている
  # ため、まずこちらを最優先で調べ、実在するファイルであればそちらを使う。
  if ($Path -match '\.lnk$') {
    $wshell = New-Object -ComObject WScript.Shell
    $sc = $wshell.CreateShortcut($Path)
    $target = $sc.TargetPath
    $args = $sc.Arguments
    $iconLoc = $sc.IconLocation

    $iconFile = $null
    $iconIndex = 0
    if ($iconLoc) {
      $parts = $iconLoc.Split(",")
      $candidate = $parts[0].Trim()
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $iconFile = $candidate
        if ($parts.Length -gt 1) { [void][int]::TryParse($parts[1].Trim(), [ref]$iconIndex) }
      }
    }

    if ($iconFile) {
      $resolvedPath = $iconFile
    } elseif ($target -match 'explorer\.exe$' -and $args -match 'shell:AppsFolder\\(.+)$') {
      $resolvedPath = "shell:AppsFolder\" + $matches[1]
    } elseif ($target -and (Test-Path -LiteralPath $target -PathType Leaf) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      # LINEやMicrosoft 365アプリなどでよく見られる「App実行エイリアス」
      # （%LOCALAPPDATA%\Microsoft\WindowsApps\ 内にある、中身が空の代理ファイル）を
      # 直接指しているケース。このファイル自体にはアイコン情報が無いため、
      # スタート画面に登録されているアプリ一覧（AUMID）から同名のアプリを探し、
      # 本来のパッケージアイコンに解決する。
      $stubName = [IO.Path]::GetFileNameWithoutExtension($target)
      $appMatch = $null
      try { $appMatch = Get-StartApps | Where-Object { $_.AppID -match [Regex]::Escape($stubName) } | Select-Object -First 1 } catch { }
      if ($appMatch) { $resolvedPath = "shell:AppsFolder\" + $appMatch.AppID } else { $resolvedPath = $target }
    } elseif ($target) {
      $resolvedPath = $target
    }
  }

  # ショートカット経由かどうかに関わらず、最終的な解決先が
  # 「App実行エイリアス」（中身の無い代理exe）そのものだった場合は、
  # ここでもう一度、同じ考え方でパッケージの本来のアイコンに解決し直す。
  if ((Test-Path -LiteralPath $resolvedPath -PathType Leaf) -and ((Get-Item -LiteralPath $resolvedPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $stubName2 = [IO.Path]::GetFileNameWithoutExtension($resolvedPath)
    $appMatch3 = $null
    try { $appMatch3 = Get-StartApps | Where-Object { $_.AppID -match [Regex]::Escape($stubName2) } | Select-Object -First 1 } catch { }
    if ($appMatch3) { $resolvedPath = "shell:AppsFolder\" + $appMatch3.AppID }
  }

  Add-Type -ReferencedAssemblies "System.Drawing.dll" -Language CSharp -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;

public class IconExtractor {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    int GetImage(SIZE size, int flags, out IntPtr phbm);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct SIZE { public int cx; public int cy; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);

  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr hIcon);

  public static string GetIconBase64(string path, int size) {
    Guid guid = typeof(IShellItemImageFactory).GUID;
    IShellItemImageFactory factory;
    int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref guid, out factory);
    if (hr != 0) throw new Exception("SHCreateItemFromParsingName failed: 0x" + hr.ToString("X"));

    SIZE sz = new SIZE();
    sz.cx = size;
    sz.cy = size;
    IntPtr hbitmap;
    // SIIGBF_ICONONLY(0x4) | SIIGBF_BIGGERSIZEOK(0x1)
    int hr2 = factory.GetImage(sz, 0x5, out hbitmap);
    if (hr2 != 0 || hbitmap == IntPtr.Zero) throw new Exception("GetImage failed: 0x" + hr2.ToString("X"));

    try {
      using (Bitmap bmp = Bitmap.FromHbitmap(hbitmap)) {
        using (MemoryStream ms = new MemoryStream()) {
          bmp.Save(ms, ImageFormat.Png);
          return Convert.ToBase64String(ms.ToArray());
        }
      }
    } finally {
      DeleteObject(hbitmap);
    }
  }

  // ショートカットのIconLocationが「exeやdllの中のN番目のアイコン」を指しているとき用。
  // SHCreateItemFromParsingName経由では常に先頭（0番目）のアイコンしか取れないことがあるため、
  // 指定インデックスのアイコンをExtractIconExで直接取り出す。
  public static string GetIconByIndexBase64(string file, int index, int size) {
    IntPtr[] largeArr = new IntPtr[1];
    IntPtr[] smallArr = new IntPtr[1];
    ExtractIconEx(file, index, largeArr, smallArr, 1);
    IntPtr hIcon = largeArr[0] != IntPtr.Zero ? largeArr[0] : smallArr[0];
    if (hIcon == IntPtr.Zero) throw new Exception("ExtractIconEx failed");
    try {
      using (Icon ico = Icon.FromHandle(hIcon)) {
        using (Bitmap src = ico.ToBitmap()) {
          bool needResize = src.Width != size || src.Height != size;
          Bitmap outBmp = needResize ? new Bitmap(src, new Size(size, size)) : src;
          try {
            using (MemoryStream ms = new MemoryStream()) {
              outBmp.Save(ms, ImageFormat.Png);
              return Convert.ToBase64String(ms.ToArray());
            }
          } finally {
            if (needResize) outBmp.Dispose();
          }
        }
      }
    } finally {
      DestroyIcon(hIcon);
    }
  }
}
"@

  try {
    $b64 = [IconExtractor]::GetIconBase64($resolvedPath, $Size)
  } catch {
    # 通常の方法（0番目のアイコン）で失敗し、かつIconLocationが特定のインデックスを
    # 指定していた場合のみ、そのインデックスを直接抜き出す方法を試す。
    if ($iconFile -and $iconIndex -ne 0) {
      try { $b64 = [IconExtractor]::GetIconByIndexBase64($iconFile, $iconIndex, $Size) } catch { $b64 = $null }
    }
    if (-not $b64) {
      # 最後の手段：ここまでの方法がすべて失敗した場合、ショートカットの表示名
      # （ファイル名）でスタートメニューのアプリ一覧を検索し、一致するアプリの
      # 本来のアイコンに解決する。TargetPathやIconLocationの形式に関わらず、
      # 「アプリの表示名」さえ一致すれば拾えるための保険。
      if ($Path -match '\.lnk$') {
        $displayName = [IO.Path]::GetFileNameWithoutExtension($Path)
        $appMatch2 = $null
        try { $appMatch2 = Get-StartApps | Where-Object { $_.Name -eq $displayName -or $_.Name -like "*$displayName*" } | Select-Object -First 1 } catch { }
        if ($appMatch2) {
          try { $b64 = [IconExtractor]::GetIconBase64("shell:AppsFolder\" + $appMatch2.AppID, $Size) } catch { $b64 = $null }
        }
      }
      if (-not $b64) { throw }
    }
  }
  Write-Output $b64
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
