[CmdletBinding()]
param([string]$Toolchain)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolArgs = @()
if ($Toolchain) { $toolArgs += "+$Toolchain" }
& cargo @toolArgs build --release --locked --manifest-path (Join-Path $root 'agent/Cargo.toml')
if ($LASTEXITCODE) { throw 'Rust-Build fehlgeschlagen.' }
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$out = Join-Path $root 'agent/target/release/OpenWorks-Apps.exe'
& $csc /nologo /target:winexe /platform:anycpu /codepage:65001 "/out:$out" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll (Join-Path $root 'agent/ui/Catalog.cs') (Join-Path $root 'agent/ui/Activity.cs')
if ($LASTEXITCODE) { throw 'Katalog-Build fehlgeschlagen.' }
Write-Output $out
