import { useEffect, useState } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import { fetchPedestrianRoute, type Position, type RouteInfo } from './routeService'
import {
  DEFAULT_SIGNAL_TIMING,
  ROUTE_SIGNAL_DISTANCE_METERS,
  WALKING_SPEED_KMH,
  getEstimatedDelayForSignal,
  getSignalRuntime,
  getSignalStateLabel,
  type SignalState,
} from './signalTiming'

type SignalType = 'pedestrian' | 'vehicle' | 'both' | 'crossing' | 'unknown'
type SignalDisplayMode = 'routeOnly' | 'all'

type TrafficSignal = { id: number; lat: number; lng: number; type: SignalType; source: string; redSeconds: number; greenSeconds: number; yellowSeconds: number }
type SignalGroup = { id: string; lat: number; lng: number; signals: TrafficSignal[] }
type NominatimResult = { display_name: string; lat: string; lon: string }

const SIGNAL_GROUP_DISTANCE_METERS = 18
const ROUTE_SIGNAL_GROUP_DISTANCE_METERS = 90

const currentLocationIcon = new L.Icon({ iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })
const startIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })
const destinationIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-orange.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })

function getSignalLabel(type: SignalType) { if (type === 'vehicle') return '車両用信号'; if (type === 'pedestrian') return '歩行者用信号'; if (type === 'both') return '車両・歩行者両方'; if (type === 'crossing') return '横断歩道'; return '不明' }
function getSignalColor(state: SignalState) { if (state === 'red') return '#dc2626'; if (state === 'green') return '#16a34a'; return '#facc15' }
function getSignalTextColor(state: SignalState) { if (state === 'yellow') return '#111827'; return '#ffffff' }

function getSignalMarkerIcon(state: SignalState, remainingSeconds: number, signalCount: number, isRouteNearby: boolean, showCountdown: boolean) {
  const size = isRouteNearby ? 44 : 18
  const fontSize = isRouteNearby ? 14 : 0
  const borderWidth = isRouteNearby ? 4 : 2
  const label = showCountdown ? String(remainingSeconds) : ''
  const badge = signalCount > 1 ? String(signalCount) : ''
  return L.divIcon({
    className: 'traffic-signal-countdown-marker',
    html: `<div style="position:relative;width:${size}px;height:${size}px;"><div style="width:${size}px;height:${size}px;border-radius:9999px;background:${getSignalColor(state)};color:${getSignalTextColor(state)};border:${borderWidth}px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${fontSize}px;font-family:sans-serif;line-height:1;box-sizing:border-box;">${label}</div>${badge ? `<div style="position:absolute;right:-5px;top:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:#111827;color:white;border:1px solid white;font-size:10px;font-weight:700;font-family:sans-serif;display:flex;align-items:center;justify-content:center;box-sizing:border-box;">${badge}</div>` : ''}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
  })
}

function formatMinutes(seconds: number) { return `${Math.round(seconds / 60)}分` }
function formatSeconds(seconds: number) { if (seconds < 60) return `${Math.round(seconds)}秒`; return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒` }
function formatKm(meters: number) { return `${(meters / 1000).toFixed(2)}km` }
function distanceMeters(a: Position, b: Position) { const earthRadius = 6371000; const lat1 = (a.lat * Math.PI) / 180; const lat2 = (b.lat * Math.PI) / 180; const deltaLat = ((b.lat - a.lat) * Math.PI) / 180; const deltaLng = ((b.lng - a.lng) * Math.PI) / 180; const h = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2); return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) }
function distanceToRouteMeters(point: Position, route: Position[]) { if (route.length === 0) return Infinity; let shortest = Infinity; for (const routePoint of route) { const distance = distanceMeters(point, routePoint); if (distance < shortest) shortest = distance } return shortest }

