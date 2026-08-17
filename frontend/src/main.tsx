import React from 'react'
import ReactDOM from 'react-dom/client'
import L from 'leaflet'
import App from './App'
import 'leaflet/dist/leaflet.css'

const currentLocationMarkerUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png'
const transparentMarkerUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E"
const localMarkerUrls: Record<string, string> = {
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png': '/markers/marker-icon-green.png',
  'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-orange.png': '/markers/marker-icon-orange.png',
}

const originalCreateIcon = L.Icon.prototype.createIcon
L.Icon.prototype.createIcon = function (oldIcon?: HTMLElement) {
  const iconUrl = this.options.iconUrl
  if (iconUrl === currentLocationMarkerUrl) {
    this.options.iconUrl = transparentMarkerUrl
    this.options.shadowUrl = transparentMarkerUrl
    this.options.iconSize = L.point(0, 0)
    this.options.shadowSize = L.point(0, 0)
    this.options.iconAnchor = L.point(0, 0)
    this.options.shadowAnchor = L.point(0, 0)
    this.options.popupAnchor = L.point(0, 0)
  } else if (iconUrl) {
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
