"""Security boundaries for the same auth router used by production and preview."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

_TMP = tempfile.TemporaryDirectory()
os.environ['DATABASE_URL'] = 'sqlite:///' + str(Path(_TMP.name) / 'test.sqlite3')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy import select
from app import auth
from app.auth_security import hash_secret, verify_secret
from app.db import Base, SessionLocal, engine
from app.models import AdminAccount, AuditLog, AuthSession, LoginThrottle, OperatorAccessPolicy, User

@compiles(JSONB, 'sqlite')
def jsonb_as_json(element, compiler, **kw):
    return 'JSON'

TABLES = [model.__table__ for model in (User, AdminAccount, OperatorAccessPolicy, AuthSession, LoginThrottle, AuditLog)]
app = FastAPI()
app.include_router(auth.router)

class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.encoded = hash_secret('admin-test-password')

    def setUp(self):
        Base.metadata.drop_all(engine, tables=TABLES)
        Base.metadata.create_all(engine, tables=TABLES)
        self.manifest = Path(_TMP.name) / 'accounts.json'
        self.provision([{'login': 'qa-admin', 'name': 'QA Admin', 'password_hash': self.encoded}])
        self.admin = TestClient(app)
        self.operator = TestClient(app)

    def provision(self, accounts):
        self.manifest.write_text(json.dumps({'version': 1, 'accounts': accounts}))
        with SessionLocal() as db:
            auth.bootstrap_admin_accounts(db, str(self.manifest))

    def login_admin(self):
        response = self.admin.post('/api/session/login', json={'name': 'QA-Admin', 'access_key': 'admin-test-password', 'mode': 'ADMIN'})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def enable_operator(self, code='operator-test-code'):
        self.login_admin()
        response = self.admin.put('/api/admin/access/operator-code', json={'code': code})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['operator_enabled'])
        self.assertNotIn(code, response.text)
        self.assertNotIn('password_hash', response.text)

    def test_admin_allowlist_and_password(self):
        for name, password in [('anyone', 'admin-test-password'), ('qa-admin', 'wrong-password')]:
            self.assertEqual(self.admin.post('/api/session/login', json={'name': name, 'access_key': password}).status_code, 401)
        self.assertEqual(self.login_admin()['role'], 'SUPERADMIN')
        self.assertEqual(self.admin.get('/api/session/me').status_code, 200)
        self.assertEqual(len(self.admin.get('/api/admin/access').json()['admins']), 1)

    def test_operator_disabled_until_admin_sets_code(self):
        self.assertEqual(self.operator.post('/api/session/login', json={'name': 'any name', 'access_key': 'operator-test-code', 'mode': 'OPERATOR'}).status_code, 401)
        self.assertEqual(self.operator.put('/api/admin/access/operator-code', json={'code': 'operator-test-code'}).status_code, 401)

    def test_role_separation_and_code_rotation(self):
        admin_id = self.login_admin()['id']
        self.enable_operator()
        response = self.operator.post('/api/session/login', json={'name': 'qa-admin', 'access_key': 'operator-test-code', 'mode': 'OPERATOR'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['role'], 'OPERATOR')
        self.assertNotEqual(response.json()['id'], admin_id)
        for method, path, kwargs in [('get', '/api/admin/access', {}), ('put', '/api/admin/access/operator-code', {'json': {'code': 'another-operator-code'}}), ('delete', '/api/admin/access/operator-code', {})]:
            self.assertEqual(getattr(self.operator, method)(path, **kwargs).status_code, 403)
        self.admin.put('/api/admin/access/operator-code', json={'code': 'rotated-operator-code'})
        self.assertEqual(self.operator.get('/api/session/me').status_code, 401)
        self.assertEqual(self.admin.get('/api/session/me').status_code, 200)
        self.assertEqual(self.operator.post('/api/session/login', json={'name': 'new name', 'access_key': 'operator-test-code', 'mode': 'OPERATOR'}).status_code, 401)
        self.assertEqual(self.operator.post('/api/session/login', json={'name': 'new name', 'access_key': 'rotated-operator-code', 'mode': 'OPERATOR'}).status_code, 200)
        self.admin.delete('/api/admin/access/operator-code')
        self.assertEqual(self.operator.get('/api/session/me').status_code, 401)

    def test_logout_expiry_and_legacy_cookie(self):
        self.admin.cookies.set(auth.COOKIE_NAME, 'qa-admin.legacy-signature')
        self.assertEqual(self.admin.get('/api/session/me').status_code, 401)
        self.admin.cookies.clear()
        self.login_admin()
        token = self.admin.cookies.get(auth.COOKIE_NAME)
        self.admin.post('/api/session/logout')
        with SessionLocal() as db:
            self.assertIsNone(auth.user_from_token(db, token))
        self.login_admin()
        with SessionLocal() as db:
            for session in db.scalars(select(AuthSession)):
                session.expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        self.assertEqual(self.admin.get('/api/session/me').status_code, 401)

    def test_allowlist_removal_and_password_change_revoke_sessions(self):
        self.login_admin()
        self.provision([{'login': 'qa-admin', 'name': 'QA Admin', 'password_hash': hash_secret('changed-password')}])
        self.assertEqual(self.admin.get('/api/session/me').status_code, 401)
        self.admin.post('/api/session/login', json={'name': 'qa-admin', 'access_key': 'changed-password'})
        self.provision([{'login': 'other-admin', 'name': 'Other Admin', 'password_hash': self.encoded}])
        self.assertEqual(self.admin.get('/api/session/me').status_code, 401)
        self.assertEqual(self.admin.post('/api/session/login', json={'name': 'qa-admin', 'access_key': 'changed-password'}).status_code, 401)

    def test_throttling_and_hash_only_storage(self):
        with SessionLocal() as db:
            db.add(LoginThrottle(key=auth.fingerprint('testclient'), failures=auth.MAX_LOGIN_FAILURES, window_start=datetime.utcnow()))
            db.commit()
        self.assertEqual(self.admin.post('/api/session/login', json={'name': 'qa-admin', 'access_key': 'admin-test-password'}).status_code, 429)
        self.assertNotIn('admin-test-password', self.manifest.read_text())
        self.assertTrue(verify_secret('admin-test-password', self.encoded))
        self.assertFalse(verify_secret('admin-test-password', None))

    def test_legacy_environment_keys_do_not_grant_access(self):
        os.environ['SUPERADMIN_ACCESS_KEY'] = 'legacy-shared-admin-key'
        os.environ['OPERATOR_ACCESS_KEY'] = 'legacy-shared-operator-key'
        for mode, key in [('ADMIN', 'legacy-shared-admin-key'), ('OPERATOR', 'legacy-shared-operator-key')]:
            self.assertEqual(self.admin.post('/api/session/login', json={'name': 'qa-admin', 'access_key': key, 'mode': mode}).status_code, 401)

if __name__ == '__main__':
    unittest.main()
