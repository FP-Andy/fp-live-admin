const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('../apps/web/node_modules/typescript');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function compile(file) {
  return ts.transpile(fs.readFileSync(path.join(root, file), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, ''), { target: ts.ScriptTarget.ES2020 });
}
const source = fs.readFileSync(path.join(root, 'apps/web/components/basketball/BasketballMatchControl.tsx'), 'utf8');
const ast = ts.createSourceFile('control.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let zones;
for (const stmt of ast.statements) if (ts.isVariableStatement(stmt)) {
  for (const decl of stmt.declarationList.declarations) if (decl.name.getText(ast) === 'ZONES') zones = Function(`return (${decl.initializer.getText(ast)})`)();
}
const api = Function('ZONES', compile('apps/web/components/basketball/graphicExports.ts') + '\n' + compile('apps/web/lib/pngArchive.ts') + ';return {shotBand,validShotThresholds,DEFAULT_SHOT_THRESHOLDS,playersForExport,safeFilename,shotGraphic,marginGraphic,reboundGraphic,pngArchive};')(zones);
const custom = { red: 2, yellow: 6, green: 10 };
for (const invalid of [null, {}, {red:0,yellow:0,green:5}, {red:-1,yellow:2,green:5}, {red:0,yellow:6,green:5}, {red:0,yellow:1.5,green:5}, {red:0,yellow:1,green:Infinity}, {red:'0',yellow:1,green:5}]) {
  assert.equal(api.validShotThresholds(invalid), false);
  assert.throws(() => api.shotGraphic([], 'HOME', invalid));
}
assert(api.validShotThresholds(custom));
for (const [points,band] of [[0,'gray'],[1,'gray'],[2,'red'],[5,'red'],[6,'yellow'],[9,'yellow'],[10,'green'],[20,'green']]) {
  assert.equal(api.shotBand(points, 1, custom), band);
  assert.equal(api.shotBand(points, 0, custom), 'gray');
}
for (const [points,band] of [[0,'red'],[1,'yellow'],[4,'yellow'],[5,'green']]) assert.equal(api.shotBand(points, 1), band);
const zone = zones[0].id;
const shots = Array.from({length:3}, (_,i) => ({id:String(i),type:'SHOT',team:'HOME',zoneId:zone,shotResult:'MADE',points:2,period:1,clock:'10:00',timestamp:i,marginAfter:(i+1)*2}));
for (const team of [undefined, 'HOME']) {
  const defaultGraphic = api.shotGraphic(shots, team);
  const customGraphic = api.shotGraphic(shots, team, custom);
  assert(defaultGraphic.includes('fill="#20c35b"'));
  assert(customGraphic.includes('fill="#facc15"'));
  assert(!customGraphic.includes('fill="#20c35b"'));
  assert(customGraphic.includes('fill="#e7e7ed" fill-opacity="0.5"'));
}
assert(!api.shotGraphic([{...shots[0],shotResult:'MISSED'}], 'HOME').includes('fill="#20c35b"'));
const players = api.playersForExport({ HOME: [{number:'7',name:'홈'}, {number:'8',name:'무기록'}, {number:'',name:'미배정1'}, {number:'',name:'미배정2'}], AWAY: [{number:'7',name:'원정'}] }, [{team:'HOME',playerNumber:'9'}]);
assert.equal(players.length, 6);
assert.equal(players.filter(p => p.number === '7').length, 2);
assert.equal(players.find(p => p.number === '9').name, '이름없음');
assert.equal(api.safeFilename('팀/명:7'), '팀_명_7');
for (const [graphic,w,h] of [[api.shotGraphic([], 'HOME'),1017,936], [api.shotGraphic([]),1721,857], [api.marginGraphic([],10,4),1921,1139], [api.reboundGraphic({ar:0,dr:0,ra:0}),886,815]]) {
  assert(graphic.includes(`width="${w}" height="${h}"`));
  assert(!graphic.includes('NaN'));
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'basketball-zip-'));
  try {
    const file = path.join(tmp,'test.zip');
    const blob = await api.pngArchive([{name:'홈-7-김선수-shotmap.png',blob:new Blob(['home'])},{name:'원정-7-이선수-shotmap.png',blob:new Blob(['away'])}]);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    execFileSync('python3',['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert z.read("홈-7-김선수-shotmap.png")==b"home"\n assert z.read("원정-7-이선수-shotmap.png")==b"away"', file]);
    await assert.rejects(api.pngArchive([]));
    await assert.rejects(api.pngArchive([{name:'same.png',blob:new Blob()},{name:'same.png',blob:new Blob()}]));
    console.log('Basketball roster, empty graphics, dimensions, UTF-8 ZIP and CRC checks passed');
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
})().catch(err => { console.error(err); process.exitCode=1; });
