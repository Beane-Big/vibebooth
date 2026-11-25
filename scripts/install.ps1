# Vibebooth 一键安装与升级脚本（Windows PowerShell 5.1 / 7+）
#
# 支持两种运行方式：
#   1. 无需提前下载代码，直接在 PowerShell 中一条命令安装：
#      irm https://raw.githubusercontent.com/Beane-Big/vibebooth/main/scripts/install.ps1 | iex
#   2. 在已下载的仓库目录内运行：
#      powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# 脚本会自动完成：
#   1. 若尚未下载仓库，自动下载到 %USERPROFILE%\vibebooth（无需预装 Git）
#   2. 若尚未安装 Docker Desktop，自动通过 winget 或官方安装程序安装并拉起 Docker 引擎
#   3. 首次运行自动生成 .env（UTF-8 无 BOM）与随机强密码
#   4. 自动探测网络环境：国内网络自动配置 Go / npm 加速源
#   5. 优先拉取预构建镜像免编译启动；拉取失败自动切换本机源码构建

param(
    [switch]$FromSource,
    [switch]$Cn,
    [string]$Port = "",
    [string]$Dir = "",
    [switch]$NoAutoDocker
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $FromSource -and $env:VIBEBOOTH_FROM_SOURCE -eq "1") { $FromSource = $true }
if (-not $Cn -and $env:VIBEBOOTH_CN -eq "1") { $Cn = $true }
if ([string]::IsNullOrEmpty($Port) -and -not [string]::IsNullOrEmpty($env:VIBEBOOTH_PORT)) { $Port = $env:VIBEBOOTH_PORT }
if ([string]::IsNullOrEmpty($Dir)) {
    if (-not [string]::IsNullOrEmpty($env:VIBEBOOTH_DIR)) {
        $Dir = $env:VIBEBOOTH_DIR
    } else {
        $Dir = Join-Path $env:USERPROFILE "vibebooth"
    }
}

$RepoUrl = "https://github.com/Beane-Big/vibebooth.git"
$ZipUrl = "https://github.com/Beane-Big/vibebooth/archive/refs/heads/main.zip"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Test-UrlReachable {
    param([string]$Url, [int]$TimeoutSec = 4)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Timeout = $TimeoutSec * 1000
        $req.Method = "GET"
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        if ($_.Exception.Response -ne $null) {
            $code = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Close()
            if ($code -ge 200 -and $code -lt 500) {
                return $true
            }
        }
        return $false
    } catch {
        return $false
    }
}

function New-RandomPassword {
    param([int]$Length = 16)
    $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    $bytes = New-Object byte[] ($Length * 2)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $Length; $i++) {
        $idx = $bytes[$i] % $chars.Length
        [void]$sb.Append($chars[$idx])
    }
    return $sb.ToString()
}

function Get-EnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return "" }
    foreach ($line in [System.IO.File]::ReadAllLines($Path, $Utf8NoBom)) {
        if ($line -match "^$([regex]::Escape($Key))=(.*)$") {
            return $Matches[1].Trim()
        }
    }
    return ""
}

function Set-EnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path $Path) {
        foreach ($l in [System.IO.File]::ReadAllLines($Path, $Utf8NoBom)) {
            $lines.Add($l)
        }
    }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^$([regex]::Escape($Key))=") {
            $lines[$i] = "$Key=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) {
        $lines.Add("$Key=$Value")
    }
    $content = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($Path, $content, $Utf8NoBom)
}

