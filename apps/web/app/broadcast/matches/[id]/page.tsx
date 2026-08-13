import { BroadcastShowroomMatch } from '../../../../components/BroadcastShowroom';

export default function BroadcastMatchPage({ params }: { params: { id: string } }) {
  return <BroadcastShowroomMatch matchId={params.id} />;
}
