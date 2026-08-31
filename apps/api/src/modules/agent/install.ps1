# gb-crm skill installer (Windows / PowerShell), served by the CRM server /agent/skill/gb-crm/install.ps1, intranet only, no GitHub needed.
# Steps: resolve target dirs (current AGENT project/user + codex global + claude global) -> download
#        SKILL.md + scripts/gb-crm.py to each -> prompt for authorization (username/password -> PAT).
# Security: the skill contains no secrets; credentials are written only to %USERPROFILE%\.gb-crm\credentials.json;
#           password is typed only in your terminal.
#
# Install (Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/skill/gb-crm/install.ps1 | iex"
# Or download then run (more reliable):
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

function Install-Skill {
  param([string]$target)
  $t = Join-Path $target "gb-crm"
  New-Item -ItemType Directory -Force -Path (Join-Path $t "scripts") | Out-Null
  # Overwrite = update: each rerun replaces with the latest SKILL.md / gb-crm.py from the server
  Invoke-WebRequest -UseBasicParsing -Uri "$skillBase/SKILL.md" -OutFile (Join-Path $t "SKILL.md")
  Invoke-WebRequest -UseBasicParsing -Uri "$skillBase/scripts/gb-crm.py" -OutFile (Join-Path $t "scripts\gb-crm.py")
  Write-Host "skill installed: $t"
}

$py = Resolve-Python
if (-not $py) {
  Write-Host "python3 / python / py not found. This skill needs Python 3; files are still installed, but the script will not run." -ForegroundColor Yellow
  Write-Host "Please install Python (https://www.python.org/downloads/ or Microsoft Store Python 3)." -ForegroundColor Yellow
}

# Current AGENT skill dir: project .agents/skills first (matches this AGENT inside the project), else user-level
$agentDir = if (Test-Path ".\.agents\skills") { ".\.agents\skills" } else { (Join-Path $HOME ".agents\skills") }

Write-Host "Downloading skill files from $base ..."
# Besides the current AGENT, also install into codex / claude global SKILL dirs for cross-agent reuse
Install-Skill $agentDir
Install-Skill (Join-Path $HOME ".codex\skills")
Install-Skill (Join-Path $HOME ".claude\skills")

$credFile = Join-Path $HOME ".gb-crm\credentials.json"
$skipLogin = $false
if ($env:GB_CRM_SKIP_LOGIN -eq "1") { $skipLogin = $true }
elseif ($env:GB_CRM_FORCE_LOGIN -eq "1") { $skipLogin = $false }
elseif (Test-Path $credFile) { $skipLogin = $true }

if ($skipLogin) {
  if ($env:GB_CRM_SKIP_LOGIN -eq "1") {
    Write-Host "Skipped authorization (GB_CRM_SKIP_LOGIN=1). Run it manually later: irm $base/agent/login.ps1 | iex"
  } else {
    Write-Host "Local credentials found, skipped authorization (update does not reissue a token). To reissue: set GB_CRM_FORCE_LOGIN=1 or delete $credFile and rerun."
  }
} else {
  Write-Host "Next: authorize in CRM (enter username/password) to get a local access token:"
  $loginTmp = Join-Path $env:TEMP "gb-crm-login-$PID.ps1"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/agent/login.ps1" -OutFile $loginTmp
    & $loginTmp
  } finally {
    Remove-Item -Path $loginTmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Done. Verify with:"
if ($py) {
  $verify = Join-Path $agentDir "gb-crm\scripts\gb-crm.py"
  Write-Host "  & '$py' '$verify' me"
} else {
  Write-Host "  After installing Python 3: python3 '$agentDir\gb-crm\scripts\gb-crm.py' me"
}
Write-Host "Tip: do not share %USERPROFILE%\.gb-crm\credentials.json with anyone / do not paste it into chat."
