import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import {
  OfflinePack,
  OfflinePackStatus,
  OfflineManager
} from '@maplibre/maplibre-react-native';
import {
  deleteOfflinePack,
  OfflinePackRecord,
  readOfflinePacks,
  startOfflinePack,
  updateOfflinePack
} from './offlineMaps';
import {
  estimateMapTileCount,
  makeRegionBounds,
  maximumZoomWithinTileLimit
} from './mapBounds';

const C = {
  panel: '#FFFFFF',
  line: '#E1E8EB',
  text: '#17252E',
  muted: '#6C7B84',
  accent: '#087F72',
  amber: '#9A6500',
  red: '#C44642'
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PackCard({
  record,
  onRefresh,
  onError
}: {
  record: OfflinePackRecord;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const { pack, status } = record;
  const label = typeof pack.metadata?.label === 'string' ? pack.metadata.label : 'Downloaded region';
  const sizeMb = (status.completedResourceSize / 1024 / 1024).toFixed(1);
  const percent = Math.min(100, Math.max(0, status.percentage));
  const operation = async (run: () => Promise<void>) => {
    try {
      await run();
      onRefresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  return (
    <View style={styles.packCard}>
      <View style={styles.packHeader}>
        <View style={styles.packTitleBox}>
          <Text style={styles.packTitle}>{label}</Text>
          <Text style={styles.packSub}>
            {status.state.toUpperCase()} · {status.completedTileCount.toLocaleString()} tiles · {sizeMb} MB
          </Text>
        </View>
        <Text style={styles.percent}>{Math.round(percent)}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${percent}%` }]} />
      </View>
      <View style={styles.packActions}>
        {status.state === 'active' ? (
          <SmallButton label="PAUSE" onPress={() => void operation(() => pack.pause())} />
        ) : status.state !== 'complete' ? (
          <SmallButton label="RESUME" onPress={() => void operation(() => pack.resume())} />
        ) : (
          <SmallButton label="UPDATE" onPress={() => void operation(() => updateOfflinePack(pack.id))} />
        )}
        <SmallButton
          label="DELETE"
          danger
          onPress={() =>
            Alert.alert('Delete offline region?', `${label} will no longer be available without internet.`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => void operation(() => deleteOfflinePack(pack.id))
              }
            ])
          }
        />
      </View>
    </View>
  );
}

function SmallButton({
  label,
  onPress,
  danger = false
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.smallButton, danger && styles.smallButtonDanger]}>
      <Text style={[styles.smallButtonText, danger && styles.smallButtonDangerText]}>{label}</Text>
    </Pressable>
  );
}

export function OfflineMapsScreen({
  styleUrl,
  attribution
}: {
  styleUrl: string | null;
  attribution: string;
}) {
  const [records, setRecords] = useState<OfflinePackRecord[]>([]);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radiusKm, setRadiusKm] = useState('5');
  const [maxZoom, setMaxZoom] = useState('14');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listenerIdsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const current = await readOfflinePacks();
    const liveIds = new Set(current.map(({ pack }) => pack.id));
    for (const id of listenerIdsRef.current) {
      if (!liveIds.has(id)) {
        OfflineManager.removeListener(id);
        listenerIdsRef.current.delete(id);
      }
    }
    setRecords(current);
    return current;
  }, []);

  const registerListeners = useCallback((pack: OfflinePack) => {
    if (listenerIdsRef.current.has(pack.id)) return;
    listenerIdsRef.current.add(pack.id);
    void OfflineManager.addListener(
      pack.id,
      (_updatedPack: OfflinePack, status: OfflinePackStatus) => {
        setRecords((existing) =>
          existing.map((item) => item.pack.id === pack.id ? { ...item, status } : item)
        );
      },
      (_updatedPack, error) => setNotice(`Map download failed: ${error.message}`)
    ).catch((error: unknown) => {
      listenerIdsRef.current.delete(pack.id);
      setNotice(`Could not watch map download status: ${errorMessage(error)}`);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void refresh()
      .then((current) => {
        if (!active) return;
        for (const { pack } of current) registerListeners(pack);
      })
      .catch((error: unknown) => {
        if (active) setNotice(`Could not read offline map inventory: ${errorMessage(error)}`);
      });
    return () => {
      active = false;
      for (const id of listenerIdsRef.current) OfflineManager.removeListener(id);
      listenerIdsRef.current.clear();
    };
  }, [refresh, registerListeners]);

  const useCurrentPosition = async () => {
    setNotice(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error('Location permission is required to center a download area.');
      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced
      });
      setLatitude(current.coords.latitude.toFixed(6));
      setLongitude(current.coords.longitude.toFixed(6));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const beginDownload = () => {
    if (!styleUrl || !attribution.trim()) {
      setNotice('Configure a licensed MapLibre style URL and provider attribution in app configuration before downloading.');
      return;
    }
    const centerLat = Number(latitude);
    const centerLon = Number(longitude);
    const radius = Number(radiusKm);
    const zoom = Number(maxZoom);
    if (
      !Number.isFinite(centerLat) ||
      !Number.isFinite(centerLon) ||
      !Number.isFinite(radius) ||
      !Number.isInteger(zoom) ||
      zoom < 10 ||
      zoom > 16
    ) {
      setNotice('Enter valid center coordinates, a radius from 1 to 500 km, and a maximum zoom from 10 to 16.');
      return;
    }
    let bounds: [number, number, number, number];
    try {
      bounds = makeRegionBounds(centerLat, centerLon, radius);
    } catch (error) {
      setNotice(errorMessage(error));
      return;
    }
    const tileLimit = 10_000;
    const estimatedTiles = estimateMapTileCount(bounds, zoom);
    if (estimatedTiles > tileLimit) {
      const allowedZoom = maximumZoomWithinTileLimit(bounds, 10, zoom, tileLimit);
      setNotice(
        allowedZoom === null
          ? 'This region is too large for the offline tile limit, even at zoom 10. Reduce the radius.'
          : `This region needs about ${estimatedTiles.toLocaleString()} map tiles at zoom ${zoom}, above the 10,000-tile limit. Set max zoom to ${allowedZoom} or lower.`
      );
      return;
    }
    const label = `Area ${centerLat.toFixed(3)}, ${centerLon.toFixed(3)} · ${radius} km`;
    Alert.alert(
      'Confirm map download',
      `Download a rectangular region around this center, radius ${radius} km, zoom 10–${zoom} (about ${estimatedTiles.toLocaleString()} map tiles). Confirm that your map provider permits offline downloads.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download',
          onPress: () => void (async () => {
            setBusy(true);
            setNotice(null);
            try {
              const network = await Network.getNetworkStateAsync();
              if (network.isConnected === false || network.isInternetReachable === false) {
                throw new Error('Connect to the internet before downloading map data.');
              }
              await OfflineManager.setTileCountLimit(tileLimit);
              const pack = await startOfflinePack(
                styleUrl,
                bounds,
                10,
                zoom,
                label,
                (_updatedPack, status) => {
                  setRecords((existing) =>
                    existing.map((item) =>
                      item.pack.id === _updatedPack.id ? { ...item, status } : item
                    )
                  );
                },
                (_failedPack, error) => setNotice(`Map download failed: ${error.message}`)
              );
              setNotice('Map region queued. Keep the app open and connected while the provider data downloads.');
              await refresh();
              registerListeners(pack);
            } catch (error) {
              setNotice(errorMessage(error));
            } finally {
              setBusy(false);
            }
          })()
        }
      ]
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <View style={styles.heading}>
        <View>
          <Text style={styles.eyebrow}>MAP DATA · PROVIDER RULES APPLY</Text>
          <Text style={styles.title}>Offline regions</Text>
        </View>
        <SmallButton label="REFRESH" onPress={() => void refresh().catch((error) => setNotice(errorMessage(error)))} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Download an area</Text>
        <Text style={styles.copy}>
          MapLibre saves this style’s resources in its native offline database. Regions can be up to a 500 km radius; downloads are capped at 10,000 map tiles, so larger areas require a lower zoom.
        </Text>
        <View style={styles.inputRow}>
          <Field label="CENTER LATITUDE" value={latitude} onChangeText={setLatitude} keyboardType="decimal-pad" />
          <Field label="CENTER LONGITUDE" value={longitude} onChangeText={setLongitude} keyboardType="decimal-pad" />
        </View>
        <SmallButton label="USE CURRENT LOCATION" onPress={() => void useCurrentPosition()} />
        <View style={styles.inputRow}>
          <Field label="RADIUS (KM · MAX 500)" value={radiusKm} onChangeText={setRadiusKm} keyboardType="decimal-pad" />
          <Field label="MAX ZOOM (10–16)" value={maxZoom} onChangeText={setMaxZoom} keyboardType="number-pad" />
        </View>
        <Text style={styles.copy}>
          The selected circle is downloaded as a bounded rectangle. The app checks estimated map tiles against the 10,000-tile cap before downloading. Reduce zoom or radius if the estimate is too large.
        </Text>
        <Pressable
          disabled={busy}
          onPress={beginDownload}
          style={[styles.downloadButton, busy && styles.disabled]}
        >
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.downloadButtonText}>DOWNLOAD REGION</Text>}
        </Pressable>
      </View>

      <View style={styles.inventoryHeading}>
        <Text style={styles.cardTitle}>Downloaded regions</Text>
        <Text style={styles.count}>{records.length}</Text>
      </View>
      {!records.length ? (
        <View style={styles.empty}>
          <Text style={styles.copy}>No offline map regions are registered on this device.</Text>
        </View>
      ) : (
        records.map((record) => (
          <PackCard
            key={record.pack.id}
            record={record}
            onRefresh={() => void refresh().catch((error) => setNotice(errorMessage(error)))}
            onError={setNotice}
          />
        ))
      )}

      <Text style={styles.disclaimer}>
        Availability depends on completed provider resources and requested coverage. Keep attribution visible and verify licensing before downloading. Map coverage never determines whether GPS recording works.
      </Text>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </ScrollView>
  );
}

