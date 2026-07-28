$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$generator = Join-Path $PSScriptRoot "generate-icon.cjs"
$output = Join-Path $root "resources\icon.png"

if (-not (Test-Path -LiteralPath $electron)) {
  throw "Electron is not installed. Run npm install before generating the icon."
}

$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$previousNodeOptions = $env:NODE_OPTIONS
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  & $electron $generator
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Add-Type -AssemblyName System.Drawing
  $sourceImage = [System.Drawing.Image]::FromFile($output)
  try {
    if ($sourceImage.Width -ne 512 -or $sourceImage.Height -ne 512) {
      $normalized = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($normalized)
      try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::GammaCorrected
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, 512, 512)
      } finally {
        $graphics.Dispose()
      }
      $temporary = "$output.normalized.png"
      $normalized.Save($temporary, [System.Drawing.Imaging.ImageFormat]::Png)
      $normalized.Dispose()
      $sourceImage.Dispose()
      Move-Item -LiteralPath $temporary -Destination $output -Force
    }
  } finally {
    $sourceImage.Dispose()
  }
} finally {
  if ($null -ne $previousRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
  if ($null -ne $previousNodeOptions) { $env:NODE_OPTIONS = $previousNodeOptions }
}
