import { setCurrentRouteWardHint } from './signalRegion'

export type SignalType = 'pedestrian' | 'vehicle' | 'both' | 'unknown'
export type SignalPositionSource = 'live-osm' | 'osm-snapshot'

export type OsmTrafficSignal = {
  id: number
  lat: number
  lng: number
  type: SignalType
  source: string
  positionSource?: SignalPositionSource
  snapshotTimestamp?: string
}

type Position = {
  lat: number
  lng: number
}

type RouteGeometry = {
  coordinates: readonly Position[]
}

type OverpassElement = {
  id?: unknown
  lat?: unknown
  lon?: unknown
  tags?: unknown
}

type OverpassResponse = {
  elements?: unknown
  remark?: unknown
}

type NominatimReverseResponse = {
  display_name?: unknown
  address?: unknown
}

type OsmSignalSnapshot = {
  schemaVersion: number
  source?: string
  sourceUrl?: string
  osmDataTimestamp?: string | null
  bounds: {
    west: number
    south: number
    east: number
    north: number
  }
  signalCount?: number
  signals: unknown[]
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type FetchTrafficSignalsOptions = {
  signal?: AbortSignal
  endpoints?: readonly string[]
  requestTimeoutMs?: number
  fetchImpl?: FetchLike
}

export const SIGNAL_CORRIDOR_RADIUS_METERS = 50
export const OVERPASS_REQUEST_TIMEOUT_MS = 29_000
export const OSM_SIGNAL_SNAPSHOT_URL = '/data/osm-traffic-signals-tokyo.json'

const ROUTE_SIMPLIFY_TOLERANCE_METERS = 10
const MAX_POINTS_PER_AROUND_CLAUSE = 100
const OVERPASS_QUERY_TIMEOUT_SECONDS = 10
const NOMINATIM_MIN_REQUEST_INTERVAL_MS = 1_050
const TOKYO_WARD_PATTERN = /^[^\s,]{1,12}区$/
const RETRYABLE_OVERPASS_STATUSES = new Set([406, 408, 429, 500, 502, 503, 504])
const reverseWardCache = new Map<string, string | null>()
let lastNominatimRequestStartedAt = 0
let nominatimQueue: Promise<void> = Promise.resolve()
let osmSignalSnapshotPromise: Promise<OsmSignalSnapshot> | null = null

export const OVERPASS_ENDPOINTS = ['/api/overpass'] as const

class NonRetryableOverpassError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
}

function enqueueNominatimRequest<T>(request: () => Promise<T>): Promise<T> {
  const queued = nominatimQueue.then(async () => {
    const waitMilliseconds = Math.max(
      0,
      NOMINATIM_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastNominatimRequestStartedAt),
    )
    if (waitMilliseconds > 0) await delay(waitMilliseconds)
    lastNominatimRequestStartedAt = Date.now()
    return request()
  })
  nominatimQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function getReverseWardCacheKey(position: Position) {
  return `${position.lat.toFixed(3)},${position.lng.toFixed(3)}`
}

function extractTokyoWard(data: NominatimReverseResponse) {
  const address = isRecord(data.address) ? data.address : {}
  const addressValues = Object.values(address).filter((value): value is string => typeof value === 'string')
  const displayName = typeof data.display_name === 'string' ? data.display_name : ''
  const context = [displayName, ...addressValues].join(',')
  if (!context.includes('東京都') && !/\bTokyo\b/i.test(context)) return null

  const preferredKeys = ['city_district', 'city', 'municipality', 'borough', 'county', 'suburb']
  for (const key of preferredKeys) {
    const value = address[key]
    if (typeof value === 'string' && TOKYO_WARD_PATTERN.test(value)) return value
  }
  return addressValues.find((value) => TOKYO_WARD_PATTERN.test(value)) ?? null
}

async function reverseGeocodeTokyoWard(position: Position, signal?: AbortSignal) {
  const cacheKey = getReverseWardCacheKey(position)
  if (reverseWardCache.has(cacheKey)) return reverseWardCache.get(cacheKey) ?? null

  return enqueueNominatimRequest(async () => {
    if (reverseWardCache.has(cacheKey)) return reverseWardCache.get(cacheKey) ?? null
    signal?.throwIfAborted()
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: position.lat.toFixed(7),
      lon: position.lng.toFixed(7),
      addressdetails: '1',
      'accept-language': 'ja',
    })
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!response.ok) throw new Error(`Nominatim reverse API error: ${response.status}`)
    const data = (await response.json()) as NominatimReverseResponse
    const ward = extractTokyoWard(data)
    reverseWardCache.set(cacheKey, ward)
    return ward
  })
}

