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
$helper = Join-Path $PSScriptRoot "space-headers.mjs"
$nodePath = Resolve-ParleyNodeExecutable
$secureToken = Read-Host "Parley manual token" -AsSecureString
$bstr = [IntPtr]::Zero
$token = $null

try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $nodePath
  $processInfo.Arguments = ('"{0}" claude manual --helper-source "{1}"' -f $manager, $helper)
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  [void]$process.Start()
  $process.StandardInput.WriteLine($token)
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Parley Claude configuration could not be updated."
  }
} finally {
  $token = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
