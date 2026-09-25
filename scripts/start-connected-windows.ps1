$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.data\tools\node-v22.14.0-win-x64'
$postgresDirectory = Join-Path $projectRoot '.data\tools\postgresql17\pgsql\bin'
if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe'))) { throw 'Project Node 22 runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $postgresDirectory 'pg_ctl.exe'))) { throw 'Project PostgreSQL 17 runtime is missing.' }
$env:Path = "$nodeDirectory;$postgresDirectory;$env:Path"
$dataDirectory = Join-Path (Split-Path -Parent $projectRoot) 'teacher-platform-local-data'
Push-Location $projectRoot
try {
    & (Join-Path $nodeDirectory 'node.exe') 'scripts/start-connected-local.mjs' $dataDirectory
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
