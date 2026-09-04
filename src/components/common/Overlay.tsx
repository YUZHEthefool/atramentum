// 模态遮罩：Esc / 点击遮罩关闭，内容区阻止冒泡
import { useEffect } from 'react'
import type { ReactNode } from 'react'

export function Overlay({
  children,
  onClose,
  closeOnOverlay = true,
}: {
  children: ReactNode
  onClose: () => void
  closeOnOverlay?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4 backdrop-blur-sm"
      onClick={closeOnOverlay ? onClose : undefined}
    >
      <div className="max-h-[88vh] w-[560px] max-w-full overflow-hidden border border-ink/20 bg-paper shadow-paper" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
