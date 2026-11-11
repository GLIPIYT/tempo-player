import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

if (import.meta.env.DEV) {
  let captureOnLaunch = false
  try {
    captureOnLaunch = window.localStorage.getItem('tempo.devPerformance.autoStart.v1') === '1'
  } catch {
    /* local storage is optional */
  }

  if (captureOnLaunch) {
    void import('./dev-performance/DevPerformancePanel')
      .then(({ mountDevPerformancePanel, startDevPerformanceCapture }) => {
        mountDevPerformancePanel()
        startDevPerformanceCapture()
        renderApp()
      })
      .catch(() => renderApp())
  } else {
    renderApp()
    void import('./dev-performance/DevPerformancePanel')
      .then(({ mountDevPerformancePanel }) => mountDevPerformancePanel())
      .catch(() => {})
  }
} else {
  renderApp()
}
