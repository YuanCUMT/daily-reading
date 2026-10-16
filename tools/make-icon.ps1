# Generates icon.ico for the desktop shortcut.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/make-icon.ps1
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$icoPath = Join-Path $root 'icon.ico'
$previewPath = Join-Path $root 'test\icon-preview.png'

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $k = $size / 256.0

    # rounded square background (same accent red as the app)
    $pad = 5 * $k
    $r = 54 * $k
    $d = 2 * $r
    $x = $pad; $y = $pad; $w = $size - 2 * $pad; $h = $size - 2 * $pad
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 192, 83, 47))
    $g.FillPath($bg, $path)

    # open book: two white pages with the spine in the middle
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $cream = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 244, 230))

    $left = New-Object System.Drawing.Drawing2D.GraphicsPath
    $left.AddPolygon(@(
        (New-Object System.Drawing.PointF (52 * $k), (94 * $k)),
        (New-Object System.Drawing.PointF (124 * $k), (76 * $k)),
        (New-Object System.Drawing.PointF (124 * $k), (186 * $k)),
        (New-Object System.Drawing.PointF (52 * $k), (198 * $k))
    ))
    $g.FillPath($white, $left)

    $right = New-Object System.Drawing.Drawing2D.GraphicsPath
    $right.AddPolygon(@(
        (New-Object System.Drawing.PointF (204 * $k), (94 * $k)),
        (New-Object System.Drawing.PointF (132 * $k), (76 * $k)),
        (New-Object System.Drawing.PointF (132 * $k), (186 * $k)),
        (New-Object System.Drawing.PointF (204 * $k), (198 * $k))
    ))
    $g.FillPath($cream, $right)

    # a few text lines, only where they will actually be visible
    if ($size -ge 48) {
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 192, 83, 47)), (4.5 * $k)
        foreach ($i in 0..2) {
            $yy = (104 + $i * 26) * $k
            $g.DrawLine($pen, (66 * $k), ($yy + 8 * $k), (112 * $k), ($yy + 2 * $k))
            $g.DrawLine($pen, (144 * $k), ($yy + 2 * $k), (190 * $k), ($yy + 8 * $k))
        }
        $pen.Dispose()
    }

    $g.Dispose()
    return $bmp
}

# --- assemble a multi-size .ico ---
# Every entry is a classic DIB (BITMAPINFOHEADER + BGRA + AND mask) rather than a
# PNG. PNG entries are legal since Vista but not every shell code path reads them,
# and Explorer silently falls back to a generic document icon when it fails.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    if ($s -eq 256) { $bmp.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png) }

    $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $pixels = New-Object byte[] ($stride * $s)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    $bmp.UnlockBits($data)
    $bmp.Dispose()

    $maskRow = [math]::Floor(($s + 31) / 32) * 4   # 1bpp rows, padded to 4 bytes
    $maskSize = $maskRow * $s

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    # BITMAPINFOHEADER -- biHeight is doubled (XOR image + AND mask)
    $bw.Write([UInt32]40); $bw.Write([Int32]$s); $bw.Write([Int32]($s * 2))
    $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]0)
    $bw.Write([UInt32]($stride * $s)); $bw.Write([Int32]0); $bw.Write([Int32]0)
    $bw.Write([UInt32]0); $bw.Write([UInt32]0)
    # XOR image, bottom-up
    for ($y = $s - 1; $y -ge 0; $y--) { $bw.Write($pixels, $y * $stride, $stride) }
    # AND mask, all zero (alpha channel carries the shape)
    $bw.Write((New-Object byte[] $maskSize))
    $bw.Flush()
    $img = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()

    $entries += , @{ size = $s; data = $img }
}

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = if ($e.size -ge 256) { 0 } else { $e.size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$e.data.Length); $bw.Write([UInt32]$offset)
    $offset += $e.data.Length
}
foreach ($e in $entries) { $bw.Write($e.data) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
$bw.Dispose(); $out.Dispose()

Write-Host ("wrote {0} ({1} bytes, {2} sizes, DIB)" -f $icoPath, (Get-Item $icoPath).Length, $entries.Count)
Write-Host ("preview: {0}" -f $previewPath)
