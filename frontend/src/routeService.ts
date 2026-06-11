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

function getWalkingDurationSeconds(distanceMeters: number) {
  return (distanceMeters / 1000 / WALKING_SPEED_KMH) * 3600
}

async function fetchOpenRouteServiceWalkingRoute(start: Position, destination: Position, apiKey: string): Promise<RouteInfo> {
  const response = await fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      coordinates: [
        [start.lng, start.lat],
        [destination.lng, destination.lat],
      ],
      instructions: false,
      preference: 'shortest',
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenRouteService API error: ${response.status}`)
  }

  const data = (await response.json()) as OpenRouteServiceResponse

  if (!data.features || data.features.length === 0) {
    throw new Error('OpenRouteServiceでルートが見つかりませんでした。')
  }

  const route = data.features[0]
  const coordinates: Position[] = route.geometry.coordinates.map(([lng, lat]) => ({
    lat,
    lng,
  }))

  return {
    coordinates,
    distanceMeters: route.properties.summary.distance,
    durationSeconds: getWalkingDurationSeconds(route.properties.summary.distance),
    provider: 'OpenRouteService',
    profile: 'foot-walking / shortest',
    note: 'OpenRouteServiceの歩行者向けルートです。細道・歩道・徒歩通路をOSRMより拾いやすい想定です。',
  }
}

async function fetchOsrmFootRoute(start: Position, destination: Position): Promise<RouteInfo> {
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

  const route = [...data.routes].sort((a, b) => a.distance - b.distance)[0]
  const coordinates: Position[] = route.geometry.coordinates.map(([lng, lat]) => ({
    lat,
    lng,
  }))

  return {
    coordinates,
    distanceMeters: route.distance,
    durationSeconds: getWalkingDurationSeconds(route.distance),
    provider: 'OSRM public server',
    profile: 'foot / fallback',
    note: 'OpenRouteService APIキーがない、または取得に失敗したためOSRMに戻しました。OSRMは徒歩ルートが車道寄りになる場合があります。',
  }
}

export async function fetchPedestrianRoute(start: Position, destination: Position): Promise<RouteInfo> {
  const apiKey = import.meta.env.VITE_OPENROUTESERVICE_API_KEY

  if (apiKey) {
    try {
      return await fetchOpenRouteServiceWalkingRoute(start, destination, apiKey)
    } catch (error) {
      console.error(error)
      return fetchOsrmFootRoute(start, destination)
    }
  }

  return fetchOsrmFootRoute(start, destination)
}
