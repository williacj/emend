# ABOUTME: Samples aggregate CPU and physical-disk pressure for a bounded Windows contention run.
# ABOUTME: Stops only when its caller creates the unique stop marker supplied for this process.

param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$StopPath
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType File -Path $OutputPath -Force | Out-Null

while (-not (Test-Path -LiteralPath $StopPath)) {
  try {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    @{
      timestamp = (Get-Date).ToUniversalTime().ToString('o')
      cpuPercent = [double]$cpu.PercentProcessorTime
      diskQueueLength = [double]$disk.CurrentDiskQueueLength
      diskPercent = [double]$disk.PercentDiskTime
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $OutputPath -Encoding UTF8
  }
  catch {
    @{
      timestamp = (Get-Date).ToUniversalTime().ToString('o')
      error = $_.Exception.Message
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $OutputPath -Encoding UTF8
  }
  Start-Sleep -Seconds 5
}
