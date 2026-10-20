param([int]$ParentProcessId,[int]$BrowserProcessId,[string]$Profile)
$ErrorActionPreference = 'Stop'
try {
  $ownedBrowser = Get-Process -Id $BrowserProcessId -ErrorAction SilentlyContinue
  if (-not $ownedBrowser) { exit 0 }
  $browserStart = $ownedBrowser.StartTime.ToUniversalTime().Ticks
  $ownedParent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
  $parentStart = if ($ownedParent) { $ownedParent.StartTime.ToUniversalTime().Ticks } else { 0 }
  while ($true) {
    $browser = Get-Process -Id $BrowserProcessId -ErrorAction SilentlyContinue
    if (-not $browser -or $browser.StartTime.ToUniversalTime().Ticks -ne $browserStart) { exit 0 }
    $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if (-not $parent -or $parent.StartTime.ToUniversalTime().Ticks -ne $parentStart) {
      # Verify the unique task profile before terminating this exact process.
      $binding = Get-CimInstance Win32_Process -Filter "ProcessId=$BrowserProcessId"
      if ($binding.CommandLine -and $binding.CommandLine.Contains($Profile)) {
        Stop-Process -Id $BrowserProcessId -ErrorAction SilentlyContinue
      }
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }
} catch { exit 1 }
