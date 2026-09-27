import FpaTrackingWorkspace from '../../../../../components/fpa/FpaTrackingWorkspace';

export const dynamic = 'force-dynamic';

export default function FutsalTrackingPage({ searchParams }: { searchParams?: { job?: string } }) {
  // The existing loopback service retains the user's local reviews for preview.
  // A production build always uses FPC's own API and assets, never this override.
  let source = '/fpa-cv/index.html';
  if (process.env.NODE_ENV === 'development' && process.env.FPA_CV_PREVIEW_ORIGIN) {
    const local = new URL(process.env.FPA_CV_PREVIEW_ORIGIN);
    if (local.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(local.hostname)) {
      source = `${local.origin}/index.html`;
    }
  }
  const job = searchParams?.job;
  return <FpaTrackingWorkspace source={source} localPreview={source.startsWith('http:')} initialJob={job && /^(existing|[a-f0-9]{32})$/.test(job) ? job : undefined} />;
}
