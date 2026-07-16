Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root "resources"
$output = Join-Path $resources "icon.png"
New-Item -ItemType Directory -Path $resources -Force | Out-Null

$size = 512
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$rect = New-Object System.Drawing.RectangleF(68, 61, 376, 376)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 112
$diameter = $radius * 2
$path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
$path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
$path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()

$start = [System.Drawing.Color]::FromArgb(255, 91, 132, 255)
$end = [System.Drawing.Color]::FromArgb(255, 49, 93, 229)
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  $start,
  $end,
  [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
)
$graphics.FillPath($gradient, $path)

$whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 26)
$whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$whitePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawCurve($whitePen, @(
  [System.Drawing.PointF]::new(161, 326),
  [System.Drawing.PointF]::new(173, 294),
  [System.Drawing.PointF]::new(180, 254),
  [System.Drawing.PointF]::new(180, 213)
))
$graphics.DrawCurve($whitePen, @(
  [System.Drawing.PointF]::new(142, 337),
  [System.Drawing.PointF]::new(184, 339),
  [System.Drawing.PointF]::new(222, 350),
  [System.Drawing.PointF]::new(253, 374)
))
$graphics.DrawCurve($whitePen, @(
  [System.Drawing.PointF]::new(185, 331),
  [System.Drawing.PointF]::new(211, 296),
  [System.Drawing.PointF]::new(229, 257),
  [System.Drawing.PointF]::new(237, 214)
))

function Draw-Sparkle {
  param(
    [System.Drawing.Graphics]$Canvas,
    [int]$CenterX,
    [int]$CenterY,
    [int]$Radius,
    [System.Drawing.Color]$Color
  )
  $narrow = [Math]::Max(7, [Math]::Floor($Radius / 3))
  $points = @(
    [System.Drawing.PointF]::new($CenterX, $CenterY - $Radius),
    [System.Drawing.PointF]::new($CenterX + $narrow, $CenterY - $narrow),
    [System.Drawing.PointF]::new($CenterX + $Radius, $CenterY),
    [System.Drawing.PointF]::new($CenterX + $narrow, $CenterY + $narrow),
    [System.Drawing.PointF]::new($CenterX, $CenterY + $Radius),
    [System.Drawing.PointF]::new($CenterX - $narrow, $CenterY + $narrow),
    [System.Drawing.PointF]::new($CenterX - $Radius, $CenterY),
    [System.Drawing.PointF]::new($CenterX - $narrow, $CenterY - $narrow)
  )
  $brush = New-Object System.Drawing.SolidBrush($Color)
  $Canvas.FillPolygon($brush, $points)
  $brush.Dispose()
}

Draw-Sparkle $graphics 279 177 52 ([System.Drawing.Color]::White)
Draw-Sparkle $graphics 360 262 39 ([System.Drawing.Color]::FromArgb(255, 217, 227, 255))

$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$whitePen.Dispose()
$gradient.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated $output"
