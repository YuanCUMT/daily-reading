#Requires -Version 5.1
<#
.SYNOPSIS
    在桌面创建「每日阅读 · 考研英语」快捷方式。

.DESCRIPTION
    指向本项目的 start.cmd，工作目录设为项目目录，图标用项目里的 icon.ico
    （没有就现场生成）。项目换位置之后重新跑一次即可。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/install-shortcut.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = '每日阅读·考研英语'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$startCmd = Join-Path $root 'start.cmd'
if (-not (Test-Path -LiteralPath $startCmd)) {
    throw "找不到 start.cmd：$startCmd"
}

$icon = Join-Path $root 'icon.ico'
if (-not (Test-Path -LiteralPath $icon)) {
    $maker = Join-Path $PSScriptRoot 'make-icon.ps1'
    if (Test-Path -LiteralPath $maker) {
        Write-Host 'icon.ico 不存在，正在生成……'
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $maker
    }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop "$Name.lnk"

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($linkPath)
$lnk.TargetPath = $startCmd
$lnk.WorkingDirectory = $root
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Description = '用今天背的考研单词，生成一篇真题风格的阅读文章'
$lnk.Save()

Write-Host ''
Write-Host "  已创建快捷方式：$linkPath"
Write-Host "  目标：$startCmd"
Write-Host ''
Write-Host '  如果桌面上图标显示为白页，执行 ie4uinit.exe -show 再按 F5 刷新图标缓存。'
Write-Host ''
