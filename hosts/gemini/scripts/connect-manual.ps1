$ErrorActionPreference = "Stop"

if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
  throw "Run this command from a private interactive terminal."
}

& gemini extensions config parley PARLEY_TOKEN --scope user
if ($LASTEXITCODE -ne 0) {
  throw "Gemini did not update the Parley recovery setting."
}
