import assert from 'node:assert/strict';
import {renderResolveReceipt,receiptHeader} from '../src/draft/resolve-receipt.ts';
const markdown='## 回答\n\n"引号"与 **强调**\n\n![CPU](/cpu.svg)';
const result={ok:true,answer:{embedded:markdown},run:'hidden-run',sourceHash:'hidden-hash',batch:'hidden-batch',counts:{executed:1,cached:0},approval:'not-required',delivery:{ok:true,messageId:'msg-1'}};
const original=structuredClone(result);
const receipt=renderResolveReceipt(result);
assert(receipt.startsWith(receiptHeader('Succeed')));
assert(receipt.includes('answer message: msg-1'));
assert(receipt.includes('run: hidden-run'));
assert(receipt.includes('executed: 1, cached: 0'));
assert(!receipt.includes(markdown),'the answer belongs to the delivered message, not the receipt');
assert.deepEqual(result,original);
// Delivery unsupported still yields a receipt, never the Answer body.
assert(!renderResolveReceipt({...result,delivery:undefined}).includes(markdown));
// Delivery failure makes the model the only remaining channel: hand it the full Answer.
const failedDelivery=renderResolveReceipt({...result,delivery:{ok:false,error:'no surface'},deliveryNote:'交付失败（no surface）。请把下面的 Answer 原文完整转发给用户。'});
assert(failedDelivery.includes(markdown));assert(failedDelivery.startsWith('交付失败'));
assert.throws(()=>renderResolveReceipt({ok:true}),/Missing resolved Answer/);
const failed=renderResolveReceipt({ok:false,status:'failed',failures:[{name:'root',status:'failed',at:{line:3,column:5},error:'Truncated input'},{name:'blocked',status:'blocked',at:{line:4,column:1},error:'Upstream root is blocked'}],diagnostics:[{span:{start:{line:3,column:5}},message:'Truncated input'}],outputs:[{name:'unused',shape:'hidden-shape'}]});
assert.equal(failed,'ResolveFailed\n-------------\n\n# errors:\n- L3:5: Truncated input');
assert(!failed.includes('Upstream'));assert(!failed.includes('hidden-shape'));
const errors=renderResolveReceipt({ok:false,failures:Array.from({length:25},(_,i)=>({error:'Error '+i,at:{line:i+1,column:1}}))});
assert.equal(errors.split('\n').filter(l=>l.startsWith('- L')).length,20);assert(errors.includes('5 more errors omitted'));
assert.equal(renderResolveReceipt({ok:false,status:'approval-rejected'}),'ResolveFailed\n-------------\n\n# errors:\n- approval-rejected');
const check='CheckFailed\n-----------\n\n# errors:\n- bad type';assert.equal(renderResolveReceipt({ok:false,text:check}),check);
assert.equal(receiptHeader('Succeed'),'Succeed\n-------');assert.equal(receiptHeader('CheckFailed'),'CheckFailed\n-----------');
console.log('Resolve receipt: delivered Answer replaced by message-id receipt, failure fallback keeps the body, compact root failures and status headers passed');
