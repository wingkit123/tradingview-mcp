# PowerShell Script to register or update Windows Scheduled Task for XAUUSD Auto-Mapper
param (
    [string]$TaskName = "XAUUSD-SNR-AutoMapper",
    [string]$DailyTime = "14:00" # 2:00 PM local time (Asia/Shanghai or GMT+8 before London session)
)

$scriptPath = "C:\Users\Wing Kit\Trading View PineScript\tradingview-mcp\scripts\run_scheduled_mapper.ps1"

if (-not (Test-Path $scriptPath)) {
    Write-Error "Runner script not found at $scriptPath"
    exit 1
}

Write-Host "=== Setting up Windows Scheduled Task: $TaskName ==="
Write-Host "Execution Time: Daily at $DailyTime"
Write-Host "Target Script : $scriptPath"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyTime
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "[SUCCESS] Scheduled Task '$TaskName' registered successfully!"
    Write-Host "To view or trigger task immediately, run:"
    Write-Host "  Get-ScheduledTask -TaskName '$TaskName'"
    Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
} catch {
    Write-Error "Failed to register scheduled task: $_"
}
