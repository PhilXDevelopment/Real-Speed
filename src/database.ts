import * as SQLite from 'expo-sqlite';
import { evaluateGpsPoint, GpsPoint, isValidPoint, maximumSpeedForMode } from './domain';

export type Trip = {
  id: string;
  started_at: number;
  ended_at: number | null;
  mode: string;
  status: 'recording' | 'paused' | 'complete' | 'interrupted';
  distance_m: number;
  max_speed_mps: number;
  last_point_at: number | null;
  paused_at: number | null;
  paused_duration_ms: number;
  track_segment: number;
  sync_status: 'local' | 'pending' | 'synced' | 'error';
};

export type TripPoint = GpsPoint & { segment: number };

let database: Promise<SQLite.SQLiteDatabase> | undefined;

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  database ??= SQLite.openDatabaseAsync('realspeed.db').then(async (db) => {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        distance_m REAL NOT NULL DEFAULT 0,
        max_speed_mps REAL NOT NULL DEFAULT 0,
        last_point_at INTEGER,
        paused_at INTEGER,
        paused_duration_ms INTEGER NOT NULL DEFAULT 0,
        track_segment INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'local'
      );
      CREATE TABLE IF NOT EXISTS gps_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        speed_mps REAL,
        accuracy_m REAL,
        altitude_m REAL,
        heading_deg REAL,
        segment INTEGER NOT NULL DEFAULT 0,
        distance_anchor INTEGER NOT NULL DEFAULT 0,
        UNIQUE(trip_id, timestamp)
      );
      CREATE INDEX IF NOT EXISTS gps_points_trip_time ON gps_points(trip_id, timestamp);
      CREATE TABLE IF NOT EXISTS sync_queue (
        trip_id TEXT PRIMARY KEY NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_queue_status ON sync_queue(status, last_attempt_at);
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS gps_points_trip_segment_anchor ON gps_points(trip_id, segment, distance_anchor, timestamp)'
    );
    const tripColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(trips)');
    const knownColumns = new Set(tripColumns.map((column) => column.name));
    if (!knownColumns.has('paused_at')) {
      await db.execAsync('ALTER TABLE trips ADD COLUMN paused_at INTEGER');
    }
    if (!knownColumns.has('paused_duration_ms')) {
      await db.execAsync(
        'ALTER TABLE trips ADD COLUMN paused_duration_ms INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!knownColumns.has('track_segment')) {
      await db.execAsync(
        'ALTER TABLE trips ADD COLUMN track_segment INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!knownColumns.has('sync_status')) {
      await db.execAsync(
        "ALTER TABLE trips ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local'"
      );
    }
    const pointColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(gps_points)');
    if (!pointColumns.some((column) => column.name === 'segment')) {
      await db.execAsync(
        'ALTER TABLE gps_points ADD COLUMN segment INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!pointColumns.some((column) => column.name === 'distance_anchor')) {
      await db.execAsync(
        'ALTER TABLE gps_points ADD COLUMN distance_anchor INTEGER NOT NULL DEFAULT 0'
      );
    }
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if ((version?.user_version ?? 0) < 5) {
      const savedTrips = await db.getAllAsync<{ id: string; mode: string }>(
        'SELECT id, mode FROM trips'
      );
      for (const trip of savedTrips) {
        await db.runAsync('UPDATE gps_points SET distance_anchor = 0 WHERE trip_id = ?', trip.id);
        const points = await db.getAllAsync<TripPoint>(
          `SELECT latitude, longitude, timestamp, speed_mps AS speedMps,
                  accuracy_m AS accuracy, altitude_m AS altitude, heading_deg AS heading,
                  segment
           FROM gps_points WHERE trip_id = ? ORDER BY timestamp`,
          trip.id
        );
        let previous: TripPoint | null = null;
        let distanceAnchor: TripPoint | null = null;
        let distance = 0;
        let maxSpeed = 0;
        for (const point of points) {
          if (previous?.segment !== point.segment) {
            previous = null;
            distanceAnchor = null;
          }
          const evaluation = evaluateGpsPoint(
            previous,
            point,
            maximumSpeedForMode(trip.mode),
            distanceAnchor
          );
          if (evaluation) {
            distance += evaluation.distanceMeters;
            maxSpeed = Math.max(maxSpeed, evaluation.maxSpeedMps);
            if (evaluation.distanceAnchorUpdated) {
              distanceAnchor = point;
              await db.runAsync(
                'UPDATE gps_points SET distance_anchor = 1 WHERE trip_id = ? AND timestamp = ?',
                trip.id,
                point.timestamp
              );
            }
          }
          previous = point;
        }
        await db.runAsync(
          'UPDATE trips SET distance_m = ?, max_speed_mps = ? WHERE id = ?',
          distance,
          maxSpeed,
          trip.id
        );
      }
      await db.execAsync('PRAGMA user_version = 5');
    }
    return db;
  });
  return database;
}

