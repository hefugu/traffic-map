export type SignalState = 'red' | 'green' | 'yellow'

export type SignalTiming = {
  redSeconds: number
  greenSeconds: number
  yellowSeconds: number
}

export const DEFAULT_SIGNAL_TIMING: SignalTiming = {
  redSeconds: 50,
  greenSeconds: 40,
  yellowSeconds: 3,
}

export const ROUTE_SIGNAL_DISTANCE_METERS = 30
export const WALKING_SPEED_KMH = 4.8

export function getSignalStateLabel(state: SignalState) {
  if (state === 'red') return '赤'
  if (state === 'green') return '青'
  return '黄'
}

export function getSignalOffsetSeconds(signalId: number) {
  return Math.abs(signalId % 60)
}

export function getSignalRuntime(signalId: number, timing: SignalTiming, nowMs: number) {
  const cycleSeconds = timing.redSeconds + timing.greenSeconds + timing.yellowSeconds
  const elapsedSeconds = Math.floor(nowMs / 1000) + getSignalOffsetSeconds(signalId)
  const cyclePosition = ((elapsedSeconds % cycleSeconds) + cycleSeconds) % cycleSeconds

  if (cyclePosition < timing.redSeconds) {
    return {
      state: 'red' as SignalState,
      remainingSeconds: timing.redSeconds - cyclePosition,
      cycleSeconds,
    }
  }

  if (cyclePosition < timing.redSeconds + timing.greenSeconds) {
    return {
      state: 'green' as SignalState,
      remainingSeconds: timing.redSeconds + timing.greenSeconds - cyclePosition,
      cycleSeconds,
    }
  }

  return {
    state: 'yellow' as SignalState,
    remainingSeconds: cycleSeconds - cyclePosition,
    cycleSeconds,
  }
}

export function getEstimatedDelayForSignal(signalId: number, timing: SignalTiming, nowMs: number) {
  const runtime = getSignalRuntime(signalId, timing, nowMs)

  if (runtime.state === 'red') return runtime.remainingSeconds
  if (runtime.state === 'yellow') return timing.redSeconds * 0.5
  return 0
}

export function getWalkingDurationSeconds(distanceMeters: number) {
  return (distanceMeters / 1000 / WALKING_SPEED_KMH) * 3600
}
