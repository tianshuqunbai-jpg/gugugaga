Add-Type -AssemblyName System.Drawing

$res = Join-Path $PSScriptRoot '..\android\app\src\main\res'
$bg = [System.Drawing.Color]::FromArgb(255, 10, 13, 34)   # #0a0d22 与 favicon 底色一致

# 四角星多边形（外尖 / 内凹交替），cx,cy 中心，outer 外尖半径，inner 内凹半径
function New-StarPath {
  param([double]$cx, [double]$cy, [double]$outer, [double]$inner)
  $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  for ($i = 0; $i -lt 8; $i++) {
    $r = if ($i % 2 -eq 0) { $outer } else { $inner }
    # 从正上方开始，每 45 度一个点
    $ang = [Math]::PI * 2 * $i / 8 - [Math]::PI / 2
    $pts.Add([System.Drawing.PointF]::new(
      [float]($cx + $r * [Math]::Cos($ang)),
      [float]($cy + $r * [Math]::Sin($ang))))
  }
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddPolygon($pts.ToArray())
  return $p
}

# 星形渐变刷：左上青 → 中紫 → 右下品红（对应 favicon 的 #38e0f5 / #8b5cf6 / #e879f9）
function New-StarBrush {
  param([System.Drawing.RectangleF]$rect, [string]$name)
  $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 56, 224, 245),
    [System.Drawing.Color]::FromArgb(255, 232, 121, 249),
    [float]45)
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend
  $blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 56, 224, 245),
    [System.Drawing.Color]::FromArgb(255, 139, 92, 246),
    [System.Drawing.Color]::FromArgb(255, 232, 121, 249)
  )
  $blend.Positions = @([float]0, [float]0.5, [float]1)
  $b.InterpolationColors = $blend
  return $b
}

# ---- 1. 自适应图标前景：432x432，星形画在中间安全区内 ----
$fg = New-Object System.Drawing.Bitmap(432, 432)
$g = [System.Drawing.Graphics]::FromImage($fg)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$outer = 432 * 0.30
$inner = $outer * 0.30
$path = New-StarPath -cx 216 -cy 216 -outer $outer -inner $inner
# 注意：PowerShell 里 `216 - $outer` 在 New-Object 的参数位置上会被当成数组，
# 必须先算好放进变量，不能直接写表达式
$x0 = 216.0 - $outer
$y0 = 216.0 - $outer
$side = $outer * 2.0
$rect = New-Object System.Drawing.RectangleF(
  [float]$x0, [float]$y0, [float]$side, [float]$side)
$brush = New-StarBrush -rect $rect -name 'star'
$g.FillPath($brush, $path)
$g.Dispose(); $brush.Dispose(); $path.Dispose()

$mipmaps = @{ 'mipmap-mdpi' = 108; 'mipmap-hdpi' = 162; 'mipmap-xhdpi' = 216; 'mipmap-xxhdpi' = 324; 'mipmap-xxxhdpi' = 432 }
foreach ($k in $mipmaps.Keys) {
  $size = $mipmaps[$k]
  $dir = Join-Path $res $k
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gg.DrawImage($fg, 0, 0, $size, $size)
  $gg.Dispose()
  $bmp.Save((Join-Path $dir 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  图标前景 {0,-18} {1}x{1}" -f $k, $size)
}
$fg.Dispose()

# ---- 2. 自适应图标背景：纯深色 ----
$bgBmp = New-Object System.Drawing.Bitmap(432, 432)
$gb = [System.Drawing.Graphics]::FromImage($bgBmp)
$gb.Clear($bg)
$gb.Dispose()
foreach ($k in $mipmaps.Keys) {
  $size = $mipmaps[$k]
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $gg = [System.Drawing.Graphics]::FromImage($bmp)
  $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gg.DrawImage($bgBmp, 0, 0, $size, $size)
  $gg.Dispose()
  $bmp.Save((Join-Path (Join-Path $res $k) 'ic_launcher_background.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$bgBmp.Dispose()
Write-Host '  图标背景 各分辨率 已生成'

# ic_launcher_background.xml（颜色资源）也改成同色，避免和 png 不一致
$colorXml = Join-Path $res 'values\ic_launcher_background.xml'
if (Test-Path $colorXml) {
  @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0A0D22</color>
</resources>
'@ | Set-Content -Path $colorXml -Encoding UTF8
  Write-Host '  ic_launcher_background.xml 已改为 #0A0D22'
}

# ---- 3. 启动图：各分辨率同尺寸，深色底 + 居中星形 ----
# 用正方形整图，避免横竖屏两套；Star 只占中间一小块，缩放时不会变形
$splashSpecs = @{
  'drawable'                 = 480
  'drawable-land-mdpi'       = 480
  'drawable-land-hdpi'       = 800
  'drawable-land-xhdpi'      = 1280
  'drawable-land-xxhdpi'     = 1600
  'drawable-land-xxxhdpi'    = 1920
  'drawable-port-mdpi'       = 320
  'drawable-port-hdpi'       = 480
  'drawable-port-xhdpi'      = 720
  'drawable-port-xxhdpi'     = 960
  'drawable-port-xxxhdpi'    = 1280
}
foreach ($k in $splashSpecs.Keys) {
  $h = $splashSpecs[$k]
  $w = if ($k -like '*land*') { [int]($h * 16 / 9) } elseif ($k -like '*port*') { [int]($h * 9 / 16) } else { $h }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $gs = [System.Drawing.Graphics]::FromImage($bmp)
  $gs.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gs.Clear($bg)
  $cx = $w / 2.0
  $cy = $h / 2.0
  $so = [Math]::Min($w, $h) * 0.16
  $si = $so * 0.30
  $sp = New-StarPath -cx $cx -cy $cy -outer $so -inner $si
  # 同样先算好再传，别在 New-Object 参数位置写表达式
  $sx0 = $cx - $so
  $sy0 = $cy - $so
  $sside = $so * 2.0
  $srect = New-Object System.Drawing.RectangleF(
    [float]$sx0, [float]$sy0, [float]$sside, [float]$sside)
  $sb = New-StarBrush -rect $srect -name 'splash'
  $gs.FillPath($sb, $sp)
  $gs.Dispose(); $sb.Dispose(); $sp.Dispose()
  $dir = Join-Path $res $k
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $bmp.Save((Join-Path $dir 'splash.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  启动图 {0,-24} {1}x{2}" -f $k, $w, $h)
}

Write-Host ''
Write-Host '=== 生成完毕 ==='
