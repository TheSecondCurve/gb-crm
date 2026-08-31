# gb-crm Windows 登录：用已有用户名/密码签发个人令牌，写入 %USERPROFILE%\.gb-crm\credentials.json
#
# 无需克隆仓库（Windows PowerShell）：
#   powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/login.ps1 | iex"
# 或下载后运行（更稳）：
#   curl.exe -fsSL http://<crm-host>/agent/login.ps1 -o $env:TEMP\gb-crm-login.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\gb-crm-login.ps1
#
# 非交互：
#   $env:GB_CRM_USERNAME='alice'; $env:GB_CRM_PASSWORD='***'; $env:GB_CRM_SCOPE='read'; iex ...
#
# 覆盖签发地址：$env:GB_CRM_BASE_URL
# 密码不明文落盘、不打印到 stdout；token 也不打印到 stdout。
# GB_CRM_INSECURE=1：跳过 TLS 证书校验（本机缺 CA 包时的逃生门；明文风险自担，能修证书就别开）。
$ErrorActionPreference = "Stop"

$base = [string]$env:GB_CRM_BASE_URL
if (-not $base) { $base = "__GB_CRM_BASE_URL__" }
$base = $base.TrimEnd("/")

function Invoke-GbCrmLogin {
  $username = $env:GB_CRM_USERNAME
  if (-not $username) { $username = Read-Host "用户名: " }

  $password = $env:GB_CRM_PASSWORD
  if (-not $password) {
    $secure = Read-Host "密码: " -AsSecureString
    $password = [System.Net.NetworkCredential]::new("", $secure).Password
  }

  $scope = $env:GB_CRM_SCOPE
  if (-not $scope) {
    $scope = Read-Host "范围 read / write [read]: "
    if (-not $scope) { $scope = "read" }
  }
  if ($scope -ne "read" -and $scope -ne "write") { throw "范围必须是 read 或 write。" }

  $name = $env:GB_CRM_TOKEN_NAME
  if (-not $name) { $name = $env:COMPUTERNAME }
  if (-not $name) { $name = "agent" }

  $payload = @{ username = $username; password = $password; scope = $scope; name = $name } | ConvertTo-Json -Compress

  # 走 HttpClient：能指定不走系统代理（防 localhost 被代理转走挂起），并支持按 GB_CRM_INSECURE 跳过证书校验
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  if ($env:GB_CRM_INSECURE -eq "1") {
    $handler.ServerCertificateCustomValidationCallback = [System.Net.Security.RemoteCertificateValidationCallback] { param($a, $b, $c, $d) return $true }
    Write-Host "警告: GB_CRM_INSECURE=1，已跳过 TLS 证书校验。" -ForegroundColor Yellow
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
    throw "无法连接 $base : $($_.Exception.Message)"
  }

  if (-not $resp.IsSuccessStatusCode) {
    $msg = $body
    try { $msg = [string]($body | ConvertFrom-Json).error.message } catch { }
    throw $msg
  }

  $data = ($body | ConvertFrom-Json).data
  $token = [string]$data.token
  if (-not $token) { throw "签发响应缺少 token" }

  $credDir = Join-Path $HOME ".gb-crm"
  New-Item -ItemType Directory -Force -Path $credDir | Out-Null
  $cred = @{ baseUrl = $base; token = $token; scope = [string]$data.scope; username = $username } | ConvertTo-Json
  $final = Join-Path $credDir "credentials.json"
  $tmp = Join-Path $credDir "credentials.json.tmp"
  # 必须无 BOM：PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，Python 的 json.loads(utf-8) 会解析失败
  [System.IO.File]::WriteAllText($tmp, $cred, [System.Text.UTF8Encoding]::new($false))
  Move-Item -Path $tmp -Destination $final -Force

  # Windows 无 0600；尽力收紧 ACL 到当前用户（失败仅提示，不中断）
  try {
    icacls $credDir /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
    icacls $final /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
  } catch {
    Write-Host "警告: 未能收紧 credentials.json 的 ACL。" -ForegroundColor Yellow
  }

  Write-Host "已写入 $final"
  Write-Host "范围: $($data.scope)  前缀: $($data.prefix)"
  Write-Host "请不要把 token 发给别人或写进 git。之后 skill 会读取该文件。"
}

Invoke-GbCrmLogin
