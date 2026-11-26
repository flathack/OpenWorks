$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 12
$computer = Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 12
$bios = Get-CimInstance Win32_BIOS -OperationTimeoutSec 12 -ErrorAction SilentlyContinue
$cpu = Get-CimInstance Win32_Processor -OperationTimeoutSec 12 -ErrorAction SilentlyContinue | Select-Object -First 1
$ips = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    ForEach-Object { $_.Address.IPAddressToString } | Select-Object -Unique -First 32
@{
    hostname = $env:COMPUTERNAME; os = [string]$os.Caption
    architecture = [string](@{0='x86'; 5='ARM'; 9='x64'; 12='ARM64'}[[int]$cpu.Architecture]); build = [string]$os.BuildNumber
    manufacturer = [string]$computer.Manufacturer; model = [string]$computer.Model
    serial = [string]$bios.SerialNumber; cpu = [string]$cpu.Name
    memory = ('{0:N1} GiB' -f ($computer.TotalPhysicalMemory / 1GB))
    boot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
    user = [string]$computer.UserName; ips = $ips -join ', '
} | ConvertTo-Json -Compress