export async function createTrip(mode: string): Promise<Trip> {
  const db = await getDatabase();
  const openTrip = await getActiveTrip();
  if (openTrip) {
    throw new Error('Finish or resume the existing trip before starting another one.');
  }
  const trip: Trip = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    started_at: Date.now(),
    ended_at: null,
    mode,
    status: 'recording',
    distance_m: 0,
    max_speed_mps: 0,
    last_point_at: null,
    paused_at: null,
    paused_duration_ms: 0,
    track_segment: 0,
    sync_status: 'local'
  };
  await db.runAsync(
    'INSERT INTO trips (id, started_at, mode, status) VALUES (?, ?, ?, ?)',
    trip.id,
    trip.started_at,
    trip.mode,
    trip.status
  );
  return trip;
}

export async function addGpsPoint(
  tripId: string,
  point: GpsPoint,
  maximumSpeedMps?: number
): Promise<void> {
  const db = await getDatabase();
  if (!isValidPoint(point)) return;
  await db.withTransactionAsync(async () => {
    const trip = await db.getFirstAsync<Trip>(
      "SELECT * FROM trips WHERE id = ? AND status = 'recording'",
      tripId
    );
    if (!trip) return;
    const previous = await db.getFirstAsync<GpsPoint>(
      `SELECT latitude, longitude, timestamp, speed_mps AS speedMps, accuracy_m AS accuracy,
              altitude_m AS altitude, heading_deg AS heading
       FROM gps_points WHERE trip_id = ? AND segment = ? ORDER BY timestamp DESC LIMIT 1`,
      tripId,
      trip.track_segment
    );
    const distanceAnchor = await db.getFirstAsync<GpsPoint>(
      `SELECT latitude, longitude, timestamp, speed_mps AS speedMps, accuracy_m AS accuracy,
              altitude_m AS altitude, heading_deg AS heading
       FROM gps_points
       WHERE trip_id = ? AND segment = ? AND distance_anchor = 1
       ORDER BY timestamp DESC LIMIT 1`,
      tripId,
      trip.track_segment
    );
    const evaluation = evaluateGpsPoint(
      previous ?? null,
      point,
      maximumSpeedMps ?? maximumSpeedForMode(trip.mode),
      distanceAnchor ?? null
    );
    if (!evaluation) return;
    const segment = trip.track_segment + (evaluation.segmentBreak ? 1 : 0);
    const result = await db.runAsync(
      `INSERT OR IGNORE INTO gps_points
       (trip_id, timestamp, latitude, longitude, speed_mps, accuracy_m, altitude_m, heading_deg, segment, distance_anchor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tripId,
      point.timestamp,
      point.latitude,
      point.longitude,
      point.speedMps,
      point.accuracy,
      point.altitude,
      point.heading,
      segment,
      evaluation.distanceAnchorUpdated ? 1 : 0
    );
    if (result.changes === 0) return;
    await db.runAsync(
      `UPDATE trips SET distance_m = distance_m + ?, max_speed_mps = MAX(max_speed_mps, ?),
       last_point_at = ?, track_segment = MAX(track_segment, ?)
       WHERE id = ? AND status = 'recording'`,
      evaluation.distanceMeters,
      evaluation.maxSpeedMps,
      point.timestamp,
      segment,
      tripId
    );
  });
}

export async function setTripStatus(tripId: string, status: Trip['status']): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE trips SET status = ?, ended_at = ?,
     paused_duration_ms = paused_duration_ms +
       CASE WHEN ? = 'complete' AND paused_at IS NOT NULL THEN ? - paused_at ELSE 0 END,
     paused_at = CASE WHEN ? = 'complete' THEN NULL ELSE paused_at END WHERE id = ?`,
    status,
    status === 'complete' ? Date.now() : null,
    status,
    Date.now(),
    status,
    tripId
  );
}

export async function getAppSetting(key: string): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_state WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)',
    key,
    value
  );
}

