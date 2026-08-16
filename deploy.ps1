# deploy.ps1 — install dsh-autonomy into the web profile the official way:
# `dsh plugin --profile web add` (pnpm + automatic bundle-layer reconcile).
# Run from this directory.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $DSH_HOME 'profiles\web'

# 1. Build both packages (dsh-autonomy-client's build also emits the browser
#    bundle in the ModuleLoader handoff format via build-client.mjs)
foreach ($p in 'dsh-autonomy', 'dsh-autonomy-client') {
  Write-Host "building $p"
  Push-Location (Join-Path $root "packages\$p")
  npm run build | Out-Null
  Pop-Location
}

# 2. Install through the official plugin channel. pnpm installs the package
#    (and its dsh-autonomy-client dependency), then `dsh` reconciles the
#    profile's bundle layer list — a dependency declaring `dsh.bundle.patch`
#    (this package does) joins the layer stack automatically, so the plugin
#    rows in packages/dsh-autonomy/cordis.patch.yml become active.
#    BOTH packages are added as direct dependencies: pnpm normalizes a
#    directly-added local path to `link:` (a junction to the source tree, so
#    rebuilds reflect immediately), while a transitive file: dependency
#    snapshots into the store and would NOT track source edits. The client
#    package would otherwise be installed only as dsh-autonomy's dependency
#    and go stale after every rebuild.
Write-Host "installing via dsh plugin --profile web add"
& dsh plugin --profile web add (Join-Path $root 'packages\dsh-autonomy') (Join-Path $root 'packages\dsh-autonomy-client')
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

# 3. Remove the legacy user-layer rows written by deploy.ps1 v1 (before the
#    bundle rewrite). Without this, the rows would exist in BOTH the bundle
#    layer and the user patch layer after a restart — a duplicate
#    registration that fails to boot. Byte-level edit: the file may contain
#    non-UTF-8 bytes, so no text-level round-trip is performed.
$patch = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patch) {
  $bytes = [System.IO.File]::ReadAllBytes($patch)
  $ascii = [System.Text.Encoding]::ASCII
  $lines = New-Object System.Collections.Generic.List[byte[]]
  $start = 0
  for ($i = 0; $i -le $bytes.Length; $i++) {
    if ($i -eq $bytes.Length -or $bytes[$i] -eq 0x0A) {
      $len = $i - $start
      if ($len -gt 0 -and $bytes[$i - 1] -eq 0x0D) { $len-- }
      $line = New-Object byte[] $len
      [Array]::Copy($bytes, $start, $line, 0, $len)
      $lines.Add($line)
      $start = $i + 1
    }
  }
  $texts = $lines | ForEach-Object { $ascii.GetString($_) }
  $drop = New-Object System.Collections.Generic.List[bool]
  for ($j = 0; $j -lt $texts.Count; $j++) { $drop.Add($false) }
  for ($j = 0; $j -lt $texts.Count; $j++) {
    $t = $texts[$j]
    if ($t -match 'id: autonomy' -or $t -match 'name: dsh-autonomy' -or $t -match 'id: autonomy-client' -or $t -match 'name: dsh-autonomy-client') {
      $drop[$j] = $true
      if ($j -gt 0 -and $texts[$j - 1].Trim() -eq '- insert:') { $drop[$j - 1] = $true }
    }
  }
  # Collapse runs of blank lines to one (the removed block left gaps).
  # NOTE: iterate the List[byte[]] by index and copy byte-by-byte — `$kept +=
  # $lines[$j]` and `AddRange($line)` both hit PowerShell's collection
  # unrolling (a byte[] degrades to a single byte), corrupting the output.
  $out = New-Object System.Collections.Generic.List[byte]
  $prevBlank = $false
  for ($j = 0; $j -lt $lines.Count; $j++) {
    if ($drop[$j]) { continue }
    $lineBytes = $lines[$j]
    $blank = $lineBytes.Length -eq 0
    if ($blank -and $prevBlank) { continue }
    $prevBlank = $blank
    for ($k = 0; $k -lt $lineBytes.Length; $k++) { $out.Add($lineBytes[$k]) }
    $out.Add(0x0A)
  }
  # Trim trailing blank lines.
  while ($out.Count -gt 0 -and ($out[$out.Count - 1] -eq 0x0A -or $out[$out.Count - 1] -eq 0x0D -or $out[$out.Count - 1] -eq 0x20)) {
    $out.RemoveAt($out.Count - 1)
  }
  $out.Add(0x0A)
  [System.IO.File]::WriteAllBytes($patch, $out.ToArray())
  Write-Host "legacy user-layer rows removed from $patch"
}

# 4. Expose the 'autonomy' settings namespace to the web client (dsh rc.6 serves
#    only allowlisted namespaces). A dsh upgrade overwrites the installed copy,
#    so re-run this script after upgrading dsh.
& (Join-Path $root 'patch-platform.ps1')

Write-Host ''
Write-Host 'dsh-autonomy deployed. Restart the host, then use the 自主性 slider'
Write-Host 'next to the model switcher (per-session, applies to the next message).'
