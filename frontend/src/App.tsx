import { useEffect, useState } from 'react'
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet'
import L from 'leaflet'

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

const currentLocationIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
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
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const unknownIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-grey.png',
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

function App() {
  const [position, setPosition] = useState<Position | null>(null)
  const [signals, setSignals] = useState<TrafficSignal[]>([])
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [loadingSignals, setLoadingSignals] = useState<boolean>(false)

  useEffect(() => {
    if (!navigator.geolocation) {
      setErrorMessage('このブラウザは位置情報に対応していません。')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        })
      },
      (error) => {
        console.error(error)
        setErrorMessage('位置情報の取得に失敗しました。ブラウザの位置情報許可を確認してください。')
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      },
    )
  }, [])

  useEffect(() => {
    if (!position) return

    const fetchSignals = async () => {
      setLoadingSignals(true)
      setErrorMessage('')

      const radius = 700

      const query = `
        [out:json][timeout:25];
        (
          node["highway"="traffic_signals"](around:${radius},${position.lat},${position.lng});
          node["crossing"="traffic_signals"](around:${radius},${position.lat},${position.lng});
          node["highway"="crossing"](around:${radius},${position.lat},${position.lng});
          way["highway"="crossing"](around:${radius},${position.lat},${position.lng});
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
              redSeconds: 50,
              greenSeconds: 40,
              yellowSeconds: 3,
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
  }, [position])

  const vehicleCount = signals.filter((signal) => signal.type === 'vehicle').length
  const pedestrianCount = signals.filter((signal) => signal.type === 'pedestrian').length
  const bothCount = signals.filter((signal) => signal.type === 'both').length
  const crossingCount = signals.filter((signal) => signal.type === 'crossing').length
  const unknownCount = signals.filter((signal) => signal.type === 'unknown').length

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

  if (errorMessage && !position) {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h1>交通マップ</h1>
        <p>{errorMessage}</p>
      </div>
    )
  }

  if (!position) {
    return (
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h1>交通マップ</h1>
        <p>現在地を取得中...</p>
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          top: '12px',
          left: '12px',
          background: 'white',
          padding: '12px 16px',
          borderRadius: '8px',
          fontFamily: 'sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          fontSize: '14px',
          lineHeight: '1.6',
        }}
      >
        <div style={{ fontWeight: 'bold' }}>交通マップ 試作</div>
        <div>取得半径: 700m</div>
        <div>総数: {signals.length}</div>
        <div>車両用: {vehicleCount}</div>
        <div>歩行者用: {pedestrianCount}</div>
        <div>両方: {bothCount}</div>
        <div>横断歩道: {crossingCount}</div>
        <div>不明: {unknownCount}</div>
        <div>{loadingSignals ? '信号取得中...' : '取得完了'}</div>
        {errorMessage && <div style={{ color: 'red' }}>{errorMessage}</div>}
      </div>

      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          bottom: '20px',
          left: '12px',
          background: 'white',
          padding: '10px 14px',
          borderRadius: '8px',
          fontFamily: 'sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          fontSize: '13px',
          lineHeight: '1.8',
        }}
      >
        <div>青: 歩行者用信号</div>
        <div>赤: 車両用信号</div>
        <div>紫: 両方</div>
        <div>緑: 横断歩道</div>
        <div>灰: 不明</div>
      </div>

      <MapContainer
        center={[position.lat, position.lng]}
        zoom={17}
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
        />

        <Marker position={[position.lat, position.lng]} icon={currentLocationIcon}>
          <Popup>現在地</Popup>
        </Marker>

        {signals.map((signal) => (
          <Marker
            key={`${signal.type}-${signal.id}`}
            position={[signal.lat, signal.lng]}
            icon={getSignalIcon(signal.type)}
          >
            <Popup>
              <div style={{ minWidth: '180px', fontFamily: 'sans-serif' }}>
                <div>種類: {getSignalLabel(signal.type)}</div>
                <div>信号ID: {signal.id}</div>
                <div>取得元: {signal.source}</div>

                <label>
                  赤 秒
                  <input
                    type="number"
                    value={signal.redSeconds}
                    onChange={(e) =>
                      updateSignalSeconds(signal, 'redSeconds', Number(e.target.value))
                    }
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </label>

                <label>
                  青 秒
                  <input
                    type="number"
                    value={signal.greenSeconds}
                    onChange={(e) =>
                      updateSignalSeconds(signal, 'greenSeconds', Number(e.target.value))
                    }
                    style={{ width: '100%', boxSizing: 'border-box' }}
                  />
                </label>

                <label>
                  黄 秒
                  <input
                    type="number"
                    value={signal.yellowSeconds}
                    onChange={(e) =>
                      updateSignalSeconds(signal, 'yellowSeconds', Number(e.target.value))
                    }
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