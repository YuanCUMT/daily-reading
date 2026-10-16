# Generates the PNG fixtures used by the OCR tests.
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File make-fixtures.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-Canvas($w, $h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = 'AntiAliasGridFit'
    return @($bmp, $g)
}

# ---- 1. Word card: one big word + small example sentences (simulates a Baicizhan card)
# Sized like a real phone screenshot (1080x2400-ish) so OCR behaves as it does in practice.
# The big word is deliberately misspelt the way OCR tends to get it wrong,
# so the "AI fix" path has something to repair.
$c = New-Canvas 1080 1920
$bmp = $c[0]; $g = $c[1]
$fBig = New-Object System.Drawing.Font 'Arial', 90, ([System.Drawing.FontStyle]::Bold)
$fMid = New-Object System.Drawing.Font 'Microsoft YaHei', 40
$fSmall = New-Object System.Drawing.Font 'Arial', 30
$g.DrawString('cautlous', $fBig, [System.Drawing.Brushes]::Black, 80, 620)
$g.DrawString('/kOs@s/', $fMid, [System.Drawing.Brushes]::Gray, 84, 780)
$g.DrawString([char]0x8C28 + [char]0x614E + [char]0x7684, $fMid, [System.Drawing.Brushes]::Black, 84, 870)
$g.DrawString('She was reluctant to lend money to strangers.', $fSmall, [System.Drawing.Brushes]::Gray, 84, 1040)
$g.DrawString('The harvest was modest this year.', $fSmall, [System.Drawing.Brushes]::Gray, 84, 1105)
$g.DrawString('baicizhan  3/12', $fSmall, [System.Drawing.Brushes]::Gray, 80, 90)
$g.Dispose()
$bmp.Save((Join-Path $out 'word-card.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote word-card.png"

# ---- 2. Word list: all words the same size (simulates a word-book list page)
$c = New-Canvas 1080 1920
$bmp = $c[0]; $g = $c[1]
$fList = New-Object System.Drawing.Font 'Arial', 60
$fTitle = New-Object System.Drawing.Font 'Microsoft YaHei', 36
$g.DrawString([char]0x6211 + [char]0x7684 + [char]0x5355 + [char]0x8BCD + [char]0x672C, $fTitle, [System.Drawing.Brushes]::Gray, 80, 90)
$words = @('abandon', 'procedure', 'reluctant', 'vivid', 'harvest', 'modest')
$y = 240
foreach ($w in $words) {
    $g.DrawString($w, $fList, [System.Drawing.Brushes]::Black, 80, $y)
    $y += 230
}
$g.Dispose()
$bmp.Save((Join-Path $out 'word-list.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote word-list.png"
