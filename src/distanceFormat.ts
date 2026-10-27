export type DistanceUnit = 'km/h' | 'mph';

export function formatDistance(meters: number, unit: DistanceUnit): string {
  const distance = unit === 'km/h' ? meters / 1000 : meters * 0.000621371192237334;
  if (distance < 1) {
    return unit === 'km/h'
      ? `${Math.round(meters)} m`
      : `${Math.round(meters * 3.28084)} ft`;
  }
  return `${distance.toFixed(2)} ${unit === 'km/h' ? 'km' : 'mi'}`;
}
