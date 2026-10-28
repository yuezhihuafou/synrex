param(
    [Parameter(Mandatory = $true)][string]$PlatformRoot,
    [Parameter(Mandatory = $true)][string]$RuntimePackagePath,
    [Parameter(Mandatory = $true)][string]$SlotName,
    [Parameter(Mandatory = $true)][string]$SourceRevision,
    [string]$NodeSourceSlot = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PlatformRoot).TrimEnd('\')
$package = [IO.Path]::GetFullPath($RuntimePackagePath)
$runtime = Join-Path $root 'runtime'
$slots = Join-Path $runtime 'slots'
$slot = Join-Path $slots $SlotName
$preparing = $slot + '.preparing'
$activePointer = Join-Path $runtime 'active-slot.txt'
$currentActive = if (Test-Path -LiteralPath $activePointer -PathType Leaf) {
    (Get-Content -Raw -LiteralPath $activePointer).Trim()
} else {
    ''
}
$buildFreeSpaceReserveBytes = 512MB

function Get-DirectoryBytes([string]$path) {
    if (!(Test-Path -LiteralPath $path -PathType Container)) { return [long]0 }
    $measurement = Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction Stop |
        Measure-Object -Property Length -Sum
    if ($null -eq $measurement.Sum) { return [long]0 }
    return [long]$measurement.Sum
}

if ($SlotName -ne [IO.Path]::GetFileName($SlotName) -or -not $SlotName.StartsWith('synrex-windows-')) {
    throw "Invalid Synrex Windows slot name: $SlotName"
}
if ([string]::IsNullOrWhiteSpace($SourceRevision)) {
    throw 'SourceRevision is required for Windows slot provenance.'
}
if (-not [string]::IsNullOrWhiteSpace($currentActive) -and $SlotName -eq $currentActive) {
    throw "Refusing to replace the active runtime slot: $SlotName"
}
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) {
    throw "Synrex runtime package was not found: $package"
}
if ((Test-Path -LiteralPath $slot) -and -not $Force) {
    throw "Runtime slot already exists: $slot"
}

$manifestText = (& tar.exe -xOf $package 'package/package.json' | Out-String)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($manifestText)) {
    throw "Unable to read package/package.json from: $package"
}
$manifest = $manifestText | ConvertFrom-Json
if ($manifest.name -ne 'synrex') {
    throw "Unexpected runtime package name: $($manifest.name)"
}
if ($manifest.dependencies.koffi -ne '3.2.1') {
    throw "Synrex package must pin koffi 3.2.1 before a Windows slot can be prepared."
}

if ([string]::IsNullOrWhiteSpace($NodeSourceSlot)) {
    if ([string]::IsNullOrWhiteSpace($currentActive)) {
        throw 'No active runtime slot is available as the Node.js source.'
    }
    $NodeSourceSlot = $currentActive
}
if ($NodeSourceSlot -ne [IO.Path]::GetFileName($NodeSourceSlot)) {
    throw "Invalid Node source slot name: $NodeSourceSlot"
}
$nodeSource = Join-Path $slots (Join-Path $NodeSourceSlot 'node')
$sourceNode = Join-Path $nodeSource 'node.exe'
$sourceNpm = Join-Path $nodeSource 'node_modules\npm\bin\npm-cli.js'
foreach ($required in @($sourceNode, $sourceNpm)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Node source slot is incomplete: $required"
    }
}
$nodeVersion = (& $sourceNode --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v22.22.3') {
    throw "Unexpected Node source version: $nodeVersion"
}

New-Item -ItemType Directory -Force $slots | Out-Null
Remove-Item -LiteralPath $preparing -Recurse -Force -ErrorAction SilentlyContinue
$sourceSlotRoot = Split-Path -Parent $nodeSource
$sourceSlotBytes = Get-DirectoryBytes $sourceSlotRoot
$drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
$minimumFree = $sourceSlotBytes + $buildFreeSpaceReserveBytes
if ($drive.AvailableFreeSpace -lt $minimumFree) {
    throw ('Insufficient disk space to prepare a new Synrex Windows runtime slot. ' +
        'free=' + $drive.AvailableFreeSpace + ' sourceSlotBytes=' + $sourceSlotBytes +
        ' reserve=' + $buildFreeSpaceReserveBytes + '. Prune superseded slots or other disposable files before retrying.')
}
New-Item -ItemType Directory -Force $preparing | Out-Null

