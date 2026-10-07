let checking;
const sessionError=message=>Object.assign(Error(message),{code:'DRAFT_SESSION'});
/** The server session, never the cached display name, scopes browser drafts. */
export async function verifiedDraftOwner(expectedId){
 if(!checking)checking=fetch('/api/session/me',{credentials:'include',cache:'no-store'}).then(async response=>{
  if(!response.ok)throw sessionError('로그인 상태를 확인한 뒤 초안을 다시 여세요.');
  const user=await response.json();
  if(typeof user.id!=='string'||!user.id||!['OPERATOR','SUPERADMIN'].includes(user.role))throw sessionError('초안 소유자를 확인하지 못했습니다.');
  return user;
 }).catch(error=>{if(error?.code==='DRAFT_SESSION')throw error;throw sessionError('로그인 상태를 확인할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요.');}).finally(()=>{checking=undefined;});
 const user=await checking;
 if(expectedId&&user.id!==expectedId)throw sessionError('로그인 계정이 바뀌었습니다. 이전 계정의 입력은 해당 계정의 복구 자료에 보관됩니다.');
 return user;
}
