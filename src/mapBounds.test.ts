import {
  estimateMapTileCount,
  makeRegionBounds,
  maximumZoomWithinTileLimit
} from './mapBounds';

describe('offline map bounds', () => {
  it('calculates ordered bounds around the requested center', () => {
    const [west, south, east, north] = makeRegionBounds(0, 0, 5);
    expect(west).toBeLessThan(0);
    expect(south).toBeLessThan(0);
    expect(east).toBeGreaterThan(0);
    expect(north).toBeGreaterThan(0);
  });

  it('widens the longitude span at high latitudes', () => {
    const equator = makeRegionBounds(0, 0, 5);
    const highLatitude = makeRegionBounds(60, 0, 5);
    expect(highLatitude[2] - highLatitude[0]).toBeGreaterThan(equator[2] - equator[0]);
  });

  it('supports map regions up to a 500 km radius and rejects larger ones', () => {
    expect(() => makeRegionBounds(90, 0, 5)).toThrow();
    expect(makeRegionBounds(0, 0, 500)).toHaveLength(4);
    expect(() => makeRegionBounds(0, 0, 501)).toThrow();
    expect(() => makeRegionBounds(0, 179.99, 5)).toThrow();
  });

  it('limits large offline regions to a zoom that fits the tile budget', () => {
    const bounds = makeRegionBounds(0, 0, 500);
    const zoom = maximumZoomWithinTileLimit(bounds, 10, 16, 10_000);

    if (zoom === null) throw new Error('Expected a zoom level within the tile limit.');
    expect(estimateMapTileCount(bounds, zoom)).toBeLessThanOrEqual(10_000);
    expect(zoom).toBeLessThanOrEqual(12);
  });

  it('rejects invalid bound rectangles and impossible tile budgets', () => {
    expect(() => estimateMapTileCount([0, 0, 0, 0], 10)).toThrow();
    expect(() => maximumZoomWithinTileLimit([0, 0, 10, 5], 4, 3, 100)).toThrow();
    expect(() => maximumZoomWithinTileLimit(makeRegionBounds(0, 0, 5), 10, 12, 0)).toThrow();
  });
});
