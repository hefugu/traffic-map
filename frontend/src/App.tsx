import { useCallback, useEffect, useRef, useState } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import {
  SIGNAL_CORRIDOR_RADIUS_METERS,
  fetchTrafficSignalsAroundRoutes,
  type SignalType,
} from './overpassService'
import { fetchPedestrianRoutes, type Position, type RouteInfo } from './routeService'
import {
  DEFAULT_SIGNAL_TIMING,
  MEASURED_SIGNAL_MATCH_DISTANCE_METERS,
  WALKING_SPEED_KMH,
  getExpectedSignalDelay,
  getPredictedSignalState,
  getSignalRedSeconds,
  getSignalStateProbabilities,
  resolveSignalTiming,
  type PredictedSignalState,
  type ResolvedSignalTiming,
} from './signalTiming'

type SignalDisplayMode = 'routeOnly' | 'all'
type SignalFetchStatus = 'idle' | 'loading' | 'success' | 'error'

type TrafficSignal = {
  id: number
  lat: number
  lng: number
  type: SignalType
  source: string
  timingResolution: ResolvedSignalTiming
}

type SignalGroup = { id: string; lat: number; lng: number; signals: TrafficSignal[] }
type SignalSyncMethod = 'individual' | 'bulk-simulation'
type SignalSynchronization = {
  greenStartedAtMs: number
  method: SignalSyncMethod
}
type SignalSynchronizations = Record<string, SignalSynchronization>
type NominatimResult = { display_name: string; lat: string; lon: string }
type RouteEvaluation = {
  route: RouteInfo
  signalGroups: SignalGroup[]
  signalDelaySeconds: number
  totalSeconds: number
}

const SIGNAL_GROUP_DISTANCE_METERS = 35
const ROUTE_SIGNAL_GROUP_DISTANCE_METERS = 30
const SIGNAL_GROUP_KEY_VERSION = 2
const SIGNAL_SYNC_STORAGE_VERSION = 2
const SIGNAL_SYNC_STORAGE_KEY = 'traffic-map.signal-synchronizations.v2'
const LEGACY_SIGNAL_SYNC_STORAGE_KEY = 'traffic-map.signal-green-started-at.v1'
const SIGNAL_SYNC_STALE_MS = 10 * 60 * 1000
const SIGNAL_STATE_COLORS = {
  green: '#16a34a',
  blinking: '#eab308',
  red: '#dc2626',
  unsynchronized: '#64748b',
} as const

const currentLocationIcon = new L.Icon({ iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })
const startIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })
const destinationIcon = new L.Icon({ iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-orange.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] })

function getSignalLabel(type: SignalType) {
  if (type === 'vehicle') return '車両用信号'
  if (type === 'pedestrian') return '歩行者用信号'
  if (type === 'both') return '車両・歩行者両方'
  return '不明'
}

function getTimingSourceLabel(resolution: ResolvedSignalTiming) {
  if (resolution.source === 'measured') return '実測'
  if (resolution.source === 'no-pedestrian-crossing') return '横断歩道なし'
  return '実測平均'
}

function getSignalMarkerColor(resolution: ResolvedSignalTiming) {
  if (resolution.source === 'measured') return '#2563eb'
  if (resolution.source === 'no-pedestrian-crossing') return '#16a34a'
  return '#64748b'
}

