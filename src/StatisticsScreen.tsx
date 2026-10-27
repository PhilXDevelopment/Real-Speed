import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Trip } from './database';

const C = { panel: '#FFFFFF', line: '#E1E8EB', text: '#17252E', muted: '#6C7B84', accent: '#087F72', blue: '#3479C5' };

type SpeedUnit = 'km/h' | 'mph';

export function StatisticsScreen({ trips, unit, onBack }: { trips: Trip[]; unit: SpeedUnit; onBack: () => void }) {
  const completed = useMemo(() => trips.filter((trip) => trip.status === 'complete'), [trips]);
  const totalDistance = completed.reduce((sum, trip) => sum + trip.distance_m, 0);
  const totalDuration = completed.reduce(
    (sum, trip) => sum + Math.max(0, (trip.ended_at ?? trip.started_at) - trip.started_at - trip.paused_duration_ms),
    0
  );
  const modeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    completed.forEach((trip) => counts.set(trip.mode, (counts.get(trip.mode) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [completed]);
  const distanceBars = completed.slice(0, 12).reverse();
  const longest = Math.max(1, ...distanceBars.map((trip) => trip.distance_m));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.heading}>
        <Pressable onPress={onBack} style={styles.back}><Text style={styles.backText}>‹  TRIPS</Text></Pressable>
        <View>
          <Text style={styles.eyebrow}>LOCAL DATA ONLY</Text>
          <Text style={styles.title}>Ride statistics</Text>
        </View>
      </View>
      <View style={styles.summaryRow}>
        <Metric label="COMPLETED TRIPS" value={String(completed.length)} />
        <Metric label="TOTAL DISTANCE" value={unit === 'km/h' ? `${(totalDistance / 1000).toFixed(1)} km` : `${(totalDistance * 0.000621371).toFixed(1)} mi`} />
        <Metric label="TIME RECORDING" value={`${(totalDuration / 3_600_000).toFixed(1)} h`} />
      </View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Trip distance · most recent 12 ({unit === 'km/h' ? 'km' : 'mi'})</Text>
        {distanceBars.length ? (
          <View style={styles.chart}>
            {distanceBars.map((trip) => (
              <View key={trip.id} style={styles.barColumn}>
                <Text style={styles.barValue}>{(trip.distance_m * (unit === 'km/h' ? 0.001 : 0.000621371)).toFixed(1)}</Text>
                <View style={[styles.bar, { height: Math.max(5, (trip.distance_m / longest) * 100) }]} />
                <Text style={styles.barLabel}>{new Date(trip.started_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.empty}>Complete recorded trips to see distance history.</Text>
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Trips by mode</Text>
        {modeCounts.length ? modeCounts.map(([mode, count]) => (
          <View key={mode} style={styles.modeRow}>
            <Text style={styles.modeName}>{mode.toUpperCase()}</Text>
            <View style={styles.modeTrack}>
              <View style={[styles.modeFill, { width: `${(count / completed.length) * 100}%` }]} />
            </View>
            <Text style={styles.modeCount}>{count}</Text>
          </View>
        )) : <Text style={styles.empty}>No completed trips yet.</Text>}
      </View>
      <Text style={styles.disclaimer}>
        Totals use locally recorded GPS data and may undercount where fixes were rejected or unavailable. They are not odometer-grade measurements.
      </Text>
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
  container: { padding: 15, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingBottom: 30 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 13 },
  back: { backgroundColor: '#EAF4F1', padding: 9, borderRadius: 10 },
  backText: { color: C.accent, fontSize: 9, fontWeight: '900' },
  eyebrow: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1.1 },
  title: { color: C.text, fontSize: 18, fontWeight: '800', marginTop: 3 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: C.line },
  metric: { width: '33.33%', minWidth: 100, padding: 10, backgroundColor: '#F8FAFB', borderRightColor: C.line, borderRightWidth: 1 },
  metricLabel: { color: C.muted, fontSize: 7, fontWeight: '800' },
  metricValue: { color: C.accent, fontSize: 15, fontWeight: '800', marginTop: 7 },
  card: { backgroundColor: '#FBFCFD', borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 13, marginBottom: 10 },
  sectionTitle: { color: C.text, fontSize: 11, fontWeight: '800' },
  chart: { height: 145, flexDirection: 'row', alignItems: 'flex-end', gap: 5, paddingTop: 12 },
  barColumn: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', gap: 3 },
  barValue: { color: C.muted, fontSize: 7 },
  bar: { width: '70%', backgroundColor: C.blue, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  barLabel: { color: C.muted, fontSize: 6 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  modeName: { color: C.muted, fontSize: 8, width: 65, fontWeight: '800' },
  modeTrack: { height: 6, backgroundColor: '#E6ECEF', flex: 1, borderRadius: 3, overflow: 'hidden' },
  modeFill: { height: 6, backgroundColor: C.accent },
  modeCount: { color: C.text, fontSize: 9, width: 18, textAlign: 'right' },
  empty: { color: C.muted, fontSize: 10, paddingVertical: 14 },
  disclaimer: { color: C.muted, fontSize: 9, lineHeight: 14, marginTop: 2 },
});
