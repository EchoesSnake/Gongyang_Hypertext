param(
  [int]$Port = 8000,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

function Test-PortOpen {
  param([int]$TestPort)
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $TestPort)
    $listener.Start()
    $listener.Stop()
    return $false
  } catch {
    return $true
  }
}

function Resolve-Python {
  $candidates = @("py", "python", "python3")
  foreach ($name in $candidates) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $cmd) {
      return $cmd.Source
    }
  }
  return $null
}

$projectRoot = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $projectRoot

$pythonExe = Resolve-Python
if ($null -eq $pythonExe) {
  Write-Host "Python not found. Please install Python first."
  exit 1
}

$selectedPort = $Port
if (Test-PortOpen -TestPort $selectedPort) {
  Write-Host "Port $selectedPort is already in use. Finding another port..."
  while (Test-PortOpen -TestPort $selectedPort) {
    $selectedPort += 1
  }
}

$escapedRoot = $projectRoot.Replace("'", "''")
$escapedPython = $pythonExe.Replace("'", "''")
$serverCommand = "Set-Location -LiteralPath '$escapedRoot'; & '$escapedPython' -m http.server $selectedPort"

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-Command", $serverCommand
) | Out-Null

$url = "http://localhost:$selectedPort/index.html"
if (-not $NoBrowser) {
  Start-Sleep -Milliseconds 700
  Start-Process $url | Out-Null
}

Write-Host "Server started."
Write-Host "Project: $projectRoot"
Write-Host "URL: $url"
Write-Host "Close the server PowerShell window to stop."
