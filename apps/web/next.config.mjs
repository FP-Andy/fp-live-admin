/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: 'standalone',
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
