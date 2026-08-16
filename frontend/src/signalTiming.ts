import { MEASURED_SIGNAL_PROFILES, type MeasuredSignalProfile } from './measuredSignalTimings'

export type SignalTiming = {
  cycleSeconds: number
  greenSeconds: number
  blinkSeconds: number
}

export type SignalStateProbabilities = {
  greenProbability: number
  blinkingProbability: number
  redProbability: number
  waitProbability: number
}

export type PredictedSignalState = {
  state: 'green' | 'blinking' | 'red'
  remainingSeconds: number
  elapsedCycleSeconds: number
}

export type SignalTimingSource = 'measured' | 'measured-average' | 'no-pedestrian-crossing'

export type ResolvedSignalTiming = {
  timing: SignalTiming
  source: SignalTimingSource
  label: string
  sourceUrl?: string
  noPedestrianCrossing: boolean
  matchDistanceMeters?: number
}

export const ROUTE_SIGNAL_DISTANCE_METERS = 30
export const WALKING_SPEED_KMH = 4.8
export const MEASURED_SIGNAL_MATCH_DISTANCE_METERS = 85

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function getRepresentativeTiming(profile: MeasuredSignalProfile): SignalTiming | null {
  if (profile.crossings.length === 0) return null
  return {
    cycleSeconds: profile.cycleSeconds,
    greenSeconds: average(profile.crossings.map((crossing) => crossing.greenSeconds)),
    blinkSeconds: average(profile.crossings.map((crossing) => crossing.blinkSeconds)),
  }
}

const profilesForAverage = MEASURED_SIGNAL_PROFILES.filter((profile) => profile.crossings.length > 0)

