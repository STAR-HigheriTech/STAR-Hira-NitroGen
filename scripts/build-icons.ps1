#Requires -Version 5.1
<#
  图标资产一键重生成（默认素材源：HiraNG.png）

  源可以是任意尺寸的 PNG / JPG / BMP / ICO；ICO 会自动挑里面最大的那一帧作为母版。
  换 logo：更新根目录 HiraNG.png，或通过 -Source 指定其他 PNG/ICO，然后 pnpm icons:build。
  完整保留源图画布和底色，不做内容裁切或抠图。

  产出（全部由母版重采样，尺寸标准化，不再依赖源图是否齐档）：
    build/icon.ico                  多 DPI ICO（16/20/24/32/40/48/64/96/128/256）
    build/installerIcon.ico         同 icon.ico（NSIS 安装器图标）
    build/uninstallerIcon.ico       同 icon.ico（卸载器图标）
    build/installerHeaderIcon.ico   同 icon.ico（安装向导页眉小图标 / SpiderBanner）
    build/installerSidebar.bmp      164x314 24bpp（欢迎页 + 完成页 + 卸载页侧栏）
    build/installerHeader.bmp       150x57  24bpp（中间步骤页页眉右侧图）

  用法：pnpm icons:build
        pnpm icons:build -Source D:\my-icon.png
#>
param(
  [string]$Source,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class HiraIcoEncoder
{
    public static int[] FindVisibleBounds(Bitmap bitmap)
    {
        BitmapData data = bitmap.LockBits(
            new Rectangle(0, 0, bitmap.Width, bitmap.Height),
            ImageLockMode.ReadOnly,
            PixelFormat.Format32bppArgb
        );
        int minX = bitmap.Width;
        int minY = bitmap.Height;
        int maxX = -1;
        int maxY = -1;
        try
        {
            byte[] pixels = new byte[data.Stride * data.Height];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
            for (int y = 0; y < bitmap.Height; y++)
            {
                int row = y * data.Stride;
                for (int x = 0; x < bitmap.Width; x++)
                {
                    if (pixels[row + x * 4 + 3] == 0) continue;
                    minX = Math.Min(minX, x);
                    minY = Math.Min(minY, y);
                    maxX = Math.Max(maxX, x);
                    maxY = Math.Max(maxY, y);
                }
            }
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
        return new int[] { minX, minY, maxX, maxY };
    }

    public static byte[] ToDibFrame(Bitmap bitmap)
    {
        if (bitmap.Width != bitmap.Height) throw new ArgumentException("Icon frames must be square.");
        int size = bitmap.Width;
        int pixelBytes = size * size * 4;
        int maskStride = ((size + 31) / 32) * 4;
        int imageBytes = pixelBytes + maskStride * size;
        BitmapData data = bitmap.LockBits(
            new Rectangle(0, 0, size, size),
            ImageLockMode.ReadOnly,
            PixelFormat.Format32bppArgb
        );

        try
        {
            using (MemoryStream stream = new MemoryStream(40 + imageBytes))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((uint)40);
                writer.Write(size);
                writer.Write(size * 2);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write((uint)0);
                writer.Write((uint)imageBytes);
                writer.Write(0);
                writer.Write(0);
                writer.Write((uint)0);
                writer.Write((uint)0);

                byte[] row = new byte[size * 4];
                for (int y = size - 1; y >= 0; y--)
                {
                    IntPtr source = new IntPtr(data.Scan0.ToInt64() + y * data.Stride);
                    Marshal.Copy(source, row, 0, row.Length);
                    writer.Write(row);
                }
                writer.Write(new byte[maskStride * size]);
                writer.Flush();
                return stream.ToArray();
            }
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }
}
'@

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'build' }

if (-not $Source) {
  $preferred = Join-Path $root 'HiraNG.png'
  $Source = if (Test-Path -LiteralPath $preferred) { $preferred } else { Join-Path $OutDir 'icon.ico' }
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "找不到素材源：$Source（把 HiraNG.png 放在根目录，或用 -Source 指定 PNG/ICO）"
  }
}
if (-not (Test-Path -LiteralPath $Source)) { throw "找不到源图：$Source" }

