# GiNi - stop the API, engine and both apps (MongoDB keeps running; your data stays saved).
$stopped = 0
foreach ($port in 5000, 5173, 5174) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; $stopped++
    }
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'gini_engine' -and $_.Name -match '^(python|py)' } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++
}
Write-Host "Stopped $stopped process(es). You can close the GiNi windows."
