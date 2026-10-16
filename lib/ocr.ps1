# Local OCR using the OCR engine built into Windows (Windows.Media.Ocr).
# No network, no API key, no extra install.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ListB64 <base64> -OutFile out.json
#
#   -ListB64 : base64 of a JSON array of image paths. This is the primary input:
#              no temp file, no text encoding, no line-ending surprises.
#              (The old -ListFile mode is still accepted for compatibility and
#               auto-detects both the JSON-array and one-path-per-line formats,
#               so a stale Node process can never desync from this script.)
#   -OutFile : JSON result, written as UTF-8 without BOM
#
# Output shape:
#   { "ok": true, "bridge": 2, "engine": "zh-Hans-CN", "results": [ ... ] }
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless it has a BOM, so non-ASCII characters here would be corrupted.

param(
    [string]$ListB64 = '',
    [string]$ListFile = '',
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Lang = ''
)

$ErrorActionPreference = 'Stop'
$BRIDGE_VERSION = 2

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# Never call Path::GetFileName inside a catch block: it throws on paths that
# contain characters such as '"', which would mask the real error.
function Get-SafeName([string]$p) {
    if ([string]::IsNullOrEmpty($p)) { return 'unknown' }
    try { return [System.IO.Path]::GetFileName($p) } catch { return $p }
}

function ConvertTo-PathArray($parsed) {
    $out = @()
    foreach ($x in $parsed) {
        $s = [string]$x
        if ($s.Trim() -ne '') { $out += $s.Trim() }
    }
    return $out
}

function Read-ImageList {
    if ($ListB64 -and $ListB64.Trim() -ne '') {
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ListB64))
        return (ConvertTo-PathArray ($json | ConvertFrom-Json))
    }
    if ($ListFile -and (Test-Path -LiteralPath $ListFile)) {
        $raw = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8
        if ($null -ne $raw -and $raw.TrimStart().StartsWith('[')) {
            # legacy: Node used to write a JSON array
            return (ConvertTo-PathArray ($raw | ConvertFrom-Json))
        }
        $out = @()
        foreach ($line in ($raw -split "`r?`n")) {
            if ($line.Trim() -ne '') { $out += $line.Trim() }
        }
        return $out
    }
    return @()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

    # PowerShell 5.1 hands back __ComObject for WinRT async calls, so awaiting has to
    # go through System.WindowsRuntimeSystemExtensions.AsTask<T>().
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    if (-not $asTaskGeneric) { throw 'AsTask(IAsyncOperation<T>) not found' }

    function Await($operation, [Type]$resultType) {
        $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    $available = @()
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $available += $l.LanguageTag }

    $engine = $null
    if ($Lang) {
        try {
            $language = New-Object Windows.Globalization.Language $Lang
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        } catch { }
    }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) {
        foreach ($tag in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
            try {
                $language = New-Object Windows.Globalization.Language $tag
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
                if ($engine) { break }
            } catch { }
        }
    }
    if (-not $engine) {
        Write-Result @{ ok = $false; bridge = $BRIDGE_VERSION; error = 'NO_OCR_ENGINE'; available = $available }
        exit 2
    }

    $paths = Read-ImageList
    if ($paths.Count -eq 0) {
        Write-Result @{ ok = $false; bridge = $BRIDGE_VERSION; error = 'NO_IMAGES' }
        exit 3
    }

    $results = @()
    foreach ($p in $paths) {
        $name = Get-SafeName $p
        try {
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
                $results += @{ file = $name; error = 'FILE_NOT_FOUND'; path = $p }
                continue
            }
            $ext = ''
            try { $ext = [System.IO.Path]::GetExtension($p).ToLower() } catch { }
            if ($ext -eq '.heic' -or $ext -eq '.heif') {
                $results += @{ file = $name; error = 'HEIC_NOT_SUPPORTED'; path = $p }
                continue
            }

            $full = (Resolve-Path -LiteralPath $p).Path
            $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
            $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            try {
                $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
                $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
                $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
                $lines = @()
                foreach ($line in $ocr.Lines) {
                    $words = @()
                    foreach ($w in $line.Words) {
                        $r = $w.BoundingRect
                        $words += @{
                            t = $w.Text
                            x = [int]$r.X
                            y = [int]$r.Y
                            w = [int]$r.Width
                            h = [int]$r.Height
                        }
                    }
                    $lines += @{ text = $line.Text; words = $words }
                }
                $results += @{ file = $name; path = $full; lines = $lines; text = $ocr.Text; width = $decoder.PixelWidth; height = $decoder.PixelHeight }
            } finally {
                $stream.Dispose()
            }
        } catch {
            $msg = $_.Exception.Message
            if ($_.Exception.InnerException -and $_.Exception.InnerException.Message) {
                $msg = $msg + ' | ' + $_.Exception.InnerException.Message
            }
            $results += @{ file = $name; error = $msg; path = $p }
        }
    }

    Write-Result @{
        ok        = $true
        bridge    = $BRIDGE_VERSION
        engine    = $engine.RecognizerLanguage.LanguageTag
        available = $available
        results   = $results
    }
    exit 0
} catch {
    Write-Result @{ ok = $false; bridge = $BRIDGE_VERSION; error = $_.Exception.Message }
    exit 1
}
