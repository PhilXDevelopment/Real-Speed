import {
  distanceBetweenMeters,
  evaluateGpsPoint,
  filterGpsSpeedMps,
  isPlausibleNextPoint,
  isValidPoint,
  getSpeedFromGpsFix,
  defaultCalibrationPercentForMode,
  maximumSpeedForMode,
  metersPerSecondToKmh
} from './domain';

describe('GPS calculations', () => {
  it('converts meters per second to kilometers per hour', () => {
    expect(metersPerSecondToKmh(10)).toBe(36);
  });

  it('accepts receiver speed across the fair-accuracy range and only snaps tiny noise to zero', () => {
    expect(filterGpsSpeedMps(12, 60)).toBeNull();
    expect(filterGpsSpeedMps(160, 5, 100)).toBeNull();
    expect(filterGpsSpeedMps(0.3, 5)).toBe(0);
    expect(filterGpsSpeedMps(0.8, 5)).toBe(0.8);
    expect(filterGpsSpeedMps(10, 5)).toBe(10);
  });

  it('calculates a geodesic distance', () => {
    expect(
      distanceBetweenMeters(
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 }
      )
    ).toBeCloseTo(111_195, -1);
  });

  it('rejects invalid GPS coordinates and stale time ordering', () => {
    const point = {
      latitude: 90.1,
      longitude: 0,
      timestamp: 1_000,
      speedMps: null,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    expect(isValidPoint(point)).toBe(false);
    expect(isPlausibleNextPoint({ ...point, latitude: 0 }, { ...point, latitude: 0 })).toBe(false);
  });

  it('keeps fast aircraft points within the airplane threshold', () => {
    const previous = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: null,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const next = { ...previous, longitude: 0.001, timestamp: 2_000 };
    expect(isPlausibleNextPoint(previous, next, 400)).toBe(true);
    expect(isPlausibleNextPoint(previous, next, 100)).toBe(false);
  });

  it('does not count duplicate fixes, poor-accuracy movement, or long GPS gaps as distance', () => {
    const first = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 12,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    expect(evaluateGpsPoint(first, first)).toBeNull();
    const poorFix = { ...first, longitude: 0.0001, timestamp: 2_000, accuracy: 80 };
    expect(evaluateGpsPoint(first, poorFix)?.distanceMeters).toBe(0);
    const longGap = { ...first, longitude: 0.01, timestamp: 200_000 };
    expect(evaluateGpsPoint(first, longGap)).toMatchObject({ segmentBreak: true, distanceMeters: 0 });
  });

  it('does not add small stationary GPS drift to trip distance or maximum speed', () => {
    const previous = {
      latitude: 14.5995,
      longitude: 120.9842,
      timestamp: 1_000,
      speedMps: 4,
      accuracy: 8,
      altitude: null,
      heading: null
    };
    const drift = {
      ...previous,
      latitude: previous.latitude + 0.00002,
      timestamp: 3_000
    };
    expect(evaluateGpsPoint(previous, drift)).toMatchObject({
      distanceMeters: 0,
      maxSpeedMps: 0
    });
  });

  it('retains meaningful movement while removing GPS noise', () => {
    const previous = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 10,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const moving = { ...previous, longitude: 0.0002, timestamp: 3_000 };
    expect(evaluateGpsPoint(previous, moving)?.distanceMeters).toBeGreaterThan(10);
  });

  it('accumulates short real movements from a fixed distance anchor', () => {
    const origin = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 5,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const fiveMeters = { ...origin, latitude: 5 / 111_195, timestamp: 2_000 };
    const tenMeters = { ...origin, latitude: 10 / 111_195, timestamp: 3_000 };
    const fifteenMeters = { ...origin, latitude: 15 / 111_195, timestamp: 4_000 };

    const first = evaluateGpsPoint(origin, fiveMeters, 80, origin);
    expect(first).toMatchObject({ distanceMeters: 0, distanceAnchorUpdated: false });
    const second = evaluateGpsPoint(fiveMeters, tenMeters, 80, origin);
    expect(second).toMatchObject({ distanceMeters: 0, distanceAnchorUpdated: false });
    const third = evaluateGpsPoint(tenMeters, fifteenMeters, 80, origin);
    expect(third?.distanceMeters).toBeCloseTo(15, 0);
    expect(third?.distanceAnchorUpdated).toBe(true);
  });

  it('rejects GPS position jumps that disagree with the reported speed', () => {
    const previous = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 8,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const jump = { ...previous, latitude: 80 / 111_195, timestamp: 2_000 };

    expect(evaluateGpsPoint(previous, jump, 80)).toBeNull();
  });

  it('rejects a GPS speed spike unsupported by the measured movement', () => {
    const previous = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 50,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const next = { ...previous, latitude: 15 / 111_195, timestamp: 2_000 };

    expect(evaluateGpsPoint(previous, next, 80)?.distanceMeters).toBe(0);
  });

  it('does not accumulate stationary coordinate jitter when GPS reports zero speed', () => {
    const anchor = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 0,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const jitter = { ...anchor, latitude: 25 / 111_195, timestamp: 2_000 };
    const evaluation = evaluateGpsPoint(anchor, jitter, 80, anchor);

    expect(evaluation).toMatchObject({ distanceMeters: 0, maxSpeedMps: 0 });
  });

  it('uses the selected travel mode speed limit', () => {
    expect(filterGpsSpeedMps(75, 5, maximumSpeedForMode('car'))).toBeNull();
    expect(filterGpsSpeedMps(75, 5, maximumSpeedForMode('airplane'))).toBe(75);
  });

  it('applies a ride-aware default calibration without manual tuning', () => {
    expect(defaultCalibrationPercentForMode('walking')).toBe(1.5);
    expect(defaultCalibrationPercentForMode('bicycle')).toBe(1);
    expect(defaultCalibrationPercentForMode('motorcycle')).toBe(0);
    expect(defaultCalibrationPercentForMode('car')).toBe(0);
    expect(defaultCalibrationPercentForMode('train')).toBe(1.5);
    expect(defaultCalibrationPercentForMode('airplane')).toBe(0);
  });

  it('shows valid GPS-reported speed without requiring a large one-second coordinate jump', () => {
    const previous = {
      latitude: 14.5995,
      longitude: 120.9842,
      timestamp: 1_000,
      speedMps: 8,
      accuracy: 12,
      altitude: null,
      heading: null
    };
    const next = {
      ...previous,
      latitude: previous.latitude + 0.00001,
      timestamp: 2_000
    };

    expect(getSpeedFromGpsFix(previous, next, maximumSpeedForMode('motorcycle'))).toBe(8);
  });

  it('derives slow movement across several fixes instead of resetting the movement baseline each second', () => {
    const anchor = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: null,
      accuracy: 5,
      altitude: null,
      heading: null
    };
    const first = { ...anchor, latitude: 2 / 111_195, timestamp: 2_000 };
    const second = { ...anchor, latitude: 4 / 111_195, timestamp: 3_000 };
    const third = { ...anchor, latitude: 6 / 111_195, timestamp: 4_000 };
    const moving = { ...anchor, latitude: 15 / 111_195, timestamp: 6_000 };

    expect(getSpeedFromGpsFix(first, first, 80, anchor)).toBeNull();
    expect(getSpeedFromGpsFix(second, second, 80, anchor)).toBeNull();
    expect(getSpeedFromGpsFix(third, third, 80, anchor)).toBeNull();
    expect(getSpeedFromGpsFix(third, moving, 80, anchor)).toBeCloseTo(3, 0);
  });

  it('rejects speed readings when GPS accuracy is too poor or speed exceeds the mode limit', () => {
    const point = {
      latitude: 0,
      longitude: 0,
      timestamp: 1_000,
      speedMps: 12,
      accuracy: 60,
      altitude: null,
      heading: null
    };
    expect(getSpeedFromGpsFix(null, point)).toBeNull();
    expect(getSpeedFromGpsFix(null, { ...point, accuracy: 40 })).toBe(12);
    expect(getSpeedFromGpsFix(null, { ...point, accuracy: 5, speedMps: 75 }, 70)).toBeNull();
  });
});
