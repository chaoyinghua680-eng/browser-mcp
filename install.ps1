param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NativeHostJs = Join-Path $ScriptDir "native-host\dist\index.js"

if (-not (Test-Path $NativeHostJs)) {
    Write-Host "Missing file: $NativeHostJs" -ForegroundColor Red
    Write-Host "Run these commands first:" -ForegroundColor Yellow
    Write-Host "  cd native-host"
    Write-Host "  npm install"
    Write-Host "  npm run build"
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host "Node.js was not found in PATH." -ForegroundColor Red
    exit 1
}
$NodeExe = $NodeCmd.Source

$WrapperCmd = Join-Path $ScriptDir "native-host\start.cmd"
$ManifestPath = Join-Path $ScriptDir "native-host\com.browsermcp.host.json"

$WrapperContent = @"
@echo off
"$NodeExe" "$NativeHostJs"
"@

Set-Content -Path $WrapperCmd -Value $WrapperContent -Encoding ASCII

$ManifestObject = @{
    name = "com.browsermcp.host"
    description = "Browser MCP Native Messaging Host"
    path = $WrapperCmd
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://$ExtensionId/"
    )
}

$ManifestObject | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding ASCII

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browsermcp.host"

if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browsermcp.host" /ve /t REG_SZ /d "$ManifestPath" /f | Out-Null

Write-Host ""
Write-Host "Native Messaging Host registered successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Manifest:"
Write-Host "  $ManifestPath"
Write-Host ""
Write-Host "Wrapper:"
Write-Host "  $WrapperCmd"
Write-Host ""
Write-Host "Registry:"
Write-Host "  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browsermcp.host"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Chrome"
Write-Host "  2. Reload the extension"
Write-Host "  3. Make sure native-host is built"