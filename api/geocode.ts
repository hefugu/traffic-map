type GsiFeature = {
  geometry?: {
    coordinates?: unknown
  }
  properties?: {
    title?: unknown
  }
}

type GeocodeResult = {
  lat: number
  lng: number
  label: string
  provider: 'gsi'
}

const GSI_ADDRESS_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch'
const REQUEST_TIMEOUT_MS = 8_000
const MAX_QUERY_LENGTH = 200
const MAX_RESULTS = 5

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': status === 200
        ? 'public, s-maxage=86400, stale-while-revalidate=604800'
        : 'no-store',
    },
  })
}

function parseFeature(value: unknown): GeocodeResult | null {
  if (typeof value !== 'object' || value === null) return null
  const feature = value as GsiFeature
  const coordinates = feature.geometry?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null
  const lng = Number(coordinates[0])
  const lat = Number(coordinates[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const title = typeof feature.properties?.title === 'string'
    ? feature.properties.title.trim()
    : ''
  return {
    lat,
    lng,
    label: title || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    provider: 'gsi',
  }
}

export const config = {
  maxDuration: 10,
}

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
      })
    }

    const url = new URL(request.url)
    const query = (url.searchParams.get('q') ?? '').trim()
    if (!query) return jsonResponse({ error: 'query-required' }, 400)
    if (query.length > MAX_QUERY_LENGTH) return jsonResponse({ error: 'query-too-long' }, 413)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const upstream = new URL(GSI_ADDRESS_SEARCH_URL)
      upstream.searchParams.set('q', query)
      const response = await fetch(upstream, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'traffic-map/1.0 (PC Conference research navigation app)',
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        console.warn('GSI address search failed', response.status)
        return jsonResponse({ results: [], provider: 'gsi', upstreamStatus: response.status })
      }

      const raw = await response.json() as unknown
      const results = Array.isArray(raw)
        ? raw.map(parseFeature).filter((item): item is GeocodeResult => item !== null).slice(0, MAX_RESULTS)
        : []

      return jsonResponse({ results, provider: 'gsi' })
    } catch (error) {
      console.warn('GSI address search unavailable', error)
      return jsonResponse({ results: [], provider: 'gsi' })
    } finally {
      clearTimeout(timeoutId)
    }
  },
}