function createSignalGroups(signals: TrafficSignal[]) {
  const groups: SignalGroup[] = []
  for (const signal of signals) {
    const nearestGroup = groups.find((group) => distanceMeters(signal, { lat: group.lat, lng: group.lng }) <= SIGNAL_GROUP_DISTANCE_METERS)
    if (!nearestGroup) { groups.push({ id: `${signal.type}-${signal.id}`, lat: signal.lat, lng: signal.lng, signals: [signal] }); continue }
    nearestGroup.signals.push(signal)
    nearestGroup.lat = nearestGroup.signals.reduce((total, item) => total + item.lat, 0) / nearestGroup.signals.length
    nearestGroup.lng = nearestGroup.signals.reduce((total, item) => total + item.lng, 0) / nearestGroup.signals.length
  }
  return groups
}
function getSignalTiming(signal: TrafficSignal) { return { redSeconds: signal.redSeconds, greenSeconds: signal.greenSeconds, yellowSeconds: signal.yellowSeconds } }
function getGroupRuntime(group: SignalGroup, nowMs: number) { return group.signals.map((signal) => ({ signal, runtime: getSignalRuntime(signal.id, getSignalTiming(signal), nowMs), delay: getEstimatedDelayForSignal(signal.id, getSignalTiming(signal), nowMs) })).sort((a, b) => b.delay - a.delay)[0] }

function MapFocus({ center }: { center: Position | null }) { const map = useMap(); useEffect(() => { if (!center) return; map.setView([center.lat, center.lng], Math.max(map.getZoom(), 15)) }, [center, map]); return null }