try {
    Write-Host "1/4 Copying verified Node.js from runtime slot $NodeSourceSlot ..."
    $nodeTarget = Join-Path $preparing 'node'
    & robocopy.exe $nodeSource $nodeTarget /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Node runtime copy failed with code $LASTEXITCODE" }

    Write-Host '2/4 Installing the packed Synrex runtime and production dependencies ...'
    $devspace = Join-Path $preparing 'devspace'
    New-Item -ItemType Directory -Force $devspace | Out-Null
    Copy-Item -LiteralPath $package -Destination (Join-Path $devspace 'devspace-runtime.tgz') -Force
    $compatManifest = @{
        private = $true
        dependencies = @{ '@waishnav/devspace' = 'file:devspace-runtime.tgz' }
    } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
        (Join-Path $devspace 'package.json'),
        $compatManifest + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )

    $node = Join-Path $nodeTarget 'node.exe'
    $npm = Join-Path $nodeTarget 'node_modules\npm\bin\npm-cli.js'
    $previousPath = $env:PATH
    try {
        # npm lifecycle scripts must use the slot's Node.js, not a newer Node
        # from the host PATH, otherwise native addons can be built for the
        # wrong NODE_MODULE_VERSION and fail only after activation.
        $env:PATH = $nodeTarget + [IO.Path]::PathSeparator + $previousPath
        # Run npm from the runtime root itself. Using --prefix while the shell
        # remains in a Synrex source checkout can make npm link that checkout
        # back into node_modules/synrex, which creates a non-portable slot.
        Push-Location $devspace
        try {
            & $node $npm install --omit=dev --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw "Synrex runtime npm install failed with code $LASTEXITCODE" }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:PATH = $previousPath
    }

    $unexpectedSourceLink = Join-Path $devspace 'node_modules\synrex'
    if (Test-Path -LiteralPath $unexpectedSourceLink) {
        $link = Get-Item -LiteralPath $unexpectedSourceLink -Force
        if (($link.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Runtime installation is not self-contained; unexpected source link: $unexpectedSourceLink -> $($link.Target -join ',')"
        }
    }

    Write-Host '3/4 Verifying Synrex, Koffi 3.2.1, and the Win32 native package ...'
    $packageRoot = Join-Path $devspace 'node_modules\@waishnav\devspace'
    $installedManifestPath = Join-Path $packageRoot 'package.json'
    $koffiManifestPath = Join-Path $devspace 'node_modules\koffi\package.json'
    $koffiNativeManifestPath = Join-Path $devspace 'node_modules\@koromix\koffi-win32-x64\package.json'
    $koffiNativeBinary = Join-Path $devspace 'node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node'
    foreach ($required in @($installedManifestPath, $koffiManifestPath, $koffiNativeManifestPath, $koffiNativeBinary)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required Windows runtime asset is missing: $required"
        }
    }
    $installed = Get-Content -Raw -LiteralPath $installedManifestPath | ConvertFrom-Json
    $koffi = Get-Content -Raw -LiteralPath $koffiManifestPath | ConvertFrom-Json
    $koffiNative = Get-Content -Raw -LiteralPath $koffiNativeManifestPath | ConvertFrom-Json
    if ($installed.name -ne 'synrex' -or $installed.version -ne $manifest.version) {
        throw "Unexpected installed Synrex package: $($installed.name) $($installed.version)"
    }
    if ($koffi.version -ne '3.2.1' -or $koffiNative.version -ne '3.2.1') {
        throw "Unexpected Koffi package versions: core=$($koffi.version) native=$($koffiNative.version)"
    }

    $sqliteSmoke = @'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('create table smoke(value integer); insert into smoke values (1)');
const row = db.prepare('select value from smoke').get();
db.close();
if (row?.value !== 1) throw new Error('better-sqlite3 smoke failed');
console.log(`better-sqlite3=ok abi=${process.versions.modules}`);
'@
    $koffiSmoke = @'
import koffi from 'koffi';
const kernel32 = koffi.load('kernel32.dll');
const getCurrentProcessId = kernel32.func('uint32_t GetCurrentProcessId()');
const pid = getCurrentProcessId();
if (!Number.isInteger(pid) || pid <= 0) throw new Error('Koffi Win32 call failed');
console.log(`koffi-win32=ok pid=${pid}`);
'@
    Push-Location $devspace
    try {
        & $node -e $sqliteSmoke
        if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 native smoke failed.' }
        & $node --input-type=module -e $koffiSmoke
        if ($LASTEXITCODE -ne 0) { throw 'Koffi kernel32.dll smoke failed.' }
    }
    finally { Pop-Location }

    Write-Host '4/4 Writing immutable slot metadata after native validation ...'
    $packageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    $metadata = [ordered]@{
        slot = $SlotName
        synrex = [string]$installed.version
        revision = $SourceRevision
        packageSha256 = $packageSha256
        node = $nodeVersion.TrimStart('v')
        nodeSourceSlot = $NodeSourceSlot
        platform = 'windows-x64'
        koffi = '3.2.1'
        rollbackSlot = $currentActive
        builtAt = [DateTime]::UtcNow.ToString('o')
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $preparing 'slot.json') -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $preparing 'READY') -Value ([string]$installed.version) -Encoding ASCII

    if ($Force) { Remove-Item -LiteralPath $slot -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $preparing -Destination $slot
    Write-Host "Synrex Windows runtime slot ready: $slot"
    Write-Host 'The active runtime selection was not changed.'
}
catch {
    Write-Host 'Synrex Windows slot preparation failed; active runtime is unchanged.' -ForegroundColor Yellow
    throw
}
