import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Fine Play Console',
    short_name: 'FP Console',
    description: 'Unified operations workspace for FLA and FPA',
    start_url: '/admin/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#282828',
    theme_color: '#282828',
    orientation: 'portrait',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
