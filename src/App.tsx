import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import Bookshelf from './components/Bookshelf'
import Reader from './components/Reader'
import { NewCourseDialog } from './generate/NewCourseDialog'
import { useGenerateStore } from './generate/generateStore'

export default function App() {
  const generateOpen = useGenerateStore((s) => s.open)
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Bookshelf />} />
        <Route path="/c/:courseId" element={<Reader />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* AI 著书挂在路由之外：生成中可最小化、可跨页存活，写完的课时可实时预览 */}
      {generateOpen && <NewCourseDialog />}
    </HashRouter>
  )
}