// Each intersection gets equal weight. This avoids intersections with many recorded
// crossing directions dominating the fallback value.
export const DEFAULT_SIGNAL_TIMING: SignalTiming = {
  cycleSeconds: Math.round(average(profilesForAverage.map((profile) => profile.cycleSeconds))),
  greenSeconds: Math.round(
    average(
      profilesForAverage.map(
        (profile) => getRepresentativeTiming(profile)?.greenSeconds ?? 0,
      ),
    ),
  ),
  blinkSeconds: Math.round(
    average(
      profilesForAverage.map(
        (profile) => getRepresentativeTiming(profile)?.blinkSeconds ?? 0,
      ),
    ),
  ),
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const earthRadius = 6371000
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180
  const h =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function resolveSignalTiming(lat: number, lng: number): ResolvedSignalTiming {
  const nearest = MEASURED_SIGNAL_PROFILES
    .filter((profile) => typeof profile.lat === 'number' && typeof profile.lng === 'number')
    .map((profile) => ({
      profile,
      distance: distanceMeters(lat, lng, profile.lat as number, profile.lng as number),
    }))
    .filter((candidate) => candidate.distance <= MEASURED_SIGNAL_MATCH_DISTANCE_METERS)
    .sort((a, b) => a.distance - b.distance)[0]

  if (!nearest) {
    return {
      timing: DEFAULT_SIGNAL_TIMING,
      source: 'measured-average',
      label: '江東区実測データ平均',
      noPedestrianCrossing: false,
    }
  }

  if (nearest.profile.noPedestrianCrossing || nearest.profile.crossings.length === 0) {
    return {
      timing: {
        cycleSeconds: nearest.profile.cycleSeconds,
        greenSeconds: 0,
        blinkSeconds: 0,
      },
      source: 'no-pedestrian-crossing',
      label: `${nearest.profile.name}（横断歩道なし）`,
      sourceUrl: nearest.profile.sourceUrl,
      noPedestrianCrossing: true,
      matchDistanceMeters: nearest.distance,
    }
  }

  return {
    timing: getRepresentativeTiming(nearest.profile) ?? DEFAULT_SIGNAL_TIMING,
    source: 'measured',
    label: `${nearest.profile.name} 実測`,
    sourceUrl: nearest.profile.sourceUrl,
    noPedestrianCrossing: false,
    matchDistanceMeters: nearest.distance,
  }
}

export function getSignalRedSeconds(timing: SignalTiming) {
  return Math.max(0, timing.cycleSeconds - timing.greenSeconds - timing.blinkSeconds)
}

function getNonNegativeFiniteSeconds(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

// The current phase and offset are unknown. These probabilities assume that a
// pedestrian arrives uniformly at random within a signal cycle. A new crossing
// starts only during solid green, so blinking green is included in waitProbability.
export function getSignalStateProbabilities(timing: SignalTiming): SignalStateProbabilities {
  const cycleSeconds = timing.cycleSeconds
  if (!Number.isFinite(cycleSeconds) || cycleSeconds <= 0) {
    return {
      greenProbability: 0,
      blinkingProbability: 0,
      redProbability: 0,
      waitProbability: 0,
    }
  }

  const greenSeconds = Math.min(cycleSeconds, getNonNegativeFiniteSeconds(timing.greenSeconds))
  const blinkingSeconds = Math.min(
    cycleSeconds - greenSeconds,
    getNonNegativeFiniteSeconds(timing.blinkSeconds),
  )
  const redSeconds = Math.max(0, cycleSeconds - greenSeconds - blinkingSeconds)

  return {
    greenProbability: greenSeconds / cycleSeconds,
    blinkingProbability: blinkingSeconds / cycleSeconds,
    redProbability: redSeconds / cycleSeconds,
    waitProbability: (cycleSeconds - greenSeconds) / cycleSeconds,
  }
}

// A prediction is only available after the user records the instant that green
// starts. No arbitrary or clock-based phase offset is generated here.
export function getPredictedSignalState(
  timing: SignalTiming,
  greenStartedAtMs: number,
  nowMs: number,
): PredictedSignalState | null {
  const cycleSeconds = timing.cycleSeconds
  if (
    !Number.isFinite(cycleSeconds) ||
    cycleSeconds <= 0 ||
    !Number.isFinite(greenStartedAtMs) ||
    !Number.isFinite(nowMs)
  ) {
    return null
  }

  const greenSeconds = Math.min(cycleSeconds, getNonNegativeFiniteSeconds(timing.greenSeconds))
  const blinkingSeconds = Math.min(
    cycleSeconds - greenSeconds,
    getNonNegativeFiniteSeconds(timing.blinkSeconds),
  )
  const totalElapsedSeconds = (nowMs - greenStartedAtMs) / 1000
  if (!Number.isFinite(totalElapsedSeconds)) return null

  const elapsedCycleSeconds =
    ((totalElapsedSeconds % cycleSeconds) + cycleSeconds) % cycleSeconds
  const blinkingEndsAtSeconds = greenSeconds + blinkingSeconds

  if (elapsedCycleSeconds < greenSeconds) {
    return {
      state: 'green',
      remainingSeconds: greenSeconds - elapsedCycleSeconds,
      elapsedCycleSeconds,
    }
  }
  if (elapsedCycleSeconds < blinkingEndsAtSeconds) {
    return {
      state: 'blinking',
      remainingSeconds: blinkingEndsAtSeconds - elapsedCycleSeconds,
      elapsedCycleSeconds,
    }
  }
  return {
    state: 'red',
    remainingSeconds: cycleSeconds - elapsedCycleSeconds,
    elapsedCycleSeconds,
  }
}

// No live phase/offset is available. Assuming arrival time is uniformly distributed
// over a cycle and a new crossing starts only during solid green, the expected wait is
// R^2 / (2C), where R = cycle - green and C = cycle.
export function getExpectedSignalDelay(timing: SignalTiming) {
  if (timing.cycleSeconds <= 0) return 0
  const unavailableSeconds = Math.max(0, timing.cycleSeconds - timing.greenSeconds)
  return (unavailableSeconds * unavailableSeconds) / (2 * timing.cycleSeconds)
}

export function getWalkingDurationSeconds(distanceMeters: number) {
  return (distanceMeters / 1000 / WALKING_SPEED_KMH) * 3600
}