# 品牌色（与安装向导位图保持一致）
$BrandFrom = [System.Drawing.ColorTranslator]::FromHtml('#0B4DFF')
$BrandTo   = [System.Drawing.ColorTranslator]::FromHtml('#1486FF')

$CanonicalSizes = 16, 20, 24, 32, 40, 48, 64, 96, 128, 256

# ── 0. 读取母版（ICO 取最大帧；全部读进内存，避免锁文件 / 覆盖自身）──────
function Read-IcoFrames {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 6 -or $bytes[0] -ne 0 -or $bytes[1] -ne 0 -or $bytes[2] -ne 1 -or $bytes[3] -ne 0) {
    throw "不是合法的 ICO 文件：$Path"
  }
  $count = [BitConverter]::ToUInt16($bytes, 4)
  $frames = @()
  for ($i = 0; $i -lt $count; $i++) {
    $o = 6 + 16 * $i
    $w = if ($bytes[$o] -eq 0) { 256 } else { [int]$bytes[$o] }
    $h = if ($bytes[$o + 1] -eq 0) { 256 } else { [int]$bytes[$o + 1] }
    $frames += [pscustomobject]@{
      Width  = $w
      Height = $h
      Bpp    = [BitConverter]::ToUInt16($bytes, $o + 6)
      Length = [BitConverter]::ToUInt32($bytes, $o + 8)
      Offset = [BitConverter]::ToUInt32($bytes, $o + 12)
      IsPng  = $false
    }
  }
  foreach ($f in $frames) {
    $f.IsPng = ($bytes[$f.Offset] -eq 0x89 -and $bytes[$f.Offset + 1] -eq 0x50 -and $bytes[$f.Offset + 2] -eq 0x4E)
  }
  return @{ Bytes = $bytes; Frames = $frames }
}

$ext = [System.IO.Path]::GetExtension($Source).ToLowerInvariant()
$srcBitmap = $null

if ($ext -eq '.ico') {
  $ico = Read-IcoFrames $Source
  Write-Host "[build-icons] 源 ICO 条目："
  foreach ($f in ($ico.Frames | Sort-Object Width)) {
    Write-Host ("  {0,3}x{1,-3} {2}bpp {3} {4,7} bytes" -f $f.Width, $f.Height, $f.Bpp, $(if ($f.IsPng) { 'PNG' } else { 'BMP' }), $f.Length)
  }
  $maxSide = ($ico.Frames | Measure-Object -Property Width -Maximum).Maximum
  if ($maxSide -lt 256) { Write-Warning "源 ICO 最大只有 ${maxSide}px，放大到 256 会变软，建议换 512px 以上的母版。" }

  $best = $ico.Frames | Sort-Object @{ Expression = { $_.Width * $_.Height }; Descending = $true }, @{ Expression = { $_.IsPng }; Descending = $true } | Select-Object -First 1
  if ($best.IsPng) {
    $blob = New-Object byte[] $best.Length
    [Array]::Copy($ico.Bytes, [int]$best.Offset, $blob, 0, [int]$best.Length)
    $ms0 = New-Object System.IO.MemoryStream(, $blob)
    $img0 = [System.Drawing.Image]::FromStream($ms0, $true, $true)
    $srcBitmap = New-Object System.Drawing.Bitmap($img0)
    $img0.Dispose(); $ms0.Dispose()
  }
  else {
    $icoObj = New-Object System.Drawing.Icon($Source, $best.Width, $best.Height)
    $srcBitmap = $icoObj.ToBitmap()
    $icoObj.Dispose()
  }

}
else {
  $raw = [System.IO.File]::ReadAllBytes($Source)
  $ms0 = New-Object System.IO.MemoryStream(, $raw)
  $img0 = [System.Drawing.Image]::FromStream($ms0, $true, $true)
  $srcBitmap = New-Object System.Drawing.Bitmap($img0)
  $img0.Dispose(); $ms0.Dispose()
}

Write-Host "[build-icons] 母版：$Source ($($srcBitmap.Width)x$($srcBitmap.Height))"

