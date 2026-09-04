// 划词浮动「问」印：选区右下角出现，点击发问
export function FloatingToolbar({ x, y, onAsk }: { x: number; y: number; onAsk: () => void }) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 56))
  const top = Math.max(8, Math.min(y + 8, window.innerHeight - 56))
  return (
    <button
      className="fixed z-40 h-9 w-9 bg-cinnabar font-song text-sm font-bold text-paper shadow-seal transition hover:bg-cinnabar-deep"
      style={{ left, top }}
      onPointerDown={(e) => e.preventDefault() /* 保住选区高亮 */}
      onClick={onAsk}
      title="问 AI"
      aria-label="问 AI"
    >
      问
    </button>
  )
}
