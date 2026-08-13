/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: 'standalone',
  experimental: {
    // Chromium is launched only by the internal capture route. Keeping the
    // Playwright implementation external avoids Webpack trying to bundle its
    // optional browser-engine modules into the public Next.js build.
    serverComponentsExternalPackages: ['playwright-core'],
  },
  async rewrites() {
    const apiProxy = process.env.NEXT_API_PROXY_TARGET;
    if (!apiProxy) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${apiProxy.replace(/\/$/, '')}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
