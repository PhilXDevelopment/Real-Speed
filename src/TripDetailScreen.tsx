import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapView
} from '@maplibre/maplibre-react-native';
import { Trip, TripPoint } from './database';
import { formatDistance } from './distanceFormat';
import { shareTripExport } from './tripExport';

const C = {
  panel: '#FFFFFF',
  line: '#E1E8EB',
  text: '#17252E',
  muted: '#6C7B84',
  accent: '#087F72',
  blue: '#3479C5',
  red: '#C44642'
};

type SpeedUnit = 'km/h' | 'mph';

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function tripDuration(trip: Trip): number {
  const pausedDuration =
    trip.paused_duration_ms +
    ((trip.status === 'paused' || trip.status === 'interrupted') && trip.paused_at
      ? Date.now() - trip.paused_at
      : 0);
  return Math.max(
    0,
    (trip.ended_at ?? Date.now()) - trip.started_at - pausedDuration
  );
}

function displayPointSpeed(point: TripPoint | undefined, unit: SpeedUnit): string {
  return point?.speedMps === null || point?.speedMps === undefined
    ? '—'
    : String(Math.round(point.speedMps * (unit === 'km/h' ? 3.6 : 2.236936)));
}

export function TripDetailScreen({
  trip,
  points,
  mapStyleUrl,
  unit,
  onBack,
  onDelete,
  onError
}: {
  trip: Trip;
  points: TripPoint[];
  mapStyleUrl: string | null;
  unit: SpeedUnit;
  onBack: () => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const [playheadTime, setPlayheadTime] = useState(() => points[0]?.timestamp ?? 0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [seekWidth, setSeekWidth] = useState(1);
  const accuracyPoints = useMemo(
    () => points.filter((point) => point.accuracy !== null && point.accuracy <= 50),
    [points]
  );
  const averageSpeedMps = useMemo(() => {
    let movingDistanceMeters = 0;
    let movingDurationSeconds = 0;
    for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
      const first = points[pointIndex];
      const second = points[pointIndex + 1];
      const elapsedSeconds = (second.timestamp - first.timestamp) / 1000;
      if (
        first.segment !== second.segment ||
        elapsedSeconds <= 0 ||
        elapsedSeconds > 120 ||
        first.accuracy === null ||
        second.accuracy === null ||
        first.accuracy > 50 ||
        second.accuracy > 50 ||
        first.speedMps === null ||
        second.speedMps === null
      ) continue;
      const firstSpeed = Math.max(0, first.speedMps);
      const secondSpeed = Math.max(0, second.speedMps);
      if (firstSpeed <= 0.5 && secondSpeed <= 0.5) continue;
      movingDistanceMeters += ((firstSpeed + secondSpeed) / 2) * elapsedSeconds;
      movingDurationSeconds += elapsedSeconds;
    }
    return movingDurationSeconds > 0 ? movingDistanceMeters / movingDurationSeconds : null;
  }, [points]);
  const totalTrackTime = Math.max(
    0,
    (points[points.length - 1]?.timestamp ?? 0) - (points[0]?.timestamp ?? 0)
  );
  let index = 0;
  while (index + 1 < points.length && points[index + 1].timestamp <= playheadTime) index += 1;
  const firstPoint = points[index];
  const nextPoint = points[index + 1];
  const pointInterval = firstPoint && nextPoint ? nextPoint.timestamp - firstPoint.timestamp : 0;
  const fraction = pointInterval > 0
    ? Math.min(1, Math.max(0, (playheadTime - firstPoint.timestamp) / pointInterval))
    : 0;
  const canInterpolate = Boolean(
    firstPoint &&
    nextPoint &&
    firstPoint.segment === nextPoint.segment &&
    nextPoint.timestamp - firstPoint.timestamp <= 120_000
  );
  const currentPoint = firstPoint
    ? {
        ...firstPoint,
        latitude: canInterpolate && nextPoint
          ? firstPoint.latitude + (nextPoint.latitude - firstPoint.latitude) * fraction
          : firstPoint.latitude,
        longitude: canInterpolate && nextPoint
          ? firstPoint.longitude + (nextPoint.longitude - firstPoint.longitude) * fraction
          : firstPoint.longitude,
        timestamp: canInterpolate && nextPoint
          ? firstPoint.timestamp + (nextPoint.timestamp - firstPoint.timestamp) * fraction
          : firstPoint.timestamp,
        speedMps: canInterpolate && nextPoint &&
          firstPoint.speedMps !== null &&
          nextPoint.speedMps !== null
          ? firstPoint.speedMps + (nextPoint.speedMps - firstPoint.speedMps) * fraction
          : firstPoint.speedMps
      }
    : undefined;
  const speedFactor = unit === 'km/h' ? 3.6 : 2.236936;
  const maxSpeed = trip.max_speed_mps * speedFactor;
  const routeData = useMemo(() => {
    const segments = new Map<number, TripPoint[]>();
    let visualSegment = -1;
    let previousSegment: number | null = null;
    let previousTimestamp: number | null = null;
    points.slice(0, index + 1).forEach((point) => {
      if (
        previousSegment !== point.segment ||
        (previousTimestamp !== null && point.timestamp - previousTimestamp > 120_000)
      ) {
        visualSegment += 1;
      }
      const segment = segments.get(visualSegment) ?? [];
      segment.push(point);
      segments.set(visualSegment, segment);
      previousSegment = point.segment;
      previousTimestamp = point.timestamp;
    });
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    for (const [segmentNumber, segment] of segments) {
      if (segment.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { segment: segmentNumber },
        geometry: {
          type: 'LineString',
          coordinates: segment.map((point) => [point.longitude, point.latitude])
        }
      });
    }
    const activeSegment = segments.get(visualSegment);
    if (activeSegment && currentPoint && canInterpolate && fraction > 0) {
      activeSegment.push(currentPoint);
      const activeFeature = features.find((feature) => feature.properties?.segment === visualSegment);
      activeFeature?.geometry.coordinates.push([currentPoint.longitude, currentPoint.latitude]);
    }
    return { type: 'FeatureCollection' as const, features };
  }, [points, index, currentPoint, canInterpolate, fraction]);
  const markerData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(
    () => ({
      type: 'FeatureCollection',
      features: currentPoint
        ? [{
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Point',
              coordinates: [currentPoint.longitude, currentPoint.latitude]
            }
          }]
        : []
    }),
    [currentPoint]
  );
  const chartData = accuracyPoints.filter(
    (point) => point.speedMps !== null
  ).slice(-44);
  const chartMax = Math.max(1, ...chartData.map((point) => point.speedMps ?? 0));
  const duration = tripDuration(trip);

  useEffect(() => {
    if (!playing || points.length < 2) return;
    const timer = setInterval(() => {
      setPlayheadTime((current) =>
        Math.min(points[points.length - 1].timestamp, current + (totalTrackTime / 30) * playbackRate * 0.1)
      );
    }, 100);
    return () => clearInterval(timer);
  }, [playing, playbackRate, points, totalTrackTime]);

  useEffect(() => {
    if (playing && playheadTime >= (points[points.length - 1]?.timestamp ?? 0)) setPlaying(false);
  }, [playheadTime, playing, points]);

  const onSeek = (event: { nativeEvent: { locationX: number } }) => {
    const progress = Math.max(0, Math.min(1, event.nativeEvent.locationX / seekWidth));
    const startTime = points[0]?.timestamp ?? 0;
    setPlayheadTime(startTime + totalTrackTime * progress);
  };

  const onSeekLayout = (event: LayoutChangeEvent) => setSeekWidth(Math.max(1, event.nativeEvent.layout.width));

  const exportFile = async (format: 'csv' | 'gpx') => {
    try {
      await shareTripExport(trip, points, format);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <View style={styles.heading}>
        <Pressable onPress={onBack} style={styles.backButton}><Text style={styles.backText}>‹  TRIPS</Text></Pressable>
        <View style={styles.headingText}>
          <Text style={styles.eyebrow}>RECORDED ROUTE · LOCAL DATA</Text>
          <Text style={styles.title}>{trip.mode.toUpperCase()} JOURNEY</Text>
          <Text style={styles.date}>{new Date(trip.started_at).toLocaleString()}</Text>
        </View>
        <Text style={styles.pointCount}>{points.length} POINTS</Text>
      </View>

      <View style={styles.metricRow}>
        <Metric label="DISTANCE" value={formatDistance(trip.distance_m, unit)} />
        <Metric label="DURATION" value={formatElapsed(duration)} />
        <Metric label="MAX SPEED" value={`${Math.round(maxSpeed)} ${unit}`} />
        <Metric label="AVG MOVING" value={averageSpeedMps === null ? '—' : `${Math.round(averageSpeedMps * speedFactor)} ${unit}`} />
      </View>

      {mapStyleUrl ? (
        <View style={styles.map}>
          <MapView
            style={styles.map}
            mapStyle={mapStyleUrl}
            onDidFailLoadingMap={() => onError('Map style did not load. Recorded trip points remain available locally and can be exported.')}
          >
            <Camera
              center={currentPoint ? [currentPoint.longitude, currentPoint.latitude] : undefined}
              zoom={currentPoint ? 15 : undefined}
              duration={250}
            />
            {routeData.features.length ? (
              <GeoJSONSource id={`trip-route-${trip.id}`} data={routeData}>
                <Layer
                  id={`trip-line-${trip.id}`}
                  type="line"
                  source={`trip-route-${trip.id}`}
                  paint={{ 'line-color': C.accent, 'line-width': 4, 'line-opacity': 0.9 }}
                />
              </GeoJSONSource>
            ) : null}
            {currentPoint ? (
              <GeoJSONSource id={`trip-marker-${trip.id}`} data={markerData}>
                <Layer
                  id={`trip-dot-${trip.id}`}
                  type="circle"
                  source={`trip-marker-${trip.id}`}
                  paint={{ 'circle-color': C.red, 'circle-radius': 7, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2 }}
                />
              </GeoJSONSource>
            ) : null}
          </MapView>
        </View>
      ) : (
        <View style={styles.mapFallback}>
          <Text style={styles.fallbackTitle}>ROUTE PREVIEW NEEDS A MAP STYLE</Text>
          <Text style={styles.fallbackCopy}>
            GPS points remain available locally. Configure a licensed style or use the exported GPX/CSV track.
          </Text>
          {currentPoint ? (
            <Text style={styles.coordinate}>{currentPoint.latitude.toFixed(6)}, {currentPoint.longitude.toFixed(6)}</Text>
          ) : null}
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.controlHeader}>
          <View>
            <Text style={styles.eyebrow}>TIMELINE REPLAY</Text>
            <Text style={styles.cardTitle}>
              {currentPoint ? new Date(currentPoint.timestamp).toLocaleTimeString() : 'No recorded GPS points'}
            </Text>
          </View>
          <Text style={styles.speedReadout}>{displayPointSpeed(currentPoint, unit)}<Text style={styles.speedUnit}> {unit}</Text></Text>
        </View>
        <Pressable
          onLayout={onSeekLayout}
          onPress={onSeek}
          accessibilityRole="adjustable"
          accessibilityLabel="Journey replay timeline"
          style={styles.seekTrack}
        >
          <View style={[styles.seekProgress, { width: `${totalTrackTime > 0 ? ((playheadTime - points[0].timestamp) / totalTrackTime) * 100 : 0}%` }]} />
        </Pressable>
        <View style={styles.controlRow}>
          <Pressable
            onPress={() => {
              if (index >= points.length - 1) setPlayheadTime(points[0]?.timestamp ?? 0);
              setPlaying((value) => !value);
            }}
            disabled={points.length < 2}
            style={[styles.playButton, points.length < 2 && styles.disabled]}
          >
            <Text style={styles.playText}>{playing ? 'PAUSE' : index >= points.length - 1 && index > 0 ? 'RESTART' : 'PLAY'}</Text>
          </Pressable>
          <View style={styles.rateRow}>
            {[1, 2, 4].map((rate) => (
              <Pressable key={rate} onPress={() => setPlaybackRate(rate)} style={[styles.rate, playbackRate === rate && styles.rateActive]}>
                <Text style={[styles.rateText, playbackRate === rate && styles.rateTextActive]}>{rate}×</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.timelineText}>{points.length ? `${index + 1} / ${points.length}` : '0 / 0'}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.eyebrow}>SPEED PROFILE · ACCURACY ≤ 50 M</Text>
        {chartData.length ? (
          <>
            <View style={styles.chart}>
              {chartData.map((point, chartIndex) => {
                const height = Math.max(3, ((point.speedMps ?? 0) / chartMax) * 86);
                return (
                  <View key={`${point.timestamp}-${chartIndex}`} style={styles.barSlot}>
                    <View style={[styles.bar, { height }]} />
                  </View>
                );
              })}
            </View>
            <View style={styles.chartCaption}>
              <Text style={styles.chartText}>MAX {Math.round(chartMax * speedFactor)} {unit}</Text>
              <Text style={styles.chartText}>EACH BAR IS A RECORDED FIX</Text>
            </View>
          </>
        ) : (
          <Text style={styles.fallbackCopy}>No speed measurements with acceptable GPS accuracy are available for this chart.</Text>
        )}
        <Text style={styles.gapNote}>
          Paused intervals and missing timestamps are kept as separate route segments; replay uses the saved GPS coordinates and does not request road matching.
        </Text>
      </View>

      <View style={styles.exportRow}>
        <Pressable onPress={() => void exportFile('gpx')} disabled={!points.length} style={[styles.exportButton, !points.length && styles.disabled]}>
          <Text style={styles.exportText}>EXPORT GPX</Text>
        </Pressable>
        <Pressable onPress={() => void exportFile('csv')} disabled={!points.length} style={[styles.exportButton, !points.length && styles.disabled]}>
          <Text style={styles.exportText}>EXPORT CSV</Text>
        </Pressable>
        {trip.status === 'complete' ? (
          <Pressable
            onPress={() =>
              Alert.alert('Delete this trip?', 'This permanently deletes this trip and its GPS points from this device.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: onDelete }
              ])
            }
            style={styles.deleteButton}
          >
            <Text style={styles.deleteText}>DELETE TRIP</Text>
          </Pressable>
        ) : (
          <Text style={styles.gapNote}>Finish this recording from the dashboard before deleting it.</Text>
        )}
      </View>
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14, paddingBottom: 32, backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13 },
  headingText: { flex: 1 },
  backButton: { padding: 9, backgroundColor: '#EAF4F1', borderRadius: 10 },
  backText: { color: C.accent, fontSize: 9, fontWeight: '900' },
  eyebrow: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: C.text, fontSize: 17, fontWeight: '900', marginTop: 3 },
  date: { color: C.muted, fontSize: 9, marginTop: 3 },
  pointCount: { color: C.accent, fontSize: 8, fontWeight: '800' },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderColor: C.line, borderRadius: 10, marginBottom: 11 },
  metric: { width: '50%', padding: 10, borderBottomWidth: 1, borderRightWidth: 1, borderColor: C.line },
  metricLabel: { color: C.muted, fontSize: 7, fontWeight: '800', letterSpacing: 0.8 },
  metricValue: { color: C.text, fontSize: 14, fontWeight: '800', marginTop: 5 },
  map: { height: 220, overflow: 'hidden', borderRadius: 14, backgroundColor: '#F2F5F6', marginBottom: 11 },
  mapFallback: { minHeight: 150, alignItems: 'center', justifyContent: 'center', padding: 18, borderRadius: 14, backgroundColor: '#F7F9FA', marginBottom: 11 },
  fallbackTitle: { color: C.text, fontSize: 9, fontWeight: '900', letterSpacing: 1, textAlign: 'center' },
  fallbackCopy: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 8 },
  coordinate: { color: C.accent, fontSize: 10, marginTop: 10 },
  card: { padding: 13, borderRadius: 14, borderColor: C.line, borderWidth: 1, backgroundColor: '#FBFCFD', marginBottom: 10 },
  controlHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: C.text, fontSize: 11, fontWeight: '700', marginTop: 4 },
  speedReadout: { color: C.text, fontSize: 22, fontWeight: '800' },
  speedUnit: { color: C.accent, fontSize: 9 },
  seekTrack: { height: 9, borderRadius: 5, backgroundColor: '#E6ECEF', overflow: 'hidden', marginTop: 15 },
  seekProgress: { height: 9, backgroundColor: C.accent },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  playButton: { minWidth: 74, paddingHorizontal: 11, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: C.accent },
  playText: { color: '#FFFFFF', fontSize: 8, fontWeight: '900' },
  rateRow: { flexDirection: 'row', gap: 4 },
  rate: { paddingHorizontal: 9, paddingVertical: 8, backgroundColor: '#F0F3F5', borderRadius: 8 },
  rateActive: { backgroundColor: '#EAF4F1' },
  rateText: { color: C.muted, fontSize: 8, fontWeight: '800' },
  rateTextActive: { color: C.accent },
  timelineText: { color: C.muted, fontSize: 8, marginLeft: 'auto' },
  chart: { height: 104, flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12 },
  barSlot: { flex: 1, height: 90, justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: C.blue, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  chartCaption: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  chartText: { color: C.muted, fontSize: 7, fontWeight: '800' },
  gapNote: { color: C.muted, fontSize: 9, lineHeight: 14, marginTop: 9 },
  exportRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  exportButton: { flex: 1, minWidth: 80, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: '#FFFFFF' },
  exportText: { color: C.text, fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  deleteButton: { minHeight: 42, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#F0D2CE', backgroundColor: '#FFF3F1' },
  deleteText: { color: C.red, fontSize: 8, fontWeight: '900' },
  disabled: { opacity: 0.45 },
});
