import React from 'react'
import ReactDOM from 'react-dom/client'
import L from 'leaflet'
import App from './App'
import 'leaflet/dist/leaflet.css'

const localMarkerUrls: Record<string, string> = {
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png': '/markers/marker-icon-green.png',
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-orange.png': '/markers/marker-icon-orange.png',
}

const originalCreateIcon = L.Icon.prototype.createIcon
L.Icon.prototype.createIcon = function (oldIcon?: HTMLElement) {
  const iconUrl = this.options.iconUrl
  if (iconUrl) {
    const localMarkerUrl = localMarkerUrls[iconUrl]
    if (localMarkerUrl) this.options.iconUrl = localMarkerUrl
  }
  return originalCreateIcon.call(this, oldIcon)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
