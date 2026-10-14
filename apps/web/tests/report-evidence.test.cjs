const {test}=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm');
const scope={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../lib/futsal-report-evidence.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,scope);
const {observedSeconds,limitedObservationStory}=scope.exports;
test('long elapsed stint and augmentation do not turn five observed seconds into ample evidence',()=>{const p={activeFrom:0,activeTo:900,observed:900,augmentation:{inferredSeconds:270},positions:[{t:10,seconds:3},{t:800,seconds:2}]};assert.equal(observedSeconds(p),5);});
test('clip observation volume to match interval',()=>{assert.equal(observedSeconds({positions:[{t:0,seconds:10},{t:20,seconds:10}]},5,25),10);});
test('short-evidence text does not confuse tracking volume with short actual playing time',()=>{for(const seconds of [0,5,29]){const s=JSON.stringify(limitedObservationStory(seconds));assert.doesNotMatch(s,/짧.{0,5}출전|충분한 출전|앞선 선수의 활동은 합치지/);assert.doesNotMatch(s,/주로 활동|중앙에서 활발/);}assert.match(limitedObservationStory(5).heatComment,/실제 출전시간과 다를/);});