export async function getTrips(): Promise<Trip[]> {
  const db = await getDatabase();
  return db.getAllAsync<Trip>('SELECT * FROM trips ORDER BY started_at DESC');
}

export async function getTrip(tripId: string): Promise<Trip | null> {
  const db = await getDatabase();
  return (await db.getFirstAsync<Trip>('SELECT * FROM trips WHERE id = ?', tripId)) ?? null;
}

export async function getActiveTrip(): Promise<Trip | null> {
  const db = await getDatabase();
  return (
    (await db.getFirstAsync<Trip>(
      "SELECT * FROM trips WHERE status IN ('recording', 'paused', 'interrupted') ORDER BY started_at DESC LIMIT 1"
    )) ?? null
  );
}

export async function saveBackgroundError(message: string | null): Promise<void> {
  const db = await getDatabase();
  if (message === null) {
    await db.runAsync("DELETE FROM app_state WHERE key = 'background_error'");
    return;
  }
  await db.runAsync(
    "INSERT OR REPLACE INTO app_state (key, value) VALUES ('background_error', ?)",
    message
  );
}

export async function getBackgroundError(): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_state WHERE key = 'background_error'"
  );
  return row?.value ?? null;
}

export async function markTripInterrupted(tripId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE trips SET status = 'interrupted', paused_at = ? WHERE id = ? AND status = 'recording'",
    Date.now(),
    tripId
  );
}

export async function pauseTrip(tripId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE trips SET status = 'paused', paused_at = ? WHERE id = ? AND status = 'recording'",
    Date.now(),
    tripId
  );
}

export async function resumeTrip(tripId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE trips SET status = 'recording',
     paused_duration_ms = paused_duration_ms + CASE WHEN paused_at IS NULL THEN 0 ELSE ? - paused_at END,
     paused_at = NULL, track_segment = track_segment + 1
     WHERE id = ? AND status IN ('paused', 'interrupted')`,
    Date.now(),
    tripId
  );
}

export async function getTripPointCount(tripId: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM gps_points WHERE trip_id = ?',
    tripId
  );
  return row?.count ?? 0;
}

export async function getTripPoints(tripId: string): Promise<TripPoint[]> {
  const db = await getDatabase();
  return db.getAllAsync<TripPoint>(
    `SELECT latitude, longitude, timestamp, speed_mps AS speedMps,
            accuracy_m AS accuracy, altitude_m AS altitude, heading_deg AS heading,
            segment
     FROM gps_points WHERE trip_id = ? ORDER BY timestamp`,
    tripId
  );
}

export async function getLatestTripPoint(tripId: string): Promise<TripPoint | null> {
  const db = await getDatabase();
  return (await db.getFirstAsync<TripPoint>(
    `SELECT latitude, longitude, timestamp, speed_mps AS speedMps,
            accuracy_m AS accuracy, altitude_m AS altitude, heading_deg AS heading,
            segment
     FROM gps_points WHERE trip_id = ? ORDER BY timestamp DESC LIMIT 1`,
    tripId
  )) ?? null;
}

export async function getTripSpeedAnchor(
  tripId: string,
  segment: number
): Promise<TripPoint | null> {
  const db = await getDatabase();
  const columns = `SELECT latitude, longitude, timestamp, speed_mps AS speedMps,
                          accuracy_m AS accuracy, altitude_m AS altitude,
                          heading_deg AS heading, segment
                   FROM gps_points WHERE trip_id = ? AND segment = ?`;
  const anchor = await db.getFirstAsync<TripPoint>(
    `${columns} AND distance_anchor = 1 ORDER BY timestamp DESC LIMIT 1`,
    tripId,
    segment
  );
  if (anchor) return anchor;
  return (await db.getFirstAsync<TripPoint>(
    `${columns} ORDER BY timestamp ASC LIMIT 1`,
    tripId,
    segment
  )) ?? null;
}

export async function deleteTrip(tripId: string): Promise<void> {
  const db = await getDatabase();
  const trip = await getTrip(tripId);
  if (!trip) return;
  if (trip.status !== 'complete') {
    throw new Error('Only finished trips can be deleted. Finish or recover this trip first.');
  }
  await db.runAsync('DELETE FROM trips WHERE id = ?', tripId);
}
