import { BroadcastObsOverlay } from '../../../../../components/BroadcastObsOverlay';

export default function BroadcastOverlayPage({ params }: { params: { matchId: string; locator: string[] } }) {
  return <BroadcastObsOverlay matchId={params.matchId} locator={params.locator} />;
}