function Invoke-Native {
    param([string]$File, [string[]]$ArgsList, [switch]$Silent)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($Silent) {
            & $File @ArgsList *> $null
        } else {
            & $File @ArgsList | Out-Host
        }
        $exitCode = $LASTEXITCODE
        return $exitCode
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 1. 定位或自动下载 Vibebooth 仓库目录
$RootDir = ""
if (-not [string]::IsNullOrEmpty($PSScriptRoot)) {
    $Candidate = Split-Path -Parent $PSScriptRoot
    if ((Test-Path (Join-Path $Candidate "docker-compose.yml")) -and (Test-Path (Join-Path $Candidate ".env.example"))) {
        $RootDir = $Candidate
    }
}

if ([string]::IsNullOrEmpty($RootDir)) {
    $Cwd = (Get-Location).Path
    if ((Test-Path (Join-Path $Cwd "docker-compose.yml")) -and (Test-Path (Join-Path $Cwd ".env.example"))) {
        $RootDir = $Cwd
    }
}

if ([string]::IsNullOrEmpty($RootDir)) {
    $RootDir = $Dir
    if (-not (Test-Path (Join-Path $RootDir "docker-compose.yml"))) {
        Write-Host "正在获取 Vibebooth 到 $RootDir ..." -ForegroundColor Cyan
        $downloaded = $false
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        if ($gitCmd) {
            $code = Invoke-Native -File "git" -ArgsList @("clone", "--depth", "1", $RepoUrl, $RootDir)
            if ($code -eq 0 -and (Test-Path (Join-Path $RootDir "docker-compose.yml"))) {
                $downloaded = $true
            } else {
                if (Test-Path $RootDir) { Remove-Item -Recurse -Force $RootDir -ErrorAction SilentlyContinue }
            }
        }
        if (-not $downloaded) {
            Write-Host "正在通过压缩包下载 Vibebooth..." -ForegroundColor Cyan
            $tmpZip = Join-Path $env:TEMP "vibebooth-main.zip"
            $tmpExtract = Join-Path $env:TEMP ("vibebooth-extract-" + [Guid]::NewGuid().ToString("N"))
            Invoke-WebRequest -Uri $ZipUrl -OutFile $tmpZip -UseBasicParsing
            Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
            $inner = Get-ChildItem -Path $tmpExtract -Directory | Select-Object -First 1
            if ($null -eq $inner) {
                throw "解压 Vibebooth 压缩包失败。"
            }
            $parentDir = Split-Path -Parent $RootDir
            if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
            if (Test-Path $RootDir) { Remove-Item -Recurse -Force $RootDir }
            Move-Item -Path $inner.FullName -Destination $RootDir
            Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "检测到已有 Vibebooth 目录：$RootDir" -ForegroundColor Cyan
    }
}

Set-Location $RootDir

# 2. 检查并自动安装 / 启动 Docker Desktop
$dockerBinDir = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if ((Test-Path $dockerBinDir) -and ($env:PATH -notlike "*$dockerBinDir*")) {
    $env:PATH = "$dockerBinDir;$env:PATH"
}

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $dockerCmd) {
    if ($NoAutoDocker) {
        Write-Host "未检测到 Docker。请安装 Docker Desktop 后重试：https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "未检测到 Docker，正在自动安装 Docker Desktop（Windows）..." -ForegroundColor Cyan
    $installed = $false
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        Write-Host "正在通过 winget 安装 Docker Desktop（可能需要弹出权限确认窗口）..." -ForegroundColor Cyan
        $wCode = Invoke-Native -File "winget" -ArgsList @("install", "-e", "--id", "Docker.DockerDesktop", "--accept-source-agreements", "--accept-package-agreements")
        if ($wCode -eq 0) {
            $installed = $true
        }
    }

    if (-not $installed) {
        $arch = "amd64"
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "arm64" }
        $installerUrl = "https://desktop.docker.com/win/main/$arch/Docker%20Desktop%20Installer.exe"
        $installerPath = Join-Path $env:TEMP "DockerDesktopInstaller.exe"
        Write-Host "正在下载 Docker Desktop 官方安装程序..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
            Write-Host "正在启动 Docker Desktop 安装程序，请按界面提示完成安装..." -ForegroundColor Cyan
            $proc = Start-Process -FilePath $installerPath -ArgumentList "install" -PassThru -Wait
            if ($proc.ExitCode -eq 0) {
                $installed = $true
            }
        } catch {
            Write-Host "自动下载或安装 Docker Desktop 失败：$($_.Exception.Message)" -ForegroundColor Red
            Write-Host "请手动下载安装 Docker Desktop 后重新运行本脚本：https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
            exit 1
        }
    }

    if (Test-Path $dockerBinDir) {
        $env:PATH = "$dockerBinDir;$env:PATH"
    }
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($null -eq $dockerCmd) {
        Write-Host ""
        Write-Host "Docker Desktop 已安装完成。如系统提示需要重启电脑，请重启后再次运行本命令即可启动 Vibebooth。" -ForegroundColor Yellow
        exit 0
    }
}

