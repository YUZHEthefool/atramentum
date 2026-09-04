import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import Bookshelf from './components/Bookshelf'
import Reader from './components/Reader'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Bookshelf />} />
        <Route path="/c/:courseId" element={<Reader />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
