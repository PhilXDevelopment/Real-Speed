import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Trip, TripPoint } from './database';

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createTripCsv(points: TripPoint[]): string {
  const rows = [
    ['timestamp_utc', 'latitude', 'longitude', 'speed_mps', 'accuracy_m', 'altitude_m', 'heading_deg', 'segment'],
    ...points.map((point) => [
      new Date(point.timestamp).toISOString(),
      point.latitude,
      point.longitude,
      point.speedMps,
      point.accuracy,
      point.altitude,
      point.heading,
      point.segment
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function createTripGpx(trip: Trip, points: TripPoint[]): string {
  const segments: string[] = [];
  let lastSegment: number | null = null;
  for (const point of points) {
    if (point.segment !== lastSegment) {
      if (segments.length) segments.push('    </trkseg>');
      segments.push('    <trkseg>');
      lastSegment = point.segment;
    }
    const elevation = point.altitude === null ? '' : `<ele>${point.altitude}</ele>`;
    const speed = point.speedMps === null ? '' : `<extensions><rs:speedMps>${point.speedMps}</rs:speedMps></extensions>`;
    segments.push(
      `      <trkpt lat="${point.latitude}" lon="${point.longitude}">${elevation}<time>${new Date(point.timestamp).toISOString()}</time>${speed}</trkpt>`
    );
  }
  if (lastSegment !== null) segments.push('    </trkseg>');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RealSpeed" xmlns="http://www.topografix.com/GPX/1/1" xmlns:rs="https://realspeed.app/xmlschemas/1/trackpoint">',
    `  <trk><name>RealSpeed ${trip.started_at}</name>`,
    `    <type>${trip.mode}</type>`,
    ...segments,
    '  </trk>',
    '</gpx>'
  ].join('\n');
}

export async function shareTripExport(
  trip: Trip,
  points: TripPoint[],
  format: 'csv' | 'gpx'
): Promise<void> {
  if (!points.length) throw new Error('This trip has no GPS points to export.');
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('File sharing is not available on this device.');
  }
  const extension = format;
  const mimeType = format === 'csv' ? 'text/csv' : 'application/gpx+xml';
  const content = format === 'csv' ? createTripCsv(points) : createTripGpx(trip, points);
  const file = new File(Paths.cache, `realspeed-${trip.id}.${extension}`);
  file.create({ intermediates: true, overwrite: true });
  await file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: `Export ${format.toUpperCase()} trip` });
}
