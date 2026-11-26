[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('device','user')][string]$Scope,
    [Parameter(Mandatory)][uri]$Server,
    [Parameter(Mandatory)][string]$Binary
)
$ErrorActionPreference = 'Stop'
if ($Server.Scheme -ne 'https' -and !($Server.Scheme -eq 'http' -and $Server.Host -in @('localhost','127.0.0.1','[::1]'))) {
    throw 'Für entfernte Server ist HTTPS erforderlich.'
}
if ($Server.AbsolutePath -ne '/' -or $Server.Query -or $Server.Fragment -or $Server.UserInfo) {
    throw 'Bitte nur die Serveradresse mit optionalem Port angeben.'
}
$source = (Resolve-Path -LiteralPath $Binary).Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isDevice = $Scope -eq 'device'
if ($isDevice) {
    if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Geräte-Agent in einer administrativen PowerShell einrichten.'
    }
    $dest = Join-Path $env:ProgramFiles 'OpenWorks\DeviceAgent'
    $taskName = 'OpenWorks-Device'
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
} else {
    $dest = Join-Path $env:LOCALAPPDATA 'OpenWorks\UserAgent'
    $taskName = 'OpenWorks-User-' + $identity.User.Value
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
}
$configPath = Join-Path $dest 'agent.json'
if (Test-Path -LiteralPath $configPath) { throw "Agent bereits eingerichtet: $dest" }
$null = New-Item -Path $dest -ItemType Directory -Force
if ($isDevice) {
    & icacls.exe $dest /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Agent-Verzeichnis konnte nicht geschützt werden.' }
}
$secret = Read-Host 'Agent-Token aus der OpenWorks-Konsole' -AsSecureString
$exe = Join-Path $dest 'openworks-agent.exe'
Copy-Item -LiteralPath $source -Destination $exe -Force
$config = @{ server=$Server.GetLeftPart([UriPartial]::Authority); scope=$Scope; token=[Net.NetworkCredential]::new('', $secret).Password }
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Queue -ExecutionTimeLimit (New-TimeSpan -Hours 4)
function Register-SyncTask($eventName, $trigger) {
    $action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}" {1}' -f $configPath, $eventName)
    Register-ScheduledTask -TaskName "$taskName-$eventName" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
$registered = @()
try {
    if ($isDevice) {
        Register-SyncTask 'boot' (New-ScheduledTaskTrigger -AtStartup)
        $registered += 'boot'
        $login = New-ScheduledTaskTrigger -AtLogOn
    } else {
        $login = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    }
    Register-SyncTask 'login' $login
    $registered += 'login'
    Register-SyncTask 'poll' (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
    $registered += 'poll'
    Start-ScheduledTask -TaskName "$taskName-poll"
} catch {
    foreach ($eventName in $registered) { Unregister-ScheduledTask -TaskName "$taskName-$eventName" -Confirm:$false }
    Remove-Item -LiteralPath $configPath
    throw
}
Write-Host "Agent eingerichtet: $dest"
