# patch-platform.ps1 — expose the 'autonomy' settings namespace to the web client.
#
# DeepSeek Harness rc.6 serves client-facing settings only for an explicit
# allowlist (WEB_SETTINGS_NAMESPACES in dsh-host-apiproxy); a third-party
# namespace answers `settings-not-exposed` and the autonomy slider would read
# "unavailable". There is no official extension point yet, so this script adds
# "autonomy" to the allowlist of the installed package. Idempotent; re-run
# after a dsh upgrade that reinstalled the package.
#
# The file is edited at BYTE level (ASCII needles only): the installed file
# may already contain non-UTF-8 bytes (a legacy ANSI round-trip can corrupt
# comment characters), so any text-level read/write would re-encode and
# damage it further. Byte-level edits leave every non-ASCII byte untouched.
$ErrorActionPreference = 'Stop'

$apiproxy = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js'
if (-not (Test-Path $apiproxy)) {
  $alt = Join-Path $HOME 'AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js'
  if (-not (Test-Path $alt)) { throw "dsh-host-apiproxy not found at $apiproxy or $alt" }
  $apiproxy = $alt
}

$bytes = [System.IO.File]::ReadAllBytes($apiproxy)
$ascii = [System.Text.Encoding]::ASCII

# Locate the array block boundaries by byte needles.
$openNeedle = $ascii.GetBytes('const WEB_SETTINGS_NAMESPACES = [')
$openIdx = -1
for ($i = 0; $i -le $bytes.Length - $openNeedle.Length; $i++) {
  $match = $true
  for ($k = 0; $k -lt $openNeedle.Length; $k++) { if ($bytes[$i + $k] -ne $openNeedle[$k]) { $match = $false; break } }
  if ($match) { $openIdx = $i + $openNeedle.Length - 1; break }
}
if ($openIdx -lt 0) { throw "WEB_SETTINGS_NAMESPACES declaration not found in $apiproxy — manual patch needed" }

$closeIdx = -1
for ($i = $openIdx + 1; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -eq 0x5D) { $closeIdx = $i; break } } # ']'
if ($closeIdx -lt 0) { throw "WEB_SETTINGS_NAMESPACES block not found in $apiproxy — manual patch needed" }

# Already patched (ASCII-safe scan of the block only)?
$block = $ascii.GetString($bytes, $openIdx, $closeIdx - $openIdx + 1)
if ($block.Contains('"autonomy"')) {
  Write-Host "already patched: WEB_SETTINGS_NAMESPACES contains autonomy ($apiproxy)"
  exit 0
}

# The last non-whitespace byte before ']' — if it is not a comma, add one
# right after it so the new entry keeps valid JS.
$lastIdx = $closeIdx - 1
while ($lastIdx -gt $openIdx -and ($bytes[$lastIdx] -eq 0x20 -or $bytes[$lastIdx] -eq 0x09 -or $bytes[$lastIdx] -eq 0x0A -or $bytes[$lastIdx] -eq 0x0D)) { $lastIdx-- }
$needsComma = $bytes[$lastIdx] -ne 0x2C # ','

$entry = "`n`t" + '"autonomy"'
$insert = if ($needsComma) { ',' + $entry } else { $entry }

$out = New-Object byte[] ($bytes.Length + $insert.Length)
[Array]::Copy($bytes, 0, $out, 0, $closeIdx)
$insertBytes = $ascii.GetBytes($insert)
[Array]::Copy($insertBytes, 0, $out, $closeIdx, $insertBytes.Length)
[Array]::Copy($bytes, $closeIdx, $out, $closeIdx + $insertBytes.Length, $bytes.Length - $closeIdx)

[System.IO.File]::WriteAllBytes($apiproxy, $out)
Write-Host "patched: added `"autonomy`" to WEB_SETTINGS_NAMESPACES in $apiproxy"
Write-Host 'Restart the host for the allowlist to take effect.'
