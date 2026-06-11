import { useEffect, useState } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import {
  DEFAULT_SIGNAL_TIMING,
  ROUTE_SIGNAL_DISTANCE_METERS,
  WALKING_SPEED_KMH,
  getEstimatedDelayForSignal,
  getSignalRuntime,
  getSignalStateLabel,
  getWalkingDurationSeconds,
  type SignalState,
} from './signalTiming'

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

function getSignalLabel(type: SignalType) {
  if (type === 'vehicle') return '車両用信号'
  if (type === 'pedestrian') return '歩行者用信号'
  if (type === 'both') return '車両・歩行者両方'
  if (type === 'crossing') return '横断歩道'
  return '不明'
}

function getSignalColor(state: SignalState) {
  if (state === 'red') return '#dc2626'
  if (state === 'green') return '#16a34a'
  return '#facc15'
}

function getSignalTextColor(state: SignalState) {
  if (state === 'yellow') return '#111827'
  return '#ffffff'
}

function getSignalMarkerIcon(state: SignalState, remainingSeconds: number, isRouteNearby: boolean) {
  const size = isRouteNearby ? 42 : 32
  const fontSize = isRouteNearby ? 15 : 12
  const borderWidth = isRouteNearby ? 4 : 2

  return L.divIcon({
    className: 'traffic-signal-countdown-marker',
    html: `
      <div style="
        width:${size}px;
        height:${size}px;
        border-radius:9999px;
        background:${getSignalColor(state)};
        color:${getSignalTextColor(state)};
        border:${borderWidth}px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
        font-size:${fontSize}px;
        font-family:sans-serif;
        line-height:1;
      ">${remainingSeconds}</div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
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

  const [nowMs, setNowMs] = useState<number>(Date.now())
  const [signals, setSignals] = useState<TrafficSignal[]>([])
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [loadingSignals, setLoadingSignals] = useState<boolean>(false)
  const [loadingStartSearch, setLoadingStartSearch] = useState<boolean>(false)
  const [loadingDestinationSearch, setLoadingDestinationSearch] = useState<boolean>(false)
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

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
              redSeconds: DEFAULT_SIGNAL_TIMING.redSeconds,
              greenSeconds: DEFAULT_SIGNAL_TIMING.greenSeconds,
              yellowSeconds: DEFAULT_SIGNAL_TIMING.yellowSeconds,
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
  }, [startPosition])

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
      const walkingDurationSeconds = getWalkingDurationSeconds(route.distance)

      const coordinates: Position[] = route.geometry.coordinates.map(([lng, lat]) => ({
        lat,
        lng,
      }))

      setRouteInfo({
        coordinates,
        distanceMeters: route.distance,
        durationSeconds: walkingDurationSeconds,
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

  const vehicleCount = signals.filter((signal) => signal.type === 'vehicle').length
  const pedestrianCount = signals.filter((signal) => signal.type === 'pedestrian').length
  const bothCount = signals.filter((signal) => signal.type === 'both').length
  const crossingCount = signals.filter((signal) => signal.type === 'crossing').length
  const unknownCount = signals.filter((signal) => signal.type === 'unknown').length

  const routeNearbySignals = routeInfo
    ? signals.filter((signal) => distanceToRouteMeters(signal, routeInfo.coordinates) <= ROUTE_SIGNAL_DISTANCE_METERS)
    : []

  const routeNearbySignalKeys = new Set(routeNearbySignals.map((signal) => `${signal.type}-${signal.id}`))

  const estimatedSignalDelaySeconds = routeNearbySignals.reduce((total, signal) => {
    return (
      total +
      getEstimatedDelayForSignal(
        signal.id,
        {
          redSeconds: signal.redSeconds,
          greenSeconds: signal.greenSeconds,
          yellowSeconds: signal.yellowSeconds,
        },
        nowMs,
      )
    )
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

        {routeInfo && (
          <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
            <div style={{ fontWeight: 'bold' }}>ルート情報</div>
            <div>距離: {formatKm(routeInfo.distanceMeters)}</div>
            <div>徒歩速度: {WALKING_SPEED_KMH}km/h</div>
            <div>通常時間: {formatMinutes(routeInfo.durationSeconds)}</div>
            <div>ルート付近信号: {routeNearbySignals.length}個</div>
            <div>推定信号待ち: {formatSeconds(estimatedSignalDelaySeconds)}</div>
            <div style={{ fontWeight: 'bold' }}>信号込み: {formatMinutes(estimatedRouteSeconds)}</div>
          </section>
        )}

        <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
          <div style={{ fontWeight: 'bold' }}>信号情報</div>
          <div>
            周期: 赤{DEFAULT_SIGNAL_TIMING.redSeconds}秒 / 青{DEFAULT_SIGNAL_TIMING.greenSeconds}秒 / 黄
            {DEFAULT_SIGNAL_TIMING.yellowSeconds}秒
          </div>
          <div>状態: アプリ内シミュレーション</div>
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
        <div>信号丸: 現在色と残り秒数</div>
        <div>大きい信号丸: ルート付近</div>
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

        {signals.map((signal) => {
          const signalTiming = {
            redSeconds: signal.redSeconds,
            greenSeconds: signal.greenSeconds,
            yellowSeconds: signal.yellowSeconds,
          }
          const runtime = getSignalRuntime(signal.id, signalTiming, nowMs)
          const signalKey = `${signal.type}-${signal.id}`
          const isRouteNearby = routeNearbySignalKeys.has(signalKey)
          const signalMarkerIcon = getSignalMarkerIcon(runtime.state, runtime.remainingSeconds, isRouteNearby)

          return (
            <Marker key={signalKey} position={[signal.lat, signal.lng]} icon={signalMarkerIcon}>
              <Popup>
                <div style={{ minWidth: '190px', fontFamily: 'sans-serif' }}>
                  <div>種類: {getSignalLabel(signal.type)}</div>
                  <div>信号ID: {signal.id}</div>
                  <div>取得元: {signal.source}</div>
                  <div style={{ marginTop: '6px', fontWeight: 'bold' }}>
                    現在: {getSignalStateLabel(runtime.state)} / 残り {runtime.remainingSeconds}秒
                  </div>
                  <div>周期: {runtime.cycleSeconds}秒</div>
                  <div>
                    赤 {signal.redSeconds}s / 青 {signal.greenSeconds}s / 黄 {signal.yellowSeconds}s
                  </div>
                  {isRouteNearby && <div style={{ marginTop: '6px', fontWeight: 'bold' }}>このルート付近の信号</div>}
                </div>
              </Popup>
            </Marker>
          )
        })}
      </MapContainer>
    </div>
  )
}

export default App
