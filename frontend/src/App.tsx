import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MapContainer,
  Marker,
  Pane,
  Polyline,
  Popup,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'

import 'leaflet/dist/leaflet.css'
import './App.css'
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
const INITIAL_MAP_ZOOM = 17
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

function getSignalDataBadgeColor(resolution: ResolvedSignalTiming) {
  if (resolution.source === 'measured') return '#2563eb'
  if (resolution.source === 'no-pedestrian-crossing') return '#16a34a'
  return '#94a3b8'
}

function getSignalDataBadgeLabel(resolution: ResolvedSignalTiming) {
  if (resolution.source === 'measured') return '実'
  if (resolution.source === 'no-pedestrian-crossing') return '無'
  return '平'
}

function getSignalMarkerIcon(
  signalCount: number,
  resolution: ResolvedSignalTiming,
  statusLabel: string,
  statusColor: string,
  displayMode: 'dot' | 'compact' | 'detailed',
  state: PredictedSignalState['state'] | 'unsynchronized',
) {
  const size = displayMode === 'dot' ? 14 : displayMode === 'compact' ? 26 : 40
  const hitSize = Math.max(28, size + 4)
  const countBadge = displayMode !== 'dot' && signalCount > 1 ? String(signalCount) : ''
  const sourceBadge = getSignalDataBadgeLabel(resolution)
  return L.divIcon({
    className: 'traffic-signal-marker',
    html: `<div class="signal-marker-shell signal-marker--${displayMode} signal-marker-state--${state}" style="--signal-size:${size}px;--signal-hit-size:${hitSize}px;--signal-state-color:${statusColor};--signal-data-color:${getSignalDataBadgeColor(resolution)}"><div class="signal-marker-body">${statusLabel}</div><span class="signal-data-badge signal-data-badge--${resolution.source}">${sourceBadge}</span>${countBadge ? `<span class="signal-count-badge">${countBadge}</span>` : ''}</div>`,
    iconSize: [hitSize, hitSize],
    iconAnchor: [hitSize / 2, hitSize / 2],
    popupAnchor: [0, -(size / 2 + 5)],
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
  return state === 'blinking' ? '点' : getPredictedStateLabel(state)
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

function MapZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  useMapEvents({
    zoomend: (event) => onZoomChange(event.target.getZoom()),
  })
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
  const [legendOpen, setLegendOpen] = useState(false)
  const [controlPanelOpen, setControlPanelOpen] = useState(true)
  const [mapZoom, setMapZoom] = useState(INITIAL_MAP_ZOOM)
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
  const controlPanelOpenButtonRef = useRef<HTMLButtonElement | null>(null)
  const controlPanelCloseButtonRef = useRef<HTMLButtonElement | null>(null)

  const closeControlPanel = useCallback(() => {
    setControlPanelOpen(false)
    window.requestAnimationFrame(() => controlPanelOpenButtonRef.current?.focus())
  }, [])

  const openControlPanel = useCallback(() => {
    setControlPanelOpen(true)
    window.requestAnimationFrame(() => controlPanelCloseButtonRef.current?.focus())
  }, [])

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

  useEffect(() => {
    if (!controlPanelOpen) return
    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closeControlPanel()
    }
    document.addEventListener('keydown', handleEscapeKey)
    return () => document.removeEventListener('keydown', handleEscapeKey)
  }, [closeControlPanel, controlPanelOpen])

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
  const signalFetchStatusLabel = signalFetchStatus === 'loading'
    ? '取得中'
    : signalFetchStatus === 'success'
      ? '取得完了'
      : signalFetchStatus === 'error'
        ? '取得失敗'
        : candidateRoutes.length > 0
          ? '取得待ち'
          : 'ルート検索待ち'
  const routePositions = routeInfo?.coordinates.map(
    (point) => [point.lat, point.lng] as [number, number],
  ) ?? []

  return (
    <div className={`app-shell${controlPanelOpen ? '' : ' app-shell--panel-closed'}`}>
      <button
        ref={controlPanelOpenButtonRef}
        className={`panel-open-button${controlPanelOpen ? '' : ' panel-open-button--visible'}`}
        type="button"
        onClick={openControlPanel}
        aria-label="操作パネルを開く"
        aria-expanded={controlPanelOpen}
        aria-controls="navigation-control-panel"
        aria-hidden={controlPanelOpen}
        tabIndex={controlPanelOpen ? -1 : 0}
      >
        <span aria-hidden="true">☰</span> ナビ
      </button>

      <aside
        id="navigation-control-panel"
        className={`control-panel${controlPanelOpen ? '' : ' control-panel--closed'}`}
        aria-label="ルート検索と信号情報"
        aria-hidden={!controlPanelOpen}
        inert={!controlPanelOpen}
      >
        <header className="app-header">
          <h1 className="app-title">赤信号回避ナビ</h1>
          <button
            ref={controlPanelCloseButtonRef}
            className="panel-close-button"
            type="button"
            onClick={closeControlPanel}
            aria-label="操作パネルを閉じる"
            aria-expanded={controlPanelOpen}
            aria-controls="navigation-control-panel"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="route-form">
          <div className="field">
            <label className="field-label" htmlFor="start-query">出発地</label>
            <input
              id="start-query"
              className="text-input"
              value={startQuery}
              onChange={(event) => setStartQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !loadingStartSearch) void searchStart()
              }}
              placeholder="出発地を入力"
            />
            <div className="button-row">
              <button className="button button--secondary" type="button" onClick={searchStart} disabled={loadingStartSearch}>
                {loadingStartSearch ? '検索中...' : '検索'}
              </button>
              <button className="button button--secondary" type="button" onClick={useCurrentLocationAsStart}>
                GPS現在地
              </button>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="destination-query">目的地</label>
            <input
              id="destination-query"
              className="text-input"
              value={destinationQuery}
              onChange={(event) => setDestinationQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !loadingDestinationSearch) void searchDestination()
              }}
              placeholder="目的地を入力"
            />
            <button className="button button--secondary" type="button" onClick={searchDestination} disabled={loadingDestinationSearch}>
              {loadingDestinationSearch ? '検索中...' : '目的地を検索'}
            </button>
          </div>
        </div>

        <div className="panel-actions">
          <button className="button button--primary" type="button" onClick={fetchFastestRoute} disabled={routeButtonDisabled}>
            {loadingRoute ? '候補取得中...' : '信号込みルート'}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => setSignalDisplayMode((previous) => (previous === 'routeOnly' ? 'all' : 'routeOnly'))}
          >
            信号表示: {signalDisplayMode === 'routeOnly' ? 'ルート付近のみ' : '全信号'}
          </button>
        </div>

        {(generalErrorMessage || routeErrorMessage || signalErrorMessage) && (
          <div className="alerts">
            {generalErrorMessage && <div className="alert alert--error" role="alert">{generalErrorMessage}</div>}
            {routeErrorMessage && <div className="alert alert--error" role="alert">{routeErrorMessage}</div>}
            {signalErrorMessage && <div className="alert alert--warning" role="alert">{signalErrorMessage}</div>}
          </div>
        )}

        {bestEvaluation && routeInfo && (
          <section className="route-summary-card" aria-label="採用ルート">
            <div className="route-summary-header">
              <div>
                <div className="route-summary-label">
                  {signalEvaluationReady ? '信号込み推奨ルート' : '通常の徒歩ルート'}
                </div>
                <div className="route-summary-time">{formatMinutes(estimatedRouteSeconds)}</div>
              </div>
              <span className="route-summary-chip">
                {signalEvaluationReady ? '信号評価済み' : '信号未反映'}
              </span>
            </div>
            <div className="metrics-grid">
              <div className="metric">
                <span className="metric-label">徒歩時間</span>
                <span className="metric-value">{formatMinutes(routeInfo.durationSeconds)}</span>
              </div>
              <div className="metric">
                <span className="metric-label">信号待ち</span>
                <span className="metric-value">
                  {signalEvaluationReady ? formatSeconds(estimatedSignalDelaySeconds) : '未反映'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">距離</span>
                <span className="metric-value">{formatKm(routeInfo.distanceMeters)}</span>
              </div>
              <div className="metric">
                <span className="metric-label">信号群数</span>
                <span className="metric-value">
                  {signalEvaluationReady ? `${routeNearbyGroups.length}群` : '未評価'}
                </span>
              </div>
            </div>
            {loadingSignals && (
              <p className="route-loading-note">信号を取得中です。徒歩ルートは表示済みです。</p>
            )}
          </section>
        )}

        <div className="disclosure-stack">
          {bestEvaluation && routeInfo && (
            <details className="disclosure">
              <summary className="disclosure-summary">採用ルート詳細</summary>
              <div className="disclosure-body">
                <div className="detail-list">
                  <div className="detail-row"><span className="detail-label">Provider</span><span className="detail-value">{routeInfo.provider}</span></div>
                  <div className="detail-row"><span className="detail-label">Profile</span><span className="detail-value">{routeInfo.profile}</span></div>
                  <div className="detail-row"><span className="detail-label">比較候補</span><span className="detail-value">{routeEvaluations.length}本</span></div>
                  <div className="detail-row"><span className="detail-label">徒歩速度</span><span className="detail-value">{WALKING_SPEED_KMH}km/h</span></div>
                </div>
                <p className="detail-note">{routeInfo.note}</p>
                {signalEvaluationReady && (
                  <>
                    <p className="detail-note">候補ごとに徒歩時間と期待信号待ち時間の合計を比較しています。</p>
                    <p className="detail-note">同期状態は経路評価へ使用せず、ランダム到着時の期待待ち時間を使用します。</p>
                  </>
                )}
              </div>
            </details>
          )}

          {routeEvaluations.length > 1 && (
            <details className="disclosure">
              <summary className="disclosure-summary">候補比較（{routeEvaluations.length}本）</summary>
              <div className="disclosure-body candidate-list">
                {routeEvaluations.map((evaluation, index) => (
                  <div
                    className={`candidate-item${index === 0 ? ' candidate-item--selected' : ''}`}
                    key={`${evaluation.route.provider}-${evaluation.route.profile}-${index}`}
                  >
                    <div className="candidate-title">
                      {index + 1}. {index === 0 ? '採用 ' : ''}{formatKm(evaluation.route.distanceMeters)}
                    </div>
                    <div className="candidate-breakdown">
                      {signalEvaluationReady
                        ? `徒歩 ${formatSeconds(evaluation.route.durationSeconds)} + 信号 ${formatSeconds(evaluation.signalDelaySeconds)} = ${formatSeconds(evaluation.totalSeconds)} / ${evaluation.signalGroups.length}群`
                        : `徒歩 ${formatSeconds(evaluation.route.durationSeconds)} / 信号待ちは未反映`}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="disclosure">
            <summary className="disclosure-summary">信号情報（{signalFetchStatusLabel}）</summary>
            <div className="disclosure-body">
              <div className="detail-list">
                <div className="detail-row"><span className="detail-label">取得状態</span><span className="detail-value">{signalFetchStatusLabel}</span></div>
                <div className="detail-row"><span className="detail-label">表示中</span><span className="detail-value">{visibleSignalGroups.length}群</span></div>
                <div className="detail-row"><span className="detail-label">取得信号群</span><span className="detail-value">{signalGroups.length}群</span></div>
                <div className="detail-row"><span className="detail-label">信号本数</span><span className="detail-value">{signals.length}本</span></div>
                <div className="detail-row"><span className="detail-label">実測値</span><span className="detail-value">{measuredCount}本</span></div>
              </div>
              <div className="sync-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => { void fetchSignalsForRoutes(candidateRoutes) }}
                  disabled={candidateRoutes.length === 0 || loadingSignals}
                >
                  {loadingSignals ? '信号データ再取得中...' : '信号データを再取得'}
                </button>
              </div>
            </div>
          </details>

          <details className="disclosure">
            <summary className="disclosure-summary">一括仮同期（{bulkSynchronizationCount}群）</summary>
            <div className="disclosure-body">
              <div className="detail-row">
                <span className="detail-label">同期中</span>
                <span className="detail-value">個別 {individualSynchronizationCount}群 / 仮同期 {bulkSynchronizationCount}群</span>
              </div>
              <div className="sync-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => handleBulkSynchronizeVisibleSignalGroups(new Date().getTime(), null)}
                  disabled={bulkSynchronizationEligibleCount === 0}
                >
                  表示中の信号を一括仮同期
                </button>
                <button
                  className="button button--danger"
                  type="button"
                  onClick={handleRemoveBulkSynchronizations}
                  disabled={bulkSynchronizationCount === 0}
                >
                  一括仮同期を解除
                </button>
              </div>
              <p className="detail-note">未同期の表示信号群が同時に青になったと仮定します。個別同期は変更せず、経路評価にも使用しません。</p>
            </div>
          </details>

          <details className="disclosure">
            <summary className="disclosure-summary">技術情報</summary>
            <div className="disclosure-body">
              <div className="detail-list">
                <div className="detail-row"><span className="detail-label">既定周期</span><span className="detail-value">{DEFAULT_SIGNAL_TIMING.cycleSeconds}秒</span></div>
                <div className="detail-row"><span className="detail-label">既定 青 / 点滅 / 赤</span><span className="detail-value">{DEFAULT_SIGNAL_TIMING.greenSeconds} / {DEFAULT_SIGNAL_TIMING.blinkSeconds} / {defaultRedSeconds}秒</span></div>
                <div className="detail-row"><span className="detail-label">既定期待待ち</span><span className="detail-value">約{Math.round(defaultExpectedDelaySeconds)}秒</span></div>
                <div className="detail-row"><span className="detail-label">実測マッチ</span><span className="detail-value">{MEASURED_SIGNAL_MATCH_DISTANCE_METERS}m以内</span></div>
                <div className="detail-row"><span className="detail-label">取得範囲</span><span className="detail-value">候補{candidateRoutes.length}本の周囲{SIGNAL_CORRIDOR_RADIUS_METERS}m</span></div>
                <div className="detail-row"><span className="detail-label">ルート判定</span><span className="detail-value">{ROUTE_SIGNAL_GROUP_DISTANCE_METERS}m</span></div>
                <div className="detail-row"><span className="detail-label">グループ化</span><span className="detail-value">{SIGNAL_GROUP_DISTANCE_METERS}m</span></div>
                <div className="detail-row"><span className="detail-label">種別</span><span className="detail-value">車 {vehicleCount} / 歩 {pedestrianCount} / 両 {bothCount} / 不明 {unknownCount}</span></div>
                <div className="detail-row"><span className="detail-label">出発地</span><span className="detail-value coordinates">{startPosition ? `${startPosition.lat.toFixed(5)}, ${startPosition.lng.toFixed(5)}` : '未設定'}</span></div>
                <div className="detail-row"><span className="detail-label">目的地</span><span className="detail-value coordinates">{destinationPosition ? `${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lng.toFixed(5)}` : '未設定'}</span></div>
              </div>
              <p className="detail-note">江東区の実測交差点を優先し、未計測地点には実測平均を使用します。</p>
            </div>
          </details>
        </div>
      </aside>

      <div className="map-legend">
        {legendOpen ? (
          <div className="legend-card" role="region" aria-label="地図の凡例">
            <div className="legend-header">
              <span>凡例</span>
              <button className="legend-close" type="button" onClick={() => setLegendOpen(false)} aria-label="凡例を閉じる">×</button>
            </div>
            <div className="legend-grid">
              <div className="legend-row"><span className="legend-swatch legend-swatch--green" />推定青</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--yellow" />推定点滅</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--red" />推定赤</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--gray" />未同期</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--blue" />実測</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--source-gray" />実測平均</div>
              <div className="legend-row"><span className="legend-swatch legend-swatch--source-green" />横断なし</div>
              <div className="legend-row">待○%：状態確率</div>
              <div className="legend-row legend-row--wide">青線：採用ルート / 数字：信号数</div>
              <div className="legend-row legend-row--wide">ピン：GPS（青）・出発（緑）・目的地（橙）</div>
            </div>
            <p className="legend-note">
              <span>個別同期：手動観測を基準とした推定。</span>
              <span>一括仮同期：同時青を仮定。未同期は状態確率のみ。</span>
            </p>
          </div>
        ) : (
          <button className="legend-toggle" type="button" onClick={() => setLegendOpen(true)} aria-expanded="false">凡例</button>
        )}
      </div>

      <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={INITIAL_MAP_ZOOM} zoomControl={false} className="map-canvas">
        <MapFocus center={startPosition ?? currentLocation} />
        <MapZoomTracker onZoomChange={setMapZoom} />
        <ZoomControl position="topright" />
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Pane name="route-lines" style={{ zIndex: 450, pointerEvents: 'none' }}>
          {routeInfo && (
            <>
              <Polyline
                positions={routePositions}
                interactive={false}
                pathOptions={{
                  color: '#ffffff',
                  weight: 10,
                  opacity: 0.92,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
              <Polyline
                positions={routePositions}
                interactive={false}
                pathOptions={{
                  color: '#1d4ed8',
                  weight: 6,
                  opacity: 0.94,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            </>
          )}
        </Pane>
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
          const shouldEmphasizeMarker = isRouteNearby || Boolean(signalSynchronization)
          const markerDisplayMode = mapZoom <= 13
            || timingResolution.noPedestrianCrossing
            || !shouldEmphasizeMarker
            ? 'dot'
            : mapZoom <= 15
              ? 'compact'
              : 'detailed'
          const markerStatusLabel = markerDisplayMode === 'dot'
            ? ''
            : markerDisplayMode === 'compact'
              ? predictedSignalState
                ? getMarkerStateLabel(predictedSignalState.state)
                : '待'
              : predictedSignalState
                ? `${getMarkerStateLabel(predictedSignalState.state)} ${remainingSeconds}`
                : `待 ${Math.round((signalStateProbabilities?.waitProbability ?? 0) * 100)}%`
          const markerStatusColor = predictedSignalState
            ? SIGNAL_STATE_COLORS[predictedSignalState.state]
            : SIGNAL_STATE_COLORS.unsynchronized
          const signalMarkerIcon = getSignalMarkerIcon(
            group.signals.length,
            timingResolution,
            markerStatusLabel,
            markerStatusColor,
            markerDisplayMode,
            predictedSignalState?.state ?? 'unsynchronized',
          )
          const nextStateLabel = predictedSignalState?.state === 'green'
            ? (signalStateProbabilities && signalStateProbabilities.blinkingProbability > 0 ? '青点滅' : '赤')
            : predictedSignalState?.state === 'blinking'
              ? '赤'
              : '青'
          const synchronizationIsStale = greenStartedAtMs !== undefined
            && nowMs - greenStartedAtMs >= SIGNAL_SYNC_STALE_MS
          const markerAccessibleLabel = timingResolution.noPedestrianCrossing
            ? `横断歩道なし、信号${group.signals.length}個`
            : predictedSignalState && signalSynchronization
              ? `${signalSynchronization.method === 'individual' ? '手動同期' : '一括仮同期'}による推定${getPredictedStateLabel(predictedSignalState.state)}、残り約${remainingSeconds}秒`
              : `位相未同期、待つ可能性${formatProbability(signalStateProbabilities?.waitProbability ?? 0)}`
          return (
            <Marker
              key={group.id}
              position={[group.lat, group.lng]}
              icon={signalMarkerIcon}
              zIndexOffset={shouldEmphasizeMarker ? 500 : 0}
              title={markerAccessibleLabel}
            >
              <Popup maxWidth={310} maxHeight={400} autoPan keepInView autoPanPadding={[24, 24]}>
                <div className="signal-popup">
                  <div className="signal-popup-header">
                    <div className="signal-popup-title">信号群</div>
                    {isRouteNearby && <span className="popup-chip">採用ルート上</span>}
                  </div>

                  <div className="signal-popup-status">
                    {timingResolution.noPedestrianCrossing ? (
                      <div className="signal-popup-status-title">横断歩道なし</div>
                    ) : signalStateProbabilities && predictedSignalState && signalSynchronization ? (
                      <>
                        <div className="signal-popup-status-title">
                          推定状態：{getPredictedStateLabel(predictedSignalState.state)}
                        </div>
                        <div className="signal-popup-remaining">{nextStateLabel}まで 約{remainingSeconds}秒</div>
                        <div className="signal-popup-method">
                          {signalSynchronization.method === 'individual'
                            ? '手動同期に基づく推定状態'
                            : '一括仮同期によるシミュレーション'}
                        </div>
                        <div className="signal-popup-muted">最終同期：{formatTimeSince(greenStartedAtMs, nowMs)}</div>
                        {signalSynchronization.method === 'bulk-simulation' && (
                          <div className="signal-popup-warning">実際の信号間オフセットは反映していません。</div>
                        )}
                        {synchronizationIsStale && (
                          <div className="signal-popup-warning">同期から時間が経過しているため、実際の信号とずれている可能性があります。</div>
                        )}
                      </>
                    ) : signalStateProbabilities ? (
                      <>
                        <div className="signal-popup-status-title">位相未同期</div>
                        <div className="signal-popup-remaining">
                          到着時の状態確率：青 {formatProbability(signalStateProbabilities.greenProbability)} / 青点滅 {formatProbability(signalStateProbabilities.blinkingProbability)} / 赤 {formatProbability(signalStateProbabilities.redProbability)}
                        </div>
                        <div className="signal-popup-method">待つ可能性 {formatProbability(signalStateProbabilities.waitProbability)}</div>
                        <div className="signal-popup-muted">現在状態を予測するには、青へ切り替わった瞬間に同期してください。</div>
                        <div className="signal-popup-muted">※信号の現在色ではありません。到着時刻を周期内でランダムと仮定した確率です。</div>
                      </>
                    ) : null}
                  </div>

                  <div className="signal-popup-meta">
                    <div className="signal-popup-meta-item">
                      <span className="signal-popup-meta-label">期待待ち時間</span>
                      <span className="signal-popup-meta-value">{formatSeconds(groupEstimate.delay)}</span>
                    </div>
                    <div className="signal-popup-meta-item">
                      <span className="signal-popup-meta-label">データ種別</span>
                      <span className="signal-popup-meta-value">{getTimingSourceLabel(timingResolution)}</span>
                    </div>
                  </div>

                  {timingResolution.source === 'measured-average' && (
                    <div className="signal-popup-warning">この地点は実測平均周期を使用しているため、予測精度は低くなります。</div>
                  )}

                  {!timingResolution.noPedestrianCrossing && (
                    <div className="signal-popup-actions">
                      <button className="button button--secondary button--compact" type="button" onClick={() => handleSynchronizeSignalGroup(group, Date.now())}>
                        この信号群を同期
                      </button>
                      <button className="button button--ghost button--compact" type="button" onClick={() => handleBulkSynchronizeVisibleSignalGroups(Date.now(), group)}>
                        表示中すべて仮同期
                      </button>
                      <button
                        className="button button--danger button--compact"
                        type="button"
                        onClick={() => handleRemoveSignalGroupSynchronization(group)}
                        disabled={!signalSynchronization}
                      >
                        同期解除
                      </button>
                    </div>
                  )}

                  <details className="popup-details">
                    <summary>詳細情報</summary>
                    <div className="popup-details-body">
                      <div>含まれる信号：{group.signals.length}個</div>
                      <div>周期：{timingResolution.timing.cycleSeconds}秒</div>
                      <div>青：{Math.round(timingResolution.timing.greenSeconds)}秒 / 青点滅：{Math.round(timingResolution.timing.blinkSeconds)}秒</div>
                      <div>対象：{timingResolution.label}</div>
                      {timingResolution.matchDistanceMeters !== undefined && (
                        <div>実測地点との差：{Math.round(timingResolution.matchDistanceMeters)}m</div>
                      )}
                      {timingResolution.sourceUrl && (
                        <div><a className="popup-source-link" href={timingResolution.sourceUrl} target="_blank" rel="noreferrer">実測出典</a></div>
                      )}
                      <div className="popup-signal-list">
                        {group.signals.map((signal) => (
                          <div key={`${signal.type}-${signal.id}`}>
                            <div>{getSignalLabel(signal.type)} / {getTimingSourceLabel(signal.timingResolution)}</div>
                            <div>OSM ID: {signal.id}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
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
