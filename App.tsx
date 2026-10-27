import './src/locationTask';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  PermissionsAndroid,
  Pressable,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { Camera, GeoJSONSource, Layer, Map as MapView, Marker } from '@maplibre/maplibre-react-native';
import {
  createTrip,
  getActiveTrip,
  getAppSetting,
  getBackgroundError,
  getTrip,
  getTripPoints,
  getTrips,
  markTripInterrupted,
  pauseTrip,
  deleteTrip,
  resumeTrip,
  setTripStatus,
  setAppSetting,
  Trip,
  TripPoint
} from './src/database';
import { LOCATION_TASK_NAME } from './src/locationTask';
import {
  defaultCalibrationPercentForMode,
  getSpeedFromGpsFix,
  isSignificantGpsMovement,
  maximumSpeedForMode,
  metersPerSecondToKmh
} from './src/domain';
import { formatDistance } from './src/distanceFormat';
import { OfflineCoverageStatus, OfflineMapsScreen } from './src/OfflineMapsScreen';
import { TripDetailScreen } from './src/TripDetailScreen';
import { StatisticsScreen } from './src/StatisticsScreen';
import { dismissTripNotification, updateTripNotification } from './src/tripNotification';

type Mode = 'walking' | 'bicycle' | 'motorcycle' | 'car' | 'train' | 'airplane' | 'other';
type Screen = 'dashboard' | 'drive' | 'map' | 'trips' | 'stats' | 'detail' | 'settings';
type SpeedUnit = 'km/h' | 'mph';
type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

type LiveLocation = {
  latitude: number;
  longitude: number;
  speedMps: number | null;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  timestamp: number;
};

const MODES: { id: Mode; label: string; icon: IconName }[] = [
  { id: 'walking', label: 'WALK', icon: 'walk' },
  { id: 'bicycle', label: 'BIKE', icon: 'bike' },
  { id: 'motorcycle', label: 'MOTO', icon: 'motorbike' },
  { id: 'car', label: 'CAR', icon: 'car' },
  { id: 'train', label: 'TRAIN', icon: 'train' },
  { id: 'airplane', label: 'AIR', icon: 'airplane' },
  { id: 'other', label: 'OTHER', icon: 'dots-horizontal-circle-outline' }
];

const MAP_STYLE_URL: string | null =
  Constants.expoConfig?.extra?.mapStyleUrl || 'https://tiles.openfreemap.org/styles/liberty';
const MAP_ATTRIBUTION: string =
  Constants.expoConfig?.extra?.mapAttribution || '© OpenFreeMap · © OpenStreetMap contributors';
const C = {
  bg: '#F3F6F7',
  panel: '#FFFFFF',
  panelRaised: '#F8FAFB',
  line: '#E1E8EB',
  text: '#17252E',
  muted: '#6C7B84',
  accent: '#087F72',
  blue: '#3479C5',
  amber: '#9A6500',
  red: '#C44642'
};

function asLiveLocation(location: Location.LocationObject): LiveLocation {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    speedMps: location.coords.speed !== null && location.coords.speed >= 0
      ? location.coords.speed
      : null,
    accuracy: location.coords.accuracy,
    altitude: location.coords.altitude,
    heading: location.coords.heading,
    timestamp: location.timestamp
  };
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function displaySpeed(speedMps: number | null, unit: SpeedUnit): string {
  if (speedMps === null) return '—';
  const speed = unit === 'km/h' ? metersPerSecondToKmh(speedMps) : speedMps * 2.236936;
  return String(Math.max(0, Math.round(speed)));
}

function prettyMode(mode: string): string {
  return MODES.find((item) => item.id === mode)?.label ?? mode.toUpperCase();
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricValueRow}>
        <Text style={styles.metricValue}>{value}</Text>
        {unit ? <Text style={styles.metricUnit}>{unit}</Text> : null}
      </View>
    </View>
  );
}

