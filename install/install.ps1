# agent-browser-guard, per-person install for Windows. No administrator rights.
#
#   Install or update:   powershell -ExecutionPolicy Bypass -File install\install.ps1
#   Check only:          powershell -ExecutionPolicy Bypass -File install\install.ps1 -CheckOnly
#   Without registering: powershell -ExecutionPolicy Bypass -File install\install.ps1 -NoRegister
#
# What it does: copies the tool to %LOCALAPPDATA%\AgentBrowserGuard\<version>, fetches its one
# dependency (Microsoft's Playwright MCP server) and Playwright's own Chromium, registers the tool
# server "agent-browser" in Claude Code and Codex (when installed) and runs a check.
# It needs Node.js 18 or newer. It never touches your Chrome or Edge or their profiles.
param([switch]$CheckOnly, [switch]$NoRegister, [string]$Root = (Join-Path $env:LOCALAPPDATA 'AgentBrowserGuard'))
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$name = 'agent-browser'
function Say($text) { Write-Host $text }
# Runs a command-line program and returns its exit code; its output goes to the log file.
function Quiet { $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; $rest = @($args | Select-Object -Skip 1); try { & $args[0] @rest 2>&1 | Out-File -Append -Encoding utf8 $script:Log; return $LASTEXITCODE } finally { $ErrorActionPreference = $old } }
function Check($folder) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $line = (& node (Join-Path $folder 'agent-browser-guard.mjs') check 2>&1 | Select-Object -Last 1); return "$line" } finally { $ErrorActionPreference = $old }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$script:Log = Join-Path $Root 'install.log'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Say 'NOT OK: Node.js is not installed. Get the LTS version from https://nodejs.org (the installer for your own account is enough), then run this script again.'; exit 1 }
$major = [int]((& node --version) -replace '^v(\d+)\..*$', '$1')
if ($major -lt 18) { Say "NOT OK: Node.js $major is too old; version 18 or newer is needed."; exit 1 }

if ($CheckOnly) {
    $current = Join-Path $Root 'current.txt'
    if (-not (Test-Path $current)) { Say 'NOT OK: agent-browser-guard is not installed for this user.'; exit 1 }
    $result = Check (Get-Content $current -TotalCount 1)
    Say $result; exit $(if ($result.StartsWith('OK')) { 0 } else { 1 })
}

$version = (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^[0-9A-Za-z.\-]{1,30}$') { throw "package.json has no usable version: '$version'" }
$target = Join-Path $Root $version
$previous = if (Test-Path (Join-Path $Root 'current.txt')) { Get-Content (Join-Path $Root 'current.txt') -TotalCount 1 } else { $null }
Say "agent-browser-guard $version -> $target"
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in 'agent-browser-guard.mjs', 'package.json', 'package-lock.json', 'lib', 'guard', 'LICENSE', 'README.md') {
    $from = Join-Path $source $item
    if (Test-Path $from) { Copy-Item -Recurse $from $target }
}
Get-ChildItem -Recurse -File $target | Unblock-File

Say '  Fetching the Playwright MCP server (npm)...'
Push-Location $target
try {
    if ((Quiet npm ci --omit=dev --no-audit --no-fund) -ne 0) { Say "NOT OK: npm could not fetch the dependency. Details: $script:Log"; exit 1 }
    Say '  Fetching Playwright''s own Chromium (about 150 MB the first time)...'
    if ((Quiet npx --no-install playwright install chromium) -ne 0) { Say "NOT OK: the Chromium download failed. Details: $script:Log"; exit 1 }
} finally { Pop-Location }

$result = Check $target
if (-not $result.StartsWith('OK')) {
    Remove-Item -Recurse -Force $target
    Say $result; Say 'Nothing was changed: the previous version (if any) is still the registered one.'; exit 1
}
Set-Content -Path (Join-Path $Root 'current.txt') -Value $target -Encoding UTF8
Get-ChildItem -Directory $Root | Where-Object { $_.FullName -ne $target -and $_.FullName -ne $previous } | ForEach-Object { try { Remove-Item -Recurse -Force $_.FullName } catch {} }

if ($NoRegister) { Say '  Not registered (-NoRegister).' }
else {
    $script = Join-Path $target 'agent-browser-guard.mjs'; $where = @()
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Quiet claude mcp remove $name -s user | Out-Null
        if ((Quiet claude mcp add -s user $name '--' node $script mcp) -eq 0) { $where += 'Claude Code' } else { Say '  Claude Code: registration FAILED.' }
    } else { Say '  Claude Code is not installed on this PC: skipped.' }
    if (Get-Command codex -ErrorAction SilentlyContinue) {
        Quiet codex mcp remove $name | Out-Null
        if ((Quiet codex mcp add $name '--' node $script mcp) -eq 0) { $where += 'Codex' } else { Say '  Codex: registration FAILED.' }
    } else { Say '  Codex is not installed on this PC: skipped.' }
    if ($where.Count -gt 0) { Say "  Registered as tool server `"$name`" in: $($where -join ', ')." } else { Say '  Registered nowhere.' }
}
Say $result
Say "To sign in to a site yourself:  node `"$(Join-Path $target 'agent-browser-guard.mjs')`" sign-in https://..."
