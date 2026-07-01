import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(<App />)
}
