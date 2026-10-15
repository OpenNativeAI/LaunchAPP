Get-Process | Where-Object { $_.ProcessName -match 'app-builder|node|electron|launchapp|7z' } | ForEach-Object { Write-Output ("{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.Path) }
