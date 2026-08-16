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

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type FetchTrafficSignalsOptions = {
  signal?: AbortSignal
  endpoints?: readonly string[]
  requestTimeoutMs?: number
  fetchImpl?: FetchLike
}

export const SIGNAL_CORRIDOR_RADIUS_METERS = 50
export const OVERPASS_REQUEST_TIMEOUT_MS = 12_000

const ROUTE_SIMPLIFY_TOLERANCE_METERS = 10
const MAX_POINTS_PER_AROUND_CLAUSE = 100
const OVERPASS_QUERY_TIMEOUT_SECONDS = 10
const RETRYABLE_OVERPASS_STATUSES = new Set([406, 408, 429, 500, 502, 503, 504])

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const

class NonRetryableOverpassError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
        return parseTrafficSignals(overpassData)
      } catch (error) {
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

  throw new Error('すべてのOverpass API接続先で信号情報を取得できませんでした。', {
    cause: lastError ?? undefined,
  })
}
