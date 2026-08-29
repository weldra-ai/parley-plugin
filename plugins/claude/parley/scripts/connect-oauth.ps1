$ErrorActionPreference = "Stop"

function Resolve-ParleyNodeExecutable {
  $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  if ([String]::IsNullOrWhiteSpace($pathValue)) {
    throw "Node.js was not found on PATH."
  }
  $workingDirectory = (Get-Item -LiteralPath ([Environment]::CurrentDirectory) -Force).FullName
  foreach ($rawDirectory in $pathValue.Split([IO.Path]::PathSeparator)) {
    $directory = $rawDirectory.Trim().Trim('"')
    if ([String]::IsNullOrWhiteSpace($directory) -or -not [IO.Path]::IsPathRooted($directory)) {
      continue
    }
    try {
      $absoluteDirectory = [IO.Path]::GetFullPath($directory)
      $candidate = Join-Path $absoluteDirectory "node.exe"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $candidateItem = Get-Item -LiteralPath $candidate -Force
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($candidateItem.Directory.FullName, $workingDirectory)) {
          return $candidateItem.FullName
        }
      }
    } catch {
      continue
    }
  }
  throw "Node.js was not found in an absolute PATH directory outside the current project."
}

$manager = Join-Path $PSScriptRoot "managed-config.mjs"
$nodePath = Resolve-ParleyNodeExecutable
& $nodePath $manager claude oauth
if ($LASTEXITCODE -ne 0) {
  throw "Parley Claude OAuth could not be restored."
}