async function resolveCommonRouteWard(routes: readonly RouteGeometry[], signal?: AbortSignal) {
  const route = routes.find((candidate) => candidate.coordinates.length > 0)
  if (!route) return null
  const start = route.coordinates[0]
  const destination = route.coordinates[route.coordinates.length - 1]

  try {
    const startWard = await reverseGeocodeTokyoWard(start, signal)
    if (!startWard) return null
    const destinationWard = await reverseGeocodeTokyoWard(destination, signal)
    return destinationWard === startWard ? startWard : null
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('行政区を判定できなかったため、信号周期は全体平均へフォールバックします。', error)
    return null
  }
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

function distanceToRouteMeters(point: Position, coordinates: readonly Position[]) {
  if (coordinates.length === 0) return Infinity
  if (coordinates.length === 1) return distancePointToSegmentMeters(point, coordinates[0], coordinates[0])
  let shortest = Infinity
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const distance = distancePointToSegmentMeters(point, coordinates[index], coordinates[index + 1])
    if (distance < shortest) shortest = distance
  }
  return shortest
}

function simplifyRoute(coordinates: readonly Position[]): Position[] {
  if (coordinates.length <= 2) return [...coordinates]

  let farthestIndex = -1
  let farthestDistance = 0
  const start = coordinates[0]
  const end = coordinates[coordinates.length - 1]
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const distance = distancePointToSegmentMeters(coordinates[index], start, end)
    if (distance > farthestDistance) {
      farthestDistance = distance
      farthestIndex = index
    }
  }

  if (farthestIndex === -1 || farthestDistance <= ROUTE_SIMPLIFY_TOLERANCE_METERS) {
    return [start, end]
  }

  const left = simplifyRoute(coordinates.slice(0, farthestIndex + 1))
  const right = simplifyRoute(coordinates.slice(farthestIndex))
  return [...left.slice(0, -1), ...right]
}

function chunkRoute(coordinates: readonly Position[]) {
  const simplified = simplifyRoute(coordinates)
  if (simplified.length <= MAX_POINTS_PER_AROUND_CLAUSE) return simplified.length === 0 ? [] : [simplified]

  const chunks: Position[][] = []
  for (let start = 0; start < simplified.length - 1; start += MAX_POINTS_PER_AROUND_CLAUSE - 1) {
    chunks.push(simplified.slice(start, start + MAX_POINTS_PER_AROUND_CLAUSE))
  }
  return chunks
}

function parseSnapshotBounds(value: unknown): OsmSignalSnapshot['bounds'] | null {
  if (!isRecord(value)) return null
  const { west, south, east, north } = value
  if (!isFiniteNumber(west) || !isFiniteNumber(south) || !isFiniteNumber(east) || !isFiniteNumber(north)) return null
  if (west >= east || south >= north) return null
  return { west, south, east, north }
}

function parseOsmSignalSnapshot(value: unknown): OsmSignalSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.signals)) {
    throw new Error('OSM信号スナップショットの形式が不正です。')
  }
  const bounds = parseSnapshotBounds(value.bounds)
  if (!bounds) throw new Error('OSM信号スナップショットの範囲情報が不正です。')
  return {
    schemaVersion: 2,
    source: typeof value.source === 'string' ? value.source : undefined,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : undefined,
    osmDataTimestamp: typeof value.osmDataTimestamp === 'string' ? value.osmDataTimestamp : null,
    bounds,
    signalCount: typeof value.signalCount === 'number' ? value.signalCount : undefined,
    signals: value.signals,
  }
}

async function loadOsmSignalSnapshot() {
  if (!osmSignalSnapshotPromise) {
    osmSignalSnapshotPromise = fetch(OSM_SIGNAL_SNAPSHOT_URL, {
      headers: { Accept: 'application/json' },
      cache: 'force-cache',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`OSM signal snapshot error: ${response.status}`)
        return parseOsmSignalSnapshot(await response.json())
      })
      .catch((error) => {
        osmSignalSnapshotPromise = null
        throw error
      })
  }
  return osmSignalSnapshotPromise
}

