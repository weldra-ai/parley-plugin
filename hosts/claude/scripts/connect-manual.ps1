$ErrorActionPreference = "Stop"

$manager = Join-Path $PSScriptRoot "managed-config.mjs"
$helper = Join-Path $PSScriptRoot "space-headers.mjs"
$secureToken = Read-Host "Parley manual token" -AsSecureString
$bstr = [IntPtr]::Zero
$token = $null

try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "node"
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
