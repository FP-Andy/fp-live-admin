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
  async headers() {
    // xFP 게이지 미리보기 정적 파일은 매 재빌드마다 바뀐다 — 브라우저가 반드시 서버와
    // 재검증하도록 해서(no-cache), 재빌드 후 하드 리프레시 없이도 최신본이 뜨게 한다.
    return [
      {
        source: '/gauge/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
