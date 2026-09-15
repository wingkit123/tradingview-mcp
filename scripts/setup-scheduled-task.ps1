<#
.SYNOPSIS
    Installs, configures, or queries the Windows Scheduled Task for TradingView XAUUSD Auto-Mapper.

.DESCRIPTION
    Configures a scheduled task to run every trading day (Monday-Friday) at 08:00 AM local time.
    Executes differential daily SNR mapping on TradingView chart layout 1xfXpF1b (OANDA:XAUUSD).
    Automatically launches Chrome with ChromeTradingProfile (--remote-debugging-port=9222) if not running.

.PARAMETER TaskName
    Name of the scheduled task (default: TradingView_XAUUSD_AutoMapper).

.PARAMETER Time
    Daily execution time in HH:mm format (default: 08:00).

.PARAMETER DaysOfWeek
    Days of week to run (default: Monday, Tuesday, Wednesday, Thursday, Friday).

.PARAMETER Mode
    Mapping mode: 'diff' (draws and updates daily analysis), 'capture-only' (read-only analysis).

.PARAMETER AllowMutation
    Allows chart mutations in 'diff' mode (default: true).

.PARAMETER RunNow
    Trigger immediate execution of the scheduled task.

.PARAMETER Status
    Query and display current task configuration and last run status.

.PARAMETER Disable
    Disable the scheduled task without removing it.

.PARAMETER Enable
    Enable the scheduled task.

.PARAMETER Unregister
    Remove the scheduled task from Windows Task Scheduler.

.EXAMPLE
    .\setup-scheduled-task.ps1
    .\setup-scheduled-task.ps1 -Status
    .\setup-scheduled-task.ps1 -RunNow
    .\setup-scheduled-task.ps1 -Time "08:30"
#>

[CmdletBinding()]
param (
    [Parameter()]
    [string]$TaskName = 'TradingView_XAUUSD_AutoMapper',

    [Parameter()]
    [string]$Time = '08:00',

    [Parameter()]
    [string]$Interval = '4h',

    [Parameter()]
    [DayOfWeek[]]$DaysOfWeek = @(
        [DayOfWeek]::Monday,
        [DayOfWeek]::Tuesday,
        [DayOfWeek]::Wednesday,
        [DayOfWeek]::Thursday,
        [DayOfWeek]::Friday
    ),

    [Parameter()]
    [ValidateSet('diff', 'capture-only', 'force-refresh')]
    [string]$Mode = 'diff',

    [Parameter()]
    [switch]$AllowMutation = $true,

    [Parameter()]
    [switch]$RunNow,

    [Parameter()]
    [switch]$Status,

    [Parameter()]
    [switch]$Disable,

    [Parameter()]
    [switch]$Enable,

    [Parameter()]
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkDir = Split-Path -Parent $ScriptDir
$RunnerScript = Join-Path $ScriptDir 'run_scheduled_mapper.ps1'

# 1. Query Status
if ($Status) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "[ScheduleTask] Task '$TaskName' is NOT currently installed." -ForegroundColor Yellow
        exit 0
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "=== Scheduled Task Status: $TaskName ===" -ForegroundColor Cyan
    Write-Host "State:           $($existing.State)"
    Write-Host "TaskPath:        $($existing.TaskPath)"
    Write-Host "Description:     $($existing.Description)"
    Write-Host "Last Run Time:   $($info.LastRunTime)"
    Write-Host "Last Task Result:$($info.LastTaskResult)"
    Write-Host "Next Run Time:   $($info.NextRunTime)"
    Write-Host "NumberOfMissed:  $($info.NumberOfMissedRuns)"
    Write-Host "Actions:"
    foreach ($action in $existing.Actions) {
        Write-Host "  $($action.Execute) $($action.Arguments)"
    }
    Write-Host "Triggers:"
    foreach ($trigger in $existing.Triggers) {
        $days = if ($trigger.DaysOfWeek) { $trigger.DaysOfWeek -join ', ' } else { 'Daily' }
        $repText = if ($trigger.Repetition -and $trigger.Repetition.Interval) { " | Repeat: every $($trigger.Repetition.Interval) for $($trigger.Repetition.Duration)" } else { "" }
        Write-Host "  Start: $($trigger.StartBoundary) | Days: $days$repText | Enabled: $($trigger.Enabled)"
    }
    exit 0
}

