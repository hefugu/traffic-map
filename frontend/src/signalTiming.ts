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
export type SignalTimingAverageScope = 'regional' | 'global'
export type SignalTimingMatchMethod = 'osm-id' | 'nearby' | 'regional-average' | 'global-average'

export type SignalTimingLookup = {
  osmId?: number
  lat: number
  lng: number
  ward?: string
}

export type ResolvedSignalTiming = {
  timing: SignalTiming
  source: SignalTimingSource
  label: string
  sourceUrl?: string
  noPedestrianCrossing: boolean
  matchDistanceMeters?: number
  ward?: string
  averageScope?: SignalTimingAverageScope
  matchMethod?: SignalTimingMatchMethod
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

function getAverageTiming(profiles: readonly MeasuredSignalProfile[]): SignalTiming | null {
  const usableProfiles = profiles.filter((profile) => profile.crossings.length > 0)
  if (usableProfiles.length === 0) return null
  return {
    cycleSeconds: Math.round(average(usableProfiles.map((profile) => profile.cycleSeconds))),
    greenSeconds: Math.round(
      average(
        usableProfiles.map(
          (profile) => getRepresentativeTiming(profile)?.greenSeconds ?? 0,
        ),
      ),
    ),
    blinkSeconds: Math.round(
      average(
        usableProfiles.map(
          (profile) => getRepresentativeTiming(profile)?.blinkSeconds ?? 0,
        ),
      ),
    ),
  }
}

const profilesForAverage = MEASURED_SIGNAL_PROFILES.filter((profile) => profile.crossings.length > 0)

// Each intersection gets equal weight. This avoids intersections with many recorded
// crossing directions dominating the fallback value.
export const DEFAULT_SIGNAL_TIMING: SignalTiming = getAverageTiming(profilesForAverage) ?? {
  cycleSeconds: 120,
  greenSeconds: 30,
  blinkSeconds: 10,
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

function resolveMeasuredProfile(
  profile: MeasuredSignalProfile,
  matchMethod: 'osm-id' | 'nearby',
  matchDistanceMeters?: number,
): ResolvedSignalTiming {
  if (profile.noPedestrianCrossing || profile.crossings.length === 0) {
    return {
      timing: {
        cycleSeconds: profile.cycleSeconds,
        greenSeconds: 0,
        blinkSeconds: 0,
      },
      source: 'no-pedestrian-crossing',
      label: `${profile.name}（横断歩道なし）`,
      sourceUrl: profile.sourceUrl,
      noPedestrianCrossing: true,
      matchDistanceMeters,
      ward: profile.ward,
      matchMethod,
    }
  }

  return {
    timing: getRepresentativeTiming(profile) ?? DEFAULT_SIGNAL_TIMING,
    source: 'measured',
    label: `${profile.name} 実測`,
    sourceUrl: profile.sourceUrl,
    noPedestrianCrossing: false,
    matchDistanceMeters,
    ward: profile.ward,
    matchMethod,
  }
}

function normalizeLookup(input: SignalTimingLookup | number, legacyLng?: number): SignalTimingLookup {
  if (typeof input !== 'number') return input
  if (typeof legacyLng !== 'number') {
    throw new Error('resolveSignalTiming requires longitude when called with latitude.')
  }
  return { lat: input, lng: legacyLng }
}

// Resolution order:
// 1. positively verified OSM node ID
// 2. nearby measured intersection
// 3. same-ward average when the caller has a trustworthy ward hint
// 4. average of all currently measured intersections
//
// A ward is never inferred merely from proximity to another ward's sample. This keeps
// locations such as Kinshicho or Tokyo Station from being mislabeled as Koto-ku data.
export function resolveSignalTiming(input: SignalTimingLookup | number, legacyLng?: number): ResolvedSignalTiming {
  const lookup = normalizeLookup(input, legacyLng)

  if (typeof lookup.osmId === 'number') {
    const exactProfile = MEASURED_SIGNAL_PROFILES.find((profile) =>
      profile.osmNodeIds?.includes(lookup.osmId as number),
    )
    if (exactProfile) {
      const matchDistanceMeters = typeof exactProfile.lat === 'number' && typeof exactProfile.lng === 'number'
        ? distanceMeters(lookup.lat, lookup.lng, exactProfile.lat, exactProfile.lng)
        : undefined
      return resolveMeasuredProfile(exactProfile, 'osm-id', matchDistanceMeters)
    }
  }

  const nearest = MEASURED_SIGNAL_PROFILES
    .filter((profile) => typeof profile.lat === 'number' && typeof profile.lng === 'number')
    .map((profile) => ({
      profile,
      distance: distanceMeters(lookup.lat, lookup.lng, profile.lat as number, profile.lng as number),
    }))
    .filter((candidate) => candidate.distance <= MEASURED_SIGNAL_MATCH_DISTANCE_METERS)
    .sort((a, b) => a.distance - b.distance)[0]

  if (nearest) {
    return resolveMeasuredProfile(nearest.profile, 'nearby', nearest.distance)
  }

  if (lookup.ward) {
    const regionalProfiles = MEASURED_SIGNAL_PROFILES.filter(
      (profile) => profile.ward === lookup.ward && profile.crossings.length > 0,
    )
    const regionalTiming = getAverageTiming(regionalProfiles)
    if (regionalTiming) {
      return {
        timing: regionalTiming,
        source: 'measured-average',
        label: `${lookup.ward} 実測平均`,
        noPedestrianCrossing: false,
        ward: lookup.ward,
        averageScope: 'regional',
        matchMethod: 'regional-average',
      }
    }
  }

  return {
    timing: DEFAULT_SIGNAL_TIMING,
    source: 'measured-average',
    label: '既存実測データ全体平均',
    noPedestrianCrossing: false,
    averageScope: 'global',
    matchMethod: 'global-average',
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
