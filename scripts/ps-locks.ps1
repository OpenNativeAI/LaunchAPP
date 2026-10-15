Get-Process | Where-Object { ($_.Path -like 'D:\Desktop\project\LaunchApp\dist*') -or ($_.ProcessName -like 'launchapp*') } | ForEach-Object { Write-Output ("{0} {1} {2}" -f $_.Id, $_.ProcessName, $_.Path) }
Write-Output "--- dist contents ---"
Get-ChildItem D:\Desktop\project\LaunchApp\dist -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_.Name }
