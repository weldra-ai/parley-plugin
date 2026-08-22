param(
  [switch]$OAuth
)

$ErrorActionPreference = "Stop"
$manager = Join-Path $PSScriptRoot "managed-config.mjs"

if ($OAuth) {
  & node $manager codex oauth
  if ($LASTEXITCODE -ne 0) {
    throw "Parley Codex OAuth configuration could not be restored."
  }
  return
}

if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
  throw "Run this command from a private interactive terminal."
}

$secureToken = Read-Host "Parley manual token" -AsSecureString
$bstr = [IntPtr]::Zero
$token = $null

try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "node"
  $processInfo.Arguments = ('"{0}" codex manual' -f $manager)
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardInput = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  [void]$process.Start()
  $process.StandardInput.WriteLine($token)
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Parley Codex configuration could not be updated."
  }
} finally {
  $token = $null
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