function snapshotCoversRoutes(snapshot: OsmSignalSnapshot, routes: readonly RouteGeometry[]) {
  const { west, south, east, north } = snapshot.bounds
  return routes.every((route) => route.coordinates.every(
    (position) => position.lng >= west && position.lng <= east && position.lat >= south && position.lat <= north,
  ))
}

function getExpandedRouteBounds(routes: readonly RouteGeometry[]) {
  const coordinates = routes.flatMap((route) => [...route.coordinates])
  if (coordinates.length === 0) return null
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  let latitudeTotal = 0
  for (const position of coordinates) {
    west = Math.min(west, position.lng)
    east = Math.max(east, position.lng)
    south = Math.min(south, position.lat)
    north = Math.max(north, position.lat)
    latitudeTotal += position.lat
  }
  const referenceLat = (latitudeTotal / coordinates.length) * (Math.PI / 180)
  const latPadding = SIGNAL_CORRIDOR_RADIUS_METERS / 111_320
  const lngPadding = SIGNAL_CORRIDOR_RADIUS_METERS / (111_320 * Math.max(0.1, Math.cos(referenceLat)))
  return {
    west: west - lngPadding,
    east: east + lngPadding,
    south: south - latPadding,
    north: north + latPadding,
  }
}

function decodeSnapshotSignalRow(value: unknown, snapshotTimestamp?: string | null): OsmTrafficSignal | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const [id, lat, lng, typeCode] = value
  if (!Number.isSafeInteger(id) || !isFiniteNumber(lat) || !isFiniteNumber(lng) || !Number.isInteger(typeCode)) return null

  let type: SignalType = 'unknown'
  let source = 'unknown'
  if (typeCode === 0) {
    type = 'vehicle'
    source = 'highway=traffic_signals'
  } else if (typeCode === 1) {
    type = 'pedestrian'
    source = 'crossing=traffic_signals'
  } else if (typeCode === 2) {
    type = 'both'
    source = 'highway=traffic_signals + crossing=traffic_signals'
  }

  return {
    id,
    lat,
    lng,
    type,
    source,
    positionSource: 'osm-snapshot',
    snapshotTimestamp: snapshotTimestamp ?? undefined,
  }
}

async function getSnapshotSignalsAroundRoutes(routes: readonly RouteGeometry[], signal?: AbortSignal) {
  const snapshot = await loadOsmSignalSnapshot()
  signal?.throwIfAborted()
  if (!snapshotCoversRoutes(snapshot, routes)) {
    throw new Error('ルートがOSM信号スナップショットの収録範囲外です。')
  }

  const routeBounds = getExpandedRouteBounds(routes)
  if (!routeBounds) return []
  const simplifiedRoutes = routes
    .map((route) => simplifyRoute(route.coordinates))
    .filter((coordinates) => coordinates.length > 0)
  const matches: OsmTrafficSignal[] = []

  for (const row of snapshot.signals) {
    const decoded = decodeSnapshotSignalRow(row, snapshot.osmDataTimestamp)
    if (!decoded) continue
    if (
      decoded.lng < routeBounds.west || decoded.lng > routeBounds.east
      || decoded.lat < routeBounds.south || decoded.lat > routeBounds.north
    ) {
      continue
    }
    const nearRoute = simplifiedRoutes.some(
      (coordinates) => distanceToRouteMeters(decoded, coordinates) <= SIGNAL_CORRIDOR_RADIUS_METERS,
    )
    if (nearRoute) matches.push(decoded)
  }

  return matches
}

export function buildTrafficSignalQuery(routes: readonly RouteGeometry[]) {
  const selectors = routes.flatMap((route) =>
    chunkRoute(route.coordinates).flatMap((coordinates) => {
      const path = coordinates.flatMap((position) => [position.lat.toFixed(6), position.lng.toFixed(6)]).join(',')
      return [
        `  node["highway"="traffic_signals"](around:${SIGNAL_CORRIDOR_RADIUS_METERS},${path});`,
        `  node["crossing"="traffic_signals"](around:${SIGNAL_CORRIDOR_RADIUS_METERS},${path});`,
      ]
    }),
  )

  if (selectors.length === 0) throw new Error('信号検索に使用できる候補経路がありません。')

  return [
    `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];`,
    '(',
    ...selectors,
    ');',
    'out body qt;',
  ].join('\n')
}

