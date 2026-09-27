import {trackingUI} from './tracking.mjs';
import {connectConsole} from './console-embed.mjs';

export function workbenchShell({openRun,pause}){
 connectConsole();
 const tabs=[...document.querySelectorAll('[data-app-tab]')];
 const panels={tracking:document.getElementById('tracking-panel'),work:document.getElementById('work-panel'),guide:document.getElementById('guide-panel')};
 let current=null;
 const frame=document.getElementById('guide-frame');
 function select(tab,update=true){
  if(!panels[tab])tab='tracking';
  if(tab!==current){pause();document.getElementById('tracking-preview').pause();}current=tab;
  for(const [name,panel] of Object.entries(panels))panel.hidden=name!==tab;
  for(const button of tabs){const active=button.dataset.appTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}
  if(tab==='guide'&&!frame.src)frame.src='./guide.html?embed=1';
  if(update){const url=new URL(location.href);url.hash=tab;history.replaceState(null,'',url);}
  document.title=`${tab==='tracking'?'영상 트래킹':tab==='work'?'작업 화면':'사용 가이드'} · FPA`;
  window.dispatchEvent(new Event('fpa-cv:navigation'));
 }
 for(const button of tabs){button.onclick=()=>select(button.dataset.appTab);button.onkeydown=event=>{const i=tabs.indexOf(button);let next;if(event.key==='ArrowRight')next=tabs[(i+1)%tabs.length];if(event.key==='ArrowLeft')next=tabs[(i+tabs.length-1)%tabs.length];if(event.key==='Home')next=tabs[0];if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();event.stopPropagation();next.focus();select(next.dataset.appTab);}};}
 document.addEventListener('click',event=>{
  const link=event.target.closest('a[href*="guide.html"]');if(!link)return;
  event.preventDefault();const target=new URL(link.href);frame.src='./guide.html?embed=1'+target.hash;select('guide');
 });
 window.addEventListener('hashchange',()=>select(location.hash.slice(1),false));
 const params=new URLSearchParams(location.search);
 select(location.hash.slice(1)||((params.get('autoload')==='1'||params.has('job'))?'work':'tracking'),false);
 const tracking=trackingUI({openJob:async id=>{await openRun(id);select('work');}});
 return {select,tracking,active:()=>current};
}