function App() {
  const [currentLocation, setCurrentLocation] = useState<Position | null>(null)
  const [startPosition, setStartPosition] = useState<Position | null>(null)
  const [destinationPosition, setDestinationPosition] = useState<Position | null>(null)
  const [startQuery, setStartQuery] = useState<string>('')
  const [destinationQuery, setDestinationQuery] = useState<string>('')
  const [nowMs, setNowMs] = useState<number>(Date.now())
  const [signals, setSignals] = useState<TrafficSignal[]>([])
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const [signalDisplayMode, setSignalDisplayMode] = useState<SignalDisplayMode>('routeOnly')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [loadingSignals, setLoadingSignals] = useState<boolean>(false)
  const [loadingStartSearch, setLoadingStartSearch] = useState<boolean>(false)
  const [loadingDestinationSearch, setLoadingDestinationSearch] = useState<boolean>(false)
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false)

  useEffect(() => { const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000); return () => window.clearInterval(intervalId) }, [])
  useEffect(() => { if (!navigator.geolocation) { setErrorMessage('このブラウザは位置情報に対応していません。'); return } navigator.geolocation.getCurrentPosition((pos) => { const gpsPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }; setCurrentLocation(gpsPosition); setStartPosition(gpsPosition) }, (error) => { console.error(error); setErrorMessage('位置情報の取得に失敗しました。出発地を検索で指定してください。') }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }) }, [])

  useEffect(() => {
    if (!startPosition) return
    const fetchSignals = async () => {
      setLoadingSignals(true); setErrorMessage('')
      const radius = 1000
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
        const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query })
        if (!response.ok) throw new Error(`Overpass API error: ${response.status}`)
        const data = await response.json()
        const parsed: TrafficSignal[] = data.elements.map((el: any) => {
          const tags = el.tags || {}; const lat = el.lat ?? el.center?.lat; const lng = el.lon ?? el.center?.lon
          let type: SignalType = 'unknown'; let source = 'unknown'
          const isVehicleSignal = tags.highway === 'traffic_signals'; const isTrafficSignalCrossing = tags.crossing === 'traffic_signals'; const isCrossing = tags.highway === 'crossing'
          if (isVehicleSignal && isTrafficSignalCrossing) { type = 'both'; source = 'highway=traffic_signals + crossing=traffic_signals' } else if (isTrafficSignalCrossing) { type = 'pedestrian'; source = 'crossing=traffic_signals' } else if (isVehicleSignal) { type = 'vehicle'; source = 'highway=traffic_signals' } else if (isCrossing) { type = 'crossing'; source = 'highway=crossing' }
          return { id: el.id, lat, lng, type, source, redSeconds: DEFAULT_SIGNAL_TIMING.redSeconds, greenSeconds: DEFAULT_SIGNAL_TIMING.greenSeconds, yellowSeconds: DEFAULT_SIGNAL_TIMING.yellowSeconds }
        }).filter((signal: TrafficSignal) => typeof signal.lat === 'number' && typeof signal.lng === 'number')
        setSignals(Array.from(new Map(parsed.map((signal) => [`${signal.type}-${signal.id}`, signal])).values()))
      } catch (err) { console.error(err); setErrorMessage('信号データの取得に失敗しました。時間を置いて再読み込みしてください。') } finally { setLoadingSignals(false) }
    }
    fetchSignals()
  }, [startPosition])

  useEffect(() => { setRouteInfo(null) }, [startPosition, destinationPosition])

  const searchPlace = async (query: string): Promise<Position | null> => {
    const trimmedQuery = query.trim(); if (!trimmedQuery) { setErrorMessage('検索キーワードを入力してください。'); return null }
    const params = new URLSearchParams({ format: 'json', q: trimmedQuery, countrycodes: 'jp', limit: '1' })
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`)
    if (!response.ok) throw new Error(`Nominatim API error: ${response.status}`)
    const results = (await response.json()) as NominatimResult[]
    if (results.length === 0) { setErrorMessage(`検索結果がありません: ${trimmedQuery}`); return null }
    return { lat: Number(results[0].lat), lng: Number(results[0].lon) }
  }
  const searchStart = async () => { setLoadingStartSearch(true); setErrorMessage(''); try { const result = await searchPlace(startQuery); if (!result) return; setStartPosition(result) } catch (err) { console.error(err); setErrorMessage('出発地検索に失敗しました。') } finally { setLoadingStartSearch(false) } }
  const searchDestination = async () => { setLoadingDestinationSearch(true); setErrorMessage(''); try { const result = await searchPlace(destinationQuery); if (!result) return; setDestinationPosition(result) } catch (err) { console.error(err); setErrorMessage('目的地検索に失敗しました。') } finally { setLoadingDestinationSearch(false) } }
  const fetchShortestRoute = async () => { if (!startPosition || !destinationPosition) { setErrorMessage('出発地と目的地を設定してください。'); return } setLoadingRoute(true); setErrorMessage(''); try { setRouteInfo(await fetchPedestrianRoute(startPosition, destinationPosition)) } catch (err) { console.error(err); setErrorMessage('徒歩ルート取得に失敗しました。') } finally { setLoadingRoute(false) } }
  const useCurrentLocationAsStart = () => { if (!currentLocation) { setErrorMessage('現在地が取得できていません。'); return } setStartPosition(currentLocation); setStartQuery(''); setErrorMessage('') }

  const vehicleCount = signals.filter((signal) => signal.type === 'vehicle').length
  const pedestrianCount = signals.filter((signal) => signal.type === 'pedestrian').length
  const bothCount = signals.filter((signal) => signal.type === 'both').length
  const crossingCount = signals.filter((signal) => signal.type === 'crossing').length
  const unknownCount = signals.filter((signal) => signal.type === 'unknown').length
  const signalGroups = createSignalGroups(signals)
  const routeNearbyGroups = routeInfo ? signalGroups.filter((group) => distanceToRouteMeters({ lat: group.lat, lng: group.lng }, routeInfo.coordinates) <= ROUTE_SIGNAL_GROUP_DISTANCE_METERS) : []
  const routeNearbyGroupIds = new Set(routeNearbyGroups.map((group) => group.id))
  const estimatedSignalDelaySeconds = routeNearbyGroups.reduce((total, group) => total + getGroupRuntime(group, nowMs).delay, 0)
  const estimatedRouteSeconds = routeInfo ? routeInfo.durationSeconds + estimatedSignalDelaySeconds : 0
  const visibleSignalGroups = signalGroups.filter((group) => { if (signalDisplayMode === 'all') return true; if (!routeInfo) return distanceMeters({ lat: group.lat, lng: group.lng }, startPosition ?? currentLocation ?? { lat: 0, lng: 0 }) <= 300; return routeNearbyGroupIds.has(group.id) })
  const mapCenter = startPosition ?? currentLocation ?? { lat: 35.6812, lng: 139.7671 }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div style={{ position: 'absolute', zIndex: 1000, top: '12px', left: '12px', width: '340px', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', background: 'white', padding: '12px 16px', borderRadius: '8px', fontFamily: 'sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontSize: '14px', lineHeight: '1.6' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '16px' }}>赤信号回避ナビ 試作</div>
        <section style={{ marginBottom: '12px' }}><label style={{ display: 'block', fontWeight: 'bold' }}>出発地</label><input value={startQuery} onChange={(e) => setStartQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchStart() }} placeholder="出発地" style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }} /><div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}><button onClick={searchStart} disabled={loadingStartSearch} style={{ flex: 1 }}>{loadingStartSearch ? '検索中...' : '検索'}</button><button onClick={useCurrentLocationAsStart} style={{ flex: 1 }}>現在地</button></div></section>
        <section style={{ marginBottom: '12px' }}><label style={{ display: 'block', fontWeight: 'bold' }}>目的地</label><input value={destinationQuery} onChange={(e) => setDestinationQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchDestination() }} placeholder="目的地" style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }} /><button onClick={searchDestination} disabled={loadingDestinationSearch} style={{ width: '100%', marginTop: '6px' }}>{loadingDestinationSearch ? '検索中...' : '検索'}</button></section>
        <button onClick={fetchShortestRoute} disabled={loadingRoute || !startPosition || !destinationPosition} style={{ width: '100%', padding: '10px', marginBottom: '12px', fontWeight: 'bold', cursor: loadingRoute || !startPosition || !destinationPosition ? 'not-allowed' : 'pointer' }}>{loadingRoute ? 'ルート取得中...' : '徒歩ルート表示'}</button>
        <section style={{ marginBottom: '12px' }}><button onClick={() => setSignalDisplayMode((prev) => (prev === 'routeOnly' ? 'all' : 'routeOnly'))} style={{ width: '100%' }}>信号表示: {signalDisplayMode === 'routeOnly' ? 'ルート付近のみ' : '全信号'}</button></section>
        {routeInfo && <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}><div style={{ fontWeight: 'bold' }}>ルート情報</div><div>取得: {routeInfo.provider}</div><div>方式: {routeInfo.profile}</div><div>距離: {formatKm(routeInfo.distanceMeters)}</div><div>徒歩速度: {WALKING_SPEED_KMH}km/h</div><div>通常時間: {formatMinutes(routeInfo.durationSeconds)}</div><div>ルート付近信号群: {routeNearbyGroups.length}個</div><div>推定信号待ち: {formatSeconds(estimatedSignalDelaySeconds)}</div><div style={{ fontWeight: 'bold' }}>信号込み表示時間: {formatMinutes(estimatedRouteSeconds)}</div><div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>※まだ信号込みでルート選択はしていません。現在は表示時間への加算だけです。</div><div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>{routeInfo.note}</div></section>}
        <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}><div style={{ fontWeight: 'bold' }}>信号情報</div><div>周期: 赤{DEFAULT_SIGNAL_TIMING.redSeconds}秒 / 青{DEFAULT_SIGNAL_TIMING.greenSeconds}秒 / 黄{DEFAULT_SIGNAL_TIMING.yellowSeconds}秒</div><div>状態: アプリ内シミュレーション</div><div>取得半径: 出発地から1000m</div><div>ルート付近判定: {ROUTE_SIGNAL_GROUP_DISTANCE_METERS}m</div><div>グループ化距離: {SIGNAL_GROUP_DISTANCE_METERS}m</div><div>表示中: {visibleSignalGroups.length}群</div><div>信号群: {signalGroups.length}</div><div>信号本数: {signals.length}</div><div>車両用: {vehicleCount}</div><div>歩行者用: {pedestrianCount}</div><div>両方: {bothCount}</div><div>横断歩道: {crossingCount}</div><div>不明: {unknownCount}</div><div>{loadingSignals ? '取得中...' : '取得完了'}</div></section>
        <section style={{ fontSize: '12px', color: '#555' }}><div>出発地: {startPosition ? `${startPosition.lat.toFixed(5)}, ${startPosition.lng.toFixed(5)}` : '未設定'}</div><div>目的地: {destinationPosition ? `${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lng.toFixed(5)}` : '未設定'}</div></section>{errorMessage && <div style={{ color: 'red', marginTop: '6px' }}>{errorMessage}</div>}
      </div>
      <div style={{ position: 'absolute', zIndex: 1000, bottom: '20px', right: '12px', background: 'white', padding: '8px 10px', borderRadius: '8px', fontFamily: 'sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontSize: '12px', lineHeight: '1.6' }}><div>青ピン: GPS現在地</div><div>緑ピン: 出発地</div><div>橙ピン: 目的地</div><div>青線: 徒歩ルート</div><div>大きい信号丸: ルート付近の信号群</div><div>右上数字: 含まれる信号数</div></div>
      <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={17} style={{ width: '100%', height: '100%' }}><MapFocus center={startPosition ?? currentLocation} /><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{routeInfo && <Polyline positions={routeInfo.coordinates.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#1d4ed8', weight: 6, opacity: 0.85 }} />}{currentLocation && <Marker position={[currentLocation.lat, currentLocation.lng]} icon={currentLocationIcon}><Popup>GPS現在地</Popup></Marker>}{startPosition && <Marker position={[startPosition.lat, startPosition.lng]} icon={startIcon}><Popup>出発地</Popup></Marker>}{destinationPosition && <Marker position={[destinationPosition.lat, destinationPosition.lng]} icon={destinationIcon}><Popup>目的地</Popup></Marker>}{visibleSignalGroups.map((group) => { const groupRuntime = getGroupRuntime(group, nowMs); const isRouteNearby = routeNearbyGroupIds.has(group.id); const signalMarkerIcon = getSignalMarkerIcon(groupRuntime.runtime.state, groupRuntime.runtime.remainingSeconds, group.signals.length, isRouteNearby || !routeInfo, isRouteNearby || !routeInfo); return <Marker key={group.id} position={[group.lat, group.lng]} icon={signalMarkerIcon}><Popup><div style={{ minWidth: '220px', fontFamily: 'sans-serif' }}><div style={{ fontWeight: 'bold' }}>信号群</div><div>含まれる信号: {group.signals.length}個</div><div style={{ marginTop: '6px', fontWeight: 'bold' }}>代表状態: {getSignalStateLabel(groupRuntime.runtime.state)} / 残り {groupRuntime.runtime.remainingSeconds}秒</div><div>代表待ち: {formatSeconds(groupRuntime.delay)}</div>{isRouteNearby && <div style={{ marginTop: '6px', fontWeight: 'bold' }}>このルート付近の信号群</div>}<div style={{ marginTop: '8px', borderTop: '1px solid #ddd', paddingTop: '6px' }}>{group.signals.map((signal) => { const runtime = getSignalRuntime(signal.id, getSignalTiming(signal), nowMs); return <div key={`${signal.type}-${signal.id}`} style={{ marginBottom: '6px' }}><div>{getSignalLabel(signal.type)} / {getSignalStateLabel(runtime.state)} 残り{runtime.remainingSeconds}秒</div><div style={{ fontSize: '11px', color: '#555' }}>ID: {signal.id}</div></div> })}</div></div></Popup></Marker>})}</MapContainer>
    </div>
  )
}

export default App
