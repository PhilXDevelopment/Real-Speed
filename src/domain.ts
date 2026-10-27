export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type GpsPoint = Coordinate & {
  timestamp: number;
  speedMps: number | null;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
};

const MAX_REPORTED_SPEED_ACCURACY_METERS = 50;
const STATIONARY_SPEED_THRESHOLD_MPS = 0.5;

export function metersPerSecondToKmh(speedMps: number): number {
  return speedMps * 3.6;
}

export function maximumSpeedForMode(mode: string): number {
  switch (mode) {
    case 'walking': return 8;
    case 'bicycle': return 30;
    case 'motorcycle': return 70;
    case 'car': return 70;
    case 'train': return 120;
    case 'airplane': return 400;
    default: return 80;
  }
}

export function defaultCalibrationPercentForMode(mode: string): number {
  switch (mode) {
    case 'walking': return 1.5;
    case 'bicycle': return 1;
    case 'motorcycle': return 0;
    case 'car': return 0;
    case 'train': return 1.5;
    case 'airplane': return 0;
    default: return 1;
  }
}

export function filterGpsSpeedMps(
  speedMps: number | null,
  accuracy: number | null,
  maximumSpeedMps = 100
): number | null {
  if (
    speedMps === null ||
    !Number.isFinite(speedMps) ||
    speedMps < 0 ||
    speedMps > maximumSpeedMps ||
    accuracy === null ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    accuracy > MAX_REPORTED_SPEED_ACCURACY_METERS
  ) {
    return null;
  }
  return speedMps < STATIONARY_SPEED_THRESHOLD_MPS ? 0 : speedMps;
}

export function getSpeedFromGpsFix(
  previous: GpsPoint | null,
  next: GpsPoint,
  maximumSpeedMps = 80,
  distanceAnchor: GpsPoint | null = previous
): number | null {
  const reportedSpeed = filterGpsSpeedMps(next.speedMps, next.accuracy, maximumSpeedMps);
  if (reportedSpeed !== null) return reportedSpeed;
  if (
    distanceAnchor &&
    next.accuracy !== null &&
    next.accuracy <= 25 &&
    isSignificantGpsMovement(distanceAnchor, next)
  ) {
    const elapsedSeconds = (next.timestamp - distanceAnchor.timestamp) / 1000;
    if (elapsedSeconds > 0) {
      return Math.min(maximumSpeedMps, distanceBetweenMeters(distanceAnchor, next) / elapsedSeconds);
    }
  }
  return null;
}

export function distanceBetweenMeters(a: Coordinate, b: Coordinate): number {
  const radians = (degrees: number) => degrees * (Math.PI / 180);
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine = Math.min(1, Math.max(0,
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2));
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function isValidPoint(point: GpsPoint): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    Number.isFinite(point.timestamp) &&
    (point.speedMps === null || (Number.isFinite(point.speedMps) && point.speedMps >= 0)) &&
    (point.accuracy === null || (Number.isFinite(point.accuracy) && point.accuracy >= 0))
  );
}

export function isSignificantGpsMovement(previous: GpsPoint, next: GpsPoint): boolean {
  if (
    previous.accuracy === null ||
    next.accuracy === null ||
    previous.accuracy > 25 ||
    next.accuracy > 25 ||
    next.timestamp <= previous.timestamp ||
    next.timestamp - previous.timestamp > 120_000
  ) {
    return false;
  }
  const noiseAllowance = Math.min(
    30,
    Math.max(8, (previous.accuracy + next.accuracy) * 1.25)
  );
  return distanceBetweenMeters(previous, next) > noiseAllowance;
}

export function isPlausibleNextPoint(
  previous: GpsPoint | null,
  next: GpsPoint,
  maximumSpeedMps = 100
): boolean {
  if (!isValidPoint(next)) return false;
  if (!previous) return true;

  const elapsedSeconds = (next.timestamp - previous.timestamp) / 1000;
  if (elapsedSeconds <= 0) return false;
  const distanceMeters = distanceBetweenMeters(previous, next);
  const accuracyAllowance = Math.min(
    35,
    Math.max(10, ((previous.accuracy ?? 20) + (next.accuracy ?? 20)) * 0.75)
  );
  const reportedSpeed = filterGpsSpeedMps(next.speedMps, next.accuracy, maximumSpeedMps);
  const speedAllowance = reportedSpeed !== null && reportedSpeed > 0
    ? reportedSpeed * elapsedSeconds * 2.5 + accuracyAllowance
    : maximumSpeedMps * elapsedSeconds + accuracyAllowance;
  return distanceMeters <= speedAllowance;
}

export type PointEvaluation = {
  segmentBreak: boolean;
  distanceMeters: number;
  maxSpeedMps: number;
  distanceAnchorUpdated: boolean;
};

export function evaluateGpsPoint(
  previous: GpsPoint | null,
  next: GpsPoint,
  maximumSpeedMps = 80,
  distanceAnchor: GpsPoint | null = previous
): PointEvaluation | null {
  if (!isPlausibleNextPoint(previous, next, maximumSpeedMps)) return null;
  const segmentBreak = previous !== null && next.timestamp - previous.timestamp > 120_000;
  const reliableNext = next.accuracy !== null && next.accuracy <= 25;
  if (next.accuracy === null || next.accuracy > 25 || !previous || segmentBreak) {
    return {
      segmentBreak,
      distanceMeters: 0,
      maxSpeedMps: 0,
      distanceAnchorUpdated: reliableNext
    };
  }
  if (
    !distanceAnchor ||
    distanceAnchor.accuracy === null ||
    distanceAnchor.accuracy > 25
  ) {
    return {
      segmentBreak: false,
      distanceMeters: 0,
      maxSpeedMps: 0,
      distanceAnchorUpdated: reliableNext
    };
  }

  const anchorElapsedSeconds = (next.timestamp - distanceAnchor.timestamp) / 1000;
  if (anchorElapsedSeconds <= 0 || anchorElapsedSeconds > 120) {
    return {
      segmentBreak: false,
      distanceMeters: 0,
      maxSpeedMps: 0,
      distanceAnchorUpdated: reliableNext
    };
  }
  const rawDistance = distanceBetweenMeters(distanceAnchor, next);
  const noiseAllowance = Math.min(
    30,
    Math.max(12, (distanceAnchor.accuracy + next.accuracy) * 1.25)
  );
  const reportedSpeed = filterGpsSpeedMps(next.speedMps, next.accuracy, maximumSpeedMps);
  const derivedSpeed = rawDistance / anchorElapsedSeconds;
  const speedConsistent = reportedSpeed === null
    ? derivedSpeed >= 1.5
    : reportedSpeed > 0 &&
      derivedSpeed <= reportedSpeed * 2.5 + 5 &&
      reportedSpeed <= derivedSpeed * 2.5 + 5;
  const significantMovement =
    rawDistance > noiseAllowance &&
    isSignificantGpsMovement(distanceAnchor, next) &&
    speedConsistent;
  const filteredSpeed = reportedSpeed === null
    ? derivedSpeed
    : Math.min(reportedSpeed, derivedSpeed * 1.5 + 3);
  return {
    segmentBreak: false,
    distanceMeters: significantMovement ? rawDistance : 0,
    maxSpeedMps: significantMovement ? filteredSpeed : 0,
    distanceAnchorUpdated: significantMovement
  };
}