function Remove-TransparentBorder {
  param([System.Drawing.Bitmap]$Bitmap)

  $bounds = [HiraIcoEncoder]::FindVisibleBounds($Bitmap)
  $left = $bounds[0]
  $top = $bounds[1]
  $right = $bounds[2]
  $bottom = $bounds[3]
  if ($right -lt $left -or $bottom -lt $top) { return $Bitmap }
  if ($left -eq 0 -and $top -eq 0 -and $right -eq $Bitmap.Width - 1 -and $bottom -eq $Bitmap.Height - 1) {
    return $Bitmap
  }

  $width = $right - $left + 1
  $height = $bottom - $top + 1
  $cropped = New-Object System.Drawing.Bitmap(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $cropped.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($cropped)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.DrawImage(
    $Bitmap,
    (New-Object System.Drawing.Rectangle(0, 0, $width, $height)),
    $left,
    $top,
    $width,
    $height,
    [System.Drawing.GraphicsUnit]::Pixel
  )
  $g.Dispose()
  return $cropped
}

$masterBitmap = $srcBitmap
$srcBitmap = Remove-TransparentBorder $masterBitmap
if (-not [Object]::ReferenceEquals($masterBitmap, $srcBitmap)) {
  Write-Host "[build-icons] 去除透明外缘：$($masterBitmap.Width)x$($masterBitmap.Height) → $($srcBitmap.Width)x$($srcBitmap.Height)"
  $masterBitmap.Dispose()
}

function New-HighQualityGraphics {
  param([System.Drawing.Graphics]$G)
  $G.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $G.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $G.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $G.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $G.CompositingMode   = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $G.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
}

# 等比缩放，保持透明通道，避免边缘杂色（TileFlipXY）
function Resize-Png {
  param([System.Drawing.Image]$Src, [int]$Size)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($Src.Width -eq $Size) {
    # 同尺寸直接搬运，避免反复重采样导致逐次变软
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.DrawImageUnscaled($Src, 0, 0)
    $g.Dispose()
  }
  else {
    New-HighQualityGraphics $g
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $g.DrawImage($Src, $rect, 0, 0, $Src.Width, $Src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
    $attr.Dispose()
    $g.Dispose()
  }

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return , $ms.ToArray()
}

function Resize-IconBitmap {
  param([System.Drawing.Image]$Src, [int]$Size)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  if ($Src.Width -eq $Size -and $Src.Height -eq $Size) {
    $g.DrawImageUnscaled($Src, 0, 0)
  }
  else {
    New-HighQualityGraphics $g
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $g.DrawImage($Src, $rect, 0, 0, $Src.Width, $Src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
    $attr.Dispose()
  }
  $g.Dispose()
  return $bmp
}

# ── 1. 生成标准混合帧：高 DPI 小图用 DIB，256px 用 PNG ─────────────────
$blobs = @{}
foreach ($s in $CanonicalSizes) {
  if ($s -ge 256) {
    $blobs[$s] = Resize-Png $srcBitmap $s
  }
  else {
    $frameBitmap = Resize-IconBitmap $srcBitmap $s
    $blobs[$s] = [HiraIcoEncoder]::ToDibFrame($frameBitmap)
    $frameBitmap.Dispose()
  }
}

# ── 2. 打包 ICO（ICONDIR + n*ICONDIRENTRY + DIB/PNG 混合数据）────────────
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)                        # reserved
$bw.Write([uint16]1)                        # type = icon
$bw.Write([uint16]$CanonicalSizes.Count)    # count
$offset = 6 + 16 * $CanonicalSizes.Count
foreach ($s in $CanonicalSizes) {
  $b = $blobs[$s]
  $dim = if ($s -ge 256) { 0 } else { $s }  # 0 表示 256
  $bw.Write([byte]$dim)
  $bw.Write([byte]$dim)
  $bw.Write([byte]0)                        # colorCount
  $bw.Write([byte]0)                        # reserved
  $bw.Write([uint16]1)                      # planes
  $bw.Write([uint16]32)                     # bitCount
  $bw.Write([uint32]$b.Length)
  $bw.Write([uint32]$offset)
  $offset += $b.Length
}
foreach ($s in $CanonicalSizes) { $bw.Write($blobs[$s]) }
$bw.Flush()
$icoBytes = $ms.ToArray()
$bw.Dispose(); $ms.Dispose()

$icoPath = Join-Path $OutDir 'icon.ico'
[System.IO.File]::WriteAllBytes($icoPath, $icoBytes)
foreach ($alias in 'installerIcon.ico', 'uninstallerIcon.ico', 'installerHeaderIcon.ico') {
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir $alias), $icoBytes)
}

