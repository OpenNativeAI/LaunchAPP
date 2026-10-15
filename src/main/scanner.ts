import { app } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'

export interface AppInfo {
  id: string
  name: string
  target: string
  args: string
  workdir: string
  lnk: string
  iconFile: string
}

const PS_SCRIPT = String.raw`
param([string]$IconDir, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $IconDir)) { New-Item -ItemType Directory -Path $IconDir | Out-Null }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinIcon {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    public static extern int SHDefExtractIconW(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr h);
}
"@

function Normalize-Icon([string]$png) {
    try {
        $tmp = New-Object System.Drawing.Bitmap $png
        $src = New-Object System.Drawing.Bitmap $tmp
        $tmp.Dispose()
        $w = $src.Width; $h = $src.Height
        $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
        for ($y = 0; $y -lt $h; $y++) {
            for ($x = 0; $x -lt $w; $x++) {
                if ($src.GetPixel($x, $y).A -gt 8) {
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }
        if ($maxX -lt 0) { $src.Dispose(); return }
        $bw = $maxX - $minX + 1
        $bh = $maxY - $minY + 1
        $canvas = 128
        $fill = [int]($canvas * 0.88)
        $scale = [Math]::Min(3.0, [Math]::Min($fill / $bw, $fill / $bh))
        $dw = [int][Math]::Round($bw * $scale)
        $dh = [int][Math]::Round($bh * $scale)
        $dx = [int](($canvas - $dw) / 2)
        $dy = [int](($canvas - $dh) / 2)
        $out = New-Object System.Drawing.Bitmap $canvas, $canvas, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($out)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.PixelOffsetMode = 'HighQuality'
        $destRect = New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh
        $srcRect = New-Object System.Drawing.Rectangle $minX, $minY, $bw, $bh
        $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose(); $src.Dispose()
        $out.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
    } catch { }
}

function Test-BlankPng([string]$path) {
    try {
        $img = [System.Drawing.Image]::FromFile($path)
        $bmp = New-Object System.Drawing.Bitmap $img
        $img.Dispose()
        for ($y = 0; $y -lt $bmp.Height; $y += 3) {
            for ($x = 0; $x -lt $bmp.Width; $x += 3) {
                if ($bmp.GetPixel($x, $y).A -gt 0) { $bmp.Dispose(); return $false }
            }
        }
        $bmp.Dispose()
        return $true
    } catch { return $false }
}

$sources = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
$lnks = foreach ($s in $sources) {
    if (Test-Path $s) { Get-ChildItem -LiteralPath $s -Filter *.lnk -Recurse }
}

$shell = New-Object -ComObject WScript.Shell
$apps = @()
$seen = @{}
foreach ($lnk in $lnks) {
    $sc = $shell.CreateShortcut($lnk.FullName)
    if ($null -eq $sc) { continue }
    $target = $sc.TargetPath
    if (-not $target -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    $name = $lnk.BaseName
    if ($name -match '(?i)uninstall|卸载|检查更新|更新程序|帮助|文档|说明|readme|license|注册|购买|官网|website|update|check for updates|^sample\s|示例') { continue }
    $key = "$target|$($sc.Arguments)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $apps += [pscustomobject]@{
        name         = $name
        target       = $target
        args         = $sc.Arguments
        workdir      = $sc.WorkingDirectory
        lnk          = $lnk.FullName
        iconLocation = $sc.IconLocation
        iconFile     = ''
    }
}
$apps = @($apps | Sort-Object { $_.name })
$total = $apps.Count
Write-Output "TOTAL $total"

$i = 0
foreach ($a in $apps) {
    $i++
    $iconPath = $a.target
    $iconIdx = 0
    if ($a.iconLocation -and $a.iconLocation -notmatch '^,') {
        $parts = $a.iconLocation -split ','
        $p = $parts[0].Trim()
        if ($p) {
            $iconPath = [Environment]::ExpandEnvironmentVariables($p)
            if ($parts.Count -gt 1 -and $parts[1].Trim() -match '^-?\d+$') { $iconIdx = [int]$parts[1].Trim() }
        }
    }
    $hash = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$iconPath|$iconIdx|n2"))).Replace('-','').ToLower()
    $png = Join-Path $IconDir "$hash.png"
    if ((Test-Path -LiteralPath $png) -and (Test-BlankPng $png)) { Remove-Item -LiteralPath $png }
    if (-not (Test-Path -LiteralPath $png)) {
        $big = [IntPtr]::Zero; $small = [IntPtr]::Zero
        $r = [WinIcon]::SHDefExtractIconW($iconPath, $iconIdx, 0, [ref]$big, [ref]$small, 128)
        if ($r -eq 0 -and $big -ne [IntPtr]::Zero) {
            $ico = [System.Drawing.Icon]::FromHandle($big)
            $bmp = $ico.ToBitmap()
            $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose(); $ico.Dispose()
            [WinIcon]::DestroyIcon($big) | Out-Null
        } elseif ($big -ne [IntPtr]::Zero) {
            [WinIcon]::DestroyIcon($big) | Out-Null
        }
        if (-not (Test-Path -LiteralPath $png) -or (Test-BlankPng $png)) {
            Remove-Item -LiteralPath $png -ErrorAction SilentlyContinue
            $ico2 = [System.Drawing.Icon]::ExtractAssociatedIcon($a.target)
            if ($null -ne $ico2) {
                $bmp2 = New-Object System.Drawing.Bitmap 64,64
                $g = [System.Drawing.Graphics]::FromImage($bmp2)
                $g.InterpolationMode = 'HighQualityBicubic'
                $g.DrawImage($ico2.ToBitmap(), 0, 0, 64, 64)
                $bmp2.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
                $g.Dispose(); $bmp2.Dispose(); $ico2.Dispose()
            }
        }
        if ((Test-Path -LiteralPath $png) -and (Test-BlankPng $png)) { Remove-Item -LiteralPath $png }
        if (Test-Path -LiteralPath $png) { Normalize-Icon $png }
    }
    if (Test-Path -LiteralPath $png) { $a.iconFile = "$hash.png" }
    Write-Output "PROGRESS $i $total $($a.name)"
}

ConvertTo-Json -InputObject @($apps) -Compress | Out-File -LiteralPath $OutFile -Encoding utf8
Write-Output 'DONE'
`