function ActionButton({
  label,
  mark,
  kind,
  onPress,
  disabled = false
}: {
  label: string;
  mark: IconName;
  kind: 'primary' | 'secondary' | 'danger';
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        kind === 'primary' && styles.actionPrimary,
        kind === 'secondary' && styles.actionSecondary,
        kind === 'danger' && styles.actionDanger,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed
      ]}
    >
      <MaterialCommunityIcons
        name={mark}
        size={17}
        color={kind === 'primary' ? '#FFFFFF' : kind === 'danger' ? C.red : C.text}
      />
      <Text style={[styles.actionLabel, kind === 'primary' && styles.actionLabelDark]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const isWide = width >= 760;
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [mapView, setMapView] = useState<'live' | 'offline'>('live');
  const [mode, setMode] = useState<Mode>('motorcycle');
  const [unit, setUnit] = useState<SpeedUnit>('km/h');
  const [calibrationPercent, setCalibrationPercent] = useState(0);
  const [autoFollowMap, setAutoFollowMap] = useState(true);
  const [showRoute, setShowRoute] = useState(true);
  const [mapZoom, setMapZoom] = useState(15);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripPoints, setTripPoints] = useState<TripPoint[]>([]);
  const [location, setLocation] = useState<LiveLocation | null>(null);
  const [smoothedSpeed, setSmoothedSpeed] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<TripPoint[]>([]);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const watchStartRef = useRef<Promise<void> | null>(null);
  const previousSpeedRef = useRef<number | null>(null);
  const lastSpeedMeasurementAtRef = useRef<number | null>(null);
  const previousFixRef = useRef<LiveLocation | null>(null);
  const speedDistanceAnchorRef = useRef<LiveLocation | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const loadData = useCallback(async () => {
    const [savedTrips, active, taskError] = await Promise.all([
      getTrips(),
      getActiveTrip(),
      getBackgroundError()
    ]);
    setTrips(savedTrips);
    setBackgroundError(taskError);
    if (active?.status === 'recording') {
      const tracking = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (!tracking) {
        await markTripInterrupted(active.id);
        setTrip({ ...active, status: 'interrupted' });
      } else {
        setTrip(active);
      }
    } else {
      setTrip(active);
    }
  }, []);

  const reportMessage = useCallback((text: string) => setMessage(text), []);
  const savePreference = useCallback((key: string, value: string) => {
    void setAppSetting(key, value).catch((error: unknown) => {
      setMessage(`Could not save ${key.replaceAll('_', ' ')}: ${String(error)}`);
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    loadData()
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        setMessage(`Local trip storage could not be opened: ${detail}`);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadData]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      getAppSetting('speed_unit'),
      getAppSetting('speed_calibration_percent'),
      getAppSetting('map_auto_follow'),
      getAppSetting('map_show_route'),
      getAppSetting('map_zoom')
    ]).then(([savedUnit, savedCalibration, savedAutoFollow, savedShowRoute, savedZoom]) => {
      if (!mounted) return;
      if (savedUnit === 'mph') setUnit('mph');
      const calibration = Number(savedCalibration);
      if (Number.isFinite(calibration)) {
        setCalibrationPercent(Math.max(-10, Math.min(10, calibration)));
      } else {
        setCalibrationPercent(defaultCalibrationPercentForMode(mode));
      }
      if (savedAutoFollow === 'false') setAutoFollowMap(false);
      if (savedShowRoute === 'false') setShowRoute(false);
      const zoom = Number(savedZoom);
      if (Number.isFinite(zoom)) setMapZoom(Math.max(10, Math.min(18, zoom)));
      setSettingsLoaded(true);
    }).catch((error: unknown) => {
      if (mounted) setMessage(`Could not load saved display settings: ${String(error)}`);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (settingsLoaded) savePreference('speed_unit', unit);
  }, [savePreference, settingsLoaded, unit]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const autoCalibration = defaultCalibrationPercentForMode(mode);
    setCalibrationPercent(autoCalibration);
    savePreference('speed_calibration_percent', String(autoCalibration));
  }, [mode, savePreference, settingsLoaded]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!trip) {
      setTripPoints([]);
      return;
    }
    let mounted = true;
    const refreshRoute = () => {
      void getTripPoints(trip.id)
        .then((points) => {
          if (mounted) setTripPoints(points);
        })
        .catch((error: unknown) => {
          if (mounted) setMessage(`Could not load trip route: ${String(error)}`);
        });
    };
    refreshRoute();
    if (trip.status !== 'recording') return () => { mounted = false; };
    const refresh = setInterval(() => {
      Promise.all([getTrip(trip.id), getTripPoints(trip.id)])
        .then(([latest, points]) => {
          if (latest) setTrip(latest);
          if (mounted) setTripPoints(points);
        })
        .catch((error: unknown) => {
          setMessage(`Could not refresh live trip statistics: ${String(error)}`);
        });
    }, 10_000);
    return () => {
      mounted = false;
      clearInterval(refresh);
    };
  }, [trip?.id, trip?.status]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasBackgrounded = (appStateRef.current ?? 'active').match(/inactive|background/);
      appStateRef.current = nextState;
      setAppForeground(nextState === 'active');
      if (wasBackgrounded && nextState === 'active') {
        loadData().catch((error: unknown) => {
          setMessage(`Could not refresh saved trip data: ${String(error)}`);
        });
      }
    });
    return () => subscription.remove();
  }, [loadData]);

  useEffect(() => () => watchRef.current?.remove(), []);

  useEffect(() => {
    if (screen !== 'map') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setScreen('drive');
      setMapView('live');
      return true;
    });
    return () => subscription.remove();
  }, [screen]);

  const startLiveWatch = useCallback(async (maximumSpeedMps = 100) => {
    if (watchRef.current) return;
    if (watchStartRef.current) return watchStartRef.current;
    const start = (async () => {
      previousFixRef.current = null;
      speedDistanceAnchorRef.current = null;
      previousSpeedRef.current = null;
      lastSpeedMeasurementAtRef.current = null;
      const subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 1,
          mayShowUserSettingsDialog: true
        },
        (position) => {
          const next = asLiveLocation(position);
          setLocation(next);
          const previousFix = previousFixRef.current;
          previousFixRef.current = next;
          const distanceAnchor = speedDistanceAnchorRef.current;
          const hasConfirmedMovement = distanceAnchor !== null &&
            isSignificantGpsMovement(distanceAnchor, next);
          const measuredSpeed = getSpeedFromGpsFix(
            previousFix,
            next,
            maximumSpeedMps,
            distanceAnchor
          );
          if (measuredSpeed !== null) {
            lastSpeedMeasurementAtRef.current = next.timestamp;
          }
          if (
            measuredSpeed !== null ||
            distanceAnchor === null ||
            distanceAnchor.accuracy === null ||
            distanceAnchor.accuracy > 25 ||
            next.accuracy === null ||
            next.accuracy > 25 ||
            next.timestamp - distanceAnchor.timestamp > 120_000
          ) {
            speedDistanceAnchorRef.current = next;
          }
          if (measuredSpeed === null) {
            const lastMeasurementAt = lastSpeedMeasurementAtRef.current;
            if (
              lastMeasurementAt !== null &&
              next.timestamp - lastMeasurementAt <= 5_000
            ) {
              return;
            }
            if (
              next.accuracy !== null &&
              next.accuracy <= 25 &&
              !hasConfirmedMovement
            ) {
              previousSpeedRef.current = 0;
              setSmoothedSpeed(0);
              return;
            }
            previousSpeedRef.current = null;
            setSmoothedSpeed(null);
            return;
          }
          if (measuredSpeed === 0) {
            previousSpeedRef.current = 0;
            setSmoothedSpeed(0);
            return;
          }
          const previous = previousSpeedRef.current;
          const smoothed = previous === null || previous === 0
            ? measuredSpeed
            : previous * 0.72 + measuredSpeed * 0.28;
          previousSpeedRef.current = smoothed;
          setSmoothedSpeed(smoothed);
        }
      );
      if (watchRef.current) subscription.remove();
      else watchRef.current = subscription;
    })();
    watchStartRef.current = start;
    try {
      await start;
    } finally {
      if (watchStartRef.current === start) watchStartRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!appForeground || (screen !== 'dashboard' && screen !== 'drive' && screen !== 'map')) {
      watchRef.current?.remove();
      watchRef.current = null;
      return;
    }
    let active = true;
    void (async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted || !(await Location.hasServicesEnabledAsync())) return;
      await startLiveWatch(maximumSpeedForMode(mode));
      if (!active) {
        watchRef.current?.remove();
        watchRef.current = null;
      }
    })().catch((error: unknown) => {
      if (active) setMessage(`Foreground GPS could not start: ${String(error)}`);
    });
    return () => {
      active = false;
      watchRef.current?.remove();
      watchRef.current = null;
    };
  }, [appForeground, mode, screen, startLiveWatch]);

  const startBackgroundService = useCallback(async () => {
    const serviceRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (serviceRunning) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: 2,
      deferredUpdatesInterval: 0,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'RealSpeed GPS service',
        notificationBody: 'Background GPS is active. Live ride details are shown in the trip notification.',
        notificationColor: C.accent,
        killServiceOnDestroy: false
      }
    });
  }, []);

  const beginTrip = useCallback(async () => {
    setMessage(null);
    let freshTrip: Trip | null = null;
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (!foreground.granted) {
        setMessage('Location permission is required. Enable it in Android Settings, then try again.');
        return;
      }
      const background = await Location.requestBackgroundPermissionsAsync();
      if (!background.granted) {
        setMessage(
          'Background location was not allowed. Recording can start, but Android may pause GPS when RealSpeed is not visible.'
        );
      }
      let notificationsAllowed = true;
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        notificationsAllowed = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        ) === PermissionsAndroid.RESULTS.GRANTED;
      }
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setMessage('Turn on Location services in device settings before starting a trip.');
        return;
      }
      freshTrip = await createTrip(mode);
      setTrip(freshTrip);
      await startBackgroundService();
      await startLiveWatch(maximumSpeedForMode(mode));
      await loadData();
      const warnings = [
        !background.granted ? 'Background location was not allowed, so tracking may stop when the app is hidden.' : null,
        !notificationsAllowed ? 'Notification permission was denied, so live ride details may not appear in the notification shade.' : null
      ].filter((warning): warning is string => warning !== null);
      setMessage(warnings.length ? warnings.join(' ') : null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const cleanupFailures: string[] = [];
      if (freshTrip) {
        try {
          if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
            await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
          }
        } catch (cleanupError) {
          cleanupFailures.push(`location service cleanup failed: ${String(cleanupError)}`);
        }
        try {
          await setTripStatus(freshTrip.id, 'interrupted');
        } catch (cleanupError) {
          cleanupFailures.push(`trip recovery state could not be saved: ${String(cleanupError)}`);
        }
      }
      setMessage(
        `Could not start GPS recording: ${detail}${cleanupFailures.length ? `; ${cleanupFailures.join('; ')}` : ''}`
      );
      await loadData();
    }
  }, [loadData, mode, startBackgroundService, startLiveWatch]);

  const pauseCurrentTrip = useCallback(async () => {
    if (!trip) return;
    setMessage(null);
    try {
      await pauseTrip(trip.id);
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
      await loadData();
    } catch (error) {
      setMessage(`Could not pause recording cleanly: ${String(error)}`);
      await loadData();
    }
  }, [loadData, trip]);

  const resumeCurrentTrip = useCallback(async () => {
    if (!trip) return;
    setMessage(null);
    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) {
        setMessage('Location permission is required to resume. Enable it in device Settings.');
        return;
      }
      await resumeTrip(trip.id);
      await startBackgroundService();
      await startLiveWatch(maximumSpeedForMode(trip.mode));
      await loadData();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(`Could not resume this trip: ${detail}`);
      await loadData();
    }
  }, [loadData, startBackgroundService, startLiveWatch, trip]);

  const finishCurrentTrip = useCallback(async () => {
    if (!trip) return;
    Alert.alert('Finish trip?', 'This saves the trip locally on this device.', [
      { text: 'Keep recording', style: 'cancel' },
      {
        text: 'Finish',
        onPress: () => {
          void (async () => {
            try {
              await setTripStatus(trip.id, 'complete');
              if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
                await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
              }
              setTrip(null);
              await loadData();
              setMessage('Trip saved on this device.');
            } catch (error) {
              setMessage(`Could not finish the trip: ${String(error)}`);
              await loadData();
            }
          })();
        }
      }
    ]);
  }, [loadData, trip]);

  const openTripDetails = useCallback(async (item: Trip) => {
    setMessage(null);
    try {
      setSelectedTrip(item);
      setSelectedPoints(await getTripPoints(item.id));
      setScreen('detail');
    } catch (error) {
      setMessage(`Could not load trip details: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const freshnessSeconds = location ? Math.max(0, (now - location.timestamp) / 1000) : Infinity;
  const gpsState = !location || freshnessSeconds > 10
    ? 'NO GPS'
    : location.accuracy !== null && location.accuracy <= 15
      ? 'GPS GOOD'
      : location.accuracy !== null && location.accuracy <= 50
        ? 'GPS FAIR'
        : 'GPS WEAK';
  const gpsColor = gpsState === 'GPS GOOD' ? C.accent : gpsState === 'GPS FAIR' ? C.amber : C.red;
  const currentSpeed = freshnessSeconds <= 10 && smoothedSpeed !== null
    ? Math.max(0, smoothedSpeed * (1 + calibrationPercent / 100))
    : null;
  const speed = useMemo(() => displaySpeed(currentSpeed, unit), [currentSpeed, unit]);
  const routeData = useMemo<GeoJSON.FeatureCollection<GeoJSON.MultiLineString>>(() => {
    const segments = new Map<number, [number, number][]>();
    for (const point of tripPoints) {
      const coordinates = segments.get(point.segment) ?? [];
      coordinates.push([point.longitude, point.latitude]);
      segments.set(point.segment, coordinates);
    }
    const lines = [...segments.values()].filter((coordinates) => coordinates.length > 1);
    return {
      type: 'FeatureCollection',
      features: lines.length > 0
        ? [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiLineString', coordinates: lines }
          }]
        : []
    };
  }, [tripPoints]);
  const activeDuration = trip
    ? now - trip.started_at - trip.paused_duration_ms -
      ((trip.status === 'paused' || trip.status === 'interrupted') && trip.paused_at
        ? now - trip.paused_at
        : 0)
    : 0;
  const completedCount = trips.filter((item) => item.status === 'complete').length;
  const activeNavigation = screen === 'detail' || screen === 'stats'
    ? 'trips'
    : screen === 'map'
      ? 'drive'
      : screen;

  useEffect(() => {
    if (loading) return;
    if (!trip) {
      try {
        dismissTripNotification();
      } catch (error) {
        setMessage(`Could not dismiss the live trip notification: ${String(error)}`);
      }
      return;
    }
    try {
      updateTripNotification(trip, currentSpeed, unit, now);
    } catch (error) {
      setMessage(`Could not update the live trip notification: ${String(error)}`);
    }
  }, [currentSpeed, loading, now, trip?.id, trip?.mode, trip?.paused_at, trip?.paused_duration_ms, trip?.started_at, trip?.status, unit]);

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <StatusBar barStyle="dark-content" />
        <ActivityIndicator color={C.accent} size="large" />
        <Text style={styles.loadingText}>Preparing local dashboard…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.app}>
        <View style={styles.topBar}>
          <View style={styles.brand}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>R</Text></View>
            <View>
              <Text style={styles.brandName}>REAL<Text style={styles.brandNameAccent}>SPEED</Text></Text>
              <Text style={styles.brandSub}>GPS SPEED TRACKER</Text>
            </View>
          </View>
          <View style={styles.topRight}>
            {width >= 390 ? (
              <View style={styles.localPill}>
                <MaterialCommunityIcons name="database-outline" size={13} color={C.accent} />
                <Text style={styles.localText}>ON DEVICE</Text>
              </View>
            ) : null}
            <View style={[styles.gpsPill, { borderColor: `${gpsColor}55` }]}>
              <MaterialCommunityIcons name="crosshairs-gps" size={14} color={gpsColor} />
              <Text style={[styles.gpsText, { color: gpsColor }]}>{gpsState}</Text>
            </View>
          </View>
        </View>

        <View style={styles.body}>
          <View style={styles.content}>
            {screen === 'dashboard' && (
              <ScrollView contentContainerStyle={styles.homeScroll} showsVerticalScrollIndicator={false}>
                <View style={styles.homeHeading}>
                  <Text style={styles.eyebrow}>YOUR DRIVE, AT A GLANCE</Text>
                  <Text style={styles.homeTitle}>Dashboard</Text>
                  <Text style={styles.homeSubtitle}>Your speed and trips, all in one place.</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open speedometer"
                  onPress={() => setScreen('drive')}
                  style={({ pressed }) => [styles.homeSpeedCard, pressed && styles.actionPressed]}
                >
                  <View style={styles.homeSpeedTop}>
                    <View>
                      <Text style={styles.homeSpeedLabel}>LIVE SPEED</Text>
                      <View style={styles.homeSpeedValueRow}>
                        <Text style={styles.homeSpeedValue}>{speed}</Text>
                        <Text style={styles.homeSpeedUnit}>{unit}</Text>
                      </View>
                    </View>
                    <View style={styles.homeSpeedIcon}>
                      <MaterialCommunityIcons name="speedometer" size={24} color={C.accent} />
                    </View>
                  </View>
                  <View style={styles.homeGpsStatus}>
                    <View style={[styles.signalDot, { backgroundColor: gpsColor }]} />
                    <Text style={[styles.homeGpsText, { color: gpsColor }]}>{gpsState}</Text>
                    <Text style={styles.homeGpsHint}>
                      {location?.accuracy != null ? `±${Math.round(location.accuracy)} m accuracy` : 'Waiting for GPS signal'}
                    </Text>
                  </View>
                </Pressable>

                <View style={styles.homeStatsRow}>
                  <View style={styles.homeStatCard}>
                    <Text style={styles.homeStatLabel}>TRIPS SAVED</Text>
                    <Text style={styles.homeStatValue}>{completedCount}</Text>
                    <Text style={styles.homeStatHint}>On this device</Text>
                  </View>
                  <View style={styles.homeStatCard}>
                    <Text style={styles.homeStatLabel}>CURRENT TRIP</Text>
                    <Text style={styles.homeStatValue}>{trip ? formatDistance(trip.distance_m, unit) : '—'}</Text>
                    <Text style={styles.homeStatHint}>{trip ? trip.status.toUpperCase() : 'Not recording'}</Text>
                  </View>
                </View>

                <View style={styles.homeSectionHeading}>
                  <Text style={styles.homeSectionTitle}>Quick actions</Text>
                </View>
                <View style={styles.homeActions}>
                  <ActionButton label="OPEN SPEEDOMETER" mark="speedometer" kind="primary" onPress={() => setScreen('drive')} />
                  {!trip ? (
                    <ActionButton label="START A TRIP" mark="play" kind="secondary" onPress={() => { setScreen('drive'); void beginTrip(); }} />
                  ) : (
                    <ActionButton label="CONTINUE TRIP" mark="arrow-right" kind="secondary" onPress={() => setScreen('drive')} />
                  )}
                </View>

                <View style={styles.homeSectionHeading}>
                  <Text style={styles.homeSectionTitle}>Recent trip</Text>
                  {trips.length > 0 ? (
                    <Pressable onPress={() => setScreen('trips')} accessibilityRole="button">
                      <Text style={styles.homeLink}>See history</Text>
                    </Pressable>
                  ) : null}
                </View>
                {trips[0] ? (
                  <Pressable
                    onPress={() => void openTripDetails(trips[0])}
                    accessibilityRole="button"
                    style={styles.homeRecentCard}
                  >
                    <View style={styles.homeRecentIcon}>
                      <MaterialCommunityIcons name="map-marker-path" size={20} color={C.accent} />
                    </View>
                    <View style={styles.homeRecentInfo}>
                      <Text style={styles.homeRecentMode}>{prettyMode(trips[0].mode)} · {trips[0].status.toUpperCase()}</Text>
                      <Text style={styles.homeRecentDate}>{new Date(trips[0].started_at).toLocaleDateString()}</Text>
                    </View>
                    <Text style={styles.homeRecentDistance}>{formatDistance(trips[0].distance_m, unit)}</Text>
                  </Pressable>
                ) : (
                  <View style={styles.homeRecentCard}>
                    <Text style={styles.homeEmptyText}>Your saved trips will appear here.</Text>
                  </View>
                )}
                {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}
                {backgroundError ? (
                  <Notice
                    message={`Background GPS reported an error: ${backgroundError}`}
                    onDismiss={() => setBackgroundError(null)}
                    warning
                  />
                ) : null}
              </ScrollView>
            )}

            {screen === 'drive' && (
              <ScrollView contentContainerStyle={styles.screenScroll} showsVerticalScrollIndicator={false}>
                <View style={[styles.dashboard, isWide && styles.dashboardWide]}>
                  <View style={[styles.speedPanel, isWide && styles.speedPanelWide]}>
                    <View style={styles.panelHeading}>
                      <View>
                        <Text style={styles.eyebrow}>LIVE TELEMETRY</Text>
                        <Text style={styles.panelTitle}>Speedometer</Text>
                      </View>
                      <View style={styles.speedPanelActions}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Open route map"
                          onPress={() => { setMapView('live'); setScreen('map'); }}
                          style={styles.mapViewButton}
                        >
                          <MaterialCommunityIcons name="map-outline" size={16} color={C.accent} />
                          <Text style={styles.mapViewButtonText}>MAP VIEW</Text>
                        </Pressable>
                        <View style={[styles.recordPill, trip?.status === 'recording' && styles.recordPillLive]}>
                          <View style={[styles.recordDot, trip?.status === 'recording' && styles.recordDotLive]} />
                          <Text style={[styles.recordText, trip?.status === 'recording' && styles.recordTextLive]}>
                            {trip?.status === 'recording' ? 'RECORDING' : trip?.status === 'paused' ? 'PAUSED' : trip?.status === 'interrupted' ? 'RECOVERED' : 'STANDBY'}
                          </Text>
                        </View>
                      </View>
                    </View>

                    <View style={styles.gaugeArea}>
                      <View style={styles.gaugeOuter}>
                        <View style={styles.gaugeInner}>
                          <Text style={[styles.speedDigits, speed === '—' && styles.noSpeed]}>{speed}</Text>
                          <Text style={styles.speedUnit}>{unit}</Text>
                        </View>
                      </View>
                      <View style={styles.gaugeCaption}>
                        <View style={styles.captionLine} />
                        <Text style={styles.captionText}>
                          {currentSpeed === null ? 'WAITING FOR GPS FIX' : 'GPS SPEED · FILTERED DISPLAY'}
                        </Text>
                        <View style={styles.captionLine} />
                      </View>
                    </View>

                    <View style={styles.telemetryGrid}>
                      <Metric label="TRIP DISTANCE" value={trip ? formatDistance(trip.distance_m, unit) : '—'} />
                      <Metric label="ELAPSED" value={trip ? formatDuration(activeDuration) : '—'} />
                      <Metric
                        label="MAX SPEED"
                        value={trip ? displaySpeed(trip.max_speed_mps, unit) : '—'}
                        unit={trip ? unit : undefined}
                      />
                      <Metric
                        label="GPS ACCURACY"
                        value={location?.accuracy === null || location?.accuracy === undefined ? '—' : `${Math.round(location.accuracy)}`}
                        unit={location?.accuracy == null ? undefined : 'm'}
                      />
                    </View>
                  </View>

                  <View style={styles.controlColumn}>
                    <View style={styles.modeCard}>
                      <Text style={styles.eyebrow}>TRANSPORT MODE</Text>
                      <Text style={styles.smallCardTitle}>Choose your ride</Text>
                      <View style={styles.modeGrid}>
                        {MODES.map((item) => (
                          <Pressable
                            key={item.id}
                            onPress={() => !trip && setMode(item.id)}
                            disabled={Boolean(trip)}
                            style={[
                              styles.modeButton,
                              mode === item.id && styles.modeButtonActive,
                              Boolean(trip) && styles.modeButtonLocked
                            ]}
                          >
                            <MaterialCommunityIcons
                              name={item.icon}
                              size={21}
                              color={mode === item.id ? C.accent : C.muted}
                            />
                            <Text style={[styles.modeLabel, mode === item.id && styles.modeLabelActive]}>{item.label}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>

                    <View style={styles.controlCard}>
                      <View style={styles.controlHeader}>
                        <View>
                          <Text style={styles.eyebrow}>TRIP CONTROL</Text>
                          <Text style={styles.smallCardTitle}>{trip ? prettyMode(trip.mode) : 'Ready when you are'}</Text>
                        </View>
                        <Text style={styles.localBadge}>ON DEVICE</Text>
                      </View>
                      {!trip ? (
                        <ActionButton label="START TRIP" mark="play" kind="primary" onPress={() => void beginTrip()} />
                      ) : trip.status === 'recording' ? (
                        <View style={styles.buttonRow}>
                          <ActionButton label="PAUSE RIDE" mark="pause" kind="secondary" onPress={() => void pauseCurrentTrip()} />
                          <ActionButton label="FINISH" mark="stop" kind="danger" onPress={() => void finishCurrentTrip()} />
                        </View>
                      ) : (
                        <View style={styles.buttonRow}>
                          <ActionButton
                            label="RESUME RIDE"
                            mark="play"
                            kind="primary"
                            onPress={() => void resumeCurrentTrip()}
                          />
                          <ActionButton label="FINISH" mark="stop" kind="danger" onPress={() => void finishCurrentTrip()} />
                        </View>
                      )}
                      <Text style={styles.controlFootnote}>
                        {trip ? 'GPS points are saved locally as they arrive.' : 'No trip is recorded until you press start.'}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={styles.statusStrip}>
                  <MaterialCommunityIcons name="crosshairs-gps" size={17} color={gpsColor} />
                  <Text style={styles.statusStripValue}>{gpsState}</Text>
                  <View style={styles.statusDivider} />
                  <Text style={styles.statusStripLabel}>LAST FIX</Text>
                  <Text style={styles.statusStripValue}>{location ? `${Math.floor(freshnessSeconds)}s ago` : '—'}</Text>
                  <View style={styles.statusDivider} />
                  <MaterialCommunityIcons name="history" size={16} color={C.muted} />
                  <Text style={styles.statusStripLabel}>SAVED</Text>
                  <Text style={styles.statusStripValue}>{completedCount}</Text>
                </View>
                {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}
                {backgroundError ? (
                  <Notice
                    message={`Background GPS reported an error: ${backgroundError}`}
                    onDismiss={() => setBackgroundError(null)}
                    warning
                  />
                ) : null}
              </ScrollView>
            )}

            {screen === 'map' && (
              mapView === 'offline' ? (
                <View style={styles.mapScreen}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Back to speedometer"
                    onPress={() => { setMapView('live'); setScreen('drive'); }}
                    style={styles.mapBackButton}
                  >
                    <MaterialCommunityIcons name="arrow-left" size={18} color={C.text} />
                    <Text style={styles.mapBackText}>SPEEDOMETER</Text>
                  </Pressable>
                  <View style={styles.mapTabs}>
                    <Pressable onPress={() => setMapView('live')} style={styles.mapTab}>
                      <MaterialCommunityIcons name="map-marker" size={15} color={C.muted} />
                      <Text style={styles.mapTabText}>LIVE MAP</Text>
                    </Pressable>
                    <View style={[styles.mapTab, styles.mapTabActive]}><Text style={styles.mapTabTextActive}>OFFLINE REGIONS</Text></View>
                  </View>
                  <OfflineMapsScreen styleUrl={MAP_STYLE_URL} attribution={MAP_ATTRIBUTION} />
                </View>
              ) : (
              <View style={styles.mapScreen}>
                <View style={styles.panelHeading}>
                  <View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Back to speedometer"
                      onPress={() => setScreen('drive')}
                      style={styles.mapBackButton}
                    >
                      <MaterialCommunityIcons name="arrow-left" size={18} color={C.text} />
                      <Text style={styles.mapBackText}>SPEEDOMETER</Text>
                    </Pressable>
                    <Text style={styles.panelTitle}>Route map</Text>
                  </View>
                  <View style={styles.mapHeadingActions}>
                    <Text style={styles.localBadge}>GPS {location ? 'FIXED' : 'WAITING'}</Text>
                    <Pressable onPress={() => setMapView('offline')} style={[styles.mapTab, styles.mapTabActive]}>
                      <MaterialCommunityIcons name="download" size={15} color={C.accent} />
                      <Text style={styles.mapTabTextActive}>OFFLINE MAPS</Text>
                    </Pressable>
                  </View>
                </View>
                {MAP_STYLE_URL ? (
                  <View style={styles.mapFrame}>
                    <MapView
                      style={styles.map}
                      mapStyle={MAP_STYLE_URL}
                      onDidFailLoadingMap={() => setMessage('Map style failed to load. GPS and trip recording are separate and can continue.')}
                      onRegionDidChange={(event) => {
                        if (event.nativeEvent.userInteraction) setAutoFollowMap(false);
                      }}
                    >
                      <Camera
                        center={autoFollowMap && location ? [location.longitude, location.latitude] : undefined}
                        zoom={mapZoom}
                        easing="fly"
                        duration={600}
                      />
                      {showRoute && routeData.features.length > 0 ? (
                        <GeoJSONSource id="live-trip-route" data={routeData}>
                          <Layer
                            id="live-trip-route-line"
                            type="line"
                            source="live-trip-route"
                            paint={{
                              'line-color': C.accent,
                              'line-width': 5,
                              'line-opacity': 0.9
                            }}
                          />
                        </GeoJSONSource>
                      ) : null}
                      {location ? (
                        <Marker
                          id="live-vehicle-marker"
                          lngLat={[location.longitude, location.latitude]}
                        >
                          <View style={styles.vehicleMarker}>
                            <MaterialCommunityIcons
                              name="navigation"
                              size={16}
                              color="#FFFFFF"
                              style={{ transform: [{ rotate: `${location.heading ?? 0}deg` }] }}
                            />
                            <MaterialCommunityIcons
                              name={MODES.find((item) => item.id === (trip?.mode ?? mode))?.icon ?? 'car'}
                              size={21}
                              color="#FFFFFF"
                            />
                          </View>
                        </Marker>
                      ) : null}
                    </MapView>
                    <View style={styles.mapRideInfo} pointerEvents="none">
                      <View style={styles.mapSpeedSummary}>
                        <Text style={styles.mapSpeedValue}>{speed}</Text>
                        <Text style={styles.mapSpeedUnit}>{unit}</Text>
                      </View>
                      <View style={styles.mapRideDivider} />
                      <View style={styles.mapRideStat}>
                        <MaterialCommunityIcons name="timer-outline" size={16} color={C.muted} />
                        <Text style={styles.mapRideValue}>{trip ? formatDuration(activeDuration) : '00:00'}</Text>
                      </View>
                      <View style={styles.mapRideDivider} />
                      <View style={styles.mapRideStat}>
                        <MaterialCommunityIcons name="map-marker-distance" size={16} color={C.muted} />
                        <Text style={styles.mapRideValue}>{trip ? formatDistance(trip.distance_m, unit) : '—'}</Text>
                      </View>
                    </View>
                    <View style={styles.mapControls}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Zoom in"
                        disabled={mapZoom >= 18}
                        onPress={() => {
                          const nextZoom = Math.min(18, mapZoom + 1);
                          setMapZoom(nextZoom);
                          savePreference('map_zoom', String(nextZoom));
                        }}
                        style={styles.mapControlButton}
                      >
                        <MaterialCommunityIcons name="plus" size={21} color={C.text} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Zoom out"
                        disabled={mapZoom <= 10}
                        onPress={() => {
                          const nextZoom = Math.max(10, mapZoom - 1);
                          setMapZoom(nextZoom);
                          savePreference('map_zoom', String(nextZoom));
                        }}
                        style={styles.mapControlButton}
                      >
                        <MaterialCommunityIcons name="minus" size={21} color={C.text} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Recenter map on current location"
                        onPress={() => setAutoFollowMap(true)}
                        style={[styles.mapControlButton, autoFollowMap && styles.mapControlButtonActive]}
                      >
                        <MaterialCommunityIcons
                          name="crosshairs-gps"
                          size={19}
                          color={autoFollowMap ? C.accent : C.text}
                        />
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={styles.mapUnavailable}>
                    <View style={styles.mapCrosshair}><View /><View /></View>
                    <Text style={styles.mapUnavailableTitle}>MAP IS CURRENTLY UNAVAILABLE</Text>
                    <Text style={styles.mapUnavailableCopy}>
                      GPS recording continues independently. Check your internet connection or try again later.
                    </Text>
                  </View>
                )}

                <View style={styles.mapActionBar}>
                  {!trip ? (
                    <ActionButton label="START" mark="play" kind="primary" onPress={() => void beginTrip()} />
                  ) : trip.status === 'recording' ? (
                    <>
                      <ActionButton label="PAUSE" mark="pause" kind="secondary" onPress={() => void pauseCurrentTrip()} />
                      <ActionButton label="FINISH" mark="stop" kind="danger" onPress={() => void finishCurrentTrip()} />
                    </>
                  ) : (
                    <>
                      <ActionButton label="RESUME" mark="play" kind="primary" onPress={() => void resumeCurrentTrip()} />
                      <ActionButton label="FINISH" mark="stop" kind="danger" onPress={() => void finishCurrentTrip()} />
                    </>
                  )}
                </View>

                <View style={styles.mapFooter}>
                  <Text style={styles.mapFooterText}>{MAP_ATTRIBUTION}</Text>
                  <OfflineCoverageStatus location={location} />
                  <Text style={styles.mapFooterText}>DRAG TO EXPLORE · RECENTER TO FOLLOW YOUR RIDE</Text>
                </View>
                {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}
              </View>
              )
            )}

            {screen === 'trips' && (
              <ScrollView contentContainerStyle={styles.listScreen} showsVerticalScrollIndicator={false}>
                <View style={styles.panelHeading}>
                  <View><Text style={styles.eyebrow}>LOCAL ARCHIVE</Text><Text style={styles.panelTitle}>Trip history</Text></View>
                  <View style={styles.mapHeadingActions}>
                    <Pressable onPress={() => setScreen('stats')} style={styles.mapTab}>
                      <Text style={styles.mapTabText}>STATISTICS</Text>
                    </Pressable>
                    <Text style={styles.localBadge}>{trips.length} SAVED</Text>
                  </View>
                </View>
                {trips.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyMark}>—</Text>
                    <Text style={styles.emptyTitle}>No trips recorded yet</Text>
                      <Text style={styles.emptyCopy}>Start a trip from the Speedometer screen. Your GPS data stays on this device.</Text>
                      <ActionButton label="OPEN SPEEDOMETER" mark="speedometer" kind="secondary" onPress={() => setScreen('drive')} />
                  </View>
                ) : (
                  trips.map((item) => (
                    <Pressable
                      key={item.id}
                      onPress={() => void openTripDetails(item)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${prettyMode(item.mode)} trip from ${new Date(item.started_at).toLocaleString()}`}
                      style={styles.tripCard}
                    >
                      <View style={styles.tripCardTop}>
                        <View>
                          <Text style={styles.tripMode}>{prettyMode(item.mode)} · {item.status.toUpperCase()}</Text>
                          <Text style={styles.tripDate}>{new Date(item.started_at).toLocaleString()}</Text>
                        </View>
                        <Text style={styles.tripDistance}>{formatDistance(item.distance_m, unit)}</Text>
                      </View>
                      <View style={styles.tripMetrics}>
                        <Text style={styles.tripMetric}>MAX {displaySpeed(item.max_speed_mps, unit)} {unit}</Text>
                        <Text style={styles.tripMetric}>{item.last_point_at ? 'GPS POINTS SAVED' : 'NO GPS FIX SAVED'}</Text>
                        <Text style={styles.tripMetric}>ON DEVICE</Text>
                      </View>
                    </Pressable>
                  ))
                )}
                {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}
              </ScrollView>
            )}

            {screen === 'detail' && selectedTrip && (
              <TripDetailScreen
                trip={selectedTrip}
                points={selectedPoints}
                mapStyleUrl={MAP_STYLE_URL}
                unit={unit}
                onBack={() => setScreen('trips')}
                onError={reportMessage}
                onDelete={() => {
                  void deleteTrip(selectedTrip.id)
                    .then(async () => {
                      setSelectedTrip(null);
                      setSelectedPoints([]);
                      setScreen('trips');
                      await loadData();
                    })
                    .catch((error: unknown) => setMessage(`Could not delete trip: ${String(error)}`));
                }}
              />
            )}

            {screen === 'stats' && <StatisticsScreen trips={trips} unit={unit} onBack={() => setScreen('trips')} />}

            {screen === 'settings' && (
              <ScrollView contentContainerStyle={styles.listScreen} showsVerticalScrollIndicator={false}>
                <View style={styles.panelHeading}>
                  <View><Text style={styles.eyebrow}>PREFERENCES & TOOLS</Text><Text style={styles.panelTitle}>Settings</Text></View>
                  <Text style={styles.localBadge}>DEVICE ONLY</Text>
                </View>
                <View style={styles.settingsCard}>
                  <Text style={styles.eyebrow}>MAPS & INSIGHTS</Text>
                  <Text style={styles.smallCardTitle}>Explore your data</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => { setMapView('live'); setScreen('map'); }}
                    style={styles.settingsNavigation}
                  >
                    <MaterialCommunityIcons name="map-outline" size={21} color={C.accent} />
                    <View style={styles.settingsNavigationContent}>
                      <Text style={styles.settingsNavigationTitle}>Live map</Text>
                      <Text style={styles.settingsNavigationCopy}>Follow or freely explore your live route</Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={22} color={C.muted} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => { setMapView('offline'); setScreen('map'); }}
                    style={styles.settingsNavigation}
                  >
                    <MaterialCommunityIcons name="download-outline" size={21} color={C.accent} />
                    <View style={styles.settingsNavigationContent}>
                      <Text style={styles.settingsNavigationTitle}>Offline maps</Text>
                      <Text style={styles.settingsNavigationCopy}>Manage downloaded map regions</Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={22} color={C.muted} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setScreen('stats')}
                    style={[styles.settingsNavigation, styles.settingsNavigationLast]}
                  >
                    <MaterialCommunityIcons name="chart-box-outline" size={21} color={C.accent} />
                    <View style={styles.settingsNavigationContent}>
                      <Text style={styles.settingsNavigationTitle}>Ride statistics</Text>
                      <Text style={styles.settingsNavigationCopy}>Review distance and trip totals</Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={22} color={C.muted} />
                  </Pressable>
                </View>
                <View style={styles.settingsCard}>
                  <Text style={styles.eyebrow}>SPEED DISPLAY</Text>
                  <Text style={styles.smallCardTitle}>Units</Text>
                  <View style={styles.settingChoiceRow}>
                    {(['km/h', 'mph'] as SpeedUnit[]).map((choice) => (
                      <Pressable key={choice} onPress={() => setUnit(choice)} style={[styles.settingChoice, unit === choice && styles.settingChoiceActive]}>
                        <MaterialCommunityIcons
                          name={choice === 'km/h' ? 'speedometer' : 'speedometer-medium'}
                          size={17}
                          color={unit === choice ? C.accent : C.muted}
                        />
                        <Text style={[styles.settingChoiceText, unit === choice && styles.settingChoiceTextActive]}>{choice}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={[styles.settingsCopy, styles.settingsCopyEmphasis]}>Smart speed calibration</Text>
                  <Text style={styles.settingsCopy}>RealSpeed now tunes the display for the selected ride type automatically, so you do not need to do manual calibration.</Text>
                  <View style={styles.calibrationRow}>
                    <Text style={styles.calibrationValue}>{calibrationPercent > 0 ? '+' : ''}{calibrationPercent.toFixed(1)}%</Text>
                    <Text style={styles.settingsCopy}>Auto for {prettyMode(mode)}</Text>
                  </View>
                </View>
                <View style={styles.settingsCard}>
                  <Text style={styles.eyebrow}>MAP VIEW</Text>
                  <Text style={styles.smallCardTitle}>Ride map preferences</Text>
                  <View style={styles.settingsToggleRow}>
                    <View style={styles.settingsToggleCopy}>
                      <Text style={styles.settingsNavigationTitle}>Follow my location</Text>
                      <Text style={styles.settingsNavigationCopy}>Drag the map to explore; tap recenter to resume.</Text>
                    </View>
                    <Switch
                      value={autoFollowMap}
                      onValueChange={(value) => {
                        setAutoFollowMap(value);
                        savePreference('map_auto_follow', String(value));
                      }}
                      trackColor={{ false: C.line, true: '#A8D0C6' }}
                      thumbColor={autoFollowMap ? C.accent : '#F8FAFB'}
                    />
                  </View>
                  <View style={styles.settingsToggleRow}>
                    <View style={styles.settingsToggleCopy}>
                      <Text style={styles.settingsNavigationTitle}>Show recorded route</Text>
                      <Text style={styles.settingsNavigationCopy}>Draw the saved GPS track on the live ride map.</Text>
                    </View>
                    <Switch
                      value={showRoute}
                      onValueChange={(value) => {
                        setShowRoute(value);
                        savePreference('map_show_route', String(value));
                      }}
                      trackColor={{ false: C.line, true: '#A8D0C6' }}
                      thumbColor={showRoute ? C.accent : '#F8FAFB'}
                    />
                  </View>
                  <View style={styles.settingsZoomRow}>
                    <Text style={styles.settingsNavigationTitle}>Default map zoom</Text>
                    <View style={styles.calibrationRow}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Decrease default map zoom"
                        disabled={mapZoom <= 10}
                        onPress={() => {
                          const next = Math.max(10, mapZoom - 1);
                          setMapZoom(next);
                          savePreference('map_zoom', String(next));
                        }}
                        style={styles.mapControlButton}
                      >
                        <MaterialCommunityIcons name="minus" size={20} color={C.text} />
                      </Pressable>
                      <Text style={styles.calibrationValue}>{mapZoom}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Increase default map zoom"
                        disabled={mapZoom >= 18}
                        onPress={() => {
                          const next = Math.min(18, mapZoom + 1);
                          setMapZoom(next);
                          savePreference('map_zoom', String(next));
                        }}
                        style={styles.mapControlButton}
                      >
                        <MaterialCommunityIcons name="plus" size={20} color={C.text} />
                      </Pressable>
                    </View>
                  </View>
                </View>
                <View style={styles.settingsCard}>
                  <Text style={styles.eyebrow}>LOCATION ACCESS</Text>
                  <Text style={styles.smallCardTitle}>GPS & background recording</Text>
                  <Text style={styles.settingsCopy}>
                    Start a trip to keep GPS recording while you use other apps. Android shows a live notification with speed and elapsed ride time while recording.
                  </Text>
                  <Text style={styles.settingsCopy}>
                    Battery optimization, vendor task managers, force-stop, permission changes, and device-specific policies can interrupt tracking. Check the trip status after returning to the app.
                  </Text>
                  {trip ? <Text style={styles.activeTripInfo}>Current trip: {trip.status.toUpperCase()} · {prettyMode(trip.mode)}</Text> : null}
                </View>
                <View style={styles.settingsCard}>
                  <Text style={styles.eyebrow}>MAP PROVIDER</Text>
                  <Text style={styles.smallCardTitle}>OpenFreeMap · OpenStreetMap</Text>
                  <Text style={styles.settingsCopy}>
                    RealSpeed uses the public OpenFreeMap Liberty style with OpenStreetMap data. Map tiles need an internet connection. Offline packs depend on provider availability and terms; GPS recording and saved trips remain on this device.
                  </Text>
                </View>
                {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}
              </ScrollView>
            )}
          </View>
        </View>
        <View style={styles.bottomNav} accessibilityRole="tablist">
          {([
            ['dashboard', 'Dashboard', 'view-dashboard-outline'],
            ['drive', 'Speedometer', 'speedometer'],
            ['trips', 'History', 'history'],
            ['settings', 'Settings', 'cog-outline']
          ] as [Screen, string, IconName][]).map(([id, label, icon]) => {
            const selected = activeNavigation === id;
            return (
              <Pressable
                key={id}
                onPress={() => setScreen(id)}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected }}
                style={[styles.bottomNavItem, selected && styles.bottomNavItemActive]}
              >
                <MaterialCommunityIcons
                  name={icon}
                  size={21}
                  color={selected ? C.accent : C.muted}
                />
                <Text style={[styles.bottomNavLabel, selected && styles.bottomNavTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

function Notice({ message, onDismiss, warning = false }: { message: string; onDismiss: () => void; warning?: boolean }) {
  return (
    <Pressable onPress={onDismiss} style={[styles.notice, warning && styles.noticeWarning]}>
      <View style={[styles.noticeDot, warning && styles.noticeDotWarning]} />
      <Text style={styles.noticeText}>{message}</Text>
      <MaterialCommunityIcons name="close" size={18} color={C.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0 },
  app: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 },
  loadingScreen: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: C.muted, marginTop: 14, fontSize: 13 },
  topBar: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomColor: C.line, borderBottomWidth: 1, paddingBottom: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 36, height: 36, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#FFFFFF', fontWeight: '900', fontSize: 22, fontStyle: 'italic' },
  brandName: { color: C.text, fontWeight: '900', fontSize: 15, letterSpacing: 1.2 },
  brandNameAccent: { color: C.accent },
  brandSub: { color: C.muted, fontSize: 8, fontWeight: '700', letterSpacing: 1.5, marginTop: 3 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  localPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: '#E8F4F0' },
  localText: { color: C.accent, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  gpsPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 7, borderWidth: 1, backgroundColor: C.panel },
  signalDot: { width: 7, height: 7, borderRadius: 4 },
  gpsText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  body: { flex: 1, minHeight: 0, paddingTop: 8 },
  content: { flex: 1, minHeight: 0, minWidth: 0 },
  bottomNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', minHeight: 68, marginHorizontal: -16, paddingHorizontal: 9, paddingTop: 6, paddingBottom: 3, backgroundColor: C.panel, borderTopWidth: 1, borderTopColor: C.line },
  bottomNavItem: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 13 },
  bottomNavItemActive: { backgroundColor: '#EAF4F1' },
  bottomNavLabel: { color: C.muted, fontSize: 9, fontWeight: '700' },
  bottomNavTextActive: { color: C.accent, fontWeight: '900' },
  screenScroll: { flexGrow: 1, paddingBottom: 16 },
  homeScroll: { flexGrow: 1, paddingTop: 14, paddingBottom: 20 },
  homeHeading: { marginBottom: 16 },
  homeTitle: { color: C.text, fontSize: 27, fontWeight: '800', letterSpacing: -0.5, marginTop: 4 },
  homeSubtitle: { color: C.muted, fontSize: 13, marginTop: 5 },
  homeSpeedCard: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 20, padding: 18, shadowColor: '#18342F', shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  homeSpeedTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  homeSpeedLabel: { color: C.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  homeSpeedValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 2 },
  homeSpeedValue: { color: C.text, fontSize: 56, lineHeight: 64, fontWeight: '300', fontVariant: ['tabular-nums'], letterSpacing: -2 },
  homeSpeedUnit: { color: C.accent, fontSize: 14, fontWeight: '800' },
  homeSpeedIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: '#E8F4F0', alignItems: 'center', justifyContent: 'center' },
  homeGpsStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: 13, marginTop: 9, borderTopWidth: 1, borderTopColor: C.line },
  homeGpsText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  homeGpsHint: { color: C.muted, fontSize: 10, marginLeft: 'auto' },
  homeStatsRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  homeStatCard: { flex: 1, minWidth: 0, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 16, padding: 14 },
  homeStatLabel: { color: C.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  homeStatValue: { color: C.text, fontSize: 21, fontWeight: '800', marginTop: 8 },
  homeStatHint: { color: C.muted, fontSize: 10, marginTop: 3 },
  homeSectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, marginBottom: 10 },
  homeSectionTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
  homeLink: { color: C.accent, fontSize: 12, fontWeight: '800' },
  homeActions: { gap: 9 },
  homeRecentCard: { minHeight: 68, flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 15, padding: 12, gap: 11 },
  homeRecentIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: '#E8F4F0', alignItems: 'center', justifyContent: 'center' },
  homeRecentInfo: { flex: 1, minWidth: 0 },
  homeRecentMode: { color: C.text, fontSize: 11, fontWeight: '800' },
  homeRecentDate: { color: C.muted, fontSize: 10, marginTop: 4 },
  homeRecentDistance: { color: C.accent, fontSize: 12, fontWeight: '800' },
  homeEmptyText: { color: C.muted, fontSize: 12, paddingVertical: 8 },
  dashboard: { gap: 13 },
  dashboardWide: { flexDirection: 'row', alignItems: 'stretch' },
  speedPanel: { backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 15 },
  speedPanelWide: { flex: 1.15 },
  panelHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  speedPanelActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mapViewButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10, borderWidth: 1, borderColor: '#B9DCD4', backgroundColor: '#F2F9F6', paddingHorizontal: 8 },
  mapViewButtonText: { color: C.accent, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  eyebrow: { color: C.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  panelTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 4, letterSpacing: 0.1 },
  recordPill: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 20, backgroundColor: '#EEF2F4', paddingVertical: 8, paddingHorizontal: 10 },
  recordPillLive: { backgroundColor: '#FBECEA' },
  recordDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.muted },
  recordDotLive: { backgroundColor: C.red },
  recordText: { color: C.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  recordTextLive: { color: C.red },
  gaugeArea: { alignItems: 'center', paddingVertical: 7 },
  gaugeOuter: { width: 224, height: 224, borderRadius: 112, borderColor: '#A8D0C6', borderWidth: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5FAF8' },
  gaugeInner: { width: 196, height: 196, borderRadius: 98, borderWidth: 1, borderColor: '#DDEBE6', alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel },
  speedDigits: { color: C.text, fontSize: 86, fontWeight: '300', letterSpacing: -5, lineHeight: 95, fontVariant: ['tabular-nums'] },
  noSpeed: { color: '#A4B0B6', fontWeight: '200' },
  speedUnit: { color: C.accent, fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  gaugeCaption: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 11 },
  captionLine: { width: 18, height: 1, backgroundColor: '#B8D2CA' },
  captionText: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  telemetryGrid: { flexDirection: 'row', flexWrap: 'wrap', borderTopColor: C.line, borderTopWidth: 1, marginTop: 7, paddingTop: 6 },
  metric: { width: '50%', minHeight: 58, justifyContent: 'center', paddingHorizontal: 8, borderBottomColor: '#EEF1F3', borderBottomWidth: 1 },
  metricLabel: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  metricValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 5 },
  metricValue: { color: C.text, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metricUnit: { color: C.muted, fontSize: 9, fontWeight: '700' },
  controlColumn: { gap: 13 },
  modeCard: { backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 15 },
  smallCardTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginTop: 5 },
  modeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 13 },
  modeButton: { minWidth: 70, height: 62, flexGrow: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFB', borderRadius: 13, borderWidth: 1, borderColor: C.line },
  modeButtonActive: { borderColor: '#78BDAE', backgroundColor: '#EAF4F1', borderWidth: 1.5 },
  modeButtonLocked: { opacity: 0.55 },
  modeLabel: { color: C.muted, fontSize: 8, fontWeight: '800', marginTop: 5, letterSpacing: 0.5 },
  modeLabelActive: { color: C.text },
  controlCard: { backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 15 },
  controlHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15 },
  localBadge: { color: C.accent, fontSize: 8, fontWeight: '900', letterSpacing: 0.6, backgroundColor: '#EAF4F1', paddingHorizontal: 9, paddingVertical: 7, borderRadius: 9, overflow: 'hidden' },
  actionButton: { minHeight: 50, flex: 1, borderRadius: 13, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, paddingHorizontal: 13, borderWidth: 1 },
  actionPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  actionSecondary: { backgroundColor: C.panel, borderColor: C.line },
  actionDanger: { backgroundColor: '#FFF3F1', borderColor: '#F0D2CE' },
  actionDisabled: { opacity: 0.5 },
  actionPressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  actionLabel: { color: C.text, fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  actionLabelDark: { color: '#FFFFFF' },
  buttonRow: { flexDirection: 'row', gap: 9 },
  controlFootnote: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 11 },
  statusStrip: { minHeight: 51, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 13, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 13, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line },
  statusStripLabel: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  statusStripValue: { color: C.text, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statusDivider: { height: 20, width: 1, backgroundColor: C.line, marginHorizontal: 2 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: '#EEF5FA', borderWidth: 1, borderColor: '#D8E7F1', padding: 12, marginTop: 10, borderRadius: 12 },
  noticeWarning: { backgroundColor: '#FFF6E5', borderColor: '#F0DFB6' },
  noticeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.blue },
  noticeDotWarning: { backgroundColor: C.amber },
  noticeText: { color: C.text, fontSize: 11, lineHeight: 16, flex: 1 },
  mapScreen: { flex: 1, backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 14 },
  mapBackButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, paddingVertical: 5, paddingRight: 8 },
  mapBackText: { color: C.muted, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  mapHeadingActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  mapTabs: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  mapTab: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#F7F9FA', borderWidth: 1, borderColor: C.line },
  mapTabActive: { backgroundColor: '#EAF4F1', borderColor: '#78BDAE' },
  mapTabText: { color: C.muted, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  mapTabTextActive: { color: C.accent, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  mapFrame: { flex: 1, minHeight: 220, overflow: 'hidden', borderRadius: 14, backgroundColor: '#EEF2F3', position: 'relative' },
  map: { flex: 1 },
  vehicleMarker: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.accent, borderWidth: 3, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: -2, shadowColor: '#102C28', shadowOpacity: 0.25, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 5 },
  mapRideInfo: { position: 'absolute', left: 11, top: 11, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 14, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, elevation: 3 },
  mapSpeedSummary: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  mapSpeedValue: { color: C.text, fontSize: 24, fontWeight: '800', lineHeight: 24, fontVariant: ['tabular-nums'] },
  mapSpeedUnit: { color: C.muted, fontSize: 9, fontWeight: '800', marginTop: 2 },
  mapRideStat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  mapRideValue: { color: C.text, fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  mapRideUnit: { color: C.muted, fontSize: 8, fontWeight: '700' },
  mapRideDivider: { width: 1, height: 20, backgroundColor: C.line },
  mapControls: { position: 'absolute', right: 11, top: 11, gap: 7 },
  mapControlButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, elevation: 2 },
  mapControlButtonActive: { borderColor: '#78BDAE', backgroundColor: '#EAF4F1' },
  mapActionBar: { flexDirection: 'row', gap: 9, marginTop: 12 },
  mapUnavailable: { flex: 1, minHeight: 260, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: '#F7F9FA', alignItems: 'center', justifyContent: 'center', padding: 24 },
  mapCrosshair: { width: 58, height: 58, borderWidth: 1, borderColor: '#A8D0C6', borderRadius: 29, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  mapUnavailableTitle: { color: C.text, fontSize: 11, fontWeight: '900', letterSpacing: 1.4, textAlign: 'center' },
  mapUnavailableCopy: { color: C.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', maxWidth: 440, marginTop: 9 },
  mapFooter: { marginTop: 11, alignItems: 'center' },
  mapFooterText: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  listScreen: { flexGrow: 1, padding: 15, paddingBottom: 22, backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: C.line },
  emptyState: { flex: 1, minHeight: 280, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  emptyMark: { color: '#A4B0B6', fontSize: 50, fontWeight: '200' },
  emptyTitle: { color: C.text, fontSize: 17, fontWeight: '700', marginTop: 5 },
  emptyCopy: { color: C.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 350, marginTop: 8, marginBottom: 17 },
  tripCard: { backgroundColor: '#FBFCFD', borderRadius: 15, borderWidth: 1, borderColor: C.line, padding: 14, marginBottom: 10 },
  tripCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tripMode: { color: C.accent, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  tripDate: { color: C.muted, fontSize: 10, marginTop: 5 },
  tripDistance: { color: C.text, fontSize: 18, fontWeight: '800' },
  tripMetrics: { borderTopColor: C.line, borderTopWidth: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 13, marginTop: 12, paddingTop: 11 },
  tripMetric: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  settingsCard: { backgroundColor: '#FBFCFD', borderRadius: 15, borderWidth: 1, borderColor: C.line, padding: 15, marginBottom: 11 },
  settingsNavigation: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line },
  settingsNavigationLast: { borderBottomWidth: 0 },
  settingsNavigationContent: { flex: 1 },
  settingsNavigationTitle: { color: C.text, fontSize: 12, fontWeight: '800' },
  settingsNavigationCopy: { color: C.muted, fontSize: 10, marginTop: 4 },
  settingChoiceRow: { flexDirection: 'row', gap: 8, marginTop: 13 },
  settingChoice: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 11, borderColor: C.line, borderWidth: 1, paddingHorizontal: 19, paddingVertical: 11, backgroundColor: C.panel },
  settingChoiceActive: { borderColor: '#78BDAE', backgroundColor: '#EAF4F1' },
  settingChoiceText: { color: C.muted, fontWeight: '800', fontSize: 12 },
  settingChoiceTextActive: { color: C.accent },
  settingsCopy: { color: C.muted, fontSize: 11, lineHeight: 17, marginTop: 10 },
  settingsCopyEmphasis: { color: C.text, fontSize: 12, fontWeight: '800', marginTop: 18 },
  calibrationRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  calibrationValue: { minWidth: 66, color: C.text, fontSize: 15, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  settingsToggleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.line },
  settingsToggleCopy: { flex: 1 },
  settingsZoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 13 },
  activeTripInfo: { color: C.amber, fontSize: 10, fontWeight: '800', marginTop: 12 },
});
