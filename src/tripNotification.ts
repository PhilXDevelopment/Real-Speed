import { NativeModules, Platform } from 'react-native';
import { Trip } from './database';
import { metersPerSecondToKmh } from './domain';

type SpeedUnit = 'km/h' | 'mph';

type TripNotificationModule = {
  update: (speed: string, unit: string, elapsed: string, mode: string, status: string) => void;
  dismiss: () => void;
};

const nativeNotification = NativeModules.RealSpeedTripNotification as
  | TripNotificationModule
  | undefined;

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function updateTripNotification(
  trip: Trip,
  speedMps: number | null,
  unit: SpeedUnit,
  now = Date.now()
): void {
  if (Platform.OS !== 'android') return;
  if (!nativeNotification) {
    throw new Error('Live trip notifications are unavailable in this Android build.');
  }

  const rawSpeed = speedMps === null
    ? null
    : unit === 'km/h'
      ? metersPerSecondToKmh(speedMps)
      : speedMps * 2.236936;
  const speed = rawSpeed === null ? '--' : String(Math.max(0, Math.round(rawSpeed)));
  const pauseTime = (trip.status === 'paused' || trip.status === 'interrupted') && trip.paused_at
    ? now - trip.paused_at
    : 0;
  const elapsed = now - trip.started_at - trip.paused_duration_ms - pauseTime;
  nativeNotification.update(speed, unit, formatDuration(elapsed), trip.mode, trip.status);
}

export function dismissTripNotification(): void {
  if (Platform.OS !== 'android' || !nativeNotification) return;
  nativeNotification.dismiss();
}
