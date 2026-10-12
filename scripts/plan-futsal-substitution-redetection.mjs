import fs from 'node:fs';import zlib from 'node:zlib';
import {deriveSubstitutionReport} from '../apps/web/public/fpa-cv/substitution-report.mjs';
import {planSubstitutionRedetection} from '../apps/web/public/fpa-cv/substitution-redetection.mjs';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node scripts/plan-futsal-substitution-redetection.mjs source-bundle.json[.gz] plan.json');
const b=JSON.parse(input.endsWith('.gz')?zlib.gunzipSync(fs.readFileSync(input)):fs.readFileSync(input,'utf8')),saved=b.saved||b.log;
const result=deriveSubstitutionReport(b.snapshot,b.tracks,saved),plan=planSubstitutionRedetection(b.snapshot,b.tracks,saved,result);
fs.writeFileSync(output,JSON.stringify(plan));console.log(JSON.stringify({windows:plan.windows.length,seconds:plan.totalSeconds,logs:plan.windows.flatMap(w=>w.eventIds).length}));
