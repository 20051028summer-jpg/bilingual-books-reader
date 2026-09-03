param(
  [Parameter(Mandatory = $true)]
  [string]$PngPath,
  [Parameter(Mandatory = $true)]
  [string]$IcoPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 52
$diameter = $radius * 2
$path.AddArc(0, 0, $diameter, $diameter, 180, 90)
$path.AddArc($size - $diameter, 0, $diameter, $diameter, 270, 90)
$path.AddArc($size - $diameter, $size - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc(0, $size - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()

$greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 33, 51, 44))
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 253, 247))
$graphics.FillPath($greenBrush, $path)

$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 148, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$character = [string][char]0x8BCD
$textArea = New-Object System.Drawing.RectangleF(0, -8, $size, $size)
$graphics.DrawString($character, $font, $whiteBrush, $textArea, $format)

$pngDirectory = Split-Path -Parent $PngPath
$icoDirectory = Split-Path -Parent $IcoPath
$null = New-Item -ItemType Directory -Force -Path $pngDirectory
$null = New-Item -ItemType Directory -Force -Path $icoDirectory
$bitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$pngBytes = [System.IO.File]::ReadAllBytes($PngPath)
$stream = [System.IO.File]::Create($IcoPath)
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$pngBytes.Length)
  $writer.Write([uint32]22)
  $writer.Write($pngBytes)
} finally {
  $writer.Dispose()
}

$format.Dispose()
$font.Dispose()
$whiteBrush.Dispose()
$greenBrush.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

