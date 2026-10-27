import { createTripCsv, createTripGpx } from './tripExport';
import { Trip, TripPoint } from './database';

const trip: Trip = {
  id: 'trip-1',
  started_at: 1_000,
  ended_at: 2_000,
  mode: 'car',
  status: 'complete',
  distance_m: 20,
  max_speed_mps: 10,
  last_point_at: 2_000,
  paused_at: null,
  paused_duration_ms: 0,
  track_segment: 0,
  sync_status: 'local'
};
const points: TripPoint[] = [
  { latitude: 1, longitude: 2, timestamp: 1_000, speedMps: 1, accuracy: 5, altitude: 10, heading: 0, segment: 0 },
  { latitude: 1.1, longitude: 2.1, timestamp: 2_000, speedMps: null, accuracy: null, altitude: null, heading: null, segment: 1 }
];

describe('trip exports', () => {
  it('writes CSV headers, UTC timestamps, and null measurements as blank fields', () => {
    const csv = createTripCsv(points);
    const [header, firstPoint, secondPoint] = csv.split('\r\n');
    expect(header).toBe('timestamp_utc,latitude,longitude,speed_mps,accuracy_m,altitude_m,heading_deg,segment');
    expect(firstPoint).toBe('1970-01-01T00:00:01.000Z,1,2,1,5,10,0,0');
    expect(secondPoint).toBe('1970-01-01T00:00:02.000Z,1.1,2.1,,,,,1');
  });

  it('creates a GPX document with timestamped points and elevation when available', () => {
    const gpx = createTripGpx(trip, points);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<trkpt lat="1" lon="2"><ele>10</ele><time>');
    expect(gpx.match(/<trkpt /g)).toHaveLength(2);
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
  });
});
