/**
 * 底色模糊只算一次，不再每帧重光栅。
 *
 * 原来整屏 .wallpaper 挂着 filter: blur(60px)，浏览器每次重绘都要按半径重算一遍全屏像素，
 * 拖拽/翻页时正好和图标层抢 GPU。这里改成：把截图缩成一条小图，在小图上模糊+调色，
 * 再交给浏览器放大铺满——放大本身就是二次平滑，观感一致，代价从"全屏×半径"变成"128px×6px"。
 */
const MAX_EDGE = 128

/** 模糊之后的调色后缀，和 CSS 的 filter 函数同一套语法 */
function tint(bgStyle: 'wallpaper' | 'solid' | 'fog'): string {
  return bgStyle === 'fog' ? ' saturate(0.45) brightness(1.12)' : ' saturate(1.2)'
}

export async function bakeWallpaper(
  src: string,
  radius: number,
  bgStyle: 'wallpaper' | 'solid' | 'fog'
): Promise<string> {
  // 半径 0 = 用户要看得清的桌面，直接给原图，别缩成马赛克
  if (radius <= 0) return src
  const img = new Image()
  img.src = src
  try {
    await img.decode()
  } catch {
    return src
  }
  const w0 = img.naturalWidth
  const h0 = img.naturalHeight
  if (!w0 || !h0) return src
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * k))
  const h = Math.max(1, Math.round(h0 * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  const r = Math.max(1.5, radius * k)
  // 模糊会把画布边缘啃掉一圈透明，所以画得比画布大一圈，让毛边落在外面
  const pad = Math.ceil(r * 1.5)
  ctx.filter = `blur(${r.toFixed(2)}px)` + tint(bgStyle)
  ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2)
  ctx.filter = 'none'
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return src
  }
}
