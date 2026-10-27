import { formatDistance } from './distanceFormat';

describe('distance formatting', () => {
  it('converts stored meters to kilometers instead of labeling meters as kilometers', () => {
    expect(formatDistance(1_056.71, 'km/h')).toBe('1.06 km');
  });

  it('keeps short distances in meters', () => {
    expect(formatDistance(420, 'km/h')).toBe('420 m');
  });

  it('formats miles and feet when using mph', () => {
    expect(formatDistance(1_609.344, 'mph')).toBe('1.00 mi');
    expect(formatDistance(100, 'mph')).toBe('328 ft');
  });
});
