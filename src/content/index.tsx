import React from 'react'
import { createRoot } from 'react-dom/client'
import ContentApp from './ContentApp'
import styles from './content.css?inline'

const init = () => {
  // Create a host element for the shadow DOM
  const host = document.createElement('div')
  host.id = 'ai-translate-host'
  host.style.position = 'absolute'
  host.style.top = '0'
  host.style.left = '0'
  host.style.width = '0'
  host.style.height = '0'
  host.style.zIndex = '2147483647' // Max z-index
  document.body.appendChild(host)

  // Attach shadow DOM
  const shadow = host.attachShadow({ mode: 'open' })

  // Inject styles
  const styleSheet = document.createElement('style')
  styleSheet.textContent = styles
  shadow.appendChild(styleSheet)

  // Create React root
  const rootElement = document.createElement('div')
  rootElement.id = 'ai-translate-root'
  shadow.appendChild(rootElement)

  const root = createRoot(rootElement)
  root.render(
    <React.StrictMode>
      <ContentApp />
    </React.StrictMode>
  )
}

init()
