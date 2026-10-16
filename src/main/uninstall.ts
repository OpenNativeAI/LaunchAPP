// 真正的卸载：先在注册表卸载项里按多种硬判据定位应用的官方卸载程序，
// 注册表全落空时再看应用自己目录里有没有卸载器；都没有就如实说明查过哪里。
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { app } from 'electron'
import { join } from 'path'

export interface UninstallPlan {
  /** win32=注册表卸载命令；local=应用目录里的卸载器；store=商店应用；notfound=确实查不到 */
  kind: 'win32' | 'store' | 'local' | 'notfound' | 'failed'
  /** 命中的注册表项 DisplayName（local/notfound 时为快捷方式名） */
  displayName: string
  /** 靠哪条判据命中的，给用户看清楚匹配依据 */
  how: string
  /** 将要执行的命令或卸载器完整路径 */
  cmd: string
  message: string
}

export interface UninstallResult {
  ok: boolean
  kind: UninstallPlan['kind']
  message: string
}

const PS_LOOKUP = String.raw`
param([string]$Lnk, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'
function NormDir([string]$s) {
    if (-not $s) { return '' }
    $x = [Environment]::ExpandEnvironmentVariables($s.Trim().Trim('"'))
    return $x.TrimEnd('\').ToLower()
}
function ExeOfUs([string]$u) {
    if (-not $u) { return '' }
    $s = [Environment]::ExpandEnvironmentVariables($u.Trim())
    if ($s.StartsWith('"')) {
        $e = $s.IndexOf('"', 1)
        if ($e -gt 1) { return $s.Substring(1, $e - 1) }
        return ''
    }
    $m = [regex]::Match($s, '(?i)^(.*?\.(?:exe))(?:\s|$)', 'Singleline')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}
$res = $null
try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Lnk)
    $name = (Get-Item -LiteralPath $Lnk).BaseName
    $target = ''
    if ($sc) { $target = [string]$sc.TargetPath }
    $tl = $target.ToLower()
    $nl = $name.ToLower()
    $dir = ''
    if ($target) { $dir = NormDir([string](Split-Path $target -Parent)) }
    $sysroot = NormDir([string]$env:SystemRoot)
    $isSystem = [bool]($dir -and $sysroot -and $dir.StartsWith($sysroot))
    $res = @{ kind = 'notfound'; displayName = $name; how = ''; cmd = '' }

    if ($target -and $target -like '*\WindowsApps\*') {
        $res = @{ kind = 'store'; displayName = $name; how = ''; cmd = '' }
    } elseif ($target -match '\{([0-9A-Fa-f-]{36})\}') {
        $res = @{ kind = 'win32'; displayName = $name; how = '快捷方式里的 MSI 产品码'; cmd = ('MsiExec.exe /X{' + $matches[1] + '}') }
    } elseif (-not $isSystem) {
        # 指向 System32 等系统目录的开始菜单项（注册表编辑器、任务管理器等）没有自己的卸载项，
        # 强行匹配只会撞上 Windows 组件，故整个跳过，让它们走 notfound。
        $roots = @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $best = $null
        $bestRank = 99
        foreach ($r in $roots) {
            Get-ItemProperty -Path $r | ForEach-Object {
                $p = $_.PSObject.Copy()
                if ($p.PSChildName -match '\$Bundle$') { return }
                $dn = [string]$p.DisplayName
                if (-not $dn) { return }
                $us = [string]$p.UninstallString
                if (-not $us) { $us = [string]$p.QuietUninstallString }
                if (-not $us) { return }
                $ndl = $dn.ToLower()
                $rank = 0
                $how = ''
                if ($ndl -eq $nl) { $rank = 1; $how = '注册表同名卸载项' }
                if ($rank -eq 0 -and $tl) {
                    $di = [string]$p.DisplayIcon
                    if ($di) {
                        $dip = NormDir((($di -split ',')[0]).Trim('"'))
                        if ($dip -eq $tl) { $rank = 2; $how = '注册表图标指向同一个程序' }
                    }
                }
                if ($rank -eq 0 -and $dir -and -not $isSystem) {
                    $il = NormDir([string]$p.InstallLocation)
                    if ($il -and ($il -eq $dir)) { $rank = 3; $how = '注册表安装目录与它相同' }
                    else {
                        $ue = ExeOfUs $us
                        if ($ue) {
                            $up = NormDir([string](Split-Path $ue -Parent))
                            if ($up -eq $dir) { $rank = 4; $how = '注册表卸载程序就在它所在目录' }
                        }
                    }
                }
                if ($rank -eq 0 -and $nl.Length -ge 4 -and (($ndl.Length -ge 4 -and $ndl.Contains($nl)) -or ($ndl.Length -ge 4 -and $nl.Contains($ndl)))) {
                    $rank = 5; $how = '名称近似匹配（请核对下面要运行的卸载程序）'
                }
                if ($rank -gt 0 -and $rank -lt $bestRank) {
                    $bestRank = $rank
                    $best = @{ dn = $dn; us = $us; how = $how }
                }
            }
        }
        if ($best) {
            $res = @{ kind = 'win32'; displayName = $best.dn; how = $best.how; cmd = $best.us }
        } elseif ($dir -and -not $isSystem -and (Test-Path -LiteralPath $dir)) {
            $cand = @(Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object { $_.BaseName -match '(?i)^(unins|uninstall|uninstaller|remove)' })
            if ($cand.Count -gt 0) {
                $leaf = (Split-Path $dir -Leaf).ToLower()
                $stem = $leaf
                if ($stem.Length -gt 4) { $stem = $stem.Substring(0, 4) }
                $pick = $null
                if ($stem) { $pick = @($cand | Where-Object { $_.BaseName.ToLower().Contains($stem) })[0] }
                if (-not $pick) { $pick = @($cand | Sort-Object -Property Length -Descending)[0] }
                $res = @{ kind = 'local'; displayName = $name; how = '它所在目录里的卸载器'; cmd = $pick.FullName }
            }
        }
    }
} catch {
    $res = @{ kind = 'failed'; displayName = ''; how = ''; cmd = ''; message = $_.Exception.Message }
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

interface RawLookup {
  kind: string
  displayName?: string
  how?: string
  cmd?: string
  message?: string
}

async function lookup(lnk: string): Promise<RawLookup> {
  const scriptPath = join(app.getPath('temp'), 'launchapp-lookup.ps1')
  const outFile = join(app.getPath('temp'), 'launchapp-lookup.json')
  await fs.writeFile(scriptPath, '\uFEFF' + PS_LOOKUP, 'utf8')
  await fs.rm(outFile, { force: true })
  await runPsFile(scriptPath, [lnk, outFile])
  const raw = (await fs.readFile(outFile, 'utf8')).replace(/\uFEFF+/, '')
  return JSON.parse(raw) as RawLookup
}

/** 在真正动手前先查清楚会运行什么，让确认弹窗能把依据写明白 */
export async function planUninstall(appName: string, lnk: string): Promise<UninstallPlan> {
  try {
    const f = await lookup(lnk)
    const kind = (['win32', 'store', 'local', 'failed'].includes(f.kind) ? f.kind : 'notfound') as
      | 'win32'
      | 'store'
      | 'local'
      | 'failed'
    if (kind === 'failed') {
      return {
        kind: 'failed',
        displayName: '',
        how: '',
        cmd: '',
        message: `查找卸载信息失败：${f.message || '未知错误'}`
      }
    }
    if (kind === 'store') {
      return {
        kind: 'store',
        displayName: appName,
        how: '',
        cmd: '',
        message: `「${appName}」是 Microsoft Store 应用，只能由系统卸载。点「打开系统设置」到「设置 → 应用」里卸载，或者只从启动器移除图标。`
      }
    }
    if (kind === 'local') {
      return {
        kind: 'local',
        displayName: appName,
        how: f.how || '',
        cmd: f.cmd || '',
        message: `注册表里没有它的卸载项，但它目录里有卸载器：\n${f.cmd}`
      }
    }
    return {
      kind: 'win32',
      displayName: f.displayName || appName,
      how: f.how || '',
      cmd: f.cmd || '',
      message: `匹配到「${f.displayName || appName}」的卸载命令`
    }
  } catch (e) {
    return {
      kind: 'failed',
      displayName: '',
      how: '',
      cmd: '',
      message: `查找卸载信息失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
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

export async function openAppsSettings(): Promise<void> {
  await shellOpen('ms-settings:appsfeatures')
}

async function shellOpen(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.unref()
    resolve()
  })
}

export async function uninstallApp(appName: string, lnk: string): Promise<UninstallResult> {
  const plan = await planUninstall(appName, lnk)
  if (plan.kind !== 'win32' && plan.kind !== 'local') {
    return {
      ok: false,
      kind: plan.kind === 'failed' ? 'failed' : 'notfound',
      message:
        plan.kind === 'notfound'
          ? `查过注册表三个卸载项和「${appName}」自己的安装目录，都没有它的卸载程序，它多半是绿色软件或系统组件。图标已保留，可点「仅移除图标」只从启动器移除。`
          : plan.message
    }
  }
  try {
    await runUninstaller(plan.cmd)
  } catch (e) {
    return {
      ok: false,
      kind: 'failed',
      message: `卸载程序启动失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
  await fs.rm(lnk, { force: true })
  const who = plan.kind === 'local' ? `${appName}（${plan.how}）` : plan.displayName
  return {
    ok: true,
    kind: plan.kind,
    message: `已按「${plan.how}」启动 ${who} 的卸载程序，请在弹出的窗口中完成卸载。图标已从启动器移除。`
  }
}
