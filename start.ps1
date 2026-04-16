param(
    [switch]$Build,
    [switch]$Stop,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NativeHostDir = Join-Path $RootDir "native-host"
$McpServerDir = Join-Path $RootDir "mcp-server"

$BridgeHttpPort = 3282
$BridgeWsPort = 3283
$SseServerPort = 8006

$LogDir = Join-Path $RootDir ".logs"
$BridgeStdoutLog = Join-Path $LogDir "bridge-server.stdout.log"
$BridgeStderrLog = Join-Path $LogDir "bridge-server.stderr.log"
$SseStdoutLog = Join-Path $LogDir "sse-server.stdout.log"
$SseStderrLog = Join-Path $LogDir "sse-server.stderr.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[ OK ] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Get-CommandPath {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($command.Source)) {
        throw "Unable to resolve command path for '$Name'."
    }

    return $command.Source
}

$script:NodeExe = $null
$script:NpmCmd = $null

function Get-NodeExe {
    if (-not $script:NodeExe) {
        $script:NodeExe = Get-CommandPath -Name "node"
    }

    return $script:NodeExe
}

function Get-NpmCmd {
    if (-not $script:NpmCmd) {
        $script:NpmCmd = Get-CommandPath -Name "npm"
    }

    return $script:NpmCmd
}

function Get-PortPids {
    param([int[]]$Ports)

    $pids = @()
    foreach ($port in $Ports) {
        $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if ($connections) {
            $pids += $connections | Select-Object -ExpandProperty OwningProcess
        }
    }

    return $pids |
        Where-Object { $_ -and $_ -gt 0 } |
        Sort-Object -Unique
}

function Stop-PortOwners {
    param([int[]]$Ports)

    $pids = @(Get-PortPids -Ports $Ports)
    if ($pids.Count -eq 0) {
        return
    }

    Write-Warn ("Ports {0} are in use. Stopping PIDs: {1}" -f ($Ports -join ", "), ($pids -join ", "))
    foreach ($targetPid in $pids) {
        try {
            Stop-Process -Id $targetPid -Force -ErrorAction Stop
        } catch {
            Write-Warn ("Failed to stop PID {0}: {1}" -f $targetPid, $_.Exception.Message)
        }
    }

    Start-Sleep -Seconds 1
}

function Wait-ForPort {
    param(
        [int]$Port,
        [string]$Name,
        [System.Diagnostics.Process]$Process,
        [string[]]$LogFiles,
        [int]$MaxWaitSeconds = 15
    )

    for ($elapsed = 0; $elapsed -lt $MaxWaitSeconds; $elapsed++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        if ($listener) {
            return $true
        }

        if (-not (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)) {
            break
        }

        Start-Sleep -Seconds 1
    }

    Write-Fail ("{0} did not start within {1}s." -f $Name, $MaxWaitSeconds)
    foreach ($logFile in $LogFiles) {
        if (Test-Path $logFile) {
            Write-Host ("  Log: {0}" -f $logFile) -ForegroundColor DarkYellow
        }
    }

    return $false
}

function Invoke-HealthCheck {
    param(
        [string]$Url,
        [string]$Name
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Ok ("{0} health check passed." -f $Name)
            return $true
        }

        Write-Fail ("{0} health check failed (HTTP {1})." -f $Name, $response.StatusCode)
        return $false
    } catch {
        Write-Fail ("{0} health check failed: {1}" -f $Name, $_.Exception.Message)
        return $false
    }
}

function Invoke-BuildStep {
    param(
        [string]$WorkingDirectory,
        [string]$Name
    )

    Write-Info ("Building {0}..." -f $Name)
    Push-Location $WorkingDirectory
    try {
        & (Get-NpmCmd) run build
        if ($LASTEXITCODE -ne 0) {
            throw ("{0} build failed with exit code {1}." -f $Name, $LASTEXITCODE)
        }
    } finally {
        Pop-Location
    }

    Write-Ok ("{0} build finished." -f $Name)
}

function Start-ServiceProcess {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$ScriptPath,
        [string]$StdoutLog,
        [string]$StderrLog
    )

    if (Test-Path $StdoutLog) {
        Remove-Item $StdoutLog -Force
    }
    if (Test-Path $StderrLog) {
        Remove-Item $StderrLog -Force
    }

    Write-Info ("Starting {0}..." -f $Name)
    return Start-Process `
        -FilePath (Get-NodeExe) `
        -ArgumentList $ScriptPath `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -WindowStyle Hidden `
        -PassThru
}

function Show-Usage {
    Write-Host ""
    Write-Host "browser-mcp PowerShell launcher"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\start.ps1          Start services"
    Write-Host "  .\start.ps1 -Build   Build first, then start"
    Write-Host "  .\start.ps1 -Stop    Stop running services"
    Write-Host "  .\start.ps1 -Help    Show this help"
    Write-Host ""
}

function Stop-All {
    Write-Host ""
    Write-Host "Stopping browser-mcp services..." -ForegroundColor White
    Write-Host ""

    Stop-PortOwners -Ports @($BridgeHttpPort, $BridgeWsPort, $SseServerPort)
    Write-Ok "All services stopped."
    Write-Host ""
}

