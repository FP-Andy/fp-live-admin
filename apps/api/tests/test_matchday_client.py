"""MatchDay's public response contract, without real network traffic."""
import unittest
from unittest.mock import patch
import httpx
from app import matchday_client as md


class MatchdayClientTest(unittest.TestCase):
    def setUp(self):
        md._cache = None
        md._cache_at = 0

    def client_patch(self, handler):
        real_client = httpx.Client
        return patch.object(md.httpx, 'Client', side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))

    def test_both_stages_and_slim_roster(self):
        paths = []
        def handler(request):
            paths.append(request.url.path)
            if request.url.path.endswith('/matches/827/players'):
                return httpx.Response(200, json={'status': 200, 'data': {
                    'homeTeam': {'starters': [{'id': 10, 'userId': 20, 'name': '홈', 'number': 7, 'matchPosition': 'MF', 'birthYear': 2004}], 'substitutes': []},
                    'awayTeam': {'starters': [], 'substitutes': [{'id': 11, 'userId': 21, 'name': '원정', 'number': 9, 'matchPosition': None}]}}})
            return httpx.Response(200, json={'status': 200, 'data': {'competitionId': 31, 'matches': [{'matchId': 827 if 'qualifying' in request.url.path else 900, 'homeTeamName': '홈', 'awayTeamName': '원정'}]}})
        with self.client_patch(handler):
            fixtures = md.fixtures()
            self.assertEqual([f['stage'] for f in fixtures], ['qualifying', 'finals'])
            md.fixtures()
            teams, errors = md.roster(827)
        self.assertEqual(len(paths), 3)  # cached fixture list, fresh roster
        self.assertEqual(errors, [])
        self.assertNotIn('birthYear', teams['HOME'][0])
        self.assertEqual(teams['HOME'][0]['number'], '7')
        self.assertTrue(teams['AWAY'][0]['isSubstitute'])
        self.assertEqual(teams['HOME'][0]['matchdayUserId'], 20)

    def test_invalid_numbers_fail_safely(self):
        player = {'id': 1, 'userId': 1, 'name': '선수', 'number': None}
        body = {'status': 200, 'data': {'homeTeam': {'starters': [player, {**player, 'number': 7}, {**player, 'number': '07'}], 'substitutes': []}, 'awayTeam': {'starters': [], 'substitutes': []}}}
        with self.client_patch(lambda request: httpx.Response(200, json=body)):
            _, errors = md.roster(827)
        self.assertEqual(len(errors), 2)

    def test_upstream_failure_and_invalid_response_are_errors(self):
        for response in (httpx.Response(503), httpx.Response(200, json={'status': 200, 'data': {}})):
            with self.subTest(response=response), self.client_patch(lambda request: response):
                with self.assertRaises(md.MatchdayError):
                    md.roster(827)


if __name__ == '__main__':
    unittest.main()
