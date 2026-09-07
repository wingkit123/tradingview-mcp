<#
.SYNOPSIS
    Scheduled and on-demand runner for XAUUSD TradingView SNR Auto-Mapper.
    Preserves child Node exit codes and records execution logs.

.DESCRIPTION
    Executes automated SNR mapping in either:
    - diff (default): Differential lifecycle (Update / Append / Delete)
    - capture-only: Non-mutating analysis and receipt generation
    - force-refresh: Full redraw of all active entities
#>

[CmdletBinding()]
param (
    [Parameter()]
    [ValidateSet('diff', 'capture-only', 'capture', 'force-refresh')]
    [string]$Mode = 'diff',

    [Parameter()]
    [switch]$NoLaunchBrowser,

    [Parameter()]
    [switch]$RequireTradingDay
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkDir = Split-Path -Parent $ScriptDir
Set-Location $WorkDir

$LogDir = Join-Path $WorkDir 'logs'
if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "auto_mapper_$(Get-Date -Format 'yyyyMMdd').log"
$StartTime = Get-Date
$StartTimeUtc = $StartTime.ToUniversalTime().ToString('o')

# Trading day guard (Monday-Friday)
if ($RequireTradingDay -and $StartTime.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    Write-Host "[XAUUSD-Mapper] Weekend detected with -RequireTradingDay. Skipping run."
    exit 0
}

$NormalizedMode = if ($Mode -eq 'capture') { 'capture-only' } else { $Mode }
Write-Host "[XAUUSD-Mapper] Starting run at $StartTimeUtc (Mode: $NormalizedMode)"
"[$StartTimeUtc] === Launching Auto-Mapper (Mode: $NormalizedMode) ===" | Out-File -FilePath $LogFile -Append -Encoding utf8

function Test-PortFast ([string]$ComputerName, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        $wait = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $wait) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

$IsCdpListening = Test-PortFast -ComputerName '127.0.0.1' -Port 9222
if (-not $IsCdpListening) {
    if ($NoLaunchBrowser) {
        Write-Error "Chrome CDP port 9222 is not listening and -NoLaunchBrowser is set. Failing closed."
        "[$StartTimeUtc] ERROR: CDP port 9222 unavailable (-NoLaunchBrowser)." | Out-File -FilePath $LogFile -Append -Encoding utf8
        exit 3
    }

    Write-Host "[XAUUSD-Mapper] CDP port 9222 not listening. Launching Chrome with ChromeTradingProfile..."
    "[$StartTimeUtc] CDP port 9222 not listening. Launching Chrome with ChromeTradingProfile..." | Out-File -FilePath $LogFile -Append -Encoding utf8

    $ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    $ChromeArgs = @(
        "--remote-debugging-port=9222",
        "--user-data-dir=C:\Users\Wing Kit\ChromeTradingProfile",
        "https://www.tradingview.com/chart/1xfXpF1b/"
    )

    if (Test-Path $ChromePath) {
        Start-Process -FilePath $ChromePath -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\Users\Wing Kit\ChromeTradingProfile", "https://www.tradingview.com/chart/1xfXpF1b/"
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-PortFast -ComputerName '127.0.0.1' -Port 9222) {
                Write-Host "[XAUUSD-Mapper] CDP port 9222 is active and ready."
                break
            }
        }
    } else {
        Write-Error "Chrome executable not found at $ChromePath"
        exit 3
    }
}

# Execute Node runner
$NodeScript = Join-Path $ScriptDir 'auto_map_snr.js'
$NodeArgs = @($NodeScript, "--mode", $NormalizedMode)

try {
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    & node @NodeArgs *>> $LogFile
    $NodeExit = $LASTEXITCODE
    $Sw.Stop()

    $Status = if ($NodeExit -eq 0) { "SUCCESS" } else { "FAILED (Exit code $NodeExit)" }
    Write-Host "[XAUUSD-Mapper] Auto-Mapper Run Completed in $($Sw.ElapsedMilliseconds)ms with Status: $Status"
    "[$StartTimeUtc] Auto-Mapper Run Completed in $($Sw.ElapsedMilliseconds)ms with Status: $Status" | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit $NodeExit
} catch {
    Write-Error "Error during Auto-Mapper run: $_"
    "[$StartTimeUtc] Error during Auto-Mapper run: $_" | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 1
}
