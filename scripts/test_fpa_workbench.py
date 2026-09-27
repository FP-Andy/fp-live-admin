import copy
import json
import os
from pathlib import Path
import sys
import unittest
os.environ.setdefault('MPLCONFIGDIR',str(Path(os.getenv('TMPDIR','/tmp'))/'fpa-cv-matplotlib'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'apps/api'))
from app.fpa_workbench import edit_event,match_player,describe_event,normalize_document,export_workbook,import_workbook


def request(code='4ss5',team='home',dots=None):
    return {'stat_input':code,'team':team,'half':'2H','direction':'right','timeline':'00:25.125',
            'dots':dots or [{'meter_x':10,'meter_y':8},{'meter_x':20,'meter_y':8}], 'sport':'FUTSAL'}


def add(doc=None,req=None):
    return edit_event({'document':doc or {'rows':[],'logs':[]},'request':req or request()})['document']


def match(doc,number='6',team='home',role='actor',index=0):
    return match_player({'document':doc,'event_id':doc['rows'][index]['FpaEventId'],
        'role':role,'identity':{'team':team,'jersey':number}})['document']


class WorkbenchTests(unittest.TestCase):
    def test_new_event_uses_real_fpa_generator(self):
        doc=add();row=doc['rows'][0]
        self.assertEqual((row['Player'],row['Receiver'],row['Action'],row['Half']),('4','5','Pass','2H'))
        self.assertEqual(row['StatInput'],'4ss5');self.assertTrue(row['FpaEventId'])
        self.assertIn('4 Pass to 5',doc['logs'][0]);self.assertTrue(row['EPV'])

    def test_actor_receiver_atomic_and_source_unchanged(self):
        doc=add();before=copy.deepcopy(doc);out=match(doc)
        self.assertEqual(doc,before);self.assertEqual(out['rows'][0]['Player'],'6')
        self.assertEqual(out['rows'][0]['StatInput'],'6ss5');self.assertIn('6 Pass to 5',out['logs'][0])
        out=match(out,'7',role='receiver');self.assertEqual(out['rows'][0]['StatInput'],'6ss7')
        self.assertEqual(out['rows'][0]['FpaEventId'],doc['rows'][0]['FpaEventId'])

    def test_reject_referee_opponent_unassigned_and_non_receiver(self):
        doc=add()
        for team,number in [('referee','REF'),('away','4'),('home','')]:
            with self.assertRaises(ValueError):match(doc,number,team)
        with self.assertRaises(ValueError):match(add(req=request('4dd')),'5',role='receiver')

    def test_edit_recalculates_coordinates_code_and_time(self):
        doc=add();req=request('4cc5',dots=[{'meter_x':0,'meter_y':10},{'meter_x':5,'meter_y':8}]);req['timeline']='01:02.003'
        out=edit_event({'document':doc,'event_id':doc['rows'][0]['FpaEventId'],'request':req})['document']
        self.assertEqual(out['rows'][0]['Action'],'Kick-in');self.assertEqual(out['rows'][0]['Time'],'01:02.003')
        self.assertIn('Pos(0.0, 10.0)',out['logs'][0]);self.assertIn('Set Piece',out['rows'][0]['Tags'])

    def scene_doc(self):
        doc=add();doc=add(doc,request('4q','away',dots=[{'meter_x':15,'meter_y':8}]))
        doc=add(doc,request())
        dots=[{'id':'h','number':'4','meter_x':10,'meter_y':8,'teamSide':'home','team':'ally','needsCheck':True},
              {'id':'r','number':'5','meter_x':20,'meter_y':8,'teamSide':'home','team':'ally'},
              {'id':'a','number':'4','meter_x':15,'meter_y':8,'teamSide':'away','team':'opponent'}]
        for i,row in enumerate(doc['rows']):
            state={'schema':'fineplay.fpa.scene_state.v0.1','scene_index':11 if i<2 else 12,
                   'beforeDots':dots,'afterDots':copy.deepcopy(dots),'primary':0,
                   'passArrows':[{'side':'before','startId':'h','rowIndex':0,'code':'4ss5','x1':10,'y1':10,'x2':20,'y2':10}]}
            row.update(SceneIndex='1',SceneActionIndex=str(7+i),SceneState=json.dumps(state))
        return doc

    def test_shared_scene_team_perspective_and_clip_isolation(self):
        doc=self.scene_doc();before=copy.deepcopy(doc);out=match(doc)
        self.assertEqual(doc,before)
        for i in [0,1]:
            state=json.loads(out['rows'][i]['SceneState'])
            self.assertEqual(state['beforeDots'][0]['number'],'6');self.assertFalse(state['beforeDots'][0]['needsCheck'])
            self.assertEqual(state['afterDots'][0]['number'],'6');self.assertEqual(state['beforeDots'][2]['number'],'4')
            self.assertEqual(state['passArrows'][0]['code'],'6ss5')
        self.assertEqual(out['rows'][1]['Player'],'4');self.assertIn('4 Intercept',out['logs'][1])
        away_dual=json.loads(out['rows'][1]['DualState'])
        self.assertEqual(away_dual['before'][0]['team'],'opponent');self.assertEqual(away_dual['before'][2]['team'],'ally')
        self.assertEqual(out['rows'][2],doc['rows'][2]);self.assertEqual(out['logs'][2],doc['logs'][2])

    def test_scene_number_collision_fails_without_partial_write(self):
        doc=self.scene_doc();original=copy.deepcopy(doc)
        with self.assertRaises(ValueError):match(doc,'5')
        self.assertEqual(doc,original)

    def test_scene_ids_reused_in_another_period_stay_separate(self):
        doc=self.scene_doc();other=copy.deepcopy(doc['rows'][0])
        other.update(Half='1H',FpaEventId='other-period')
        doc['rows'].append(other);doc['logs'].append(doc['logs'][0].replace('2H |','1H |',1))
        out=match(doc)
        self.assertEqual(out['rows'][-1],other)
        self.assertEqual(out['logs'][-1],doc['logs'][-1])

    def test_time_edit_and_number_match_preserve_shot_observation(self):
        doc=add(req=request('4dd'));row=doc['rows'][0]
        row.update(GoalMouth='0.50,0.40',GoalMouthX='0.50',GoalMouthY='0.40',xGOT='0.432')
        renamed=match(doc)
        req=describe_event(renamed['rows'][0],renamed['logs'][0]);req['timeline']='00:27.100'
        moved=edit_event({'document':renamed,'event_id':row['FpaEventId'],'request':req})['document']
        self.assertEqual(moved['rows'][0]['xGOT'],'0.432')
        self.assertEqual(moved['rows'][0]['GoalMouth'],'0.50,0.40')
        self.assertEqual(moved['logs'][0].count('Metrics:'),1)
        req['dots'][0]['meter_x']=12
        changed=edit_event({'document':moved,'event_id':row['FpaEventId'],'request':req})['document']
        self.assertEqual(changed['rows'][0]['xGOT'],'')
        self.assertNotIn('GoalMouth:',changed['logs'][0])

    def test_shared_scene_edits_protect_points_and_update_arrow(self):
        doc=self.scene_doc();event_id=doc['rows'][0]['FpaEventId']
        req=describe_event(doc['rows'][0],doc['logs'][0]);req['dots'][0]['meter_x']=11
        with self.assertRaises(ValueError):edit_event({'document':doc,'event_id':event_id,'request':req})
        req=describe_event(doc['rows'][0],doc['logs'][0]);req['stat_input']='4cc5'
        edited=edit_event({'document':doc,'event_id':event_id,'request':req})['document']
        self.assertEqual(edited['rows'][0]['Action'],'Kick-in')
        self.assertEqual(json.loads(edited['rows'][1]['SceneState'])['passArrows'][0]['code'],'4cc5')
        self.assertEqual(edited['rows'][2],doc['rows'][2])

    def test_legacy_code_and_half_reconstruction(self):
        doc=add(req=request('4cc5.sp'));row=doc['rows'][0];del row['StatInput'];del row['Half'];del row['Direction']
        normalized=normalize_document(doc);req=describe_event(normalized['rows'][0],doc['logs'][0])
        self.assertTrue(req['stat_input'].startswith('4cc5'));self.assertEqual(req['half'],'2H');self.assertEqual(req['direction'],'right')
        self.assertEqual(match(normalized)['rows'][0]['Player'],'6')

    def test_validation_duplicate_id_invalid_time_and_futsal_bounds(self):
        doc=add();doc['rows'].append(copy.deepcopy(doc['rows'][0]));doc['logs']*=2
        with self.assertRaises(ValueError):normalize_document(doc)
        for req in [{**request(),'timeline':'00:65'},{**request(),'dots':[{'meter_x':41,'meter_y':8}]},{**request(),'stat_input':'4ss5.fake'},{**request(),'dots':[]}]:
            with self.assertRaises(ValueError):add(req=req)

    def test_workbook_roundtrip_preserves_event_id_stat_input_and_period(self):
        doc=match(add(req=request('4cc5.sp')))
        doc.update(match_id='test-match',teamid_h='Home',teamid_a='Away')
        restored=import_workbook(export_workbook(doc))['document']
        for key in ['Player','Receiver','StatInput','FpaEventId','Half','Direction','Sport']:
            self.assertEqual(restored['rows'][0][key],doc['rows'][0][key],key)
        self.assertIn('6 Kick-in to 5',restored['logs'][0])

    def test_team_action_survives_workbook_roundtrip(self):
        doc=add(req=request('pr'))
        restored=import_workbook(export_workbook(doc))['document']
        self.assertEqual(restored['rows'][0]['Player'],'')
        self.assertEqual(restored['rows'][0]['Action'],'Press')
        self.assertEqual(restored['rows'][0]['StatInput'],'pr')


class NativeEditorTests(unittest.TestCase):
    def test_dual_generator_is_fpc_engine(self):
        from app import fpa
        from app.fpa_workbench import generate_editor_log
        req=request()
        req['dual_pitch']={'actor_team':'home','before':{'dots':req['dots']},'after':{'dots':req['dots']}}
        self.assertEqual(generate_editor_log(req),fpa.generate_log_entry(**req))
        broken=copy.deepcopy(req);broken['dual_pitch']['before']['dots'][0]['meter_x']=float('nan')
        with self.assertRaises(ValueError):generate_editor_log(broken)

    def test_shared_xgot_and_off_target(self):
        from app.fpa_workbench import estimate_editor_xgot
        center=estimate_editor_xgot({'xg':.3,'is_on_target':True,'goalmouth_x':.5,'goalmouth_y':0})
        corner=estimate_editor_xgot({'xg':.3,'is_on_target':True,'goalmouth_x':0,'goalmouth_y':1})
        self.assertGreater(corner['xgot'],center['xgot'])
        self.assertEqual(estimate_editor_xgot({'xg':.3})['xgot'],0)
        with self.assertRaises(ValueError):estimate_editor_xgot({'xg':float('nan')})


if __name__=='__main__':unittest.main()
