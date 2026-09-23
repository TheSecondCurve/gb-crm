# gb-content workbench installer (Windows / PowerShell), served by the CRM server at
# /agent/workbench/install.ps1, intranet only. Same flow as install.sh:
#   authorize (reuses gb-crm %USERPROFILE%\.gb-crm\credentials.json, issues one if missing)
#   -> fetch latest manifest.tsv -> download each object + verify sha256 -> write to target dir.
# Daily updates afterwards do NOT rerun this script: run the sync script inside the target
# dir instead (or tell the agent on this computer to sync the workbench).
# Rerunning this script = force reinstall to the latest version (local changes are overwritten).
# Security: credentials exist only in %USERPROFILE%\.gb-crm\credentials.json; this script
# carries no secrets. Mode (755/644) is a POSIX exec bit, meaningless on Windows, ignored.
#
# Install (when remote script execution is allowed):
#   powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/workbench/install.ps1 | iex"
# Or download then run (when `irm ... | iex` is blocked by machine policy; a plain relative
# file name works from both cmd.exe and a PowerShell session, and C:\temp is NOT guaranteed
# to exist - from cmd.exe do NOT write $env:TEMP either, cmd passes it through literally):
#   powershell -Command "irm http://<crm-host>/agent/workbench/install.ps1 -OutFile gb-crm-workbench-install.ps1"
#   powershell -ExecutionPolicy Bypass -File gb-crm-workbench-install.ps1
# (skill installer uses gb-crm-skill-install.ps1 - distinct names, no overwrite)
#
# Target dir: first positional argument > GB_WORKBENCH_DIR > default under $HOME.
# GB_CRM_SKIP_LOGIN=1 skips authorization; GB_CRM_FORCE_LOGIN=1 forces a reissue;
# GB_CRM_INSECURE=1 skips TLS cert validation (escape hatch, same as login.ps1).
#
# This file must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# and a BOM breaks `irm | iex` (see auth/login-script.ts). The default dir name is Chinese,
# so it is written below as char code points instead of literal text.
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 does not auto-load this assembly (same as auth/login.ps1)
Add-Type -AssemblyName System.Net.Http

$base = [string]$env:GB_CRM_BASE_URL
if (-not $base) { $base = "__GB_CRM_BASE_URL__" }
$base = $base.TrimEnd("/")
$api = "$base/api/v1/workbench"

# Default target dir keeps the same Chinese folder name as install.sh (~/<workbench root>);
# code-point form keeps this file pure ASCII.
$defaultDirName = -join @(
  [char]0x95EA, [char]0x5149, [char]0x56E2, [char]0x961F,
  [char]0x5DE5, [char]0x4F5C, [char]0x53F0
)
$target = [string]$args[0]
if (-not $target) { $target = $env:GB_WORKBENCH_DIR }
if (-not $target) { $target = Join-Path $HOME $defaultDirName }

$credFile = Join-Path $HOME ".gb-crm\credentials.json"

if (Test-Path (Join-Path $target ".git")) {
  throw "$target is a git repository (a developer working copy); members must not install a snapshot into it."
}

# One HttpClient for every request: bypasses the system proxy (the intranet CRM host must
# not be routed through a corporate proxy) and supports GB_CRM_INSECURE.
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
if ($env:GB_CRM_INSECURE -eq "1") {
  $handler.ServerCertificateCustomValidationCallback = [System.Net.Security.RemoteCertificateValidationCallback] { param($a, $b, $c, $d) return $true }
  Write-Host "WARNING: GB_CRM_INSECURE=1, TLS cert validation disabled." -ForegroundColor Yellow
}
$client = [System.Net.Http.HttpClient]::new($handler)
$client.DefaultRequestHeaders.UserAgent.ParseAdd("gb-crm-agent/1.0")

function Get-GbBytes {
  param([string]$uri, [string]$token)
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $uri)
  if ($token) {
    $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $token)
  }
  $resp = $client.SendAsync($req).GetAwaiter().GetResult()
  $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  return @{ status = [int]$resp.StatusCode; body = $bytes }
}

# --- authorization (same SKIP / FORCE semantics as the skill installer) ---
$skipLogin = $false
if ($env:GB_CRM_SKIP_LOGIN -eq "1") { $skipLogin = $true }
elseif ($env:GB_CRM_FORCE_LOGIN -eq "1") { $skipLogin = $false }
elseif (Test-Path $credFile) { $skipLogin = $true }

if (-not $skipLogin) {
  Write-Host "Next: authorize in CRM (enter username/password) to get a local access token:"
  $loginTmp = Join-Path $env:TEMP "gb-crm-login-$PID.ps1"
  try {
    $dl = Get-GbBytes "$base/agent/login.ps1" $null
    if ($dl.status -ne 200) { throw "Cannot download the login script (HTTP $($dl.status)) from $base" }
    [System.IO.File]::WriteAllBytes($loginTmp, $dl.body)
    & $loginTmp
  } finally {
    Remove-Item -Path $loginTmp -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $credFile)) {
  throw "Missing $credFile (authorization not completed). Rerun this script, or authorize first: irm $base/agent/login.ps1 | iex"
}
# The token is used only inside this script; do not echo it or write it anywhere else.
$token = [string]([System.IO.File]::ReadAllText($credFile) | ConvertFrom-Json).token
if (-not $token) {
  throw "Cannot read a token from $credFile (format changed?) Re-authorize: irm $base/agent/login.ps1 | iex"
}