function Start-All {
    Write-Host ""
    Write-Host "Launching browser-mcp services" -ForegroundColor White
    Write-Host ("Project root: {0}" -f $RootDir)
    Write-Host ""

    Write-Info "Checking port usage..."
    Stop-PortOwners -Ports @($BridgeHttpPort, $BridgeWsPort, $SseServerPort)
    Write-Ok "Ports are clear."

    $bridgeEntry = Join-Path $NativeHostDir "dist\bridge-server.js"
    $sseEntry = Join-Path $McpServerDir "dist\sse-server.js"

    if (-not (Test-Path $bridgeEntry)) {
        Write-Warn "native-host is not built yet. Building now..."
        Invoke-BuildStep -WorkingDirectory $NativeHostDir -Name "native-host"
    }

    if (-not (Test-Path $sseEntry)) {
        Write-Warn "mcp-server is not built yet. Building now..."
        Invoke-BuildStep -WorkingDirectory $McpServerDir -Name "mcp-server"
    }

    $bridgeProcess = $null
    $sseProcess = $null

    try {
        $bridgeProcess = Start-ServiceProcess `
            -Name "Bridge Server" `
            -WorkingDirectory $NativeHostDir `
            -ScriptPath "dist/bridge-server.js" `
            -StdoutLog $BridgeStdoutLog `
            -StderrLog $BridgeStderrLog

        if (-not (Wait-ForPort `
            -Port $BridgeHttpPort `
            -Name "Bridge Server" `
            -Process $bridgeProcess `
            -LogFiles @($BridgeStdoutLog, $BridgeStderrLog))) {
            throw "Bridge Server failed to start."
        }

        Write-Ok ("Bridge Server started (PID: {0})" -f $bridgeProcess.Id)

        $sseProcess = Start-ServiceProcess `
            -Name "SSE MCP Server" `
            -WorkingDirectory $McpServerDir `
            -ScriptPath "dist/sse-server.js" `
            -StdoutLog $SseStdoutLog `
            -StderrLog $SseStderrLog

        if (-not (Wait-ForPort `
            -Port $SseServerPort `
            -Name "SSE MCP Server" `
            -Process $sseProcess `
            -LogFiles @($SseStdoutLog, $SseStderrLog))) {
            throw "SSE MCP Server failed to start."
        }

        Write-Ok ("SSE MCP Server started (PID: {0})" -f $sseProcess.Id)

        Write-Host ""
        Write-Info "Running health checks..."
        Start-Sleep -Seconds 1
        Invoke-HealthCheck -Url ("http://localhost:{0}/health" -f $BridgeHttpPort) -Name "Bridge Server" | Out-Null
        Invoke-HealthCheck -Url ("http://localhost:{0}/health" -f $SseServerPort) -Name "SSE MCP Server" | Out-Null

        Write-Host ""
        Write-Host "browser-mcp is up" -ForegroundColor Green
        Write-Host ("  Bridge Server : http://localhost:{0}" -f $BridgeHttpPort)
        Write-Host ("  SSE Server    : http://localhost:{0}" -f $SseServerPort)
        Write-Host ("  SSE endpoint  : http://localhost:{0}/sse" -f $SseServerPort)
        Write-Host ("  Logs          : {0}" -f $LogDir)
        Write-Host ("  Stop command  : .\start.ps1 -Stop")
        Write-Host ""
        Write-Warn "Keep Chrome and the extension running."
        Write-Info "Press Ctrl+C to stop both services."
        Write-Host ""

        while ($true) {
            $bridgeAlive = Get-Process -Id $bridgeProcess.Id -ErrorAction SilentlyContinue
            $sseAlive = Get-Process -Id $sseProcess.Id -ErrorAction SilentlyContinue

            if (-not $bridgeAlive -or -not $sseAlive) {
                if (-not $bridgeAlive) {
                    Write-Warn "Bridge Server exited."
                }
                if (-not $sseAlive) {
                    Write-Warn "SSE MCP Server exited."
                }
                break
            }

            Start-Sleep -Seconds 2
        }
    } finally {
        Write-Host ""
        Write-Warn "Stopping services..."

        foreach ($process in @($bridgeProcess, $sseProcess)) {
            if ($process -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
                try {
                    Stop-Process -Id $process.Id -Force -ErrorAction Stop
                } catch {
                    Write-Warn ("Failed to stop PID {0}: {1}" -f $process.Id, $_.Exception.Message)
                }
            }
        }

        Stop-PortOwners -Ports @($BridgeHttpPort, $BridgeWsPort, $SseServerPort)
        Write-Ok "Services stopped."
        Write-Host ""
    }
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($Stop) {
    Stop-All
    exit 0
}

if ($Build) {
    Write-Host ""
    Write-Host "Building browser-mcp..." -ForegroundColor White
    Write-Host ""

    Invoke-BuildStep -WorkingDirectory $NativeHostDir -Name "native-host"
    Invoke-BuildStep -WorkingDirectory $McpServerDir -Name "mcp-server"

    Write-Host ""
}

Start-All
