# gb-crm Windows login: issue a personal token with username/password, write to %USERPROFILE%\.gb-crm\credentials.json
#
# No repo clone needed (Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/login.ps1 | iex"
# Or download then run (more reliable):
#   curl.exe -fsSL http://<crm-host>/agent/login.ps1 -o $env:TEMP\gb-crm-login.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\gb-crm-login.ps1
#
# Non-interactive:
#   $env:GB_CRM_USERNAME='alice'; $env:GB_CRM_PASSWORD='***'; $env:GB_CRM_SCOPE='read'; iex ...
#
# Override base URL: $env:GB_CRM_BASE_URL
# Password is never written to disk or printed to stdout; token is never printed either.
# GB_CRM_INSECURE=1: skip TLS cert validation (escape hatch when local CA is missing; crypto risk is yours, fix CA if you can).
$ErrorActionPreference = "Stop"

# Load System.Net.Http explicitly: Windows PowerShell 5.1 does not auto-load the assembly,
# so [System.Net.Http.HttpClientHandler] / [System.Net.Http.HttpClient] fail with "Unable to find type".
Add-Type -AssemblyName System.Net.Http

$base = [string]$env:GB_CRM_BASE_URL
if (-not $base) { $base = "__GB_CRM_BASE_URL__" }
$base = $base.TrimEnd("/")

function Invoke-GbCrmLogin {
  $username = $env:GB_CRM_USERNAME
  if (-not $username) { $username = Read-Host "User name: " }

  $password = $env:GB_CRM_PASSWORD
  if (-not $password) {
    $secure = Read-Host "Password: " -AsSecureString
    $password = [System.Net.NetworkCredential]::new("", $secure).Password
  }

  $scope = $env:GB_CRM_SCOPE
  if (-not $scope) {
    $scope = Read-Host "Scope read / write [read]: "
    if (-not $scope) { $scope = "read" }
  }
  if ($scope -ne "read" -and $scope -ne "write") { throw "Scope must be read or write." }

  $name = $env:GB_CRM_TOKEN_NAME
  if (-not $name) { $name = $env:COMPUTERNAME }
  if (-not $name) { $name = "agent" }

  $payload = @{ username = $username; password = $password; scope = $scope; name = $name } | ConvertTo-Json -Compress

  # Use HttpClient so we can bypass the system proxy (localhost must not be routed through a proxy),
  # and optionally skip TLS cert validation via GB_CRM_INSECURE.
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  if ($env:GB_CRM_INSECURE -eq "1") {
    $handler.ServerCertificateCustomValidationCallback = [System.Net.Security.RemoteCertificateValidationCallback] { param($a, $b, $c, $d) return $true }
    Write-Host "WARNING: GB_CRM_INSECURE=1, TLS cert validation disabled." -ForegroundColor Yellow
  }
  $client = [System.Net.Http.HttpClient]::new($handler)
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/v1/auth/tokens")
  $req.Headers.UserAgent.ParseAdd("gb-crm-agent/1.0")
  $req.Headers.Accept.ParseAdd("application/json")
  $req.Content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, "application/json")

  try {
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  } catch {
    throw "Cannot connect to $base : $($_.Exception.Message)"
  }

  if (-not $resp.IsSuccessStatusCode) {
    $msg = $body
    try { $msg = [string]($body | ConvertFrom-Json).error.message } catch { }
    throw $msg
  }

  $data = ($body | ConvertFrom-Json).data
  $token = [string]$data.token
  if (-not $token) { throw "Token issuance response missing token" }

  $credDir = Join-Path $HOME ".gb-crm"
  New-Item -ItemType Directory -Force -Path $credDir | Out-Null
  $cred = @{ baseUrl = $base; token = $token; scope = [string]$data.scope; username = $username } | ConvertTo-Json
  $final = Join-Path $credDir "credentials.json"
  $tmp = Join-Path $credDir "credentials.json.tmp"
  # Must be BOM-less: PS 5.1 Set-Content -Encoding UTF8 writes a BOM, which breaks Python json.loads(utf-8)
  [System.IO.File]::WriteAllText($tmp, $cred, [System.Text.UTF8Encoding]::new($false))
  Move-Item -Path $tmp -Destination $final -Force

  # Windows has no 0600; best-effort tighten ACL to current user (warn only, do not abort)
  try {
    icacls $credDir /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    icacls $final /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
  } catch {
    Write-Host "WARNING: could not tighten ACL on credentials.json." -ForegroundColor Yellow
  }

  Write-Host "Wrote $final"
  Write-Host "Scope: $($data.scope)   Prefix: $($data.prefix)"
  Write-Host "Do not share the token with anyone or commit it to git. The skill will read this file."
}

Invoke-GbCrmLogin
