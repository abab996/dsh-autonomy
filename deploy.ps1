# deploy.ps1 — install dsh-autonomy (host) + dsh-autonomy-client (web) into the web profile.
# Run from this directory. Uses npm (pnpm is not required).
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

# 2. Install into the web profile (npm adds local file: deps to the profile package.json)
Write-Host "installing into $profileDir"
Push-Location $profileDir
npm install (Join-Path $root 'packages\dsh-autonomy') (Join-Path $root 'packages\dsh-autonomy-client') --no-audit --no-fund --cache (Join-Path $root '.npm-cache')
Pop-Location

# 3. Enable host + client plugins in the profile's user patch layer
$patch = Join-Path $profileDir 'cordis.patch.yml'
$rows = @(
  '',
  '- insert:',
  '    - id: autonomy',
  '      name: dsh-autonomy',
  '    - id: autonomy-client',
  '      name: dsh-autonomy-client'
)
$existing = if (Test-Path $patch) { @(Get-Content $patch) } else { @('[]') }
if (($existing -join "`n") -notmatch 'name: dsh-autonomy') {
  # Drop the template's standalone `[]` placeholder line (it may sit below
  # comment lines), then append our entries.
  $content = @($existing | Where-Object { $_.Trim() -ne '[]' }) + $rows
  Set-Content -Path $patch -Value $content
}

# 4. Expose the 'autonomy' settings namespace to the web client (dsh rc.6 serves
#    only allowlisted namespaces). A dsh upgrade overwrites the installed copy,
#    so re-run this script after upgrading dsh.
& (Join-Path $root 'patch-platform.ps1')

Write-Host ''
Write-Host 'dsh-autonomy deployed. Restart the host, then use the 自主性 slider'
Write-Host 'next to the model switcher (per-session, applies to the next message).'
