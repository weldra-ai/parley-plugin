$ErrorActionPreference = "Stop"

$manager = Join-Path $PSScriptRoot "managed-config.mjs"
& node $manager claude oauth
if ($LASTEXITCODE -ne 0) {
  throw "Parley Claude OAuth could not be restored."
}
