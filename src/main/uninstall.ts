// 真正的卸载：在注册表卸载项里找到应用的官方卸载程序并启动它，随后删掉开始菜单快捷方式。
// 找不到卸载信息（商店应用、绿色软件）时不删快捷方式，返回原因由界面提示。
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { app } from 'electron'
import { join } from 'path'

export interface UninstallResult {
  ok: boolean
  kind: 'win32' | 'store' | 'mssettings' | 'notfound' | 'failed'
  message: string
}

const PS_LOOKUP = String.raw`
param([string]$Lnk, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'
$res = $null
try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Lnk)
    $target = ''
    $name = (Get-Item -LiteralPath $Lnk).BaseName
    if ($sc) { $target = $sc.TargetPath }
    $tl = $target.ToLower()
    $nl = $name.ToLower()
    $res = @{ kind = 'notfound'; displayName = $name }

    if ($target -and $target -like '*\WindowsApps\*') {
        $res = @{ kind = 'store'; displayName = $name }
    } elseif ($target -match '\{([0-9A-Fa-f-]{36})\}') {
        $res = @{ kind = 'win32'; displayName = $name; uninstallString = ('MsiExec.exe /X{' + $matches[1] + '}') }
    } else {
        $roots = @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $hitB = $null; $hitC = $null; $hitD = $null
        foreach ($r in $roots) {
            Get-ItemProperty -Path $r | ForEach-Object {
                $p = $_.PSObject.Copy()
                if ($p.PSChildName -match '\$Bundle$') { return }
                $dn = $p.DisplayName
                if (-not $dn) { return }
                $us = $p.UninstallString
                if (-not $us) { $us = $p.QuietUninstallString }
                if (-not $us) { return }
                $ndl = $dn.ToLower()
                if ($ndl -eq $nl) { if (-not $hitB) { $hitB = @{ dn = $dn; us = $us } }; return }
                $di = $p.DisplayIcon
                if ($di) {
                    $dip = (($di -split ',')[0]).Trim('"').ToLower()
                    $dip = [Environment]::ExpandEnvironmentVariables($dip)
                    if ($tl -and $dip -eq $tl) { if (-not $hitC) { $hitC = @{ dn = $dn; us = $us } }; return }
                }
                if ($nl.Length -ge 4 -and ($ndl.Contains($nl) -or ($ndl.Length -ge 4 -and $nl.Contains($ndl)))) {
                    if (-not $hitD) { $hitD = @{ dn = $dn; us = $us } }
                }
            }
        }
        $best = $hitB; if (-not $best) { $best = $hitC }; if (-not $best) { $best = $hitD }
        if ($best) { $res = @{ kind = 'win32'; displayName = $best.dn; uninstallString = $best.us } }
    }
} catch {
    $res = @{ kind = 'failed'; message = $_.Exception.Message }
}
$res | ConvertTo-Json -Compress | Out-File -LiteralPath $OutFile -Encoding utf8
`

function runPsFile(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true }
    )
    let stderr = ''
    let stdout = ''
    child.stderr.setEncoding('utf8')
    child.stdout?.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (stderr += c))
    child.stdout?.on('data', (c: string) => (stdout += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error((stdout + stderr).trim() || `PowerShell 退出码 ${code}`))
    )
  })
}

interface Lookup {
  kind: string
  displayName?: string
  uninstallString?: string
  message?: string
}

async function lookup(lnk: string): Promise<Lookup> {
  const scriptPath = join(app.getPath('temp'), 'launchapp-lookup.ps1')
  const outFile = join(app.getPath('temp'), 'launchapp-lookup.json')
  await fs.writeFile(scriptPath, '\uFEFF' + PS_LOOKUP, 'utf8')
  await fs.rm(outFile, { force: true })
  await runPsFile(scriptPath, [lnk, outFile])
  const raw = (await fs.readFile(outFile, 'utf8')).replace(/^\uFEFF/, '')
  return JSON.parse(raw) as Lookup
}

const PS_RUN = String.raw`
param([string]$Raw)
$ErrorActionPreference = 'Stop'
$s = [Environment]::ExpandEnvironmentVariables($Raw.Trim())
$exe = ''
$rest = ''
try {
    if ($s -match '(?i)^\s*msiexec(\.exe)?(\s|$)') {
        $arg = ($s -replace '(?i)^\s*msiexec(\.exe)?\s*', '')
        if ($arg -notmatch '(?i)/x') {
            $arg = $arg -replace '(?i)/I', '/x'
            $arg = $arg -replace '(?i)/i(?=\s|$)', '/x'
        }
        Start-Process msiexec.exe -ArgumentList $arg
        exit 0
    }
    if ($s -match '^"') {
        $end = $s.IndexOf('"', 1)
        $exe = $s.Substring(1, $end - 1)
        $rest = $s.Substring($end + 1).Trim()
    } else {
        $m = [regex]::Match($s, '^(.*?\.(?:exe|com))(?:\s+(.*))?$', 'Singleline')
        if ($m.Success) {
            $exe = $m.Groups[1].Value
            if ($m.Groups[2].Success) { $rest = $m.Groups[2].Value }
        } else {
            $exe = $s
        }
    }
    if ($rest) { Start-Process -FilePath $exe -ArgumentList $rest }
    else { Start-Process -FilePath $exe }
    exit 0
} catch {
    $m = $_.Exception.Message
    if ($m -match '(?i)cancel') { Write-Output ('CANCELLED:' + $m); exit 2 }
    try {
        if ($rest) { Start-Process -FilePath $exe -ArgumentList $rest -Verb RunAs }
        else { Start-Process -FilePath $exe -Verb RunAs }
        exit 0
    } catch {
        Write-Output ('ERR:' + $_.Exception.Message)
        exit 1
    }
}
`

async function runUninstaller(raw: string): Promise<void> {
  const scriptPath = join(app.getPath('temp'), 'launchapp-uninstall.ps1')
  await fs.writeFile(scriptPath, '\uFEFF' + PS_RUN, 'utf8')
  await runPsFile(scriptPath, [raw])
}

export async function removeShortcut(lnk: string): Promise<void> {
  await fs.rm(lnk, { force: true })
}

export async function uninstallApp(appName: string, lnk: string): Promise<UninstallResult> {
  try {
    const found = await lookup(lnk)
    if (found.kind === 'win32' && found.uninstallString) {
      try {
        await runUninstaller(found.uninstallString)
      } catch (e) {
        return {
          ok: false,
          kind: 'failed',
          message: `卸载程序启动失败：${e instanceof Error ? e.message : String(e)}`
        }
      }
      await fs.rm(lnk, { force: true })
      const dn = found.displayName || appName
      return {
        ok: true,
        kind: 'win32',
        message: `已启动「${dn}」的官方卸载程序，请在弹出的窗口中完成卸载。图标已从启动器移除。`
      }
    }
    if (found.kind === 'store') {
      return {
        ok: false,
        kind: 'store',
        message: '这是 Microsoft Store 应用，请在「设置 → 应用 → 已安装的应用」中卸载。'
      }
    }
    return {
      ok: false,
      kind: 'notfound',
      message: `注册表中没有找到「${found.displayName || appName}」的卸载信息，它可能是绿色软件或脚本工具，没有官方卸载程序。图标已保留，可点「仅移除图标」只从启动器移除。`
    }
  } catch (e) {
    return {
      ok: false,
      kind: 'failed',
      message: `查找卸载信息失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
}
