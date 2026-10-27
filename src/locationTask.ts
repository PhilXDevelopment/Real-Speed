import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  addGpsPoint,
  getActiveTrip,
  getAppSetting,
  getLatestTripPoint,
  getTripSpeedAnchor,
  saveBackgroundError
} from './database';
import { GpsPoint, isSignificantGpsMovement } from './domain';
import {
  getSpeedFromGpsFix,
  maximumSpeedForMode
} from './domain';
import { updateTripNotification } from './tripNotification';

export const LOCATION_TASK_NAME = 'realspeed-background-location';

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    await saveBackgroundError(error.message);
    console.error('Background location task failed:', error.message);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations?.length) return;

  try {
    const trip = await getActiveTrip();
    if (!trip || trip.status !== 'recording') return;
    const lastPoint = await getLatestTripPoint(trip.id);
    let segment = trip.track_segment;
    let previous = lastPoint?.segment === segment ? lastPoint : null;
    let speedDistanceAnchor = previous
      ? await getTripSpeedAnchor(trip.id, segment)
      : null;
    let latestSpeed: number | null = null;
    for (const location of locations) {
      const point: GpsPoint = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        timestamp: location.timestamp,
        speedMps: location.coords.speed !== null && location.coords.speed >= 0
          ? location.coords.speed
          : null,
        accuracy: location.coords.accuracy,
        altitude: location.coords.altitude,
        heading: location.coords.heading
      };
      const maximumSpeedMps = maximumSpeedForMode(trip.mode);
      if (previous && point.timestamp - previous.timestamp > 120_000) {
        segment += 1;
        previous = null;
        speedDistanceAnchor = null;
      }
      const confirmedMovement = speedDistanceAnchor !== null &&
        isSignificantGpsMovement(speedDistanceAnchor, point);
      const measuredSpeed = getSpeedFromGpsFix(
        previous,
        point,
        maximumSpeedMps,
        speedDistanceAnchor
      );
      latestSpeed = measuredSpeed;
      if (measuredSpeed === null && point.accuracy !== null && point.accuracy <= 25 && !confirmedMovement) {
        latestSpeed = 0;
      }
      if (
        measuredSpeed !== null ||
        speedDistanceAnchor === null ||
        speedDistanceAnchor.accuracy === null ||
        speedDistanceAnchor.accuracy > 25 ||
        point.accuracy === null ||
        point.accuracy > 25 ||
        (speedDistanceAnchor && point.timestamp - speedDistanceAnchor.timestamp > 120_000)
      ) {
        speedDistanceAnchor = { ...point, segment };
      }
      await addGpsPoint(trip.id, point, maximumSpeedMps);
      previous = { ...point, segment };
    }
    const storedUnit = await getAppSetting('speed_unit');
    const unit = storedUnit === 'mph' ? 'mph' : 'km/h';
    const calibrationValue = Number(await getAppSetting('speed_calibration_percent'));
    const calibration = Number.isFinite(calibrationValue)
      ? Math.max(-10, Math.min(10, calibrationValue))
      : 0;
    updateTripNotification(
      trip,
      latestSpeed !== null
        ? latestSpeed * (1 + calibration / 100)
        : null,
      unit
    );
    await saveBackgroundError(null);
  } catch (taskError) {
    const message = taskError instanceof Error ? taskError.message : String(taskError);
    await saveBackgroundError(message);
    console.error('Unable to save background location:', message);
  }
});
