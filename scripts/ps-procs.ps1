Get-Process | Where-Object { $_.ProcessName -match 'electron|launchapp' } | ForEach-Object { Write-Output ("{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.Path) }