# 检查 Docker 引擎是否已就绪；未启动则自动拉起 Docker Desktop
$infoCode = Invoke-Native -File "docker" -ArgsList @("info") -Silent
if ($infoCode -ne 0) {
    $desktopExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktopExe) {
        Write-Host "正在启动 Docker Desktop（首次打开可能需要在弹窗中同意协议）..." -ForegroundColor Cyan
        Start-Process -FilePath $desktopExe
    } else {
        Write-Host "Docker 引擎尚未运行，请先打开 Docker Desktop 后重试。" -ForegroundColor Yellow
        exit 1
    }

    Write-Host -NoNewline "等待 Docker 引擎就绪"
    $ready = $false
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 3
        if ((Invoke-Native -File "docker" -ArgsList @("info") -Silent) -eq 0) {
            $ready = $true
            Write-Host " 完成！" -ForegroundColor Green
            break
        }
        Write-Host -NoNewline "."
    }
    if (-not $ready) {
        Write-Host ""
        Write-Host "等待 Docker 启动超时。" -ForegroundColor Yellow
        Write-Host "请在弹出的 Docker Desktop 窗口中完成初始化（如首次安装提示需要重启电脑或开启 WSL2，请重启后再次运行本命令）。" -ForegroundColor Yellow
        exit 1
    }
}

if ((Invoke-Native -File "docker" -ArgsList @("compose", "version") -Silent) -ne 0) {
    Write-Host "未检测到 docker compose 插件，请升级 Docker Desktop 到最新版本后重试。" -ForegroundColor Red
    exit 1
}

# 3. 生成 .env 并自动探测国内加速源
$EnvPath = Join-Path $RootDir ".env"
$EnvExamplePath = Join-Path $RootDir ".env.example"
$NewEnv = $false
$InitAdminPass = ""

if (-not (Test-Path $EnvPath)) {
    $NewEnv = $true
    $raw = [System.IO.File]::ReadAllText($EnvExamplePath, $Utf8NoBom) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($EnvPath, $raw, $Utf8NoBom)
    $pgPass = New-RandomPassword -Length 24
    $InitAdminPass = New-RandomPassword -Length 14
    Set-EnvValue -Path $EnvPath -Key "POSTGRES_PASSWORD" -Value $pgPass
    Set-EnvValue -Path $EnvPath -Key "ADMIN_PASSWORD" -Value $InitAdminPass
    Write-Host "已自动生成 .env 配置文件。" -ForegroundColor Green
}

if (-not [string]::IsNullOrEmpty($Port)) {
    Set-EnvValue -Path $EnvPath -Key "PUBLIC_PORT" -Value $Port
}

$curGoProxy = Get-EnvValue -Path $EnvPath -Key "GOPROXY"
$curNpm = Get-EnvValue -Path $EnvPath -Key "NPM_REGISTRY"

if ($Cn) {
    Set-EnvValue -Path $EnvPath -Key "GOPROXY" -Value "https://goproxy.cn,direct"
    Set-EnvValue -Path $EnvPath -Key "NPM_REGISTRY" -Value "https://registry.npmmirror.com"
    Write-Host "已配置国内加速源（GOPROXY=https://goproxy.cn,direct，NPM_REGISTRY=https://registry.npmmirror.com）。" -ForegroundColor Green
} elseif ([string]::IsNullOrEmpty($curGoProxy) -or [string]::IsNullOrEmpty($curNpm)) {
    Write-Host "正在检测网络环境..." -ForegroundColor Cyan
    $cnDetected = $false
    if ([string]::IsNullOrEmpty($curGoProxy)) {
        if (-not (Test-UrlReachable "https://proxy.golang.org") -and (Test-UrlReachable "https://goproxy.cn")) {
            Set-EnvValue -Path $EnvPath -Key "GOPROXY" -Value "https://goproxy.cn,direct"
            $cnDetected = $true
        }
    }
    if ([string]::IsNullOrEmpty($curNpm)) {
        if ($cnDetected -or (-not (Test-UrlReachable "https://registry.npmjs.org/") -and (Test-UrlReachable "https://registry.npmmirror.com"))) {
            if (Test-UrlReachable "https://registry.npmmirror.com") {
                Set-EnvValue -Path $EnvPath -Key "NPM_REGISTRY" -Value "https://registry.npmmirror.com"
                $cnDetected = $true
            }
        }
    }
    if ($cnDetected) {
        Write-Host "检测到国内网络环境，已自动配置 Go / npm 加速源。" -ForegroundColor Green
    }
}

