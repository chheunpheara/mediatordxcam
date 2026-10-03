import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { App } from './app/App'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  // The element is in index.html; its absence means the bundle was mounted into
  // the wrong document, which no user-facing message can repair.
  throw new Error('root element missing')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)