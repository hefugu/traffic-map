import { setCurrentRouteWardHint } from './signalRegion'

export type SignalType = 'pedestrian' | 'vehicle' | 'both' | 'unknown'

export type OsmTrafficSignal = {
  id: number
  lat: number
  lng: number
  type: SignalType
  source: string
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

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type FetchTrafficSignalsOptions = {
  signal?: AbortSignal
  endpoints?: readonly string[]
  requestTimeoutMs?: number
  fetchImpl?: FetchLike
}

export const SIGNAL_CORRIDOR_RADIUS_METERS = 50
export const OVERPASS_REQUEST_TIMEOUT_MS = 29_000

const ROUTE_SIMPLIFY_TOLERANCE_METERS = 10
const MAX_POINTS_PER_AROUND_CLAUSE = 100
const OVERPASS_QUERY_TIMEOUT_SECONDS = 10
const NOMINATIM_MIN_REQUEST_INTERVAL_MS = 1_050
const TOKYO_WARD_PATTERN = /^[^\s,]{1,12}区$/
const RETRYABLE_OVERPASS_STATUSES = new Set([406, 408, 429, 500, 502, 503, 504])
const reverseWardCache = new Map<string, string | null>()
let lastNominatimRequestStartedAt = 0
let nominatimQueue: Promise<void> = Promise.resolve()

export const OVERPASS_ENDPOINTS = ['/api/overpass'] as const

class NonRetryableOverpassError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  const query = buildTrafficSignalQuery(routes)
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS
  const requestTimeoutMs = options.requestTimeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const routeWardPromise = options.fetchImpl
    ? Promise.resolve<string | null>(null)
    : resolveCommonRouteWard(routes, options.signal)
  let lastError: Error | null = null

  setCurrentRouteWardHint(null)

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
