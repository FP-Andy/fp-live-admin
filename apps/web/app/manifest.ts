import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Fine Play Live Admin',
    short_name: 'Live Admin',
    description: 'Production-oriented match operation console',
    start_url: '/admin/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#101010',
    theme_color: '#ff7400',
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
