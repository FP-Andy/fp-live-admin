import FcmMatchSetupPage from '../../../../../components/FcmMatchSetupPage';

export default function MatchSetupPage({ params }: { params: { id: string } }) {
  return <FcmMatchSetupPage matchId={params.id} />;
}
