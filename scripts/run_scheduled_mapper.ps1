# PowerShell Runner for Scheduled XAUUSD Auto-Mapper
[CmdletBinding()]
param (
    [Parameter()]
    [ValidateSet('diff', 'capture-only', 'force-refresh')]
    [string]$Mode = 'capture-only',

    [Parameter()]
    [switch]$NoLaunchBrowser,

    [Parameter()]
    [switch]$AllowMutation
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $ScriptDir 'run-daily.ps1'

$RunnerParams = @{
    Mode = $Mode
    RequireTradingDay = $true
}
if ($NoLaunchBrowser) { $RunnerParams.NoLaunchBrowser = $true }
if ($AllowMutation) { $RunnerParams.AllowMutation = $true }

& $Runner @RunnerParams
exit $LASTEXITCODE
