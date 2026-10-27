import {
  OfflineManager,
  OfflinePack,
  OfflinePackStatus
} from '@maplibre/maplibre-react-native';
export { makeRegionBounds } from './mapBounds';

export type OfflinePackRecord = {
  pack: OfflinePack;
  status: OfflinePackStatus;
};

export async function readOfflinePacks(): Promise<OfflinePackRecord[]> {
  const packs = await OfflineManager.getPacks();
  return Promise.all(packs.map(async (pack) => ({ pack, status: await pack.status() })));
}

export async function startOfflinePack(
  styleUrl: string,
  bounds: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
  label: string,
  onProgress: (pack: OfflinePack, status: OfflinePackStatus) => void,
  onError: (pack: OfflinePack, error: { id: string; message: string }) => void
): Promise<OfflinePack> {
  if (!styleUrl.trim()) throw new Error('A licensed MapLibre style URL must be configured first.');
  let style: URL;
  try {
    style = new URL(styleUrl);
  } catch {
    throw new Error('The map style URL is invalid.');
  }
  const localHttp = style.protocol === 'http:' &&
    (style.hostname === 'localhost' || style.hostname === '127.0.0.1');
  if (style.protocol !== 'https:' && !localHttp) {
    throw new Error('Offline map downloads require an HTTPS map style URL.');
  }
  if (minZoom < 1 || maxZoom > 16 || minZoom > maxZoom) {
    throw new Error('Choose a zoom range from 1 through 16.');
  }
  const existing = await OfflineManager.getPacks();
  const duplicate = existing.find((pack) => {
    const metadata = pack.metadata;
    return metadata?.label === label && JSON.stringify(pack.bounds) === JSON.stringify(bounds);
  });
  if (duplicate) throw new Error('This region is already in the offline maps list.');
  return OfflineManager.createPack(
    {
      mapStyle: styleUrl,
      bounds,
      minZoom,
      maxZoom,
      metadata: { label, createdAt: new Date().toISOString(), minZoom, maxZoom }
    },
    onProgress,
    onError
  );
}

export async function deleteOfflinePack(id: string): Promise<void> {
  await OfflineManager.deletePack(id);
}

export async function pauseOfflinePack(id: string): Promise<void> {
  await (await OfflineManager.getPack(id)).pause();
}

export async function resumeOfflinePack(id: string): Promise<void> {
  await (await OfflineManager.getPack(id)).resume();
}

export async function updateOfflinePack(id: string): Promise<void> {
  await OfflineManager.invalidatePack(id);
}
