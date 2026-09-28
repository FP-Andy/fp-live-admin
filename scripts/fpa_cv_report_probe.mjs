import fs from 'node:fs';
import {reportMetrics} from './fpa_cv_report_metrics.mjs';
const [input,settings,output]=process.argv.slice(2);
if(!input||!settings||!output)throw Error('Usage: node scripts/fpa_cv_report_probe.mjs heatmaps.json settings.json report.json');
const source=JSON.parse(fs.readFileSync(input,'utf8')),config=JSON.parse(fs.readFileSync(settings,'utf8'));
const start=performance.now(),report=reportMetrics(source,config);
report.inputFile=input;report.settingsSource=config.source||null;report.generatedAt=new Date().toISOString();report.computeMilliseconds=performance.now()-start;
fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,players:report.players.length,milliseconds:report.computeMilliseconds,comparisonEligible:report.players.filter(p=>p.timeComparisonAllowed).length,distanceSensitivityRange:[Math.min(...report.players.map(p=>p.distance.smoothingSensitivity)),Math.max(...report.players.map(p=>p.distance.smoothingSensitivity))]}));
