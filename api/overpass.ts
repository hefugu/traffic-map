const UPSTREAM_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const

const UPSTREAM_TIMEOUT_MS = 8_500
const MAX_QUERY_LENGTH = 100_000

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

export const config = {
  maxDuration: 30,
}

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          Allow: 'POST',
          'Cache-Control': 'no-store',
        },
      })
    }

    let query = ''
    try {
      const body = await request.text()
      query = new URLSearchParams(body).get('data') ?? ''
    } catch {
      return jsonResponse({ error: 'request-body-invalid' }, 400)
    }

    if (!query.trim()) {
      return jsonResponse({ error: 'overpass-query-required' }, 400)
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return jsonResponse({ error: 'overpass-query-too-large' }, 413)
    }

    const failures: Array<{ endpoint: string; status?: number; error?: string }> = []

    for (const endpoint of UPSTREAM_ENDPOINTS) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
        })

        if (!response.ok) {
          failures.push({ endpoint, status: response.status })
          continue
        }

        const responseText = await response.text()
        try {
          JSON.parse(responseText)
        } catch {
          failures.push({ endpoint, error: 'invalid-json-response' })
          continue
        }

        return new Response(responseText, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Overpass-Upstream': new URL(endpoint).host,
          },
        })
      } catch (error) {
        failures.push({
          endpoint,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        clearTimeout(timeoutId)
      }
    }

    console.error('All Overpass upstreams failed', failures)
    return jsonResponse(
      {
        error: 'all-overpass-upstreams-failed',
        failures,
      },
      502,
    )
  },
}
