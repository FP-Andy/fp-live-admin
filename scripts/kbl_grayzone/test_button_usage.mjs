import test from 'node:test';
import assert from 'node:assert/strict';
import {trackedAction} from '../../apps/web/public/kbl-grayzone/button-usage.mjs';
const event=(id,extra={})=>({isTrusted:true,target:{closest:()=>({id,...extra})}});
test('only explicitly allowed active controls count, without recording content',()=>{
 assert.equal(trackedAction('report',event('generate')),'generate');
 assert.equal(trackedAction('report',event('generate',{disabled:true})),null);
 assert.equal(trackedAction('objects',event('generate')),null);
 assert.equal(trackedAction('report',event('private-value')),null);
 assert.equal(trackedAction('report',{...event('generate'),isTrusted:false}),null);
 assert.equal(trackedAction('report',{isTrusted:true,target:null}),null);
});
