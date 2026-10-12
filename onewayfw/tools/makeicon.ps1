# makeicon.ps1 — 生成 OneWayFW 应用图标（多分辨率 .ico）
#
# 设计语义：圆角深蓝底 + 蓝色盾牌 + 白色向右箭头（只出不进）+ 左侧白色墙体
#   - 盾牌  = 防护
#   - 右箭头 = 允许本机主动向外发起连接
#   - 左侧墙 = 外部主动连入被拦住
#
# 输出混合格式 ICO：<=64px 用传统 BMP/DIB 条目（兼容性最好，任务栏/资源管理器小图标），
# 128/256px 用 PNG 条目（体积小，Vista+ 支持）。
#
# 用法: pwsh -File makeicon.ps1 -Out ..\OneWayFW.ico

param(
    [string]$Out = "$PSScriptRoot\..\OneWayFW.ico"
)

Add-Type -AssemblyName System.Drawing

# 尺寸与编码方式（$true = PNG 条目）
$sizes = @(
    @{ S = 16; Png = $false },
    @{ S = 20; Png = $false },
    @{ S = 24; Png = $false },
    @{ S = 32; Png = $false },
    @{ S = 40; Png = $false },
    @{ S = 48; Png = $false },
    @{ S = 64; Png = $false },
    @{ S = 128; Png = $true },
    @{ S = 256; Png = $true }
)

function New-RoundRectPath {
    param([double]$X, [double]$Y, [double]$W, [double]$H, [double]$R)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $R * 2
    $p.AddArc([float]$X, [float]$Y, [float]$d, [float]$d, 180, 90)
    $p.AddArc([float]($X + $W - $d), [float]$Y, [float]$d, [float]$d, 270, 90)
    $p.AddArc([float]($X + $W - $d), [float]($Y + $H - $d), [float]$d, [float]$d, 0, 90)
    $p.AddArc([float]$X, [float]($Y + $H - $d), [float]$d, [float]$d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-ShieldPath {
    param([double]$Cx, [double]$Hw, [double]$Top, [double]$Bot)
    $h = $Bot - $Top
    $mid = $Top + $h * 0.55
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddLine([float]($Cx - $Hw), [float]$Top, [float]($Cx + $Hw), [float]$Top)
    $p.AddLine([float]($Cx + $Hw), [float]$Top, [float]($Cx + $Hw), [float]$mid)
    # 右半下缘弧线收到底部尖点
    $p.AddBezier(
        [float]($Cx + $Hw), [float]$mid,
        [float]($Cx + $Hw), [float]($Bot - $h * 0.10),
        [float]($Cx + $Hw * 0.45), [float]$Bot,
        [float]$Cx, [float]$Bot)
    # 左半镜像
    $p.AddBezier(
        [float]$Cx, [float]$Bot,
        [float]($Cx - $Hw * 0.45), [float]$Bot,
        [float]($Cx - $Hw), [float]($Bot - $h * 0.10),
        [float]($Cx - $Hw), [float]$mid)
    $p.AddLine([float]($Cx - $Hw), [float]$mid, [float]($Cx - $Hw), [float]$Top)
    $p.CloseFigure()
    return $p
}

function New-IconBitmap {
    param([int]$S)

    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # ---- 底板：深蓝渐变圆角方块 ----
    $rr = New-RoundRectPath 0 0 $S $S ($S * 0.18)
    $rectF = New-Object System.Drawing.RectangleF(0, 0, [float]$S, [float]$S)
    $c1 = [System.Drawing.Color]::FromArgb(255, 26, 58, 92)
    $c2 = [System.Drawing.Color]::FromArgb(255, 10, 24, 40)
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rectF, $c1, $c2, 90.0)
    $g.FillPath($bgBrush, $rr)
    $bgBrush.Dispose()

    # ---- 盾牌 ----
    $cx = $S / 2.0
    $hw = $S * 0.30
    $top = $S * 0.16
    $bot = $S * 0.86
    $sh = New-ShieldPath $cx $hw $top $bot
    $shRect = New-Object System.Drawing.RectangleF([float]($cx - $hw), [float]$top, [float]($hw * 2), [float]($bot - $top))
    $s1 = [System.Drawing.Color]::FromArgb(255, 96, 165, 250)
    $s2 = [System.Drawing.Color]::FromArgb(255, 37, 99, 176)
    $shBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($shRect, $s1, $s2, 90.0)
    $g.FillPath($shBrush, $sh)
    $shBrush.Dispose()

    # 盾牌描边（浅色，增强小尺寸下的轮廓）
    $edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 191, 219, 254), [float][Math]::Max(1.0, $S * 0.035))
    $edge.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($edge, $sh)
    $edge.Dispose()

    # ---- 白色元素 ----
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $h = $bot - $top
    $yMid = $top + $h * 0.46

    # 左侧墙体（外部连入被拦）
    $wallW = $hw * 0.14
    $wallX = $cx - $hw * 0.66
    $g.FillRectangle($white, [float]$wallX, [float]($yMid - $h * 0.26), [float]$wallW, [float]($h * 0.52))

    # 向右箭头（本机主动外连放行）
    $shaftH = $h * 0.17
    $shaftX0 = $cx - $hw * 0.42
    $shaftX1 = $cx + $hw * 0.14
    $g.FillRectangle($white, [float]$shaftX0, [float]($yMid - $shaftH / 2), [float]($shaftX1 - $shaftX0), [float]$shaftH)
    $headX = $cx + $hw * 0.60
    $pts = @(
        (New-Object System.Drawing.PointF([float]$shaftX1, [float]($yMid - $h * 0.24))),
        (New-Object System.Drawing.PointF([float]$headX, [float]$yMid)),
        (New-Object System.Drawing.PointF([float]$shaftX1, [float]($yMid + $h * 0.24)))
    )
    $g.FillPolygon($white, $pts)

    $white.Dispose()
    $sh.Dispose()
    $rr.Dispose()
    $g.Dispose()
    return $bmp
}

