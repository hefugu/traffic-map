let currentRouteWardHint: string | undefined

export function setCurrentRouteWardHint(ward: string | null | undefined) {
  currentRouteWardHint = ward ?? undefined
}

export function getCurrentRouteWardHint() {
  return currentRouteWardHint
}