$finalGoProxy = Get-EnvValue -Path $EnvPath -Key "GOPROXY"
$finalNpm = Get-EnvValue -Path $EnvPath -Key "NPM_REGISTRY"
if (-not [string]::IsNullOrEmpty($finalGoProxy)) { $env:GOPROXY = $finalGoProxy }
if (-not [string]::IsNullOrEmpty($finalNpm)) { $env:NPM_REGISTRY = $finalNpm }

$PublicPortVal = Get-EnvValue -Path $EnvPath -Key "PUBLIC_PORT"
if ([string]::IsNullOrEmpty($PublicPortVal)) { $PublicPortVal = "8080" }

# 4. 检测冲突实例并启动 Vibebooth
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$labelLines = & docker ps --filter "network=platform" --filter "label=com.docker.compose.service=portal" --format "{{.Labels}}" 2>$null
$ErrorActionPreference = $prevEap
$conflicts = New-Object System.Collections.Generic.List[string]
if ($labelLines) {
    foreach ($line in $labelLines) {
        if ($line -match 'com\.docker\.compose\.project=([^,]+)') {
            $proj = $Matches[1].Trim()
            if ($proj -and $proj -ne "home-platform" -and (-not $conflicts.Contains($proj))) {
                $conflicts.Add($proj)
            }
        }
    }
}
if ($conflicts.Count -gt 0) {
    Write-Host "警告：检测到其他同名平台实例正在运行，可能造成路由冲突或资源 404：" -ForegroundColor Yellow
    foreach ($p in $conflicts) {
        Write-Host "  -> 可执行停止：docker compose -p $p down" -ForegroundColor Yellow
    }
    Write-Host ""
}

function Start-FromSource {
    Write-Host "正在从源码构建并启动 Vibebooth（首次构建约需几分钟）..." -ForegroundColor Cyan
    $code = Invoke-Native -File "docker" -ArgsList @("compose", "up", "-d", "--build")
    if ($code -ne 0) {
        Write-Host ""
        Write-Host "启动失败。如在国内网络下提示拉取基础镜像超时，请在 Docker Desktop 的 Settings -> Docker Engine 中配置国内镜像加速，或开启代理后重试。" -ForegroundColor Red
        exit $code
    }
}

if ($FromSource) {
    Start-FromSource
} else {
    Write-Host "正在拉取预构建镜像..." -ForegroundColor Cyan
    $pullCode = Invoke-Native -File "docker" -ArgsList @("compose", "-f", "docker-compose.prebuilt.yml", "pull")
    if ($pullCode -eq 0) {
        $upCode = Invoke-Native -File "docker" -ArgsList @("compose", "-f", "docker-compose.prebuilt.yml", "up", "-d")
        if ($upCode -ne 0) {
            exit $upCode
        }
    } else {
        Write-Host "预构建镜像暂不可用，自动切换为本机源码构建..." -ForegroundColor Yellow
        Start-FromSource
    }
}

# 5. 获取局域网 IP 并输出访问信息
$LanIp = ""
try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike "127.*" -and
            $_.IPAddress -notlike "169.254.*" -and
            $_.InterfaceAlias -notlike "*vEthernet*" -and
            $_.InterfaceAlias -notlike "*WSL*" -and
            $_.InterfaceAlias -notlike "*Docker*" -and
            $_.PrefixOrigin -ne "WellKnown"
        } |
        Select-Object -First 1
    if ($ips) { $LanIp = $ips.IPAddress }
} catch {
    $LanIp = ""
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Vibebooth 已启动" -ForegroundColor Green
Write-Host "  安装目录：$RootDir"
Write-Host "  本机访问：http://localhost:$PublicPortVal"
if (-not [string]::IsNullOrEmpty($LanIp)) {
    Write-Host "  局域网访问：http://${LanIp}:${PublicPortVal}"
}
if ($NewEnv) {
    Write-Host "  初始账号：admin"
    Write-Host "  初始密码：$InitAdminPass"
    Write-Host "  （请妥善保存，首次登录后可在“联系人 -> 我”中修改密码）"
}
Write-Host "========================================" -ForegroundColor Green
