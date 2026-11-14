// A local read-only QA route has test-only auth and must never ship in FPC.
const fs = require('node:fs');
const path = require('node:path');

function assertProductionRoutes(root) {
  if (fs.existsSync(path.join(root, 'app', 'courtside-preview'))) {
    throw new Error('로컬 전용 courtside-preview가 포함되어 있습니다. 미리보기 파일이 없는 배포 사본에서 빌드하세요.');
  }
  // The public directory is served without the FPC match authorization bridge.
  // Development/demo imagery and generated player meshes must never go there.
  for (const dir of ['frames', 'posters', 'review-survey', 'assets/poses', 'data']) {
    const target = path.join(root, 'public', 'kbl-grayzone', dir);
    if (fs.existsSync(target)) {
      throw new Error(`로컬 경기 자료가 공개 빌드에 포함되어 있습니다: public/kbl-grayzone/${dir}`);
    }
  }
  // These local entry points contain a hard-coded historical game and are not
  // used as the FPC workbench entry. Never publish them as static web assets.
  for (const file of ['index.html', 'case.html', 'case.mjs']) {
    if (fs.existsSync(path.join(root, 'public', 'kbl-grayzone', file))) {
      throw new Error(`로컬 경기 전용 화면이 공개 빌드에 포함되어 있습니다: public/kbl-grayzone/${file}`);
    }
  }
}

if (require.main === module) {
  try { assertProductionRoutes(process.cwd()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { assertProductionRoutes };
