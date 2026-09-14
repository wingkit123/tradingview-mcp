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
    [switch]$RequireTradingDay,

    [Parameter()]
    [switch]$AllowMutation
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkDir = Split-Path -Parent $ScriptDir
Set-Location $WorkDir

# The mapper must select the exact chart target, not the first TradingView tab.
if ([string]::IsNullOrWhiteSpace($env:TRADINGVIEW_CHART_ID)) {
    $env:TRADINGVIEW_CHART_ID = '1xfXpF1b'
}

$LogDir = Join-Path $WorkDir 'logs'
if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "auto_mapper_$(Get-Date -Format 'yyyyMMdd').log"
$StartTime = Get-Date
$StartTimeUtc = $StartTime.ToUniversalTime().ToString('o')
$NormalizedMode = if ($Mode -eq 'capture') { 'capture-only' } else { $Mode }
$RunnerReceiptPath = Join-Path $WorkDir 'artifacts\mapper-runner-receipt.json'
$TargetChartId = $env:TRADINGVIEW_CHART_ID
$TargetSymbol = $env:TRADINGVIEW_SYMBOL
if ([string]::IsNullOrWhiteSpace($TargetSymbol)) {
    $TargetSymbol = 'OANDA:XAUUSD'
    $env:TRADINGVIEW_SYMBOL = $TargetSymbol
}
$TargetChartUrl = $env:TRADINGVIEW_TAB_URL

