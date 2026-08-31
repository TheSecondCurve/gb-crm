# gb-crm skill 安装器（Windows / PowerShell），由 CRM 服务器 /agent/skill/gb-crm/install.ps1 下发，仅需内网、不需 GitHub。
# 步骤：探测 AGENT 技能目录 → 下载 SKILL.md + scripts/gb-crm.py → 引导授权（用户名/密码 → PAT）。
# 安全：skill 不含任何密钥；凭证只写入 %USERPROFILE%\.gb-crm\credentials.json；密码只在你的终端里输入。
#
# 安装（Windows PowerShell）：
#   powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/skill/gb-crm/install.ps1 | iex"
# 或下载后运行（更稳）：
#   curl.exe -fsSL http://<crm-host>/agent/skill/gb-crm/install.ps1 -o $env:TEMP\gb-crm-install.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\gb-crm-install.ps1
$ErrorActionPreference = "Stop"

$base = [string]$env:GB_CRM_BASE_URL
if (-not $base) { $base = "__GB_CRM_BASE_URL__" }
$base = $base.TrimEnd("/")
$skillBase = "$base/agent/skill/gb-crm"

function Resolve-Python {
  foreach ($cmd in @("python3", "python", "py")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { return $cmd }
  }
  return $null
}

function Select-SkillDir {
  # 项目级 .agents/skills 优先（跟在项目里用这本 AGENT 一致），否则用户级
  if (Test-Path ".\.agents\skills") { return ".\.agents\skills" }
  foreach ($d in @(
    (Join-Path $HOME ".agents\skills")
    (Join-Path $HOME ".codex\skills")
    (Join-Path $HOME ".claude\skills")
    (Join-Path $HOME ".cursor\skills")
  )) {
    if (Test-Path $d) { return $d }
  }
  return (Join-Path $HOME ".agents\skills")
}

$py = Resolve-Python
if (-not $py) {
  Write-Host "未找到 python3 / python / py。本 skill 需要 Python 3，安装文件仍将继续，但脚本之后无法运行。" -ForegroundColor Yellow
  Write-Host "请安装 Python（https://www.python.org/downloads/ 或 Microsoft Store 中的 Python 3）。" -ForegroundColor Yellow
}

$dir = Select-SkillDir
$target = Join-Path $dir "gb-crm"
New-Item -ItemType Directory -Force -Path (Join-Path $target "scripts") | Out-Null

Write-Host "从 $base 下载 skill 文件到 $target ..."
# 覆盖即更新：每次重跑都会用服务端最新 SKILL.md / gb-crm.py 替换
Invoke-WebRequest -UseBasicParsing -Uri "$skillBase/SKILL.md" -OutFile (Join-Path $target "SKILL.md")
Invoke-WebRequest -UseBasicParsing -Uri "$skillBase/scripts/gb-crm.py" -OutFile (Join-Path $target "scripts\gb-crm.py")
Write-Host "skill 已安装：$target"

$credFile = Join-Path $HOME ".gb-crm\credentials.json"
$skipLogin = $false
if ($env:GB_CRM_SKIP_LOGIN -eq "1") { $skipLogin = $true }
elseif ($env:GB_CRM_FORCE_LOGIN -eq "1") { $skipLogin = $false }
elseif (Test-Path $credFile) { $skipLogin = $true }

if ($skipLogin) {
  if ($env:GB_CRM_SKIP_LOGIN -eq "1") {
    Write-Host "已按 GB_CRM_SKIP_LOGIN=1 跳过授权。之后请自行运行：irm $base/agent/login.ps1 | iex"
  } else {
    Write-Host "已检测到本机凭证，跳过授权（更新无需重发令牌）。如需重新授权：设置 GB_CRM_FORCE_LOGIN=1 或删除 $credFile 后重跑。"
  }
} else {
  Write-Host "接下来在 CRM 授权（输入用户名/密码），以领取本机可用的访问令牌："
  $loginTmp = Join-Path $env:TEMP "gb-crm-login-$PID.ps1"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/agent/login.ps1" -OutFile $loginTmp
    & $loginTmp
  } finally {
    Remove-Item -Path $loginTmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "完成。现在可验证："
if ($py) {
  Write-Host "  & '$py' '$target\scripts\gb-crm.py' me"
} else {
  Write-Host "  安装 Python 3 后运行: python3 '$target\scripts\gb-crm.py' me"
}
Write-Host "提示：不要把 %USERPROFILE%\.gb-crm\credentials.json 的内容发给任何人 / 不要写进对话。"
