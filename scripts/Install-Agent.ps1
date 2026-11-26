[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('device','user')][string]$Scope,
    [uri]$Server,
    [Parameter(Mandatory)][string]$Binary,
    [SecureString]$Token,
    [switch]$Update
)
$ErrorActionPreference = 'Stop'
if (!$Update -and !$Server) { throw 'Serveradresse fehlt.' }
if ($Server -and $Server.Scheme -ne 'https' -and !($Server.Scheme -eq 'http' -and $Server.Host -in @('localhost','127.0.0.1','[::1]'))) {
    throw 'Für entfernte Server ist HTTPS erforderlich.'
}
if ($Server -and ($Server.AbsolutePath -ne '/' -or $Server.Query -or $Server.Fragment -or $Server.UserInfo)) {
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
$exe = Join-Path $dest 'openworks-agent.exe'
if (!$isDevice) {
    $guiSource = Join-Path (Split-Path -Parent $source) 'OpenWorks-Apps.exe'
    if (!(Test-Path -LiteralPath $guiSource -PathType Leaf)) { throw 'OpenWorks-Apps.exe neben der Agent-EXE bereitstellen (Build-Client.ps1).' }
}
function Install-Catalog {
    $gui = Join-Path $dest 'OpenWorks-Apps.exe'
    Copy-Item -LiteralPath $guiSource -Destination $gui -Force
    $menu = [Environment]::GetFolderPath('Programs')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'OpenWorks Anwendungen.lnk'))
    $shortcut.TargetPath = $gui
    $shortcut.WorkingDirectory = $dest
    $shortcut.Save()
}
if ($Update) {
    if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Vorhandene Registrierung fehlt.' }
    if (!$isDevice) { Install-Catalog }
    $staged = Join-Path $dest ('update-' + [Guid]::NewGuid() + '.exe')
    try {
        Copy-Item -LiteralPath $source -Destination $staged
        [IO.File]::Replace($staged, $exe, (Join-Path $dest 'agent.previous.exe'))
    } finally {
        if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
    }
    Start-ScheduledTask -TaskName "$taskName-poll"
    return
}
if (Test-Path -LiteralPath $configPath) { throw "Agent bereits eingerichtet: $dest" }
$null = New-Item -Path $dest -ItemType Directory -Force
if ($isDevice) {
    & icacls.exe $dest /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Agent-Verzeichnis konnte nicht geschützt werden.' }
}
if (!$Token) { $Token = Read-Host 'Agent-Token aus der OpenWorks-Konsole' -AsSecureString }
Copy-Item -LiteralPath $source -Destination $exe -Force
$config = @{ server=$Server.GetLeftPart([UriPartial]::Authority); scope=$Scope; token=[Net.NetworkCredential]::new('', $Token).Password }
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Queue -ExecutionTimeLimit (New-TimeSpan -Hours 4)
function Register-SyncTask($eventName, $trigger) {
    $action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}" {1}' -f $configPath, $eventName)
    Register-ScheduledTask -TaskName "$taskName-$eventName" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
$registered = @()
try {
    if (!$isDevice) { Install-Catalog }
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
