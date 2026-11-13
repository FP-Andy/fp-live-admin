const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertProductionRoutes } = require('../scripts/check-production-routes.cjs');

test('production build rejects the local-only Courtside preview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'courtside-routes-'));
  try {
    assert.doesNotThrow(() => assertProductionRoutes(root));
    fs.mkdirSync(path.join(root, 'app', 'courtside-preview'), { recursive: true });
    assert.throws(() => assertProductionRoutes(root), /로컬 전용 courtside-preview/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production build rejects every local game imagery and pose directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'courtside-private-assets-'));
  try {
    for (const dir of ['frames', 'posters', 'review-survey', 'assets/poses', 'data']) {
      const target = path.join(root, 'public', 'kbl-grayzone', dir);
      fs.mkdirSync(target, { recursive: true });
      assert.throws(() => assertProductionRoutes(root), /로컬 경기 자료가 공개 빌드/);
      fs.rmSync(target, { recursive: true, force: true });
    }
    assert.doesNotThrow(() => assertProductionRoutes(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
