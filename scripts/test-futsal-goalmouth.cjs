const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('../apps/web/node_modules/typescript');
const React = require('../apps/web/node_modules/react');
const { renderToStaticMarkup } = require('../apps/web/node_modules/react-dom/server');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/admin/match/[id]/page.tsx'), 'utf8');
const ast = ts.createSourceFile('match.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let surface, submit, goalHandler;
function visit(node) {
  if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression) && node.expression.whenTrue.getText(ast).includes('className="fla-goalmouth"') && node.expression.condition.getText(ast).startsWith('isOnTargetShot')) surface = node.expression;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'submitXgInternal') submit = node.initializer;
  if (ts.isJsxElement(node) && node.children.some(c => ts.isJsxText(c) && c.text.trim() === '골')) {
    const attr = node.openingElement.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'onClick');
    goalHandler = attr.initializer.expression;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compile = code => ts.transpile(code, {target:ts.ScriptTarget.ES2020, jsx:ts.JsxEmit.React});
function make(code,env) { return Function(...Object.keys(env),compile('const fn = '+code)+';return fn;')(...Object.values(env)); }
for (const isFutsal of [true,false]) {
  for (const active of [true,false]) {
    const View = make('() => ('+surface.getText(ast)+')', {React,isFutsal,isOnTargetShot:active,goalmouthPoint:{x:.25,y:.75},onGoalmouthClick:()=>{}});
    const html = renderToStaticMarkup(React.createElement(View));
    assert.equal(html.includes('aria-label="골문 도착 위치 선택"'),active);
    if (active) assert(html.includes('left:25%;top:25%'));
  }
}
for (const previous of [true,false]) {
  let goal, target;
  make(goalHandler.getText(ast), {isGoalShot:previous,isFutsal:true,setIsGoalShot:v=>goal=v,setIsOnTargetShot:v=>target=v})();
  assert.equal(goal,!previous); assert.equal(target,!previous);
}
async function checkSubmit(coordinates) {
  let payload, notice;
  const code = submit.getText(ast);
  const env = Object.fromEntries([...new Set(code.match(/\bset[A-Z]\w+/g))].map(name=>[name,()=>{}]));
  Object.assign(env, {canWrite:true,isOwnGoal:false,isGoalShot:true,isOnTargetShot:true,
    xgValue:'0.25',xgTeam:'HOME',clockMs:60000,id:'fixture',selectedXgPlayer:{name:'Test',number:'7'},
    isHeaderShot:false,isUnderPressureShot:false,isOneOnOneShot:false,
    getShotCoordinates:()=>({shot_x:34,shot_y:10}),getGoalmouthCoordinates:()=>coordinates,
    makeId:()=> 'test-event',setControlNotice:v=>notice=v,fetchAll:async()=>{},
    apiFetch:async(_,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({})};}});
  await make(code,env)();
  if (!coordinates) { assert.equal(payload,undefined); assert(notice.includes('골문')); }
  else {
    assert.equal(payload.is_goal,true); assert.equal(payload.is_on_target,true);
    assert.equal(payload.goalmouth_x,.25); assert.equal(payload.goalmouth_y,.75);
    assert.equal(payload.shot_x,34); assert.equal(payload.shot_y,10);
  }
}
(async()=>{
  await checkSubmit({goalmouth_x:.25,goalmouth_y:.75});
  await checkSubmit(null);
  console.log('Futsal/football goalmouth rendering, goal toggle reset, coordinates in shot payload and required-position validation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
