export type Position = {
  lat: number
  lng: number
}

export type RouteInfo = {
  coordinates: Position[]
  distanceMeters: number
  durationSeconds: number
  provider: string
  profile: string
  note: string
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

type OpenRouteServiceResponse = {
  features?: Array<{
    properties: {
      summary: {
        distance: number
        duration: number
      }
    }
    geometry: {
      coordinates: Array<[number, number]>
    }
  }>
}

const WALKING_SPEED_KMH = 4.8
const ALTERNATIVE_ROUTE_TARGET_COUNT = 3

function getWalkingDurationSeconds(distanceMeters: number) {
  return (distanceMeters / 1000 / WALKING_SPEED_KMH) * 3600
}

function toRouteInfo(
  coordinates: Array<[number, number]>,
  distanceMeters: number,
  provider: string,
  profile: string,
  note: string,
): RouteInfo {
  return {
    coordinates: coordinates.map(([lng, lat]) => ({ lat, lng })),
    distanceMeters,
    durationSeconds: getWalkingDurationSeconds(distanceMeters),
    provider,
    profile,
    note,
  }
}

async function requestOpenRouteService(
  start: Position,
  destination: Position,
  apiKey: string,
  withAlternatives: boolean,
) {
  const body: Record<string, unknown> = {
    coordinates: [
      [start.lng, start.lat],
      [destination.lng, destination.lat],
    ],
    instructions: false,
    preference: 'shortest',
  }

  if (withAlternatives) {
    body.alternative_routes = {
      target_count: ALTERNATIVE_ROUTE_TARGET_COUNT,
      weight_factor: 1.8,
      share_factor: 0.6,
    }
  }

  return fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function fetchOpenRouteServiceWalkingRoutes(
  start: Position,
  destination: Position,
  apiKey: string,
): Promise<RouteInfo[]> {
  let response = await requestOpenRouteService(start, destination, apiKey, true)
  let usedAlternatives = true

  // Some routes cannot satisfy the alternative-route constraints. In that case,
  // retry as a normal pedestrian route instead of failing the whole navigation.
  if (!response.ok) {
    console.warn(`OpenRouteService alternative route request failed: ${response.status}`)
    response = await requestOpenRouteService(start, destination, apiKey, false)
    usedAlternatives = false
  }

  if (!response.ok) {
    throw new Error(`OpenRouteService API error: ${response.status}`)
  }

  const data = (await response.json()) as OpenRouteServiceResponse
  if (!data.features || data.features.length === 0) {
    throw new Error('OpenRouteServiceでルートが見つかりませんでした。')
  }

  return data.features
    .map((route, index) =>
      toRouteInfo(
        route.geometry.coordinates,
        route.properties.summary.distance,
        'OpenRouteService',
        usedAlternatives ? `foot-walking / candidate ${index + 1}` : 'foot-walking / shortest',
        usedAlternatives
          ? 'OpenRouteServiceの歩行者向け代替ルート候補です。信号待ち込みの総所要時間で候補を比較します。'
          : '代替ルートを取得できなかったため、OpenRouteServiceの通常歩行ルートを使用しています。',
      ),
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

async function fetchOsrmFootRoutes(start: Position, destination: Position): Promise<RouteInfo[]> {
  const url =
    `https://router.project-osrm.org/route/v1/foot/` +
    `${start.lng},${start.lat};` +
    `${destination.lng},${destination.lat}` +
    '?overview=full&geometries=geojson&alternatives=true&steps=false'

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OSRM API error: ${response.status}`)
  }

  const data = (await response.json()) as OsrmRouteResponse
  if (!data.routes || data.routes.length === 0) {
    throw new Error('OSRMでルートが見つかりませんでした。')
  }

  return data.routes
    .map((route, index) =>
      toRouteInfo(
        route.geometry.coordinates,
        route.distance,
        'OSRM public server',
        `foot / candidate ${index + 1}`,
        'OpenRouteService APIキーがない、または取得に失敗したためOSRMの候補ルートを使用しています。OSRMは徒歩ルートが車道寄りになる場合があります。',
      ),
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

export async function fetchPedestrianRoutes(start: Position, destination: Position): Promise<RouteInfo[]> {
  const apiKey = import.meta.env.VITE_OPENROUTESERVICE_API_KEY

  if (apiKey) {
    try {
      return await fetchOpenRouteServiceWalkingRoutes(start, destination, apiKey)
    } catch (error) {
      console.error(error)
      return fetchOsrmFootRoutes(start, destination)
    }
  }

  return fetchOsrmFootRoutes(start, destination)
}