export function OfflineCoverageStatus({
  location
}: {
  location: { latitude: number; longitude: number } | null;
}) {
  const [coverage, setCoverage] = useState<string>('Checking downloaded map coverage…');
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const records = await readOfflinePacks();
        if (!active) return;
        const currentLocation = locationRef.current;
        if (!currentLocation) {
          setCoverage('Coverage unknown until GPS provides a position.');
          return;
        }
        const covering = records.find(({ pack, status }) => {
          if (status.state !== 'complete') return false;
          const [west, south, east, north] = pack.bounds;
          return currentLocation.longitude >= west &&
            currentLocation.longitude <= east &&
            currentLocation.latitude >= south &&
            currentLocation.latitude <= north;
        });
        const label = typeof covering?.pack.metadata?.label === 'string'
          ? covering.pack.metadata.label
          : 'Downloaded region';
        setCoverage(covering ? `OFFLINE MAP AVAILABLE · ${label}` : 'OUTSIDE DOWNLOADED MAP COVERAGE');
      } catch (error) {
        if (active) setCoverage(`Offline coverage could not be checked: ${errorMessage(error)}`);
      }
    };
    void check();
    const interval = setInterval(() => void check(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return <Text style={[styles.coverage, coverage.startsWith('OFFLINE MAP AVAILABLE') && styles.coverageAvailable]}>{coverage}</Text>;
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType: 'decimal-pad' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder="—"
        placeholderTextColor="#8B989F"
        style={styles.input}
        selectTextOnFocus
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 14, paddingBottom: 32, backgroundColor: C.panel, borderRadius: 18, borderWidth: 1, borderColor: C.line },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15 },
  eyebrow: { color: C.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 4 },
  card: { backgroundColor: '#FBFCFD', borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14 },
  cardTitle: { color: C.text, fontSize: 14, fontWeight: '800' },
  copy: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 8 },
  inputRow: { flexDirection: 'row', gap: 9, marginTop: 13 },
  field: { flex: 1 },
  fieldLabel: { color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  input: { height: 44, marginTop: 5, paddingHorizontal: 10, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.line, color: C.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  smallButton: { minHeight: 38, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: '#FFFFFF', marginTop: 10 },
  smallButtonText: { color: C.text, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  smallButtonDanger: { borderColor: '#F0D2CE', backgroundColor: '#FFF3F1' },
  smallButtonDangerText: { color: C.red },
  downloadButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent, borderRadius: 9, marginTop: 14 },
  downloadButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  disabled: { opacity: 0.5 },
  inventoryHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 8 },
  count: { color: C.accent, fontWeight: '800', fontSize: 11 },
  packCard: { backgroundColor: '#FBFCFD', borderColor: C.line, borderWidth: 1, borderRadius: 13, padding: 13, marginBottom: 8 },
  packHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  packTitleBox: { flex: 1, paddingRight: 12 },
  packTitle: { color: C.text, fontSize: 11, fontWeight: '800' },
  packSub: { color: C.muted, fontSize: 8, marginTop: 5 },
  percent: { color: C.accent, fontSize: 11, fontWeight: '800' },
  progressTrack: { height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: '#E6ECEF', marginTop: 10 },
  progressFill: { height: 5, backgroundColor: C.accent },
  packActions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  empty: { padding: 17, borderRadius: 12, backgroundColor: '#F7F9FA' },
  disclaimer: { color: C.muted, fontSize: 9, lineHeight: 14, marginTop: 13 },
  coverage: { color: C.amber, fontSize: 8, fontWeight: '900', letterSpacing: 0.6, marginTop: 8, textAlign: 'center' },
  coverageAvailable: { color: C.accent },
  notice: { color: C.amber, fontSize: 10, lineHeight: 15, marginTop: 10 },
});
