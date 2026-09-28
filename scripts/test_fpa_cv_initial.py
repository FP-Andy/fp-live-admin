import copy
import unittest
from fpa_cv_initial import SLOTS, initial_review, validate_initial, initial_detections, initial_track_seeds


class InitialMatching(unittest.TestCase):
    def setUp(self):
        self.roster=[{'id':pid,'group':group,'jersey':'REF' if group=='referee' else str(i+1),'detectionId':i+1} for i,(pid,group) in enumerate(SLOTS.items())]
        self.boxes=[{'id':i+1,'box':[.01+i*.075,.2,.04+i*.075,.3],'confidence':.8} for i in range(13)]
        palette={g:[[20+i*40,100,200]] for i,g in enumerate(('home_gk','home','referee','away','away_gk'))}
        self.seed={'preparationId':'test','uniforms':palette,'roster':self.roster}
        self.prepared={'time':1,'frameIndex':30,'boxes':self.boxes}
        self.data={'datasetId':'independent-run','video':{'clipStart':0,'clipEnd':3},'detector':{'sampleFps':15},
          'frames':[{'t':1,'boxes':[{'id':100+i,'box':b['box']} for i,b in enumerate(self.boxes)]}],
          'tracks':[{'id':100+i,'first':0,'last':2.9} for i in range(13)]}

    def test_numbers_follow_positions_not_temporary_detection_ids(self):
        setup=validate_initial(self.seed,self.prepared)
        self.data['frames'][0]['boxes'].reverse()
        result=initial_review(self.data,setup)
        self.assertEqual(len(result['segments']),13)
        self.assertEqual(result['setup'],{'time':1})
        self.assertEqual(result['segments'][0]['trackId'],100)
        self.assertEqual(result['segments'][0]['personId'],'home_gk-1')
        self.assertEqual(result['datasetId'],'independent-run')

    def test_ambiguous_merged_boxes_are_not_forced_into_roster(self):
        setup=validate_initial(self.seed,self.prepared)
        setup['roster'][1]['box']=setup['roster'][0]['box']
        result=initial_review(self.data,setup)
        self.assertEqual(len(result['segments']),11)
        self.assertEqual(result['setup'],{'time':1},'One missing seed must not disable everyone else')
        self.assertEqual(set(result['initialization']['unmatched']),{'home_gk-1','home-1'})

    def test_anchor_roundoff_does_not_fall_before_clip_start(self):
        setup=validate_initial(self.seed,self.prepared)
        self.data['video']['clipStart']=1.0000000000000002
        result=initial_review(self.data,setup)
        self.assertGreaterEqual(result['setup']['time'],self.data['video']['clipStart'])

    def test_missing_anchor_is_rejected(self):
        setup=validate_initial(self.seed,self.prepared)
        self.data['frames'][0]['t']=1.1
        with self.assertRaises(ValueError):initial_review(self.data,setup)

    def test_duplicate_numbers_and_missing_colors_are_rejected(self):
        bad=copy.deepcopy(self.seed);bad['roster'][1]['jersey']='01'
        with self.assertRaises(ValueError):validate_initial(bad,self.prepared)
        bad=copy.deepcopy(self.seed);bad['uniforms']['home']=[]
        with self.assertRaises(ValueError):validate_initial(bad,self.prepared)

    def test_excluded_ids_are_valid_unique_and_not_assigned(self):
        for ids in ([1],[999],[True],'14'):
            with self.subTest(ids=ids),self.assertRaises(ValueError):
                validate_initial({**self.seed,'excludedDetectionIds':ids},self.prepared)
        self.prepared['boxes'].append({'id':14,'box':[.1,.2,.3,.4],'confidence':.7})
        with self.assertRaises(ValueError):validate_initial({**self.seed,'excludedDetectionIds':[14,14]},self.prepared)
        valid=validate_initial({**self.seed,'excludedDetectionIds':[14],'detections':[{'id':999,'box':[0,0,1,1]}]},self.prepared)
        self.assertEqual(valid['excludedDetectionIds'],[14])
        self.assertEqual(valid['detections'],self.prepared['boxes'])

    def test_low_confidence_body_is_seeded_and_shadow_box_is_not_sent_to_tracker(self):
        self.prepared['boxes'][0]['confidence']=.12
        self.prepared['boxes'].append({'id':99,'box':[.01,.2,.09,.3],'confidence':.8})
        seed=validate_initial({**self.seed,'excludedDetectionIds':[99]},self.prepared)
        # Detection list order is unrelated to roster order or final track IDs.
        seed['detections'].reverse()
        rows,scores,teams=initial_detections(seed,1920,1080,.25)
        self.assertEqual(len(rows),13)
        self.assertEqual(rows[-1][:4],[.01*1920,.2*1080,.04*1920,.3*1080])
        self.assertEqual(rows[-1][4],.25)
        self.assertEqual(scores[-1],.12)
        self.assertEqual(teams[-1],1)
        self.assertEqual(teams[6],0)

    def test_reviewed_detection_provenance_preserves_close_people(self):
        setup=validate_initial(self.seed,self.prepared)
        setup['roster'][1]['box']=setup['roster'][0]['box']
        setup['excludedDetectionIds']=[]
        setup['detections'].reverse()
        output=[[0,0,0,0,100+12-i,.8,0,i] for i in range(13)]
        assignments=initial_track_seeds(setup,output)
        self.data['detector']['initialSetup']={'frameIndex':30,'assignments':assignments}
        result=initial_review(self.data,setup)
        self.assertEqual(len(result['segments']),13)
        self.assertEqual(result['segments'][1]['trackId'],101)
        self.assertEqual(result['initialization']['matches'][1]['method'],'reviewed-detection')

    def test_absent_provenance_observation_is_not_invented(self):
        setup=validate_initial(self.seed,self.prepared)
        self.data['detector']['initialSetup']={'frameIndex':30,'assignments':[]}
        result=initial_review(self.data,setup)
        self.assertEqual(result['segments'],[])
        self.assertEqual(len(result['initialization']['failures']),13)
        self.assertIsNone(result['setup'])

    def test_duplicate_provenance_is_rejected(self):
        setup=validate_initial(self.seed,self.prepared)
        links=[{'personId':p['id'],'detectionId':p['detectionId'],'trackId':100} for p in setup['roster']]
        self.data['detector']['initialSetup']={'frameIndex':30,'assignments':links}
        self.assertEqual(initial_review(self.data,setup)['segments'],[])

    def test_unselected_near_identical_box_does_not_create_initial_track(self):
        self.prepared['boxes'].append({'id':90,'box':self.boxes[0]['box'][:],'confidence':.9})
        setup=validate_initial(self.seed,self.prepared)
        rows,_,_=initial_detections(setup,1920,1080,.25)
        self.assertEqual(len(rows),13)
        self.prepared['boxes'][1]['box']=self.boxes[0]['box'][:]
        setup=validate_initial(self.seed,self.prepared)
        self.assertEqual(len(initial_detections(setup,1920,1080,.25)[0]),13,'Both human selections remain')

    def test_legacy_reviewed_exact_box_is_not_rejected_by_near_duplicate(self):
        setup=validate_initial(self.seed,self.prepared)
        copybox=self.data['frames'][0]['boxes'][0]['box'][:];copybox[0]+=.0002
        self.data['frames'][0]['boxes'].append({'id':999,'box':copybox})
        self.data['detector']['initialSetup']={'frameIndex':30,'source':'operator-reviewed-frame'}
        result=initial_review(self.data,setup)
        self.assertEqual(len(result['segments']),13)
        self.assertEqual(result['segments'][0]['trackId'],100)
        self.assertEqual(result['initialization']['matches'][0]['method'],'exact-reviewed-box')


if __name__=='__main__':unittest.main()