function Get-IcoBmpEntry {
    param([System.Drawing.Bitmap]$Bmp)
    $w = $Bmp.Width
    $h = $Bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $raw = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $Bmp.UnlockBits($data)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER：高度写 2 倍（XOR 位图 + AND 掩码）
    $bw.Write([uint32]40)
    $bw.Write([int32]$w)
    $bw.Write([int32]($h * 2))
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]0)      # BI_RGB
    $bw.Write([uint32]($w * $h * 4))
    $bw.Write([int32]0); $bw.Write([int32]0)
    $bw.Write([uint32]0); $bw.Write([uint32]0)

    # XOR 位图：自底向上逐行
    for ($y = $h - 1; $y -ge 0; $y--) {
        $bw.Write($raw, $y * $stride, $w * 4)
    }

    # AND 掩码：全 0（透明度由 alpha 通道决定），每行按 4 字节对齐
    $maskRow = [Math]::Floor(($w + 31) / 32) * 4
    $zeros = New-Object byte[] ($maskRow * $h)
    $bw.Write($zeros, 0, $zeros.Length)

    $bw.Flush()
    return $ms.ToArray()
}

function Get-IcoPngEntry {
    param([System.Drawing.Bitmap]$Bmp)
    $ms = New-Object System.IO.MemoryStream
    $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

# ---------------------------------------------------------------------------
# 渲染全部尺寸并组装 ICO
# ---------------------------------------------------------------------------
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s.S
    if ($s.Png) {
        $bytes = Get-IcoPngEntry $bmp
    } else {
        $bytes = Get-IcoBmpEntry $bmp
    }
    $entries += [pscustomobject]@{ S = $s.S; Bytes = $bytes }
    $bmp.Dispose()
    Write-Host ("  渲染 {0}x{0}  {1} 字节" -f $s.S, $bytes.Length)
}

$outMs = New-Object System.IO.MemoryStream
$ow = New-Object System.IO.BinaryWriter($outMs)
$ow.Write([uint16]0)                 # reserved
$ow.Write([uint16]1)                 # type = icon
$ow.Write([uint16]$entries.Count)

$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $dim = $e.S
    if ($dim -ge 256) { $dim = 0 }   # 256 在 ICO 目录项里写 0
    $ow.Write([byte]$dim)            # width
    $ow.Write([byte]$dim)            # height
    $ow.Write([byte]0)               # 调色板颜色数
    $ow.Write([byte]0)               # reserved
    $ow.Write([uint16]1)             # planes
    $ow.Write([uint16]32)            # bit count
    $ow.Write([uint32]$e.Bytes.Length)
    $ow.Write([uint32]$offset)
    $offset += $e.Bytes.Length
}
foreach ($e in $entries) {
    $ow.Write($e.Bytes, 0, $e.Bytes.Length)
}
$ow.Flush()

$outPath = [System.IO.Path]::GetFullPath($Out)
[System.IO.File]::WriteAllBytes($outPath, $outMs.ToArray())
$ow.Dispose(); $outMs.Dispose()

Write-Host ("已写出 {0}（{1} 字节，{2} 个尺寸）" -f $outPath, (Get-Item $outPath).Length, $entries.Count)
