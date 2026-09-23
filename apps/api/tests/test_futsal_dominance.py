"""Exercise the production aggregation without starting API background workers."""
import ast
from pathlib import Path
from types import SimpleNamespace as Row
import unittest
from unittest.mock import MagicMock

source = ast.parse((Path(__file__).parents[1] / 'app/main.py').read_text())
names = {'_build_split_halves_dominance', '_compute_dominance_value'}
module = ast.Module(body=[node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
class HTTPException(Exception):
    def __init__(self, status_code, detail): self.status_code = status_code
symbols = {name: MagicMock() for name in ['Match', 'PossessionSegment', 'Event', 'MatchMarker', 'Session', 'UUID']}
symbols.update(HTTPException=HTTPException, _clamp=lambda v,lo,hi:max(lo,min(hi,v)), DOM_POSSESSION_WEIGHT=.35, DOM_XG_WEIGHT=.65, DOM_ATTACK_WEIGHT=.25, DOM_XG_SCALE=1.8, DOM_GOAL_XG_MULTIPLIER=2.5)
exec(compile(module, '<production dominance>', 'exec'), symbols)

class FutsalDominanceTests(unittest.TestCase):
    def aggregate(self, sport='FUTSAL', mode='SINGLE', seconds=60, markers=None, clock=150000):
        db = MagicMock()
        db.get.return_value = Row(sport=sport, metadata_json={'period_mode':mode})
        possession = [Row(start_ms=0,end_ms=90000,team='HOME'),Row(start_ms=90000,end_ms=None,team='AWAY')]
        shots = [Row(clock_ms=59999,team='HOME',xg=.2,is_goal=False),Row(clock_ms=60000,team='AWAY',xg=.3,is_goal=True)]
        attacks = [Row(clock_ms=120000,team='HOME')]
        db.query.return_value.filter.return_value.order_by.return_value.all.side_effect = [possession,shots,attacks,markers or []]
        symbols['_latest_state'] = lambda *_: Row(clock_ms=clock)
        return symbols['_build_split_halves_dominance']('match', seconds, db)

    def test_minute_boundaries_and_possession_conservation(self):
        result = self.aggregate()
        bins = result['bins']
        self.assertEqual([(b['start_ms'],b['end_ms']) for b in bins],[(0,60000),(60000,120000),(120000,150000)])
        self.assertEqual(sum(b['home_poss_ms'] for b in bins),90000)
        self.assertEqual(sum(b['away_poss_ms'] for b in bins),60000)
        self.assertEqual(bins[0]['home_xg'],.2)
        self.assertEqual(bins[1]['away_xg'],.75)
        self.assertEqual(bins[1]['annotations']['goal_summary']['away'],1)
        self.assertEqual(bins[2]['home_attack_score'],1)
        self.assertEqual(result['breaks'],[])
        self.assertEqual(result['half_gap_ms'],0)

    def test_single_ignores_period_markers(self):
        marker=Row(marker_type='HALFTIME_START',clock_ms=90000)
        single=self.aggregate(markers=[marker])
        halves=self.aggregate(mode='HALVES',markers=[marker])
        self.assertEqual(len(single['halves']),1)
        self.assertEqual(len(halves['halves']),2)
        self.assertEqual(halves['half_gap_ms'],60000)
        self.assertEqual(halves['bins'][-1]['start_ms'],90000)

    def test_football_stays_three_minutes(self):
        with self.assertRaises(HTTPException): self.aggregate(sport='FOOTBALL',seconds=60)
        football=self.aggregate(sport='FOOTBALL',mode='HALVES',seconds=180)
        self.assertEqual(len(football['bins']),1)
        self.assertEqual(football['bin_seconds'],180)
        self.assertEqual(football['bins'][0]['home_poss_ms'],90000)
        self.assertEqual(football['bins'][0]['away_poss_ms'],60000)

    def test_creation_persists_single_duration_without_changing_halves(self):
        import copy
        import uuid
        function = copy.deepcopy(next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'create_match'))
        function.decorator_list = []
        function.args.defaults = [ast.Constant(None), ast.Constant(None)]
        for arg in function.args.args: arg.annotation = None
        function.returns = None
        context = dict(symbols, uuid=uuid, Match=Row, CompetitionClass=object,
                       _normalize_sport=lambda value:value, _normalize_competition_class=lambda value:value,
                       MATCH_NAME_PATTERN=MagicMock(), _resolve_ingest_fields=lambda *_:(None,None),
                       _serialize_match=lambda row:row)
        context['MATCH_NAME_PATTERN'].match.return_value = None
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])), '<production create>', 'exec'),context)
        for mode, expected_second in [('SINGLE',0),('HALVES',15)]:
            body=Row(sport='FUTSAL',competition_class='FUTSAL-QUEENCUP',name='HOME vs AWAY',round_number=1,
                     first_half_minutes=12,second_half_minutes=15,metadata={'period_mode':mode,'match_minutes':99},
                     hls_url=None,assign_operator=False,stream_mode='MANUAL',ingest_url=None,srt_url=None,ingest_protocol=None)
            db=MagicMock(); db.get.return_value=None
            row=context['create_match'](body,db)
            self.assertEqual((row.first_half_minutes,row.second_half_minutes),(12,expected_second))
            self.assertEqual(row.metadata_json['second_half_minutes'],expected_second)
            if mode=='SINGLE': self.assertEqual(row.metadata_json['match_minutes'],12)
            db.add.assert_called_once_with(row)
            db.commit.assert_called_once()

    def test_empty_and_unsupported_intervals(self):
        for seconds in [0,30,120,-60]:
            with self.assertRaises(HTTPException): self.aggregate(seconds=seconds)

if __name__ == '__main__': unittest.main()
