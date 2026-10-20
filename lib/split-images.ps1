# Split an oversized image into OCR-sized tiles.
#
# Why: Windows OCR (Windows.Media.Ocr) refuses any image whose width or height
# exceeds OcrEngine.MaxImageDimension (10000 px) with
#   "Image dimensions are too large! Check MaxImageDimension..."
# Phone long screenshots (a whole word list stitched into one image) easily pass
# that limit, so we cut them into overlapping tiles before recognizing.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File split-images.ps1 ^
#       -Path in.png -OutDir C:\tmp\abc -Prefix shot-0 -OutFile out.json
#
# Output shape:
#   { "ok": true, "width": 1080, "height": 26000, "axis": "y",
#     "slices": [ { "file": "...\shot-0-000.png", "x": 0, "y": 0, "w": 1080, "h": 9760 }, ... ] }
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless it has a BOM, so non-ASCII characters here would be corrupted.

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Prefix = 'slice',
    [int]$MaxDim = 10000,
    [int]$Overlap = 240
)

$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-Result @{ ok = $false; error = 'FILE_NOT_FOUND' }
        exit 3
    }
    if (-not (Test-Path -LiteralPath $OutDir)) {
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }
    Add-Type -AssemblyName System.Drawing | Out-Null

    $img = [System.Drawing.Image]::FromFile($Path)
    try {
        $w = $img.Width
        $h = $img.Height
        if ($MaxDim -lt 128) { throw 'MaxDim too small' }

        # Cut along the axis that exceeds the limit (tall screenshots -> horizontal strips).
        if ($h -gt $MaxDim) {
            $axis = 'y'
            $total = $h
        } elseif ($w -gt $MaxDim) {
            $axis = 'x'
            $total = $w
        } else {
            Write-Result @{ ok = $true; width = $w; height = $h; axis = 'none'; slices = @() }
            exit 0
        }

        $step = $MaxDim - $Overlap
        if ($step -lt 1) { $step = $MaxDim }

        $slices = @()
        $offset = 0
        $i = 0
        while ($offset -lt $total) {
            $len = [Math]::Min($MaxDim, $total - $offset)
            $tw = if ($axis -eq 'y') { $w } else { $len }
            $th = if ($axis -eq 'y') { $len } else { $h }
            $sx = if ($axis -eq 'y') { 0 } else { $offset }
            $sy = if ($axis -eq 'y') { $offset } else { 0 }

            $dest = Join-Path $OutDir ('{0}-{1:000}.png' -f $Prefix, $i)
            $bmp = New-Object System.Drawing.Bitmap($tw, $th)
            try {
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try {
                    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $src = New-Object System.Drawing.Rectangle($sx, $sy, $tw, $th)
                    $dst = New-Object System.Drawing.Rectangle(0, 0, $tw, $th)
                    $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
                } finally {
                    $g.Dispose()
                }
                $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $bmp.Dispose()
            }

            $slices += @{ file = $dest; x = $sx; y = $sy; w = $tw; h = $th }
            if ($offset + $len -ge $total) { break }
            $offset += $step
            $i++
            if ($i -gt 200) { throw 'too many slices' }
        }
    } finally {
        $img.Dispose()
    }

    Write-Result @{ ok = $true; width = $w; height = $h; axis = $axis; slices = $slices }
    exit 0
} catch {
    Write-Result @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
