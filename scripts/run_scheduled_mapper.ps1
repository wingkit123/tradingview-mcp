# PowerShell Runner for Scheduled XAUUSD Auto-Mapper
[CmdletBinding()]
param (
    [Parameter()]
    [ValidateSet('diff', 'capture-only', 'force-refresh')]
    [string]$Mode = 'diff',

    [Parameter()]
    [switch]$NoLaunchBrowser
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $ScriptDir 'run-daily.ps1'

$ArgsList = @('-Mode', $Mode)
if ($NoLaunchBrowser) { $ArgsList += '-NoLaunchBrowser' }

& $Runner @ArgsList
exit $LASTEXITCODE