function parseTrafficSignals(data: OverpassResponse) {
  if (!Array.isArray(data.elements)) throw new Error('Overpass APIの応答形式が不正です。')

  const signalsByOsmId = new Map<number, OsmTrafficSignal>()
  for (const rawElement of data.elements) {
    if (!isRecord(rawElement)) continue
    const element: OverpassElement = rawElement
    if (
      typeof element.id !== 'number' ||
      !Number.isSafeInteger(element.id) ||
      typeof element.lat !== 'number' ||
      !Number.isFinite(element.lat) ||
      typeof element.lon !== 'number' ||
      !Number.isFinite(element.lon)
    ) {
      continue
    }

    const tags = isRecord(element.tags) ? element.tags : {}
    const isVehicleSignal = tags.highway === 'traffic_signals'
    const isTrafficSignalCrossing = tags.crossing === 'traffic_signals'
    let type: SignalType = 'unknown'
    let source = 'unknown'
    if (isVehicleSignal && isTrafficSignalCrossing) {
      type = 'both'
      source = 'highway=traffic_signals + crossing=traffic_signals'
    } else if (isTrafficSignalCrossing) {
      type = 'pedestrian'
      source = 'crossing=traffic_signals'
    } else if (isVehicleSignal) {
      type = 'vehicle'
      source = 'highway=traffic_signals'
    }

    signalsByOsmId.set(element.id, {
      id: element.id,
      lat: element.lat,
      lng: element.lon,
      type,
      source,
      positionSource: 'live-osm',
    })
  }
  return [...signalsByOsmId.values()]
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

export async function fetchTrafficSignalsAroundRoutes(
  routes: readonly RouteGeometry[],
  options: FetchTrafficSignalsOptions = {},
): Promise<OsmTrafficSignal[]> {
  const routeWardPromise = options.fetchImpl
    ? Promise.resolve<string | null>(null)
    : resolveCommonRouteWard(routes, options.signal)

  setCurrentRouteWardHint(null)

  // Production/default path: use the bundled OSM snapshot first. This avoids making
  // route calculation depend on public Overpass instance availability or browser CORS.
  // Custom fetch/endpoints keep the live path for tests and explicit callers.
  if (!options.fetchImpl && options.endpoints === undefined) {
    try {
      const snapshotSignals = await getSnapshotSignalsAroundRoutes(routes, options.signal)
      const routeWard = await routeWardPromise
      options.signal?.throwIfAborted()
      setCurrentRouteWardHint(routeWard)
      return snapshotSignals
    } catch (error) {
      if (options.signal?.aborted) throw error
      console.warn('OSM信号スナップショットを使用できないため、Overpassへフォールバックします。', error)
    }
  }

  const query = buildTrafficSignalQuery(routes)
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS
  const requestTimeoutMs = options.requestTimeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeoutId = globalThis.setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const responseError = new Error(`Overpass API error: ${response.status} (${endpoint})`)
        if (RETRYABLE_OVERPASS_STATUSES.has(response.status)) {
          lastError = responseError
          continue
        }
        throw new NonRetryableOverpassError(responseError.message)
      }

      let data: unknown
      try {
        data = await response.json()
      } catch (error) {
        lastError = asError(error)
        continue
      }
      if (!isRecord(data)) {
        lastError = new Error('Overpass APIの応答形式が不正です。')
        continue
      }
      const overpassData: OverpassResponse = data
      if (typeof overpassData.remark === 'string') {
        lastError = new Error(overpassData.remark)
        continue
      }

      try {
        const parsedSignals = parseTrafficSignals(overpassData)
        const routeWard = await routeWardPromise
        options.signal?.throwIfAborted()
        setCurrentRouteWardHint(routeWard)
        return parsedSignals
      } catch (error) {
        if (options.signal?.aborted) throw error
        lastError = asError(error)
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof NonRetryableOverpassError) throw error
      lastError = asError(error)
    } finally {
      globalThis.clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  setCurrentRouteWardHint(null)
  throw new Error('すべてのOverpass API接続先で信号情報を取得できませんでした。', {
    cause: lastError ?? undefined,
  })
}
