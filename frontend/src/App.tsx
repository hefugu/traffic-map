import { useEffect, useState } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'

type Position = {
  lat: number
  lng: number
}

type SignalType = 'pedestrian' | 'vehicle' | 'both' | 'crossing' | 'unknown'

type TrafficSignal = {
  id: number
  lat: number
  lng: number
  type: SignalType
  source: string
  redSeconds: number
  greenSeconds: number
  yellowSeconds: number
}

type NominatimResult = {
  display_name: string
  lat: string
  lon: string
}

type RouteInfo = {
  coordinates: Position[]
  distanceMeters: number
  durationSeconds: number
}

type OsrmRouteResponse = {
  routes?: Array<{
    distance: number
    duration: number
    geometry: {
      coordinates: Array<[number, number]>
    }
  }>
}

const currentLocationIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const startIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const destinationIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-orange.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const vehicleSignalIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const pedestrianSignalIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const bothSignalIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-violet.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const crossingIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-grey.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const unknownIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-black.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

function getSignalIcon(type: SignalType) {
  if (type === 'vehicle') return vehicleSignalIcon
  if (type === 'pedestrian') return pedestrianSignalIcon
  if (type === 'both') return bothSignalIcon
  if (type === 'crossing') return crossingIcon
  return unknownIcon
}

function getSignalLabel(type: SignalType) {
  if (type === 'vehicle') return '車両用信号'
  if (type === 'pedestrian') return '歩行者用信号'
  if (type === 'both') return '車両・歩行者両方'
  if (type === 'crossing') return '横断歩道'
  return '不明'
}