function Write-RunnerReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [Parameter(Mandatory = $true)][string]$FailureStage,
        [string]$ErrorMessage,
        [object]$SourceReceipt
    )

    $targetVerification = $null
    $timeframeVerification = $null
    $chartSave = [ordered]@{
        status = 'unverified'
        verified_by = $null
    }
    $manifestHash = $null
    $quotePrice = $null

    if ($null -ne $SourceReceipt) {
        $targetVerification = $SourceReceipt.target_verification
        $timeframeVerification = $SourceReceipt.timeframe_verification
        if ($null -ne $SourceReceipt.chart_save) {
            $chartSave = $SourceReceipt.chart_save
        }
        $manifestHash = $SourceReceipt.manifest_hash
        $quotePrice = $SourceReceipt.quote_price
        if ([string]::IsNullOrWhiteSpace($ErrorMessage) -and $SourceReceipt.errors -and $SourceReceipt.errors.Count -gt 0) {
            $ErrorMessage = [string]$SourceReceipt.errors[0].message
        }
    }

    $receipt = [ordered]@{
        status = $Status
        mode = $NormalizedMode
        failure_stage = $FailureStage
        error = if ([string]::IsNullOrWhiteSpace($ErrorMessage)) { $null } else { $ErrorMessage }
        exit_code = $ExitCode
        started_at_utc = $StartTimeUtc
        completed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
        target_identity = [ordered]@{
            expected_chart_id = $TargetChartId
            expected_symbol = $TargetSymbol
            expected_chart_url = $TargetChartUrl
            actual = $targetVerification
        }
        timeframe_verification = $timeframeVerification
        chart_save = $chartSave
        manifest_hash = $manifestHash
        quote_price = $quotePrice
    }

    $receiptDir = Split-Path -Parent $RunnerReceiptPath
    if (!(Test-Path $receiptDir)) {
        New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null
    }
    $tempReceiptPath = "$RunnerReceiptPath.$PID.tmp"
    try {
        $json = $receipt | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($tempReceiptPath, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempReceiptPath -Destination $RunnerReceiptPath -Force
    } finally {
        if (Test-Path $tempReceiptPath) {
            Remove-Item -LiteralPath $tempReceiptPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Send-DesktopToast {
    param(
        [string]$Title,
        [string]$Message
    )
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $textNodes = $template.GetElementsByTagName("text")
        $textNodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
        $textNodes.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("TradingView XAUUSD AutoMapper").Show($toast)
    } catch {
        # Desktop notification is a non-blocking enhancement
    }
}

# Trading day guard (Monday-Friday)
if ($RequireTradingDay -and $StartTime.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    $SkipMsg = "[XAUUSD-Mapper] STATUS: SKIPPED (Non-trading day / weekend detected with -RequireTradingDay)"
    Write-Host $SkipMsg
    "[$StartTimeUtc] $SkipMsg" | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-RunnerReceipt -Status 'SKIPPED' -ExitCode 0 -FailureStage 'trading_day_guard' -ErrorMessage 'Non-trading day / weekend detected with -RequireTradingDay'
    exit 0
}

# Scheduled runs are capture-only by default. Drawing/removal requires an
# explicit human-controlled opt-in so a stale prompt cannot mutate the chart.
if ($NormalizedMode -in @('diff', 'force-refresh') -and -not $AllowMutation) {
    $BlockedMsg = "[XAUUSD-Mapper] STATUS: BLOCKED (Mode '$NormalizedMode' requires explicit -AllowMutation; use -Mode capture-only for scheduled analysis)"
    Write-Error $BlockedMsg
    "[$StartTimeUtc] $BlockedMsg" | Out-File -FilePath $LogFile -Append -Encoding utf8
    Write-RunnerReceipt -Status 'BLOCKED' -ExitCode 4 -FailureStage 'mutation_guard' -ErrorMessage $BlockedMsg
    Send-DesktopToast -Title "TradingView XAUUSD AutoMapper" -Message "⚠️ 画图已阻断: 需指定 -AllowMutation 参数"
    exit 4
}

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
        "[$StartTimeUtc] ERROR: CDP port 9222 unavailable (-NoLaunchBrowser). STATUS: FAILED" | Out-File -FilePath $LogFile -Append -Encoding utf8
        Write-RunnerReceipt -Status 'FAILED' -ExitCode 3 -FailureStage 'chrome_start' -ErrorMessage 'Chrome CDP port 9222 is unavailable and -NoLaunchBrowser is set'
        exit 3
    }

    Write-Host "[XAUUSD-Mapper] CDP port 9222 not listening. Launching Chrome with ChromeTradingProfile..."
    "[$StartTimeUtc] CDP port 9222 not listening. Launching Chrome with ChromeTradingProfile..." | Out-File -FilePath $LogFile -Append -Encoding utf8

    $ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path $ChromePath) {
        $ChromeArgs = @(
            "--remote-debugging-port=9222",
            "--user-data-dir=`"C:\Users\Wing Kit\ChromeTradingProfile`"",
            "https://www.tradingview.com/chart/$TargetChartId/"
        )
        Start-Process -FilePath $ChromePath -ArgumentList $ChromeArgs
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-PortFast -ComputerName '127.0.0.1' -Port 9222) {
                Write-Host "[XAUUSD-Mapper] CDP port 9222 is active and ready."
                break
            }
        }
    } else {
        Write-Error "Chrome executable not found at $ChromePath"
        "[$StartTimeUtc] ERROR: Chrome executable not found at $ChromePath. STATUS: FAILED" | Out-File -FilePath $LogFile -Append -Encoding utf8
        Write-RunnerReceipt -Status 'FAILED' -ExitCode 3 -FailureStage 'chrome_start' -ErrorMessage "Chrome executable not found at $ChromePath"
        exit 3
    }

    # Recheck CDP after launch waiting: fail-closed if still unavailable
    $IsCdpListening = Test-PortFast -ComputerName '127.0.0.1' -Port 9222
    if (-not $IsCdpListening) {
        Write-Error "Chrome CDP port 9222 is still unavailable after browser launch waiting. Failing closed."
        "[$StartTimeUtc] ERROR: CDP port 9222 unavailable after browser launch. STATUS: FAILED" | Out-File -FilePath $LogFile -Append -Encoding utf8
        Write-RunnerReceipt -Status 'FAILED' -ExitCode 3 -FailureStage 'chrome_start' -ErrorMessage 'Chrome CDP port 9222 remained unavailable after browser launch waiting'
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
    $SourceReceipt = $null
    if ($NodeExit -eq 0) {
        $ReceiptValidator = Join-Path $ScriptDir 'validate_snr_map_receipt.js'
        & node $ReceiptValidator (Join-Path $WorkDir 'artifacts\snr-map.v1.json') *>> $LogFile
        if ($LASTEXITCODE -ne 0) {
            $NodeExit = $LASTEXITCODE
            $IntegrityMsg = "[XAUUSD-Mapper] STATUS: FAILED (snr-map.v1 receipt integrity validation failed)"
            Write-Error $IntegrityMsg
            "[$StartTimeUtc] $IntegrityMsg" | Out-File -FilePath $LogFile -Append -Encoding utf8
        }
    }

    $MapReceiptPath = Join-Path $WorkDir 'artifacts\snr-map.v1.json'
    $FailureReceiptPath = Join-Path $WorkDir 'artifacts\snr-map.v1.failure.json'
    $SourcePath = if ($NodeExit -eq 0) { $MapReceiptPath } else { $FailureReceiptPath }
    if (Test-Path $SourcePath) {
        try {
            $SourceReceipt = Get-Content $SourcePath -Raw | ConvertFrom-Json
        } catch {
            if ($NodeExit -eq 0) {
                $NodeExit = 5
                $IntegrityMsg = "[XAUUSD-Mapper] STATUS: FAILED (runner receipt JSON could not be parsed: $($_.Exception.Message))"
                Write-Error $IntegrityMsg
                "[$StartTimeUtc] $IntegrityMsg" | Out-File -FilePath $LogFile -Append -Encoding utf8
            }
        }
    }
    $Sw.Stop()

    $Status = if ($NodeExit -eq 0) { "PASS" } else { "FAILED (Exit code $NodeExit)" }
    Write-Host "[XAUUSD-Mapper] Auto-Mapper Run Completed in $($Sw.ElapsedMilliseconds)ms with Status: $Status"
    "[$StartTimeUtc] Auto-Mapper Run Completed in $($Sw.ElapsedMilliseconds)ms with Status: $Status" | Out-File -FilePath $LogFile -Append -Encoding utf8
    $ReceiptStage = 'mapper'
    if ($NodeExit -eq 0) {
        $ReceiptStage = 'complete'
    } elseif ($null -ne $SourceReceipt -and $SourceReceipt.failure_stage) {
        $ReceiptStage = [string]$SourceReceipt.failure_stage
    }
    $ReceiptError = $null
    if ($NodeExit -ne 0) {
        if ($null -ne $SourceReceipt -and $SourceReceipt.errors -and $SourceReceipt.errors.Count -gt 0) {
            $ReceiptError = [string]$SourceReceipt.errors[0].message
        } else {
            $ReceiptError = "Auto-Mapper exited with code $NodeExit"
        }
    }
    Write-RunnerReceipt -Status $(if ($NodeExit -eq 0) { 'PASS' } else { 'FAILED' }) -ExitCode $NodeExit -FailureStage $ReceiptStage -ErrorMessage $ReceiptError -SourceReceipt $SourceReceipt
    if ($NodeExit -eq 0) {
        Send-DesktopToast -Title "TradingView XAUUSD AutoMapper" -Message "✅ 每日分析已成功绘制并存盘 (耗时: $($Sw.ElapsedMilliseconds)ms)"
    } else {
        Send-DesktopToast -Title "TradingView XAUUSD AutoMapper" -Message "❌ 每日分析失败 (阶段: $ReceiptStage): $ReceiptError"
    }
    exit $NodeExit
} catch {
    Write-Error "Error during Auto-Mapper run: $_"
    "[$StartTimeUtc] Error during Auto-Mapper run: $_" | Out-File -FilePath $LogFile -Append -Encoding utf8
    try {
        Write-RunnerReceipt -Status 'FAILED' -ExitCode 1 -FailureStage 'runner' -ErrorMessage $_.Exception.Message
    } catch {
        Write-Error "Failed to write runner receipt: $($_.Exception.Message)"
    }
    Send-DesktopToast -Title "TradingView XAUUSD AutoMapper" -Message "❌ 运行异常: $($_.Exception.Message)"
    exit 1
}
