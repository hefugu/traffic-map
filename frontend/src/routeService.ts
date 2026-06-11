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

const WALKING_SPEED_KMH = 4.8

function getWalkingDurationSeconds(distanceMeters: number) {
  return (distanceMeters / 1000 / WALKING_SPEED_KMH) * 3600
}

export async function fetchPedestrianRoute(start: Position, destination: Position): Promise<RouteInfo> {
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
    throw new Error('ルートが見つかりませんでした。')
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
    profile: 'foot',
    note: '現在はOSRMの徒歩ルートです。歩道・細道・公園内通路・横断歩道の扱いが弱い場合があります。',
  }
}
