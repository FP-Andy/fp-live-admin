// The CSV is a reviewable suggestion. It never writes data or changes referee
// identities; only nonempty commentary fields are copied into local drafts.
export const COMMENT_FIELDS=['focus','observation','difficultyFactors','viewComment','initialCall','decisionBasis','takeaway','assessment'];
export const CSV_HEADERS=['case_id','event_id','capture_id','case_revision','records_version','editorial_version',...COMMENT_FIELDS];
export const FIELD_LABELS={focus:'판독 지점',observation:'화면 관찰',difficultyFactors:'판독 쟁점·난도',viewComment:'시야 해설',initialCall:'최초 콜',decisionBasis:'판독 근거',takeaway:'시사점',assessment:'판독 총평'};

export function parseCommentCsv(text){
 if(typeof text!=='string')throw Error('UTF-8 CSV 파일을 확인하세요.');
 text=text.replace(/^\uFEFF/,'');
 const rows=[];let row=[],field='',quoted=false,closed=false,started=false;
 const finishField=()=>{row.push(field);field='';closed=false;started=false;};
 const finishRow=()=>{finishField();if(row.some(value=>value!==''))rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c===','){finishField();continue;}
  if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;finishRow();continue;}
  if(c==='"'){if(started||closed)throw Error('CSV 따옴표 형식을 확인하세요.');quoted=true;started=true;continue;}
  if(closed)throw Error('CSV 따옴표 뒤의 문자를 확인하세요.');
  started=true;field+=c;
 }
 if(quoted)throw Error('닫히지 않은 CSV 따옴표가 있습니다.');
 if(row.length||field||started||closed)finishRow();
 if(!rows.length)throw Error('CSV 파일이 비어 있습니다.');
 const headers=rows.shift().map(value=>value.trim());
 if(headers.length!==CSV_HEADERS.length||new Set(headers).size!==headers.length||CSV_HEADERS.some(name=>!headers.includes(name)))throw Error('CSV 열이 올바르지 않습니다. 해설 자료 ZIP에 포함된 양식을 사용하세요.');
 if(!rows.length)throw Error('가져올 장면이 없습니다.');
 return rows.map((values,index)=>{if(values.length!==headers.length)throw Error(`${index+2}행의 열 개수가 다릅니다. 쉼표와 따옴표를 확인하세요.`);return Object.fromEntries(headers.map((header,i)=>[header,values[i]]));});
}

export function planCommentImport(text,editorial){
 const rows=parseCommentCsv(text),events=new Map(editorial.events.map(e=>[e.id,e])),seen=new Set(),changes=[];
 if(rows.length>events.size)throw Error('현재 경기의 장면 수보다 행이 많습니다.');
 let stale=false;
 for(const row of rows){
  const id=row.event_id.trim(),event=events.get(id);
  if(row.case_id.trim()!==editorial.caseId)throw Error('다른 경기의 CSV입니다. 해당 경기의 해설 자료를 이용하세요.');
  if(!event||seen.has(id))throw Error('존재하지 않거나 중복된 판독 장면이 있습니다.');
  seen.add(id);
  if(!event.ready||!event.captureId||row.capture_id.trim()!==event.captureId)throw Error(`판독 ${event.number}의 공간 장면이 바뀌었습니다. 최신 해설 자료로 다시 작성하세요.`);
  if(row.case_revision.trim()!==String(editorial.revision)||row.records_version.trim()!==(editorial.recordsVersion||''))throw Error('경기 기록이나 프레임이 바뀌었습니다. 최신 해설 자료로 다시 작성하세요.');
  if(!row.editorial_version.trim())throw Error('CSV의 editorial_version 값이 비어 있습니다.');
  if(row.editorial_version.trim()!==editorial.version)stale=true;
  const fields={};
  for(const key of COMMENT_FIELDS){const value=row[key].replace(/\r\n?/g,'\n').trim();if(!value)continue;const limit=editorial.limits[key];if(!Number.isInteger(limit)||value.length>limit)throw Error(`판독 ${event.number} · ${FIELD_LABELS[key]}은 ${limit}자 이내로 입력하세요.`);if(value!==(event.fields[key]||''))fields[key]=value;}
  if(Object.keys(fields).length)changes.push({id,number:event.number,fields});
 }
 if(!changes.length)throw Error('새로 반영할 코멘트가 없습니다. 빈 칸은 기존 문안을 유지합니다.');
 return {changes,stale,version:editorial.version};
}
