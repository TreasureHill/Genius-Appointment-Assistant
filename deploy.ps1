# Genius Appointment Assistant - Windows deploy script
#
# What it does, in order:
#   1. Pulls latest `main` from origin (hard reset, discards local junk)
#   2. Installs deps (npm install at workspace root)
#   3. Builds the client (npm run build)
#   4. Stops any node.exe that's serving the old build
#   5. Starts the production server detached, logs to .\logs\server.log
#   6. Makes sure Caddy is running (starts it if not)
#
# Usage (PowerShell as Administrator, from anywhere):
#   powershell -ExecutionPolicy Bypass -File C:\path\to\Genius-Appointment-Assistant\deploy.ps1
#
# Tweak the CONFIG block below to match your machine.

param(
    [string]$Branch     = "main",
    [string]$Caddyfile  = "C:\caddy\Caddyfile",
    [int]   $Port       = 4000
)

$ErrorActionPreference = "Stop"

# ----- CONFIG ---------------------------------------------------------------
$RepoDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir    = Join-Path $RepoDir "logs"
$ServerLog = Join-Path $LogDir  "server.log"
$ServerErr = Join-Path $LogDir  "server.err.log"
# ----------------------------------------------------------------------------

function Section($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Fail($msg) {
    Write-Host "!! $msg" -ForegroundColor Red
    exit 1
}

function Require-Admin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Fail "Run this PowerShell as Administrator (needed to start Caddy service)."
    }
}

# We need admin only if Caddy is installed as a service. Check soft and warn
# rather than hard-fail if the user is running caddy manually.
$caddySvc = Get-Service caddy -ErrorAction SilentlyContinue
if ($caddySvc) { Require-Admin }

if (-not (Test-Path $RepoDir)) { Fail "Repo dir not found: $RepoDir" }
Set-Location $RepoDir
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 1. Pull latest from main -----------------------------------------------------
Section "Pulling latest from origin/$Branch"
git fetch origin $Branch
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed" }
git checkout $Branch
git reset --hard "origin/$Branch"
if ($LASTEXITCODE -ne 0) { Fail "git reset failed" }
git --no-pager log -1 --pretty=format:"   on commit %h - %s (%an, %ar)"
Write-Host ""

# 2. Install deps --------------------------------------------------------------
Section "Installing dependencies (npm install)"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }

# 3. Build client --------------------------------------------------------------
Section "Building client (npm run build)"
npm run build
if ($LASTEXITCODE -ne 0) { Fail "client build failed" }

# 4. Stop the old node server --------------------------------------------------
Section "Stopping any running node server on port $Port"
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    foreach ($conn in $existing) {
        try {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "   killing PID $($proc.Id) ($($proc.ProcessName))"
                Stop-Process -Id $proc.Id -Force
            }
        } catch {}
    }
    Start-Sleep -Seconds 1
} else {
    Write-Host "   nothing listening on :$Port"
}

# 5. Start the production server ----------------------------------------------
Section "Starting server in production mode (detached)"
$env:NODE_ENV = "production"
$env:PORT     = "$Port"
# Roll the logs so they don't grow forever. Keep last run as .prev.
if (Test-Path $ServerLog) { Move-Item -Force $ServerLog "$ServerLog.prev" }
if (Test-Path $ServerErr) { Move-Item -Force $ServerErr "$ServerErr.prev" }

$proc = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "start" `
    -WorkingDirectory $RepoDir `
    -RedirectStandardOutput $ServerLog `
    -RedirectStandardError  $ServerErr `
    -WindowStyle Hidden `
    -PassThru

Write-Host "   started node, PID $($proc.Id)"
Write-Host "   logs: $ServerLog"

# Wait a few seconds and confirm it's actually listening
Section "Health check on http://localhost:$Port/api/health"
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if (-not $ok) {
    Write-Host "   server didn't answer on :$Port within 15s - check $ServerErr" -ForegroundColor Yellow
} else {
    Write-Host "   OK - server is up" -ForegroundColor Green
}

# 6. Make sure Caddy is running -----------------------------------------------
Section "Ensuring Caddy is running"
if ($caddySvc) {
    # Service install
    if ((Get-Service caddy).Status -ne "Running") {
        Write-Host "   caddy service not running - starting"
        Start-Service caddy
    } else {
        Write-Host "   caddy service is running - reloading config"
    }
    # Validate the Caddyfile before asking caddy to reload
    if (Test-Path $Caddyfile) {
        & caddy validate --config $Caddyfile
        if ($LASTEXITCODE -eq 0) {
            & caddy reload --config $Caddyfile
            if ($LASTEXITCODE -eq 0) {
                Write-Host "   caddy reloaded" -ForegroundColor Green
            } else {
                Write-Host "   caddy reload returned $LASTEXITCODE - check Event Viewer" -ForegroundColor Yellow
            }
        } else {
            Write-Host "   Caddyfile invalid - NOT reloading. Fix $Caddyfile and re-run." -ForegroundColor Red
        }
    } else {
        Write-Host "   Caddyfile not found at $Caddyfile - skipping reload" -ForegroundColor Yellow
    }
} else {
    # No service - try to find caddy.exe and run it standalone
    $running = Get-Process caddy -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "   caddy.exe already running (PID $($running.Id | Select-Object -First 1)) - reloading"
        & caddy reload --config $Caddyfile
    } else {
        Write-Host "   caddy not running - starting detached"
        Start-Process -FilePath "caddy" -ArgumentList @("run","--config",$Caddyfile) -WindowStyle Hidden
    }
}

Section "Deploy complete"
Write-Host "   App:   http://localhost:$Port  (proxied through Caddy on 80/443)"
Write-Host "   Logs:  $ServerLog"
Write-Host "   Tail:  Get-Content -Wait $ServerLog"