function formatMinutes(seconds: number) {
  return `${Math.round(seconds / 60)}分`
}

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`
}

function formatKm(meters: number) {
  return `${(meters / 1000).toFixed(2)}km`
}

function distanceMeters(a: Position, b: Position) {
  const earthRadius = 6371000
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180

  const h =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)

  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function distanceToRouteMeters(point: Position, route: Position[]) {
  if (route.length === 0) return Infinity

  let shortest = Infinity

  for (const routePoint of route) {
    const distance = distanceMeters(point, routePoint)
    if (distance < shortest) shortest = distance
  }

  return shortest
}

function MapFocus({ center }: { center: Position | null }) {
  const map = useMap()

  useEffect(() => {
    if (!center) return
    map.setView([center.lat, center.lng], Math.max(map.getZoom(), 15))
  }, [center, map])

  return null
}

function App() {
  const [currentLocation, setCurrentLocation] = useState<Position | null>(null)
  const [startPosition, setStartPosition] = useState<Position | null>(null)
  const [destinationPosition, setDestinationPosition] = useState<Position | null>(null)

  const [startQuery, setStartQuery] = useState<string>('')
  const [destinationQuery, setDestinationQuery] = useState<string>('')

  const [averageRedSeconds, setAverageRedSeconds] = useState<number>(50)
  const [averageGreenSeconds, setAverageGreenSeconds] = useState<number>(40)
  const [averageYellowSeconds, setAverageYellowSeconds] = useState<number>(3)

  const [signals, setSignals] = useState<TrafficSignal[]>([])
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [loadingSignals, setLoadingSignals] = useState<boolean>(false)
  const [loadingStartSearch, setLoadingStartSearch] = useState<boolean>(false)
  const [loadingDestinationSearch, setLoadingDestinationSearch] = useState<boolean>(false)
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false)

  useEffect(() => {
    if (!navigator.geolocation) {
      setErrorMessage('このブラウザは位置情報に対応していません。')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gpsPosition = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }

        setCurrentLocation(gpsPosition)
        setStartPosition(gpsPosition)
      },
      (error) => {
        console.error(error)
        setErrorMessage('位置情報の取得に失敗しました。出発地を検索で指定してください。')
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      },
    )
  }, [])

  useEffect(() => {
    if (!startPosition) return

    const fetchSignals = async () => {
      setLoadingSignals(true)
      setErrorMessage('')

      const radius = 700

      const query = `
        [out:json][timeout:25];
        (
          node["highway"="traffic_signals"](around:${radius},${startPosition.lat},${startPosition.lng});
          node["crossing"="traffic_signals"](around:${radius},${startPosition.lat},${startPosition.lng});
          node["highway"="crossing"](around:${radius},${startPosition.lat},${startPosition.lng});
          way["highway"="crossing"](around:${radius},${startPosition.lat},${startPosition.lng});
        );
        out center tags;
      `

      try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          body: query,
        })

        if (!response.ok) {
          throw new Error(`Overpass API error: ${response.status}`)
        }

        const data = await response.json()

        const parsed: TrafficSignal[] = data.elements
          .map((el: any) => {
            const tags = el.tags || {}

            const lat = el.lat ?? el.center?.lat
            const lng = el.lon ?? el.center?.lon

            let type: SignalType = 'unknown'
            let source = 'unknown'

            const isVehicleSignal = tags.highway === 'traffic_signals'
            const isTrafficSignalCrossing = tags.crossing === 'traffic_signals'
            const isCrossing = tags.highway === 'crossing'

            if (isVehicleSignal && isTrafficSignalCrossing) {
              type = 'both'
              source = 'highway=traffic_signals + crossing=traffic_signals'
            } else if (isTrafficSignalCrossing) {
              type = 'pedestrian'
              source = 'crossing=traffic_signals'
            } else if (isVehicleSignal) {
              type = 'vehicle'
              source = 'highway=traffic_signals'
            } else if (isCrossing) {
              type = 'crossing'
              source = 'highway=crossing'
            }

            return {
              id: el.id,
              lat,
              lng,
              type,
              source,
              redSeconds: averageRedSeconds,
              greenSeconds: averageGreenSeconds,
              yellowSeconds: averageYellowSeconds,
            }
          })
          .filter((signal: TrafficSignal) => {
            return typeof signal.lat === 'number' && typeof signal.lng === 'number'
          })

        const uniqueSignals = Array.from(
          new Map(parsed.map((signal) => [`${signal.type}-${signal.id}`, signal])).values(),
        )

        setSignals(uniqueSignals)
      } catch (err) {
        console.error(err)
        setErrorMessage('信号データの取得に失敗しました。時間を置いて再読み込みしてください。')
      } finally {
        setLoadingSignals(false)
      }
    }

    fetchSignals()
  }, [startPosition, averageRedSeconds, averageGreenSeconds, averageYellowSeconds])

  useEffect(() => {
    setRouteInfo(null)
  }, [startPosition, destinationPosition])

  const searchPlace = async (query: string): Promise<Position | null> => {
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      setErrorMessage('検索キーワードを入力してください。')
      return null
    }

    const params = new URLSearchParams({
      format: 'json',
      q: trimmedQuery,
      countrycodes: 'jp',
      limit: '1',
    })

    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`)

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status}`)
    }

    const results = (await response.json()) as NominatimResult[]

    if (results.length === 0) {
      setErrorMessage(`検索結果がありません: ${trimmedQuery}`)
      return null
    }

    return {
      lat: Number(results[0].lat),
      lng: Number(results[0].lon),
    }
  }

  const searchStart = async () => {
    setLoadingStartSearch(true)
    setErrorMessage('')

    try {
      const result = await searchPlace(startQuery)
      if (!result) return
      setStartPosition(result)
    } catch (err) {
      console.error(err)
      setErrorMessage('出発地検索に失敗しました。')
    } finally {
      setLoadingStartSearch(false)
    }
  }

  const searchDestination = async () => {
    setLoadingDestinationSearch(true)
    setErrorMessage('')

    try {
      const result = await searchPlace(destinationQuery)
      if (!result) return
      setDestinationPosition(result)
    } catch (err) {
      console.error(err)
      setErrorMessage('目的地検索に失敗しました。')
    } finally {
      setLoadingDestinationSearch(false)
    }
  }

  const fetchShortestRoute = async () => {
    if (!startPosition || !destinationPosition) {
      setErrorMessage('出発地と目的地を設定してください。')
      return
    }

    setLoadingRoute(true)
    setErrorMessage('')

    try {
      const url =
        `https://router.project-osrm.org/route/v1/foot/` +
        `${startPosition.lng},${startPosition.lat};` +
        `${destinationPosition.lng},${destinationPosition.lat}` +
        '?overview=full&geometries=geojson'

      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`OSRM API error: ${response.status}`)
      }

      const data = (await response.json()) as OsrmRouteResponse

      if (!data.routes || data.routes.length === 0) {
        setErrorMessage('ルートが見つかりませんでした。')
        return
      }

      const route = data.routes[0]

      const coordinates: Position[] = route.geometry.coordinates.map(([lng, lat]) => ({
        lat,
        lng,
      }))

      setRouteInfo({
        coordinates,
        distanceMeters: route.distance,
        durationSeconds: route.duration,
      })
    } catch (err) {
      console.error(err)
      setErrorMessage('最短ルート取得に失敗しました。')
    } finally {
      setLoadingRoute(false)
    }
  }

  const useCurrentLocationAsStart = () => {
    if (!currentLocation) {
      setErrorMessage('現在地が取得できていません。')
      return
    }

    setStartPosition(currentLocation)
    setStartQuery('')
    setErrorMessage('')
  }

  const updateSignalSeconds = (
    target: TrafficSignal,
    key: 'redSeconds' | 'greenSeconds' | 'yellowSeconds',
    value: number,
  ) => {
    setSignals((prev) =>
      prev.map((signal) =>
        signal.id === target.id && signal.type === target.type
          ? {
              ...signal,
              [key]: value,
            }
          : signal,
      ),
    )
  }

  const vehicleCount = signals.filter((signal) => signal.type === 'vehicle').length
  const pedestrianCount = signals.filter((signal) => signal.type === 'pedestrian').length
  const bothCount = signals.filter((signal) => signal.type === 'both').length
  const crossingCount = signals.filter((signal) => signal.type === 'crossing').length
  const unknownCount = signals.filter((signal) => signal.type === 'unknown').length

  const routeNearbySignals = routeInfo
    ? signals.filter((signal) => distanceToRouteMeters(signal, routeInfo.coordinates) <= 30)
    : []

  const estimatedSignalDelaySeconds = routeNearbySignals.reduce((total, signal) => {
    return total + signal.redSeconds * 0.5
  }, 0)

  const estimatedRouteSeconds = routeInfo ? routeInfo.durationSeconds + estimatedSignalDelaySeconds : 0

  const mapCenter = startPosition ?? currentLocation ?? { lat: 35.6812, lng: 139.7671 }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          top: '12px',
          left: '12px',
          width: '340px',
          maxHeight: 'calc(100vh - 24px)',
          overflowY: 'auto',
          background: 'white',
          padding: '12px 16px',
          borderRadius: '8px',
          fontFamily: 'sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          fontSize: '14px',
          lineHeight: '1.6',
        }}
      >
        <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '16px' }}>赤信号回避ナビ 試作</div>

        <section style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontWeight: 'bold' }}>出発地</label>
          <input
            value={startQuery}
            onChange={(e) => setStartQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchStart()
            }}
            placeholder="出発地"
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button onClick={searchStart} disabled={loadingStartSearch} style={{ flex: 1 }}>
              {loadingStartSearch ? '検索中...' : '検索'}
            </button>
            <button onClick={useCurrentLocationAsStart} style={{ flex: 1 }}>
              現在地
            </button>
          </div>
        </section>

        <section style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontWeight: 'bold' }}>目的地</label>
          <input
            value={destinationQuery}
            onChange={(e) => setDestinationQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchDestination()
            }}
            placeholder="目的地"
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }}
          />
          <button
            onClick={searchDestination}
            disabled={loadingDestinationSearch}
            style={{ width: '100%', marginTop: '6px' }}
          >
            {loadingDestinationSearch ? '検索中...' : '検索'}
          </button>
        </section>

        <button
          onClick={fetchShortestRoute}
          disabled={loadingRoute || !startPosition || !destinationPosition}
          style={{
            width: '100%',
            padding: '10px',
            marginBottom: '12px',
            fontWeight: 'bold',
            cursor: loadingRoute || !startPosition || !destinationPosition ? 'not-allowed' : 'pointer',
          }}
        >
          {loadingRoute ? 'ルート取得中...' : '最短ルート表示'}
        </button>

        <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
          <div style={{ fontWeight: 'bold' }}>信号平均設定</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '6px' }}>
            <label>
              赤
              <input
                type="number"
                value={averageRedSeconds}
                onChange={(e) => setAverageRedSeconds(Number(e.target.value))}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>
            <label>
              青
              <input
                type="number"
                value={averageGreenSeconds}
                onChange={(e) => setAverageGreenSeconds(Number(e.target.value))}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>
            <label>
              黄
              <input
                type="number"
                value={averageYellowSeconds}
                onChange={(e) => setAverageYellowSeconds(Number(e.target.value))}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </label>
          </div>
        </section>

        {routeInfo && (
          <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
            <div style={{ fontWeight: 'bold' }}>ルート情報</div>
            <div>距離: {formatKm(routeInfo.distanceMeters)}</div>
            <div>通常時間: {formatMinutes(routeInfo.durationSeconds)}</div>
            <div>ルート付近信号: {routeNearbySignals.length}個</div>
            <div>推定信号待ち: {formatSeconds(estimatedSignalDelaySeconds)}</div>
            <div style={{ fontWeight: 'bold' }}>信号込み: {formatMinutes(estimatedRouteSeconds)}</div>
          </section>
        )}

        <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
          <div style={{ fontWeight: 'bold' }}>信号情報</div>
          <div>取得半径: 出発地から700m</div>
          <div>総数: {signals.length}</div>
          <div>車両用: {vehicleCount}</div>
          <div>歩行者用: {pedestrianCount}</div>
          <div>両方: {bothCount}</div>
          <div>横断歩道: {crossingCount}</div>
          <div>不明: {unknownCount}</div>
          <div>{loadingSignals ? '取得中...' : '取得完了'}</div>
        </section>

        <section style={{ fontSize: '12px', color: '#555' }}>
          <div>出発地: {startPosition ? `${startPosition.lat.toFixed(5)}, ${startPosition.lng.toFixed(5)}` : '未設定'}</div>
          <div>
            目的地:{' '}
            {destinationPosition
              ? `${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lng.toFixed(5)}`
              : '未設定'}
          </div>
        </section>

        {errorMessage && <div style={{ color: 'red', marginTop: '6px' }}>{errorMessage}</div>}
      </div>

      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          bottom: '20px',
          right: '12px',
          background: 'white',
          padding: '8px 10px',
          borderRadius: '8px',
          fontFamily: 'sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          fontSize: '12px',
          lineHeight: '1.6',
        }}
      >
        <div>青ピン: GPS現在地</div>
        <div>緑ピン: 出発地</div>
        <div>橙ピン: 目的地</div>
        <div>青線: 最短ルート</div>
        <div>赤: 車両用信号</div>
        <div>青: 歩行者用信号</div>
        <div>紫: 両方</div>
        <div>灰: 横断歩道</div>
        <div>黒: 不明</div>
      </div>

      <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={17} style={{ width: '100%', height: '100%' }}>
        <MapFocus center={startPosition ?? currentLocation} />

        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {routeInfo && (
          <Polyline
            positions={routeInfo.coordinates.map((point) => [point.lat, point.lng])}
            pathOptions={{
              color: '#1d4ed8',
              weight: 6,
              opacity: 0.85,
            }}
          />
        )}

        {currentLocation && (
          <Marker position={[currentLocation.lat, currentLocation.lng]} icon={currentLocationIcon}>
            <Popup>GPS現在地</Popup>
          </Marker>
        )}

        {startPosition && (
          <Marker position={[startPosition.lat, startPosition.lng]} icon={startIcon}>
            <Popup>出発地</Popup>
          </Marker>
        )}

        {destinationPosition && (
          <Marker position={[destinationPosition.lat, destinationPosition.lng]} icon={destinationIcon}>
            <Popup>目的地</Popup>
          </Marker>
        )}

        {signals.map((signal) => (
          <Marker key={`${signal.type}-${signal.id}`} position={[signal.lat, signal.lng]} icon={getSignalIcon(signal.type)}>
            <Popup>
              <div style={{ minWidth: '190px', fontFamily: 'sans-serif' }}>
                <div>種類: {getSignalLabel(signal.type)}</div>
                <div>信号ID: {signal.id}</div>
                <div>取得元: {signal.source}</div>
                <div style={{ marginTop: '6px', fontWeight: 'bold' }}>
                  周期: {signal.redSeconds + signal.greenSeconds + signal.yellowSeconds} 秒
                </div>
                <div>
                  赤 {signal.redSeconds}s / 青 {signal.greenSeconds}s / 黄 {signal.yellowSeconds}s
                </div>

                <label>
                  赤 秒
                  <input
                    type="number"
                    value={signal.redSeconds}
                    onChange={(e) => updateSignalSeconds(signal, 'redSeconds', Number(e.target.value))}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </label>

                <label>
                  青 秒
                  <input
                    type="number"
                    value={signal.greenSeconds}
                    onChange={(e) => updateSignalSeconds(signal, 'greenSeconds', Number(e.target.value))}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </label>

                <label>
                  黄 秒
                  <input
                    type="number"
                    value={signal.yellowSeconds}
                    onChange={(e) => updateSignalSeconds(signal, 'yellowSeconds', Number(e.target.value))}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </label>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}

export default App
