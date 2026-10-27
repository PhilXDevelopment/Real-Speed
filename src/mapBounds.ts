export function makeRegionBounds(
  latitude: number,
  longitude: number,
  radiusKm: number
): [number, number, number, number] {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -85 ||
    latitude > 85 ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(radiusKm) ||
    radiusKm < 1 ||
    radiusKm > 500
  ) {
    throw new Error('Use a valid center and a region radius from 1 to 500 km.');
  }
  const latitudeDelta = radiusKm / 111.32;
  const longitudeDelta = radiusKm / (111.32 * Math.cos((latitude * Math.PI) / 180));
  if (longitude - longitudeDelta < -180 || longitude + longitudeDelta > 180) {
    throw new Error('This region crosses the international date line; choose a center farther from it.');
  }
  const south = Math.max(-85, latitude - latitudeDelta);
  const north = Math.min(85, latitude + latitudeDelta);
  const west = longitude - longitudeDelta;
  const east = longitude + longitudeDelta;
  return [west, south, east, north];
}

function validateBounds(bounds: [number, number, number, number]): [number, number, number, number] {
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    throw new Error('Bounds must contain [west, south, east, north].');
  }
  const [west, south, east, north] = bounds;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -85 ||
    south > 85 ||
    north < -85 ||
    north > 85 ||
    west >= east ||
    south >= north
  ) {
    throw new Error('Bounds must be a valid [west, south, east, north] rectangle.');
  }
  return [west, south, east, north];
}

export function estimateMapTileCount(
  bounds: [number, number, number, number],
  zoom: number
): number {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new Error('Zoom must be an integer from 0 to 22.');
  }
  const [west, south, east, north] = validateBounds(bounds);
  const tileCount = 2 ** zoom;
  const tileX = (longitude: number) =>
    Math.max(0, Math.min(tileCount - 1, Math.floor(((longitude + 180) / 360) * tileCount)));
  const tileY = (latitude: number) => {
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const radians = (clampedLatitude * Math.PI) / 180;
    const mercator = Math.log(Math.tan(Math.PI / 4 + radians / 2));
    return Math.max(
      0,
      Math.min(tileCount - 1, Math.floor(((1 - mercator / Math.PI) / 2) * tileCount))
    );
  };
  const horizontalTiles = tileX(east) - tileX(west) + 1;
  const verticalTiles = tileY(south) - tileY(north) + 1;
  return horizontalTiles * verticalTiles;
}

export function maximumZoomWithinTileLimit(
  bounds: [number, number, number, number],
  minimumZoom: number,
  maximumZoom: number,
  tileLimit: number
): number | null {
  if (!Number.isInteger(minimumZoom) || minimumZoom < 0 || minimumZoom > 22) {
    throw new Error('Minimum zoom must be an integer from 0 to 22.');
  }
  if (!Number.isInteger(maximumZoom) || maximumZoom < 0 || maximumZoom > 22) {
    throw new Error('Maximum zoom must be an integer from 0 to 22.');
  }
  if (minimumZoom > maximumZoom) {
    throw new Error('Minimum zoom must be less than or equal to maximum zoom.');
  }
  if (!Number.isFinite(tileLimit) || tileLimit <= 0) {
    throw new Error('Tile limit must be a positive number.');
  }
  validateBounds(bounds);
  for (let zoom = maximumZoom; zoom >= minimumZoom; zoom -= 1) {
    if (estimateMapTileCount(bounds, zoom) <= tileLimit) return zoom;
  }
  return null;
}
