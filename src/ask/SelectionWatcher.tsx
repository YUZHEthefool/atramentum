/**
 * 划词探针：监听文档选区变化，当「正文容器内存在非空选区」时给出浮钮定位。
 * selectionchange 拖拽期间高频触发 → 200ms 防抖后再判定。
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface SelectionProbe {
  /** 浮钮定位：选区右下角（viewport 坐标） */
  x: number
  y: number
  text: string
}

export function useSelectionProbe(containerRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [probe, setProbe] = useState<SelectionProbe | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!enabled) {
      setProbe(null)
      return
    }
    const check = () => {
      const sel = window.getSelection()
      const container = containerRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
        setProbe(null)
        return
      }
      const text = sel.toString().trim()
      const anchor = sel.anchorNode
      // 选区须起始于正文容器内（面板内划词不触发）
      if (!text || !anchor || !container.contains(anchor)) {
        setProbe(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setProbe(null)
        return
      }
      setProbe({ x: rect.right, y: rect.bottom, text })
    }
    const onChange = () => {
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(check, 200)
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
      window.clearTimeout(timerRef.current)
    }
  }, [containerRef, enabled])

  return { probe, clearProbe: () => setProbe(null) }
}
