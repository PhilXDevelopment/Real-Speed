module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    mapStyleUrl: process.env.EXPO_PUBLIC_MAP_STYLE_URL || config.extra?.mapStyleUrl || 'https://tiles.openfreemap.org/styles/liberty',
    mapAttribution: process.env.EXPO_PUBLIC_MAP_ATTRIBUTION || config.extra?.mapAttribution || '© OpenFreeMap · © OpenStreetMap contributors'
  }
});
