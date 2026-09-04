import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/prose.css'

window.addEventListener('error', (e) => console.error('[moxue] window error:', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => console.error('[moxue] unhandled rejection:', e.reason))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)