# ── 2b. 关于页品牌图标（PNG，256×256）──────────────────────────────────
# 真源仍然只有 build/icon.ico 一份 —— 这里把它的 256 帧字节原样写出，
# 内部页 `hira://shared/app-icon.png` 直接引用。
# 为什么不用 ICO：`<img src="*.ico">` 的多档帧选择由 Chromium 自己决定，
# 在 48px 显示尺寸下可能挑到 16px 那帧（糊），而 PNG 一次解码就是清晰的一张。
$appIconPath = Join-Path $root 'apps\app-main\src\pages\_shared\app-icon.png'
if (Test-Path -LiteralPath (Split-Path -Parent $appIconPath)) {
  [System.IO.File]::WriteAllBytes($appIconPath, $blobs[256])
  Write-Host "[build-icons] app-icon.png 256x256（关于页品牌区）"
}

# ── 3. NSIS 向导位图（必须 24bpp BMP）────────────────────────────────────
function New-Canvas {
  param([int]$Width, [int]$Height, [System.Drawing.Color]$Fill)
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $solid = New-Object System.Drawing.SolidBrush($Fill)
  $g.FillRectangle($solid, (New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)))
  $solid.Dispose()
  return @{ Bitmap = $bmp; Graphics = $g }
}

# 侧栏：品牌渐变底 + 装饰圆 + logo + 文案
$sidebar = New-Canvas 164 314 ([System.Drawing.Color]::White)
$sg = $sidebar.Graphics
$gradRect = New-Object System.Drawing.Rectangle(0, 0, 164, 314)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradRect, $BrandFrom, $BrandTo, 90.0)
$sg.FillRectangle($grad, $gradRect)
$grad.Dispose()
# 两枚半透明装饰圆（打破纯渐变的板正感）
$white26 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
$sg.FillEllipse($white26, -46, -34, 150, 150)
$sg.FillEllipse($white26, 96, 236, 110, 110)
$white26.Dispose()

# logo 96x96
$sg.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$attr = New-Object System.Drawing.Imaging.ImageAttributes
$attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
$sg.DrawImage($srcBitmap, (New-Object System.Drawing.Rectangle(34, 38, 96, 96)), 0, 0, $srcBitmap.Width, $srcBitmap.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)

# 文案：STAR Hira NitroGen + STAR HigheriTech（水平居中）
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$titleFont = New-Object System.Drawing.Font('Segoe UI Semibold', 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subFont   = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$subBrush   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(228, 236, 255))
$sg.DrawString('STAR Hira NitroGen', $titleFont, $titleBrush, (New-Object System.Drawing.RectangleF(0, 158, 164, 30)), $sf)
$sg.DrawString('STAR HigheriTech', $subFont, $subBrush, (New-Object System.Drawing.RectangleF(0, 194, 164, 20)), $sf)
$titleFont.Dispose(); $subFont.Dispose(); $titleBrush.Dispose(); $subBrush.Dispose()
$sg.Dispose()
$sidebar.Bitmap.Save((Join-Path $OutDir 'installerSidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$sidebar.Bitmap.Dispose()

# 页眉：纯白底 + 右对齐 40x40 logo
$header = New-Canvas 150 57 ([System.Drawing.Color]::White)
$hg = $header.Graphics
$hg.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$hg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$hg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$hg.DrawImage($srcBitmap, (New-Object System.Drawing.Rectangle(102, 8, 40, 40)), 0, 0, $srcBitmap.Width, $srcBitmap.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
$hg.Dispose()
$header.Bitmap.Save((Join-Path $OutDir 'installerHeader.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$header.Bitmap.Dispose()

$attr.Dispose()
$srcBitmap.Dispose()

Write-Host "[build-icons] icon.ico = $($icoBytes.Length) bytes ($($CanonicalSizes -join '/'))"
Write-Host "[build-icons] installerSidebar.bmp 164x314 24bpp"
Write-Host "[build-icons] installerHeader.bmp  150x57  24bpp"