# 2. Trigger On-Demand Run
if ($RunNow) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Error "[ScheduleTask] Task '$TaskName' is not registered. Run setup without -RunNow first."
        exit 1
    }
    Write-Host "[ScheduleTask] Triggering on-demand execution for '$TaskName'..." -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "[ScheduleTask] Task triggered. Current state: $($existing.State). Last run time: $($info.LastRunTime)" -ForegroundColor Green
    exit 0
}

# 3. Disable Task
if ($Disable) {
    Write-Host "[ScheduleTask] Disabling '$TaskName'..." -ForegroundColor Yellow
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "[ScheduleTask] Task '$TaskName' is now Disabled." -ForegroundColor Green
    exit 0
}

# 4. Enable Task
if ($Enable) {
    Write-Host "[ScheduleTask] Enabling '$TaskName'..." -ForegroundColor Cyan
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "[ScheduleTask] Task '$TaskName' is now Enabled (Ready)." -ForegroundColor Green
    exit 0
}

# 5. Unregister Task
if ($Unregister) {
    Write-Host "[ScheduleTask] Unregistering '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[ScheduleTask] Task '$TaskName' has been unregistered." -ForegroundColor Green
    exit 0
}

# 6. Install or Update Task
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Installing Windows Scheduled Task: $TaskName" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# Validate dependencies
if (-not (Test-Path $RunnerScript)) {
    Write-Error "Runner script not found: $RunnerScript"
    exit 1
}

$Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerScript`" -Mode $Mode"
if ($AllowMutation) {
    $Arguments += " -AllowMutation"
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $Arguments `
    -WorkingDirectory $WorkDir

# Parse time
$timeParts = $Time.Split(':')
$hour = [int]$timeParts[0]
$minute = if ($timeParts.Count -gt 1) { [int]$timeParts[1] } else { 0 }
$dt = (Get-Date).Date.AddHours($hour).AddMinutes($minute)

$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek $DaysOfWeek `
    -At $dt.ToString("HH:mm")

# Configure repetition if interval specified
if ($Interval -and $Interval -ne 'none') {
    $ptInterval = if ($Interval -match '^(\d+)[hH]$') {
        "PT$($Matches[1])H"
    } elseif ($Interval -match '^(\d+)[mM]$') {
        "PT$($Matches[1])M"
    } else {
        $Interval
    }
    $rep = [Microsoft.Management.Infrastructure.CimInstance]::new((Get-CimClass -ClassName MSFT_TaskRepetitionPattern -Namespace Root/Microsoft/Windows/TaskScheduler))
    $rep.Interval = $ptInterval
    $rep.Duration = 'P1D'
    $rep.StopAtDurationEnd = $false
    $Trigger.Repetition = $rep
}

$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$repeatDesc = if ($Interval -and $Interval -ne 'none') { " (repeats every $Interval)" } else { "" }
$Description = "Automated daily XAUUSD multi-timeframe SNR analysis and TradingView chart mapper ($Mode mode) starting at $Time on trading days$repeatDesc. Protected by (AI) ownership markers and atomic rollback."

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description $Description `
    -Force | Out-Null

# Verify installation
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($registered) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "[ScheduleTask] SUCCESS: Task '$TaskName' registered and enabled!" -ForegroundColor Green
    Write-Host "  Schedule:       Monday - Friday at $Time, repeating every $Interval" -ForegroundColor Green
    Write-Host "  Mode:           $Mode (AllowMutation = $AllowMutation)" -ForegroundColor Green
    Write-Host "  Target Chart:   1xfXpF1b (OANDA:XAUUSD)" -ForegroundColor Green
    Write-Host "  Browser Mode:   ChromeTradingProfile on 127.0.0.1:9222" -ForegroundColor Green
    Write-Host "  Next Run Time:  $($info.NextRunTime)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Commands to manage this task:"
    Write-Host "  Check Status:   powershell -File `"$ScriptDir\setup-scheduled-task.ps1`" -Status"
    Write-Host "  Trigger Now:    powershell -File `"$ScriptDir\setup-scheduled-task.ps1`" -RunNow"
    Write-Host "  Disable:        powershell -File `"$ScriptDir\setup-scheduled-task.ps1`" -Disable"
    Write-Host "  Enable:         powershell -File `"$ScriptDir\setup-scheduled-task.ps1`" -Enable"
    Write-Host "============================================================" -ForegroundColor Cyan
} else {
    Write-Error "Failed to verify registered scheduled task."
    exit 1
}