function getSignalMarkerIcon(
  signalCount: number,
  resolution: ResolvedSignalTiming,
  statusLabel: string,
  statusColor: string,
) {
  const size = 50
  const badge = signalCount > 1 ? String(signalCount) : ''
  return L.divIcon({
    className: 'traffic-signal-estimate-marker',
    html: `<div style="position:relative;width:${size}px;height:${size}px;"><div style="width:${size}px;height:${size}px;border-radius:9999px;background:${getSignalMarkerColor(resolution)};color:white;border:3px solid white;box-shadow:0 0 0 4px ${statusColor},0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;font-family:sans-serif;line-height:1;white-space:nowrap;box-sizing:border-box;">${statusLabel}</div>${badge ? `<div style="position:absolute;right:-7px;top:-7px;min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:#111827;color:white;border:1px solid white;font-size:10px;font-weight:700;font-family:sans-serif;display:flex;align-items:center;justify-content:center;box-sizing:border-box;">${badge}</div>` : ''}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}

function formatMinutes(seconds: number) { return `${Math.round(seconds / 60)}分` }
function formatSeconds(seconds: number) { if (seconds < 60) return `${Math.round(seconds)}秒`; return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒` }
function formatKm(meters: number) { return `${(meters / 1000).toFixed(2)}km` }
function formatProbability(probability: number) { return `${(probability * 100).toFixed(1)}%` }

function getPredictedStateLabel(state: PredictedSignalState['state']) {
  if (state === 'green') return '青'
  if (state === 'blinking') return '青点滅'
  return '赤'
}

function getMarkerStateLabel(state: PredictedSignalState['state']) {
  return state === 'blinking' ? '点滅' : getPredictedStateLabel(state)
}

function formatTimeSince(timestampMs: number, nowMs: number) {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}秒前`
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}分前`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}時間前`
  return `${Math.floor(elapsedHours / 24)}日前`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSignalSyncMethod(value: unknown): value is SignalSyncMethod {
  return value === 'individual' || value === 'bulk-simulation'
}

function parseSignalSynchronizations(
  value: unknown,
  acceptLegacyNumbers: boolean,
): SignalSynchronizations {
  if (!isRecord(value)) return {}

  const synchronizations: SignalSynchronizations = {}
  for (const [groupId, storedSynchronization] of Object.entries(value)) {
    if (groupId.length === 0) continue
    if (
      acceptLegacyNumbers
      && typeof storedSynchronization === 'number'
      && Number.isFinite(storedSynchronization)
    ) {
      synchronizations[groupId] = {
        greenStartedAtMs: storedSynchronization,
        method: 'individual',
      }
      continue
    }
    if (
      isRecord(storedSynchronization)
      && typeof storedSynchronization.greenStartedAtMs === 'number'
      && Number.isFinite(storedSynchronization.greenStartedAtMs)
      && isSignalSyncMethod(storedSynchronization.method)
    ) {
      synchronizations[groupId] = {
        greenStartedAtMs: storedSynchronization.greenStartedAtMs,
        method: storedSynchronization.method,
      }
    }
  }
  return synchronizations
}

function loadSignalSynchronizations(): SignalSynchronizations {
  if (typeof window === 'undefined') return {}

  try {
    const storedValue = window.localStorage.getItem(SIGNAL_SYNC_STORAGE_KEY)
    if (storedValue) {
      const parsed: unknown = JSON.parse(storedValue)
      if (
        isRecord(parsed)
        && parsed.version === SIGNAL_SYNC_STORAGE_VERSION
        && isRecord(parsed.synchronizations)
      ) {
        return parseSignalSynchronizations(parsed.synchronizations, false)
      }
    }
  } catch (error) {
    console.warn('信号同期情報を復元できませんでした。', error)
  }

  try {
    const legacyStoredValue = window.localStorage.getItem(LEGACY_SIGNAL_SYNC_STORAGE_KEY)
    if (!legacyStoredValue) return {}
    return parseSignalSynchronizations(JSON.parse(legacyStoredValue) as unknown, true)
  } catch (error) {
    console.warn('以前の信号同期情報を復元できませんでした。', error)
    return {}
  }
}

function saveSignalSynchronizations(synchronizations: SignalSynchronizations) {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(synchronizations).length === 0) {
      window.localStorage.removeItem(SIGNAL_SYNC_STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_SIGNAL_SYNC_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(SIGNAL_SYNC_STORAGE_KEY, JSON.stringify({
      version: SIGNAL_SYNC_STORAGE_VERSION,
      synchronizations,
    }))
    window.localStorage.removeItem(LEGACY_SIGNAL_SYNC_STORAGE_KEY)
  } catch (error) {
    console.warn('信号同期情報を保存できませんでした。', error)
  }
}

function distanceMeters(a: Position, b: Position) {
  const earthRadius = 6371000
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180
  const h = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function distancePointToSegmentMeters(point: Position, start: Position, end: Position) {
  const referenceLat = ((point.lat + start.lat + end.lat) / 3) * (Math.PI / 180)
  const metersPerLatDegree = 111_320
  const metersPerLngDegree = 111_320 * Math.cos(referenceLat)
  const toXY = (position: Position) => ({
    x: position.lng * metersPerLngDegree,
    y: position.lat * metersPerLatDegree,
  })
  const p = toXY(point)
  const a = toXY(start)
  const b = toXY(end)
  const abX = b.x - a.x
  const abY = b.y - a.y
  const lengthSquared = abX * abX + abY * abY
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const projection = Math.max(0, Math.min(1, ((p.x - a.x) * abX + (p.y - a.y) * abY) / lengthSquared))
  const closestX = a.x + projection * abX
  const closestY = a.y + projection * abY
  return Math.hypot(p.x - closestX, p.y - closestY)
}

function distanceToRouteMeters(point: Position, route: Position[]) {
  if (route.length === 0) return Infinity
  if (route.length === 1) return distanceMeters(point, route[0])
  let shortest = Infinity
  for (let index = 0; index < route.length - 1; index += 1) {
    const distance = distancePointToSegmentMeters(point, route[index], route[index + 1])
    if (distance < shortest) shortest = distance
  }
  return shortest
}

function getSortedSignalIds(group: SignalGroup) {
  return [...new Set(group.signals.map((signal) => signal.id))].sort((a, b) => a - b)
}

function getStableSignalGroupId(group: SignalGroup) {
  return `signal-group-v${SIGNAL_GROUP_KEY_VERSION}:${getSortedSignalIds(group).join(',')}`
}

function getLegacySignalGroupIds(group: SignalGroup) {
  const sortedSignals = [...group.signals].sort(
    (a, b) => a.id - b.id || a.type.localeCompare(b.type),
  )
  return [
    `signal-group-${sortedSignals[0].id}`,
    ...sortedSignals.map((signal) => `${signal.type}-${signal.id}`),
  ]
}

function getSignalSynchronization(
  group: SignalGroup,
  synchronizations: SignalSynchronizations,
) {
  const stableSynchronization = synchronizations[group.id]
  const legacySynchronizations = getLegacySignalGroupIds(group)
    .map((groupId) => synchronizations[groupId])
    .filter((synchronization) => synchronization !== undefined)
  const legacyIndividualSynchronization = legacySynchronizations.find(
    (synchronization) => synchronization.method === 'individual',
  )
  if (stableSynchronization?.method === 'individual') return stableSynchronization
  return legacyIndividualSynchronization ?? stableSynchronization ?? legacySynchronizations[0]
}

function migrateLegacySignalSynchronizations(
  synchronizations: SignalSynchronizations,
  groups: SignalGroup[],
) {
  let migratedSynchronizations = synchronizations
  for (const group of groups) {
    const legacyGroupIds = getLegacySignalGroupIds(group)
    const legacySynchronizations = legacyGroupIds
      .map((groupId) => synchronizations[groupId])
      .filter((synchronization) => synchronization !== undefined)
    if (legacySynchronizations.length === 0) continue
    if (migratedSynchronizations === synchronizations) {
      migratedSynchronizations = { ...synchronizations }
    }
    const legacySynchronization = legacySynchronizations.find(
      (synchronization) => synchronization.method === 'individual',
    ) ?? legacySynchronizations[0]
    const stableSynchronization = migratedSynchronizations[group.id]
    if (!stableSynchronization || (
      stableSynchronization.method === 'bulk-simulation'
      && legacySynchronization.method === 'individual'
    )) {
      migratedSynchronizations[group.id] = legacySynchronization
    }
    for (const legacyGroupId of legacyGroupIds) {
      delete migratedSynchronizations[legacyGroupId]
    }
  }
  return migratedSynchronizations
}

function createSignalGroups(signals: TrafficSignal[]) {
  const groups: SignalGroup[] = []
  const sortedSignals = [...signals].sort((a, b) => a.id - b.id || a.type.localeCompare(b.type))
  for (const signal of sortedSignals) {
    const measuredLabel = signal.timingResolution.source === 'measured-average' ? null : signal.timingResolution.label
    const nearestGroup = groups.find((group) => {
      const sameMeasuredIntersection = measuredLabel !== null && group.signals.some((item) => item.timingResolution.label === measuredLabel)
      return sameMeasuredIntersection || distanceMeters(signal, { lat: group.lat, lng: group.lng }) <= SIGNAL_GROUP_DISTANCE_METERS
    })
    if (!nearestGroup) {
      groups.push({ id: `${signal.type}-${signal.id}`, lat: signal.lat, lng: signal.lng, signals: [signal] })
      continue
    }
    nearestGroup.signals.push(signal)
    nearestGroup.lat = nearestGroup.signals.reduce((total, item) => total + item.lat, 0) / nearestGroup.signals.length
    nearestGroup.lng = nearestGroup.signals.reduce((total, item) => total + item.lng, 0) / nearestGroup.signals.length
  }
  return groups.map((group) => ({
    ...group,
    id: getStableSignalGroupId(group),
  }))
}

function getSignalExpectedDelay(signal: TrafficSignal) {
  if (signal.timingResolution.noPedestrianCrossing) return 0
  return getExpectedSignalDelay(signal.timingResolution.timing)
}

function getGroupEstimate(group: SignalGroup) {
  return group.signals
    .map((signal) => ({ signal, delay: getSignalExpectedDelay(signal) }))
    .sort((a, b) => b.delay - a.delay)[0]
}

function evaluateRoute(route: RouteInfo, signalGroups: SignalGroup[]): RouteEvaluation {
  const nearbyGroups = signalGroups.filter((group) =>
    distanceToRouteMeters({ lat: group.lat, lng: group.lng }, route.coordinates) <= ROUTE_SIGNAL_GROUP_DISTANCE_METERS,
  )
  const signalDelaySeconds = nearbyGroups.reduce((total, group) => total + getGroupEstimate(group).delay, 0)
  return {
    route,
    signalGroups: nearbyGroups,
    signalDelaySeconds,
    totalSeconds: route.durationSeconds + signalDelaySeconds,
  }
}

function evaluateRoutes(routes: RouteInfo[], signalGroups: SignalGroup[]) {
  return routes
    .map((route) => evaluateRoute(route, signalGroups))
    .sort((a, b) => a.totalSeconds - b.totalSeconds)
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
  const [signals, setSignals] = useState<TrafficSignal[]>([])
  const [candidateRoutes, setCandidateRoutes] = useState<RouteInfo[]>([])
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null)
  const [routeEvaluations, setRouteEvaluations] = useState<RouteEvaluation[]>([])
  const [signalFetchStatus, setSignalFetchStatus] = useState<SignalFetchStatus>('idle')
  const [signalDisplayMode, setSignalDisplayMode] = useState<SignalDisplayMode>('routeOnly')
  const [generalErrorMessage, setGeneralErrorMessage] = useState<string>(() =>
    typeof navigator !== 'undefined' && navigator.geolocation ? '' : 'このブラウザは位置情報に対応していません。',
  )
  const [routeErrorMessage, setRouteErrorMessage] = useState<string>('')
  const [signalErrorMessage, setSignalErrorMessage] = useState<string>('')
  const [loadingStartSearch, setLoadingStartSearch] = useState<boolean>(false)
  const [loadingDestinationSearch, setLoadingDestinationSearch] = useState<boolean>(false)
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false)
  const [signalSynchronizations, setSignalSynchronizations] = useState<SignalSynchronizations>(
    loadSignalSynchronizations,
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  const signalAbortControllerRef = useRef<AbortController | null>(null)
  const signalRequestIdRef = useRef(0)
  const routeRequestIdRef = useRef(0)
  const hasExplicitStartRef = useRef(false)

  const cancelSignalRequest = useCallback(() => {
    signalRequestIdRef.current += 1
    signalAbortControllerRef.current?.abort()
    signalAbortControllerRef.current = null
  }, [])

  const resetRoutingState = useCallback(() => {
    routeRequestIdRef.current += 1
    cancelSignalRequest()
    setCandidateRoutes([])
    setSignals([])
    setRouteInfo(null)
    setRouteEvaluations([])
    setSignalFetchStatus('idle')
    setRouteErrorMessage('')
    setSignalErrorMessage('')
    setLoadingRoute(false)
  }, [cancelSignalRequest])

  const hasSynchronizedSignals = Object.keys(signalSynchronizations).length > 0

  useEffect(() => {
    saveSignalSynchronizations(signalSynchronizations)
  }, [signalSynchronizations])

  useEffect(() => {
    if (!hasSynchronizedSignals) return
    const timerId = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timerId)
  }, [hasSynchronizedSignals])

  const handleSynchronizeSignalGroup = (group: SignalGroup, greenStartedAtMs: number) => {
    setNowMs(greenStartedAtMs)
    setSignalSynchronizations((current) => {
      const next = { ...current }
      for (const legacyGroupId of getLegacySignalGroupIds(group)) delete next[legacyGroupId]
      next[group.id] = { greenStartedAtMs, method: 'individual' }
      return next
    })
  }

  const handleRemoveSignalGroupSynchronization = (group: SignalGroup) => {
    setSignalSynchronizations((current) => {
      const next = { ...current }
      delete next[group.id]
      for (const legacyGroupId of getLegacySignalGroupIds(group)) delete next[legacyGroupId]
      return next
    })
  }

  useEffect(() => {
    if (!navigator.geolocation) return
    let active = true
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!active) return
        const gpsPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setCurrentLocation(gpsPosition)
        if (!hasExplicitStartRef.current) {
          resetRoutingState()
          setStartPosition(gpsPosition)
        }
        setGeneralErrorMessage('')
      },
      (error) => {
        if (!active) return
        console.error(error)
        setGeneralErrorMessage('位置情報の取得に失敗しました。出発地を検索で指定してください。')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
    return () => {
      active = false
      routeRequestIdRef.current += 1
      cancelSignalRequest()
    }
  }, [cancelSignalRequest, resetRoutingState])

  const searchPlace = async (query: string): Promise<Position | null> => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      setGeneralErrorMessage('検索キーワードを入力してください。')
      return null
    }
    const params = new URLSearchParams({ format: 'json', q: trimmedQuery, countrycodes: 'jp', limit: '1' })
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`)
    if (!response.ok) throw new Error(`Nominatim API error: ${response.status}`)
    const results = (await response.json()) as NominatimResult[]
    if (results.length === 0) {
      setGeneralErrorMessage(`検索結果がありません: ${trimmedQuery}`)
      return null
    }
    return { lat: Number(results[0].lat), lng: Number(results[0].lon) }
  }

  const searchStart = async () => {
    setLoadingStartSearch(true)
    setGeneralErrorMessage('')
    try {
      const result = await searchPlace(startQuery)
      if (result) {
        hasExplicitStartRef.current = true
        resetRoutingState()
        setStartPosition(result)
      }
    } catch (err) {
      console.error(err)
      setGeneralErrorMessage('出発地検索に失敗しました。')
    } finally {
      setLoadingStartSearch(false)
    }
  }

  const searchDestination = async () => {
    setLoadingDestinationSearch(true)
    setGeneralErrorMessage('')
    try {
      const result = await searchPlace(destinationQuery)
      if (result) {
        resetRoutingState()
        setDestinationPosition(result)
      }
    } catch (err) {
      console.error(err)
      setGeneralErrorMessage('目的地検索に失敗しました。')
    } finally {
      setLoadingDestinationSearch(false)
    }
  }

  const signalGroups = createSignalGroups(signals)

  const fetchSignalsForRoutes = async (routes: RouteInfo[]) => {
    if (routes.length === 0) return

    cancelSignalRequest()
    const requestId = signalRequestIdRef.current
    const controller = new AbortController()
    signalAbortControllerRef.current = controller
    const walkingOnlyEvaluations = evaluateRoutes(routes, [])
    setSignals([])
    setRouteEvaluations(walkingOnlyEvaluations)
    setRouteInfo(walkingOnlyEvaluations[0].route)
    setSignalFetchStatus('loading')
    setSignalErrorMessage('')

    try {
      const fetchedSignals = await fetchTrafficSignalsAroundRoutes(routes, { signal: controller.signal })
      if (requestId !== signalRequestIdRef.current || controller.signal.aborted) return

      const resolvedSignals: TrafficSignal[] = fetchedSignals.map((signal) => ({
        ...signal,
        timingResolution: resolveSignalTiming(signal.lat, signal.lng),
      }))
      const resolvedSignalGroups = createSignalGroups(resolvedSignals)
      const signalAwareEvaluations = evaluateRoutes(routes, resolvedSignalGroups)
      if (signalAwareEvaluations.length === 0) throw new Error('比較できる徒歩ルートがありません。')
      setSignalSynchronizations((current) =>
        migrateLegacySignalSynchronizations(current, resolvedSignalGroups),
      )
      setSignals(resolvedSignals)
      setRouteEvaluations(signalAwareEvaluations)
      setRouteInfo(signalAwareEvaluations[0].route)
      setSignalFetchStatus('success')
    } catch (err) {
      if (requestId !== signalRequestIdRef.current || controller.signal.aborted) return
      console.error(err)
      setSignals([])
      setRouteEvaluations(walkingOnlyEvaluations)
      setRouteInfo(walkingOnlyEvaluations[0].route)
      setSignalFetchStatus('error')
      setSignalErrorMessage('信号情報を取得できなかったため、信号待ちを含まない経路を表示しています。')
    } finally {
      if (requestId === signalRequestIdRef.current) signalAbortControllerRef.current = null
    }
  }

  const fetchFastestRoute = async () => {
    if (!startPosition || !destinationPosition) {
      setRouteErrorMessage('出発地と目的地を設定してください。')
      return
    }

    const requestId = routeRequestIdRef.current + 1
    routeRequestIdRef.current = requestId
    cancelSignalRequest()
    setLoadingRoute(true)
    setGeneralErrorMessage('')
    setRouteErrorMessage('')
    setSignalErrorMessage('')
    setSignalFetchStatus('idle')
    setCandidateRoutes([])
    setSignals([])
    setRouteInfo(null)
    setRouteEvaluations([])
    try {
      const routes = await fetchPedestrianRoutes(startPosition, destinationPosition)
      if (requestId !== routeRequestIdRef.current) return
      const walkingOnlyEvaluations = evaluateRoutes(routes, [])
      if (walkingOnlyEvaluations.length === 0) throw new Error('比較できる徒歩ルートがありません。')
      setCandidateRoutes(routes)
      setRouteEvaluations(walkingOnlyEvaluations)
      setRouteInfo(walkingOnlyEvaluations[0].route)
      setLoadingRoute(false)
      void fetchSignalsForRoutes(routes)
    } catch (err) {
      if (requestId !== routeRequestIdRef.current) return
      console.error(err)
      setRouteErrorMessage('徒歩ルートの取得に失敗しました。')
    } finally {
      if (requestId === routeRequestIdRef.current) setLoadingRoute(false)
    }
  }

  const useCurrentLocationAsStart = () => {
    if (!currentLocation) {
      setGeneralErrorMessage('現在地が取得できていません。')
      return
    }
    hasExplicitStartRef.current = true
    resetRoutingState()
    setStartPosition(currentLocation)
    setStartQuery('')
    setGeneralErrorMessage('')
  }

  const vehicleCount = signals.filter((signal) => signal.type === 'vehicle').length
  const pedestrianCount = signals.filter((signal) => signal.type === 'pedestrian').length
  const bothCount = signals.filter((signal) => signal.type === 'both').length
  const unknownCount = signals.filter((signal) => signal.type === 'unknown').length
  const measuredCount = signals.filter((signal) => signal.timingResolution.source === 'measured').length
  const bestEvaluation = routeEvaluations[0] ?? null
  const routeNearbyGroups = bestEvaluation?.signalGroups ?? []
  const routeNearbyGroupIds = new Set(routeNearbyGroups.map((group) => group.id))
  const estimatedSignalDelaySeconds = bestEvaluation?.signalDelaySeconds ?? 0
  const estimatedRouteSeconds = bestEvaluation?.totalSeconds ?? 0
  const visibleSignalGroups = signalGroups.filter((group) => {
    if (signalDisplayMode === 'all') return true
    if (!routeInfo) return distanceMeters({ lat: group.lat, lng: group.lng }, startPosition ?? currentLocation ?? { lat: 0, lng: 0 }) <= 300
    return routeNearbyGroupIds.has(group.id)
  })
  const synchronizableVisibleSignalGroups = visibleSignalGroups.filter(
    (group) => !getGroupEstimate(group).signal.timingResolution.noPedestrianCrossing,
  )
  const bulkSynchronizationEligibleCount = synchronizableVisibleSignalGroups.filter(
    (group) => getSignalSynchronization(group, signalSynchronizations) === undefined,
  ).length
  const bulkSynchronizationCount = Object.values(signalSynchronizations).filter(
    (synchronization) => synchronization.method === 'bulk-simulation',
  ).length
  const individualSynchronizationCount = Object.values(signalSynchronizations).filter(
    (synchronization) => synchronization.method === 'individual',
  ).length

  const handleBulkSynchronizeVisibleSignalGroups = (
    greenStartedAtMs: number,
    individualGroup: SignalGroup | null,
  ) => {
    const bulkSynchronization: SignalSynchronization = {
      greenStartedAtMs,
      method: 'bulk-simulation',
    }
    setNowMs(greenStartedAtMs)
    setSignalSynchronizations((current) => {
      const next = { ...current }
      if (individualGroup) {
        for (const legacyGroupId of getLegacySignalGroupIds(individualGroup)) {
          delete next[legacyGroupId]
        }
        next[individualGroup.id] = { greenStartedAtMs, method: 'individual' }
      }
      for (const group of synchronizableVisibleSignalGroups) {
        if (group.id === individualGroup?.id) continue
        if (getSignalSynchronization(group, current)) continue
        next[group.id] = bulkSynchronization
      }
      return next
    })
  }

  const handleRemoveBulkSynchronizations = () => {
    setSignalSynchronizations((current) => {
      const bulkGroupIds = Object.entries(current)
        .filter(([, synchronization]) => synchronization.method === 'bulk-simulation')
        .map(([groupId]) => groupId)
      if (bulkGroupIds.length === 0) return current
      const next = { ...current }
      for (const groupId of bulkGroupIds) delete next[groupId]
      return next
    })
  }
  const mapCenter = startPosition ?? currentLocation ?? { lat: 35.6812, lng: 139.7671 }
  const defaultExpectedDelaySeconds = getExpectedSignalDelay(DEFAULT_SIGNAL_TIMING)
  const defaultRedSeconds = getSignalRedSeconds(DEFAULT_SIGNAL_TIMING)
  const loadingSignals = signalFetchStatus === 'loading'
  const signalEvaluationReady = signalFetchStatus === 'success'
  const routeButtonDisabled = loadingRoute || !startPosition || !destinationPosition

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <div style={{ position: 'absolute', zIndex: 1000, top: '12px', left: '12px', width: '360px', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', background: 'white', padding: '12px 16px', borderRadius: '8px', fontFamily: 'sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontSize: '14px', lineHeight: '1.6' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '16px' }}>赤信号回避ナビ 試作</div>
        <section style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontWeight: 'bold' }}>出発地</label>
          <input value={startQuery} onChange={(e) => setStartQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !loadingStartSearch) void searchStart() }} placeholder="出発地" style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }} />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button onClick={searchStart} disabled={loadingStartSearch} style={{ flex: 1 }}>{loadingStartSearch ? '検索中...' : '検索'}</button>
            <button onClick={useCurrentLocationAsStart} style={{ flex: 1 }}>現在地</button>
          </div>
        </section>
        <section style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontWeight: 'bold' }}>目的地</label>
          <input value={destinationQuery} onChange={(e) => setDestinationQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !loadingDestinationSearch) void searchDestination() }} placeholder="目的地" style={{ width: '100%', boxSizing: 'border-box', padding: '6px' }} />
          <button onClick={searchDestination} disabled={loadingDestinationSearch} style={{ width: '100%', marginTop: '6px' }}>{loadingDestinationSearch ? '検索中...' : '検索'}</button>
        </section>
        <button onClick={fetchFastestRoute} disabled={routeButtonDisabled} style={{ width: '100%', padding: '10px', marginBottom: '12px', fontWeight: 'bold', cursor: routeButtonDisabled ? 'not-allowed' : 'pointer' }}>
          {loadingRoute ? '候補取得中...' : '信号込み最速ルート'}
        </button>
        <section style={{ marginBottom: '12px' }}>
          <button onClick={() => setSignalDisplayMode((prev) => (prev === 'routeOnly' ? 'all' : 'routeOnly'))} style={{ width: '100%' }}>信号表示: {signalDisplayMode === 'routeOnly' ? 'ルート付近のみ' : '全信号'}</button>
        </section>

        {bestEvaluation && routeInfo && (
          <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
            <div style={{ fontWeight: 'bold' }}>採用ルート</div>
            <div>取得: {routeInfo.provider}</div>
            <div>方式: {routeInfo.profile}</div>
            <div>比較候補: {routeEvaluations.length}本</div>
            <div>距離: {formatKm(routeInfo.distanceMeters)}</div>
            <div>徒歩速度: {WALKING_SPEED_KMH}km/h</div>
            <div>徒歩時間: {formatMinutes(routeInfo.durationSeconds)}</div>
            <div>ルート上信号群: {signalEvaluationReady ? `${routeNearbyGroups.length}個` : '未評価'}</div>
            <div>期待信号待ち: {signalEvaluationReady ? formatSeconds(estimatedSignalDelaySeconds) : '未反映'}</div>
            <div style={{ fontWeight: 'bold' }}>{signalEvaluationReady ? '信号込み最速時間' : '徒歩所要時間'}: {formatMinutes(estimatedRouteSeconds)}</div>
            {signalEvaluationReady && <div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>※候補ごとに「徒歩時間 + 期待信号待ち」を計算し、合計が最小のルートを採用しています。</div>}
            {signalEvaluationReady && <div style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>※経路比較には手動同期・一括仮同期の状態を使用せず、ランダム到着時の期待待ち時間で比較しています。</div>}
            {loadingSignals && <div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>候補経路周辺の信号を取得中です。通常の徒歩経路は表示済みです。</div>}
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#666' }}>{routeInfo.note}</div>
          </section>
        )}

        {routeEvaluations.length > 1 && (
          <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>候補比較</div>
            {routeEvaluations.map((evaluation, index) => (
              <div key={`${evaluation.route.provider}-${evaluation.route.profile}-${index}`} style={{ padding: '4px 0', borderTop: index === 0 ? 'none' : '1px solid #eee' }}>
                <div style={{ fontWeight: index === 0 ? 'bold' : 'normal' }}>{index + 1}. {index === 0 ? '採用 ' : ''}{formatKm(evaluation.route.distanceMeters)}</div>
                <div style={{ fontSize: '12px' }}>
                  {signalEvaluationReady
                    ? `徒歩 ${formatSeconds(evaluation.route.durationSeconds)} + 信号 ${formatSeconds(evaluation.signalDelaySeconds)} = ${formatSeconds(evaluation.totalSeconds)} / 信号${evaluation.signalGroups.length}群`
                    : `徒歩 ${formatSeconds(evaluation.route.durationSeconds)} / 信号待ちは未反映`}
                </div>
              </div>
            ))}
          </section>
        )}

        <section style={{ marginBottom: '12px', padding: '8px', border: '1px solid #ddd', borderRadius: '6px' }}>
          <div style={{ fontWeight: 'bold' }}>信号情報</div>
          <div>既定値: 周期{DEFAULT_SIGNAL_TIMING.cycleSeconds}秒 / 青{DEFAULT_SIGNAL_TIMING.greenSeconds}秒 / 青点滅{DEFAULT_SIGNAL_TIMING.blinkSeconds}秒 / 赤{defaultRedSeconds}秒</div>
          <div>既定期待待ち: 約{Math.round(defaultExpectedDelaySeconds)}秒</div>
          <div>データ: 江東区の実測交差点を優先、未計測地点は実測平均</div>
          <div>実測位置マッチ: {MEASURED_SIGNAL_MATCH_DISTANCE_METERS}m以内</div>
          <div>実測値適用中: {measuredCount}本</div>
          <div>取得範囲: 候補経路{candidateRoutes.length > 0 ? `${candidateRoutes.length}本` : ''}の周囲{SIGNAL_CORRIDOR_RADIUS_METERS}m</div>
          <div>ルート付近判定: {ROUTE_SIGNAL_GROUP_DISTANCE_METERS}m</div>
          <div>グループ化距離: {SIGNAL_GROUP_DISTANCE_METERS}m</div>
          <div>表示中: {visibleSignalGroups.length}群</div>
          <div>信号群: {signalGroups.length}</div>
          <div>信号本数: {signals.length}</div>
          <div>車両用: {vehicleCount}</div>
          <div>歩行者用: {pedestrianCount}</div>
          <div>両方: {bothCount}</div>
          <div>不明: {unknownCount}</div>
          <div>
            {signalFetchStatus === 'loading' && '取得中...'}
            {signalFetchStatus === 'success' && '取得完了'}
            {signalFetchStatus === 'error' && '取得失敗（通常経路を表示中）'}
            {signalFetchStatus === 'idle' && (candidateRoutes.length > 0 ? '信号取得待ち' : 'ルート検索待ち')}
          </div>
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #ddd' }}>
            <div style={{ fontWeight: 'bold' }}>一括仮同期シミュレーション</div>
            <div>個別同期: {individualSynchronizationCount}群 / 一括仮同期: {bulkSynchronizationCount}群</div>
            <button
              type="button"
              onClick={() => handleBulkSynchronizeVisibleSignalGroups(new Date().getTime(), null)}
              disabled={bulkSynchronizationEligibleCount === 0}
              style={{ width: '100%', marginTop: '4px' }}
            >
              表示中の信号を一括仮同期
            </button>
            <button
              type="button"
              onClick={handleRemoveBulkSynchronizations}
              disabled={bulkSynchronizationCount === 0}
              style={{ width: '100%', marginTop: '4px' }}
            >
              一括仮同期を解除
            </button>
            <div style={{ marginTop: '4px', fontSize: '11px', color: '#666' }}>
              表示中の未同期信号群が同時に青になったと仮定します。個別の手動同期は変更せず、経路評価にも使用しません。
            </div>
          </div>
          <button
            onClick={() => { void fetchSignalsForRoutes(candidateRoutes) }}
            disabled={candidateRoutes.length === 0 || loadingSignals}
            style={{ width: '100%', marginTop: '6px' }}
          >
            {loadingSignals ? '信号データ再取得中...' : '信号データを再取得'}
          </button>
        </section>
        <section style={{ fontSize: '12px', color: '#555' }}>
          <div>出発地: {startPosition ? `${startPosition.lat.toFixed(5)}, ${startPosition.lng.toFixed(5)}` : '未設定'}</div>
          <div>目的地: {destinationPosition ? `${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lng.toFixed(5)}` : '未設定'}</div>
        </section>
        {generalErrorMessage && <div style={{ color: 'red', marginTop: '6px' }}>{generalErrorMessage}</div>}
        {routeErrorMessage && <div style={{ color: 'red', marginTop: '6px' }}>{routeErrorMessage}</div>}
        {signalErrorMessage && <div style={{ color: '#b45309', marginTop: '6px' }}>{signalErrorMessage}</div>}
      </div>

      <div style={{ position: 'absolute', zIndex: 1000, bottom: '20px', right: '12px', background: 'white', padding: '8px 10px', borderRadius: '8px', fontFamily: 'sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontSize: '12px', lineHeight: '1.6' }}>
        <div>青ピン: GPS現在地</div>
        <div>緑ピン: 出発地</div>
        <div>橙ピン: 目的地</div>
        <div>青線: 採用ルート</div>
        <div>丸の塗り（データ種別）</div>
        <div>青丸: 実測タイミング</div>
        <div>灰丸: 実測平均タイミング</div>
        <div>緑丸: 横断歩道なし</div>
        <div>外枠（手動同期／一括仮同期の推定状態）</div>
        <div style={{ color: SIGNAL_STATE_COLORS.green }}>緑枠: 推定青</div>
        <div style={{ color: '#a16207' }}>黄枠: 推定青点滅</div>
        <div style={{ color: SIGNAL_STATE_COLORS.red }}>赤枠: 推定赤</div>
        <div>個別同期: 手動観測を基準とした推定</div>
        <div>一括仮同期: 全信号が同時に青開始したと仮定するシミュレーション</div>
        <div>未同期: 状態確率のみ（待○%）</div>
        <div>右上数字: 含まれる信号数</div>
      </div>

      <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={17} style={{ width: '100%', height: '100%' }}>
        <MapFocus center={startPosition ?? currentLocation} />
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {routeInfo && <Polyline positions={routeInfo.coordinates.map((point) => [point.lat, point.lng])} pathOptions={{ color: '#1d4ed8', weight: 6, opacity: 0.85 }} />}
        {currentLocation && <Marker position={[currentLocation.lat, currentLocation.lng]} icon={currentLocationIcon}><Popup>GPS現在地</Popup></Marker>}
        {startPosition && <Marker position={[startPosition.lat, startPosition.lng]} icon={startIcon}><Popup>出発地</Popup></Marker>}
        {destinationPosition && <Marker position={[destinationPosition.lat, destinationPosition.lng]} icon={destinationIcon}><Popup>目的地</Popup></Marker>}
        {visibleSignalGroups.map((group) => {
          const groupEstimate = getGroupEstimate(group)
          const isRouteNearby = routeNearbyGroupIds.has(group.id)
          const timingResolution = groupEstimate.signal.timingResolution
          const signalStateProbabilities = timingResolution.noPedestrianCrossing
            ? null
            : getSignalStateProbabilities(timingResolution.timing)
          const signalSynchronization = getSignalSynchronization(group, signalSynchronizations)
          const greenStartedAtMs = signalSynchronization?.greenStartedAtMs
          const predictedSignalState = greenStartedAtMs !== undefined && !timingResolution.noPedestrianCrossing
            ? getPredictedSignalState(timingResolution.timing, greenStartedAtMs, nowMs)
            : null
          const remainingSeconds = predictedSignalState
            ? Math.max(0, Math.ceil(predictedSignalState.remainingSeconds))
            : 0
          const markerStatusLabel = timingResolution.noPedestrianCrossing
            ? '横断なし'
            : predictedSignalState
              ? `${getMarkerStateLabel(predictedSignalState.state)} ${remainingSeconds}秒`
              : `待${formatProbability(signalStateProbabilities?.waitProbability ?? 0)}`
          const markerStatusColor = predictedSignalState
            ? SIGNAL_STATE_COLORS[predictedSignalState.state]
            : SIGNAL_STATE_COLORS.unsynchronized
          const signalMarkerIcon = getSignalMarkerIcon(
            group.signals.length,
            timingResolution,
            markerStatusLabel,
            markerStatusColor,
          )
          const nextStateLabel = predictedSignalState?.state === 'green'
            ? (signalStateProbabilities && signalStateProbabilities.blinkingProbability > 0 ? '青点滅' : '赤')
            : predictedSignalState?.state === 'blinking'
              ? '赤'
              : '青'
          const synchronizationIsStale = greenStartedAtMs !== undefined
            && nowMs - greenStartedAtMs >= SIGNAL_SYNC_STALE_MS
          return (
            <Marker key={group.id} position={[group.lat, group.lng]} icon={signalMarkerIcon}>
              <Popup>
                <div style={{ minWidth: '240px', fontFamily: 'sans-serif' }}>
                  <div style={{ fontWeight: 'bold' }}>信号群</div>
                  <div>含まれる信号: {group.signals.length}個</div>
                  <div style={{ marginTop: '6px', fontWeight: 'bold' }}>期待待ち: {formatSeconds(groupEstimate.delay)}</div>
                  <div>データ: {getTimingSourceLabel(timingResolution)}</div>
                  <div>周期: {timingResolution.timing.cycleSeconds}秒</div>
                  <div>青: {Math.round(timingResolution.timing.greenSeconds)}秒 / 青点滅: {Math.round(timingResolution.timing.blinkSeconds)}秒</div>
                  {timingResolution.noPedestrianCrossing ? (
                    <div style={{ marginTop: '8px', fontWeight: 'bold' }}>横断歩道なし</div>
                  ) : signalStateProbabilities && predictedSignalState && signalSynchronization ? (
                    <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #ddd' }}>
                      <div style={{ fontWeight: 'bold' }}>
                        {signalSynchronization.method === 'individual'
                          ? '手動同期に基づく推定状態'
                          : '一括仮同期によるシミュレーション'}
                        ：{getPredictedStateLabel(predictedSignalState.state)}
                      </div>
                      {signalSynchronization.method === 'bulk-simulation' && (
                        <div style={{ color: '#b45309' }}>実際の信号間オフセットは反映していません。</div>
                      )}
                      <div>{nextStateLabel}まで：約{remainingSeconds}秒</div>
                      <div>最終同期：{formatTimeSince(greenStartedAtMs, nowMs)}</div>
                      {synchronizationIsStale && (
                        <div style={{ marginTop: '4px', color: '#b45309' }}>同期から時間が経過しているため、実際の信号とずれている可能性があります。</div>
                      )}
                    </div>
                  ) : signalStateProbabilities ? (
                    <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #ddd' }}>
                      <div style={{ fontWeight: 'bold' }}>位相未同期・状態確率のみ</div>
                      <div>到着時の状態確率：青{formatProbability(signalStateProbabilities.greenProbability)} / 青点滅{formatProbability(signalStateProbabilities.blinkingProbability)} / 赤{formatProbability(signalStateProbabilities.redProbability)}</div>
                      <div>待つ可能性 {formatProbability(signalStateProbabilities.waitProbability)}</div>
                      <div>現在状態を予測するには、青へ切り替わった瞬間に同期してください</div>
                      <div style={{ marginTop: '4px', fontSize: '11px', color: '#666' }}>※信号の現在色ではありません。到着時刻を周期内でランダムと仮定した確率です。</div>
                    </div>
                  ) : null}
                  {!timingResolution.noPedestrianCrossing && (
                    <div style={{ display: 'grid', gap: '4px', marginTop: '8px' }}>
                      <button type="button" onClick={() => handleSynchronizeSignalGroup(group, Date.now())}>この信号群を今青に同期</button>
                      <button type="button" onClick={() => handleBulkSynchronizeVisibleSignalGroups(Date.now(), group)}>今青＋表示中すべて仮同期</button>
                      <button
                        type="button"
                        onClick={() => handleRemoveSignalGroupSynchronization(group)}
                        disabled={!signalSynchronization}
                      >
                        同期を解除
                      </button>
                    </div>
                  )}
                  {timingResolution.source === 'measured-average' && (
                    <div style={{ marginTop: '6px', color: '#b45309' }}>この地点は実測平均周期を使用しているため、予測精度は低くなります。</div>
                  )}
                  <div>対象: {timingResolution.label}</div>
                  {timingResolution.matchDistanceMeters !== undefined && <div>実測地点との差: {Math.round(timingResolution.matchDistanceMeters)}m</div>}
                  {timingResolution.sourceUrl && <div><a href={timingResolution.sourceUrl} target="_blank" rel="noreferrer">実測出典</a></div>}
                  {isRouteNearby && <div style={{ marginTop: '6px', fontWeight: 'bold' }}>採用ルート上の信号群</div>}
                  <div style={{ marginTop: '8px', borderTop: '1px solid #ddd', paddingTop: '6px' }}>
                    {group.signals.map((signal) => (
                      <div key={`${signal.type}-${signal.id}`} style={{ marginBottom: '6px' }}>
                        <div>{getSignalLabel(signal.type)} / {getTimingSourceLabel(signal.timingResolution)}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>ID: {signal.id}</div>
                      </div>
                    ))}
                  </div>
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
