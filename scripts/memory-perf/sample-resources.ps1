$ErrorActionPreference = 'Stop'
$settings = $env:TSP_PERF_SAMPLE | ConvertFrom-Json
$targetIds = @($settings.pids | ForEach-Object { [int]$_ })
$outputPath = [IO.Path]::GetFullPath([string]$settings.outputPath)
$stopPath = $outputPath + '.stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
while (-not (Test-Path -LiteralPath $stopPath)) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount,ReadTransferCount,WriteTransferCount,ReadOperationCount,WriteOperationCount)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($id in $targetIds) { [void]$ids.Add($id) }
    foreach ($process in $processes) { if ($process.Name -match '^ollama') { [void]$ids.Add([int]$process.ProcessId) } }
    do {
      $added = $false
      foreach ($process in $processes) { if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true } }
    } while ($added)
    $selected = @($processes | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object {
      [ordered]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name;
        createdAt=$_.CreationDate.ToUniversalTime().ToString('o'); cpu100ns=([double]$_.KernelModeTime+[double]$_.UserModeTime);
        workingSetBytes=[double]$_.WorkingSetSize; privateBytes=[double]$_.PrivatePageCount;
        readTransferBytes=[double]$_.ReadTransferCount; writeTransferBytes=[double]$_.WriteTransferCount;
        readOperations=[double]$_.ReadOperationCount; writeOperations=[double]$_.WriteOperationCount }
    })
    $system = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize
    $gpu = $null
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
      $gpu = @(& nvidia-smi --query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total --format=csv,noheader,nounits 2>$null | ForEach-Object {
        $parts = $_ -split ',\s*'
        if ($parts.Count -eq 5) { [ordered]@{ index=[int]$parts[0]; utilizationPercent=[double]$parts[1]; memoryUtilizationPercent=[double]$parts[2]; memoryUsedMiB=[double]$parts[3]; memoryTotalMiB=[double]$parts[4] } }
      })
    }
    $value = [ordered]@{ at=[DateTime]::UtcNow.ToString('o'); collectionMs=$clock.ElapsedMilliseconds;
      freeMemoryKiB=[double]$system.FreePhysicalMemory; totalMemoryKiB=[double]$system.TotalVisibleMemorySize;
      processes=$selected; gpu=$gpu }
    [IO.File]::AppendAllText($outputPath, (($value | ConvertTo-Json -Depth 7 -Compress) + [Environment]::NewLine), $utf8)
  } catch {
    $failure = @{ at=[DateTime]::UtcNow.ToString('o'); sampleError='resource_sample_failed' } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($outputPath, ($failure + [Environment]::NewLine), $utf8)
  }
  Start-Sleep -Milliseconds 2000
}