export function getIconsDir(): string {
  return join(app.getPath('userData'), 'data', 'icons')
}

function runScript(
  iconsDir: string,
  outFile: string,
  scriptPath: string,
  onTotal: (total: number) => void,
  onDone: (done: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, iconsDir, outFile],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let nl: number
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim()
        stdout = stdout.slice(nl + 1)
        if (line.startsWith('TOTAL ')) onTotal(parseInt(line.slice(6), 10) || 0)
        else if (line.startsWith('PROGRESS ')) {
          const parts = line.split(' ')
          onDone(parseInt(parts[1], 10) || 0)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `扫描脚本退出码 ${code}`))
    })
  })
}

export async function scanApps(onProgress: (done: number, total: number) => void): Promise<AppInfo[]> {
  const scriptPath = join(app.getPath('temp'), 'launchapp-scan.ps1')
  const outFile = join(app.getPath('temp'), 'launchapp-apps.json')
  const iconsDir = getIconsDir()
  // PowerShell 5.1 需要 UTF-8 BOM 才能正确解析脚本中的中文字符
  await fs.writeFile(scriptPath, '\uFEFF' + PS_SCRIPT, 'utf8')
  await fs.rm(outFile, { force: true })

  let total = 0
  await runScript(
    iconsDir,
    outFile,
    scriptPath,
    (t) => (total = t),
    (d) => onProgress(d, total)
  )

  const raw = (await fs.readFile(outFile, 'utf8')).replace(/^\uFEFF/, '')
  const list = (raw.trim() ? JSON.parse(raw) : []) as Array<Record<string, string>>
  return list.map((a, i) => ({
    id: `${i}-${a.iconFile || a.lnk}`,
    name: a.name,
    target: a.target,
    args: a.args || '',
    workdir: a.workdir || '',
    lnk: a.lnk,
    iconFile: a.iconFile || ''
  }))
}

export async function clearIconCache(): Promise<void> {
  await fs.rm(getIconsDir(), { recursive: true, force: true })
}
