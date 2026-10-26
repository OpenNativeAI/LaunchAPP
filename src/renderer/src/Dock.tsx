import { memo, useEffect, useRef, useState } from 'react'
import type { JSX, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { t } from './i18n'

export interface DockApp {
  lnk: string
  name: string
  iconFile: string
}

interface Props {
  items: DockApp[]
  draggingLnk: string | null
  magnify: boolean
  onDropApp: (lnk: string) => void
  onInsertAt: (lnk: string, at: number) => void
  onReorder: (from: number, to: number) => void
  onLaunch: (app: DockApp) => void
  onMenu: (lnk: string, x: number, y: number) => void
}

const BASE = 48
const GAP = 8

function Dock({
  items,
  draggingLnk,
  magnify,
  onDropApp,
  onInsertAt,
  onReorder,
  onLaunch,
  onMenu
}: Props): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef<(HTMLDivElement | null)[]>([])
  const [mouseX, setMouseX] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  /**
   * 槽位中心点只在"静止布局"下量一次。
   * 原来每次 mousemove 对每个槽调 getBoundingClientRect()：读几何紧接写 width/height，
   * 浏览器每帧被迫重排整条 Dock，鼠标一动就掉帧。
   */
  const centers = useRef<number[]>([])
  const dirty = useRef(true)
  const raf = useRef(0)
  const pendingX = useRef<number | null>(null)

  const measure = (): void => {
    const bar = barRef.current
    // 窗口隐藏时几何全是 0，量了会把放大镜算成"全部同一点"
    if (!bar || bar.clientWidth === 0) return
    const next: number[] = []
    for (let i = 0; i < items.length; i++) {
      const el = slotRefs.current[i]
      if (!el) return
      const r = el.getBoundingClientRect()
      next.push(r.left + r.width / 2)
    }
    centers.current = next
  }

  useEffect(() => {
    dirty.current = true
  }, [items.length, magnify])

  useEffect(() => {
    const onResize = (): void => {
      dirty.current = true
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const scaleFor = (i: number): number => {
    if (!magnify || mouseX === null) return 1
    const center = centers.current[i]
    if (center === undefined) return 1
    const d = Math.abs(mouseX - center)
    return 1 + 0.55 * Math.exp(-((d / 110) ** 2))
  }

  const hasDockDrag = (e: DragEvent): boolean =>
    e.dataTransfer.types.includes('application/x-dock-index')

  // 保险：dragend 丢失（如拖到网格后源节点重建）时也要清除拖拽状态
  useEffect(() => {
    if (dragIdx === null) return
    const clear = (): void => setDragIdx(null)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [dragIdx])

  // dragenter 在进入图标瞬间就触发，比节流的 dragover 快，让位零延迟
  const handleSlotDrag = (e: DragEvent, i: number): void => {
    if (hasDockDrag(e)) {
      e.preventDefault()
      if (dragIdx !== null && dragIdx !== i) {
        onReorder(dragIdx, i)
        setDragIdx(i)
      }
      return
    }
    if (draggingLnk && e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault()
      const cur = items.findIndex((x) => x.lnk === draggingLnk)
      if (cur !== i) onInsertAt(draggingLnk, i)
    }
  }

  // 一帧最多算一次放大镜，鼠标事件再密也不叠加
  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    pendingX.current = e.clientX
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      if (dirty.current) {
        dirty.current = false
        measure()
      }
      setMouseX(pendingX.current)
    })
  }

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    },
    []
  )

  return (
    <div
      ref={barRef}
      className={`dock${dragOver ? ' drag-over' : ''}`}
      onMouseMove={onMouseMove}
      onMouseLeave={() => {
        setMouseX(null)
        dirty.current = true
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(!hasDockDrag(e))
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        setDragIdx(null)
        const lnk = e.dataTransfer.getData('text/plain')
        if (lnk) onDropApp(lnk)
      }}
    >
      {items.length === 0 && <div className="dock-empty">{t('dockEmpty')}</div>}
      {items.map((a, i) => {
        // 拖拽期间 mousemove 不再触发，放大镜会冻结在旧位置造成错位，故拖拽中一律原始尺寸
        const s = dragIdx !== null || draggingLnk !== null ? 1 : scaleFor(i)
        const size = BASE * s
        return (
          <div
            key={a.lnk}
            ref={(el) => {
              slotRefs.current[i] = el
            }}
            className={`dock-slot${dragIdx === i ? ' dragging' : ''}`}
            style={{ width: size + GAP, height: size }}
            onDragEnter={(e) => handleSlotDrag(e, i)}
            onDragOver={(e) => handleSlotDrag(e, i)}
            onDrop={(e) => {
              // 位置已在 dragover 时实时调好，这里只拦截事件避免重复移动
              if (hasDockDrag(e) || (draggingLnk && e.dataTransfer.types.includes('text/plain'))) {
                e.preventDefault()
                e.stopPropagation()
                setDragOver(false)
                setDragIdx(null)
              }
            }}
          >
            <img
              className="dock-icon"
              src={`appicon:///${a.iconFile}`}
              alt={a.name}
              title={t('dockTooltip', { name: a.name })}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-dock-index', String(i))
                e.dataTransfer.effectAllowed = 'move'
                const r = e.currentTarget.getBoundingClientRect()
                e.dataTransfer.setDragImage(e.currentTarget, r.width / 2, r.height / 2)
                setDragIdx(i)
              }}
              onDragEnd={() => setDragIdx(null)}
              style={{ width: size, height: size }}
              onClick={() => onLaunch(a)}
              onContextMenu={(e) => {
                e.preventDefault()
                onMenu(a.lnk, e.clientX, e.clientY)
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

export default memo(Dock)