# --- fetch manifest.tsv (keep the status code to tell 401/404/network apart) ---
Write-Host "Fetching latest manifest from $base ..."
$m = Get-GbBytes "$api/manifest.tsv" $token
if ($m.status -eq 401 -or $m.status -eq 403) {
  throw "Credentials invalid or expired (HTTP $($m.status)). Re-authorize (irm $base/agent/login.ps1 | iex), then rerun this script."
}
if ($m.status -eq 404) {
  throw "No workbench version published on the server yet: a maintainer must run publish.sh in gb-content first."
}
if ($m.status -ne 200) {
  throw "Failed to fetch manifest (HTTP $($m.status)): check the network / server address and retry."
}

# The manifest is UTF-8 (paths contain Chinese); decode explicitly, never let PS 5.1 guess ANSI.
$manifestText = [System.Text.Encoding]::UTF8.GetString($m.body)
$meta = @{}
$dataLines = @()
foreach ($line in ($manifestText -split "`n")) {
  $line = $line.TrimEnd("`r")
  if ($line.Length -eq 0) { continue }
  if ($line.StartsWith("#")) {
    $tab = $line.IndexOf("`t")
    if ($tab -gt 0) { $meta[$line.Substring(1, $tab - 1)] = $line.Substring($tab + 1) }
  } else {
    $dataLines += $line
  }
}
if (-not $meta["version"]) {
  throw "Manifest carries no version info (no published version on the server?)"
}
$subjectPart = ""
if ($meta["subject"]) { $subjectPart = " ($($meta['subject']))" }
Write-Host "Latest version v$($meta['version'])$subjectPart, downloading $($dataLines.Count) files ..."

# --- download each object, verify sha256, write into the target dir ---
New-Item -ItemType Directory -Force -Path $target | Out-Null
$hasher = [System.Security.Cryptography.SHA256]::Create()
$count = 0
$fail = 0
foreach ($line in $dataLines) {
  # data row: sha <TAB> size <TAB> mode <TAB> path (server guarantees no tabs inside a path)
  $cols = $line -split "`t", 4
  if ($cols.Count -lt 4 -or -not $cols[3]) {
    Write-Host "[x] malformed manifest line: $line"
    $fail++
    continue
  }
  $sha = $cols[0].ToLower()
  $path = $cols[3]
  if ($sha -notmatch "^[0-9a-f]{64}$") {
    Write-Host "[x] malformed sha in manifest: $path"
    $fail++
    continue
  }
  $count++
  try {
    $obj = Get-GbBytes "$api/objects/$sha" $token
    if ($obj.status -ne 200) {
      Write-Host "[x] download failed (HTTP $($obj.status)): $path"
      $fail++
      continue
    }
    $got = [System.BitConverter]::ToString($hasher.ComputeHash($obj.body)).Replace("-", "").ToLower()
    if ($got -ne $sha) {
      Write-Host "[x] checksum mismatch: $path (rerun this script)"
      $fail++
      continue
    }
    $dest = Join-Path $target $path
    $parent = Split-Path -Parent $dest
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllBytes($dest, $obj.body)
  } catch {
    Write-Host "[x] download failed: $path ($($_.Exception.Message))"
    $fail++
  }
}

if ($fail -gt 0) {
  throw "Finished $($count - $fail)/$count files, $fail failed; rerun this script to resume."
}

# Local state consumed by the sync script; BOM-less UTF-8 + LF so awk on any platform reads it.
$stateDir = Join-Path $target ".gb-workbench"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $stateDir "manifest.tsv"), ($dataLines -join "`n") + "`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $stateDir "version"), "$($meta['version'])`n", $utf8)

Write-Host ""
Write-Host "Installed v$($meta['version']), $count files -> $target"
$syncPs1 = Get-ChildItem -LiteralPath $target -Recurse -Filter "sync.ps1" -File -ErrorAction SilentlyContinue | Select-Object -First 1
$syncSh = Get-ChildItem -LiteralPath $target -Recurse -Filter "sync.sh" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($syncPs1) {
  Write-Host "Daily update: powershell -ExecutionPolicy Bypass -File `"$($syncPs1.FullName)`" (or ask the agent on this computer to sync the workbench)."
} elseif ($syncSh) {
  Write-Host "Daily update: sh `"$($syncSh.FullName)`" (Git Bash / WSL), or ask the agent on this computer to sync the workbench."
} else {
  Write-Host "Daily update: ask the agent on this computer to sync the workbench."
}
Write-Host "Tip: do not share %USERPROFILE%\.gb-crm\credentials.json with anyone / do not paste it into chat."
