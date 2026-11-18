"""PostgreSQL-only tests; create an isolated schema in the explicit CI database."""
import os,time,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine,text
from sqlalchemy.orm import sessionmaker
from app.auth import require_session_user
from app.courtside_access import router,record_presence
from app.db import Base,get_db
from app.models import User,Match,CourtsideEditor,CourtsidePresence

URL=os.environ.get('FPC_TEST_DATABASE_URL','')
parsed=urlsplit(URL)
SAFE=parsed.hostname in ('127.0.0.1','localhost') and parsed.path=='/fpc_release_qa'

@unittest.skipUnless(SAFE,'requires the dedicated local PostgreSQL QA database')
class CollaborationPostgresTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.schema='courtside_qa_'+uuid.uuid4().hex
  cls.admin=create_engine(URL)
  with cls.admin.begin() as connection:connection.execute(text('CREATE SCHEMA '+cls.schema))
  cls.engine=create_engine(URL,connect_args={'options':'-csearch_path='+cls.schema})
  Base.metadata.create_all(cls.engine,tables=[User.__table__,Match.__table__,CourtsideEditor.__table__,CourtsidePresence.__table__])
  cls.Session=sessionmaker(bind=cls.engine,expire_on_commit=False)
 @classmethod
 def tearDownClass(cls):
  cls.engine.dispose()
  with cls.admin.begin() as connection:connection.execute(text('DROP SCHEMA '+cls.schema+' CASCADE'))
  cls.admin.dispose()
 def setUp(self):
  self.mid=uuid.uuid4()
  with self.Session.begin() as db:
   db.add_all([User(id='owner',name='담당자',role='OPERATOR'),User(id='one',name='작업자 1',role='OPERATOR'),User(id='two',name='작업자 2',role='OPERATOR')]);db.flush()
   db.add(Match(id=self.mid,name='테스트 경기',sport='BASKETBALL',operator_id='owner'))
  self.app=FastAPI();self.app.include_router(router)
  def session():
   with self.Session() as db:yield db
  self.app.dependency_overrides[get_db]=session
  self.app.dependency_overrides[require_session_user]=lambda:User(id='owner',name='담당자',role='OPERATOR')
  self.client=TestClient(self.app);self.base=f'/api/courtside/matches/{self.mid}'
 def tearDown(self):
  self.client.close()
  with self.engine.begin() as c:
   c.execute(text('DELETE FROM courtside_presence'));c.execute(text('DELETE FROM courtside_editors'));c.execute(text('DELETE FROM matches'));c.execute(text('DELETE FROM users'))
 def test_concurrent_editor_changes_and_recent_activity(self):
  version=self.client.get(self.base+'/editors').json()['version']
  def assign(ident):return self.client.post(self.base+'/editors',json={'version':version,'editorIds':[ident]},headers={'origin':'http://testserver'})
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(assign,['one','two']))
  self.assertEqual(sorted(r.status_code for r in results),[200,409])
  winner=next(r.json()['editorIds'][0] for r in results if r.status_code==200)
  self.app.dependency_overrides[require_session_user]=lambda:User(id=winner,name='동료',role='OPERATOR')
  self.assertTrue(self.client.get(self.base+'/access').json()['canEdit'])
  with self.Session() as db:record_presence(db,self.mid,User(id=winner,name='동료',role='OPERATOR'),{'records':[{'stage':'spatial','eventId':'review-2','attention':'active','endedAtMs':time.time()*1000}]})
  people=self.client.get(self.base+'/presence').json()['people'];self.assertEqual(len(people),1);self.assertEqual(people[0]['stage'],'spatial');self.assertEqual(people[0]['eventId'],'review-2')

if __name__=='__main__':unittest.main()
