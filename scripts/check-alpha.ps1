Add-Type -AssemblyName System.Drawing
$f = "D:\Desktop\project\LaunchApp\scripts\icon-out\icon-128.png"
$bmp = New-Object System.Drawing.Bitmap($f)
foreach ($p in @(@(0.25,0.12),@(0.25,0.25),@(0.75,0.25),@(0.25,0.75),@(0.75,0.75),@(0.5,0.5),@(0,0))) {
  $x = [int]($bmp.Width * $p[0]); $y = [int]($bmp.Height * $p[1])
  $c = $bmp.GetPixel($x, $y)
  Write-Output ("($x,$y) A=$($c.A) R=$($c.R) G=$($c.G) B=$($c.B)")
}
$bmp.Dispose()
