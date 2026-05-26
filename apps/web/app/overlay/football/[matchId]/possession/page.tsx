'use client';

import { useParams } from 'next/navigation';
import OverlayView from '../../../../../components/live-coder/OverlayViews';

export default function PossessionOverlayPage() {
  const params = useParams<{ matchId: string }>();
  return <OverlayView matchId={params.matchId} kind="possession" />;
}
