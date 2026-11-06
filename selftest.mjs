// Self-test: node selftest.mjs  (starts a temp server + a fake ZarinPal; no internet needed)
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fitos-'));
let n = 0;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const j = JSON.parse(b || '{}'); res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('request')) return res.end(JSON.stringify({ data: { code: 100, authority: 'A' + (++n) }, errors: [] }));
    res.end(JSON.stringify({ data: { code: 100, ref_id: 4242 }, errors: [] }));
  });
}).listen(4599);
const tgLog = []; let tgFail = false;
const fakeTg = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
  res.setHeader('Content-Type', 'application/json');
  if (tgFail) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' })); }
  tgLog.push({ url: req.url, body: Buffer.concat(c).toString('latin1') }); res.end(JSON.stringify({ ok: true, result: {} }));
}); }).listen(4597);
const env = { ...process.env, PORT: '4598', PUBLIC_URL: 'http://localhost:4598', DB_PATH: path.join(tmp, 't.db'),
  ZARINPAL_MERCHANT: 'x'.repeat(36), ZARINPAL_BASE: 'http://localhost:4599', OWNER_EMAIL: 'owner@test.com', OWNER_PASSWORD: 'correct-horse-1',
  TELEGRAM_BOT_TOKEN: 'TESTTOKEN123', TELEGRAM_OWNER_CHAT_ID: '8358194582', TELEGRAM_API_BASE: 'http://localhost:4597' };
const srv = spawn(process.execPath, ['--no-warnings', new URL('./fitos.mjs', import.meta.url).pathname], { env, stdio: 'pipe' });
await new Promise(r => srv.stdout.on('data', d => /running/.test(d) && r()));

const B = 'http://localhost:4598'; let cookie = '';
const call = async (m, p, body, extra = {}) => {
  const r = await fetch(B + p, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => ({})), loc: r.headers.get('location') };
};
const rc2 = () => Buffer.from('r').toString('base64');
let pass = 0; const ok = (n, v) => { assert.ok(v, n); pass++; console.log('ok -', n); };
try {
  ok('state needs login', (await call('GET', '/api/state')).status === 401 || assert.fail());
  ok('short password rejected', (await call('POST', '/api/auth/register', { email: 'a@b.com', password: 'short' })).status === 400 || assert.fail());
  const reg = await call('POST', '/api/auth/register', { email: 'gym@test.com', password: 'correct-horse-1', ownerName:'Gym Owner', gymName:'Test Gym' });
  ok('regular gym registration + session', reg.status === 200 && cookie.startsWith('fitos_sid=') || assert.fail());
  ok('public registration cannot claim owner email', (await call('POST', '/api/auth/register', { email: 'owner@test.com', password: 'correct-horse-1' })).status === 409 || assert.fail());
  await call('POST','/api/auth/logout',{});
  await call('POST','/api/auth/login',{email:'owner@test.com',password:'correct-horse-1'});
  ok('owner bootstrapped from server credentials', (await call('GET','/api/me')).json.role==='superadmin' || assert.fail());
  ok('me', (await call('GET', '/api/me')).json.email === 'owner@test.com' || assert.fail());
  ok('SaaS plans available', (await call('GET', '/api/saas/plans')).json.plans.length === 4 || assert.fail());
  const trial=(await call('GET', '/api/saas/subscription')).json.subscription;
  ok('trial subscription created', trial.status === 'active' || assert.fail());
  const pricing=(await call('GET','/api/saas/plans')).json.plans;
  ok('SaaS prices are exact IRR values', JSON.stringify(pricing.map(x=>x.priceIrr).filter(Boolean).sort((a,b)=>a-b))===JSON.stringify([18000000,45000000,80000000]) || assert.fail());
  ok('superadmin role protected endpoint', (await call('GET', '/api/admin/overview')).status === 200 || assert.fail());
  const paidPlan=(await call('GET','/api/saas/plans')).json.plans.find(x=>x.priceIrr>0);
  ok('invalid manual payment rejected before insert', (await call('POST','/api/saas/manual-payment',{planId:paidPlan.id,trackingCode:'x'})).status===400 || assert.fail());
  const ownerCookie = cookie;
  // --- gym manager buys a plan (separate session) ---
  cookie = ''; await call('POST','/api/auth/login',{email:'gym@test.com',password:'correct-horse-1'});
  const gymPlans=(await call('GET','/api/saas/plans')).json;
  ok('card details are served from env/config only', gymPlans.bank && 'cardNumber' in gymPlans.bank || assert.fail());
  const gsub=(await call('GET','/api/saas/subscription')).json.subscription;
  ok('new gym trial is exactly 7 days', Math.round((gsub.endsAt-gsub.startsAt)/864e5)===7 || assert.fail());
  const rc=Buffer.from('fake-receipt').toString('base64');
  const mp=await call('POST','/api/saas/manual-payment',{planId:paidPlan.id,trackingCode:'BANK-12345',receiptData:rc,receiptMime:'image/jpeg'});
  ok('manual payment request stored',mp.status===201 && mp.json.status==='pending' || assert.fail());
  ok('telegram receives real sendPhoto with details', mp.json.telegram==='sent' && tgLog.length===1 && tgLog[0].url==='/botTESTTOKEN123/sendPhoto' && tgLog[0].body.includes('8358194582') && tgLog[0].body.includes('gym@test.com') && tgLog[0].body.includes('BANK-12345') && tgLog[0].body.includes('fake-receipt') || assert.fail());
  tgFail=true;
  const mp2=await call('POST','/api/saas/manual-payment',{planId:paidPlan.id,trackingCode:'BANK-67890',receiptData:rc,receiptMime:'image/png'});
  ok('telegram failure keeps payment pending (not lost)', mp2.status===201 && mp2.json.telegram==='failed' || assert.fail());
  const hist=(await call('GET','/api/saas/subscription')).json.subscription;
  ok('purchase is linked to buyer email and IRR amount',hist.buyerEmail==='gym@test.com' && hist.purchaseAmountIrr===paidPlan.priceIrr || assert.fail());
  ok('gym manager cannot open admin payments', (await call('GET','/api/admin/payments')).status===403 || assert.fail());
  ok('gym manager cannot read receipts', (await call('GET','/api/admin/payments/receipt?id='+mp.json.paymentId)).status===403 || assert.fail());
  ok('gym manager cannot approve own payment', (await call('POST','/api/admin/payments/review',{paymentId:mp.json.paymentId,approve:true})).status===403 || assert.fail());
  ok('gym manager cannot retry telegram', (await call('POST','/api/admin/payments/telegram-retry',{paymentId:mp2.json.paymentId})).status===403 || assert.fail());
  cookie = ownerCookie;
  const bi=await call('POST','/api/buffet/items',{name:'Water',priceIrr:25000,stock:5,unit:'bottle'});
  ok('buffet item created in tenant',bi.status===201 && (await call('GET','/api/buffet/items')).json.items.length===1 || assert.fail());
  const sale=await call('POST','/api/buffet/sales',{itemId:bi.json.id,quantity:2});
  ok('buffet sale updates stock and stores IRR total',sale.status===201 && sale.json.totalIrr===50000 && (await call('GET','/api/buffet/items')).json.items[0].stock===3 || assert.fail());
  ok('buffet rejects sale beyond stock', (await call('POST','/api/buffet/sales',{itemId:bi.json.id,quantity:99})).status===409 || assert.fail());
  ok('buffet stock remains unchanged after rejected sale', (await call('GET','/api/buffet/items')).json.items[0].stock===3 || assert.fail());
  const list=(await call('GET','/api/admin/payments')).json;
  const row=list.payments.find(x=>x.id===mp2.json.paymentId);
  ok('owner sees buyer email, gym, plan, amount, tracking, telegram status', row && row.email==='gym@test.com' && row.gymName==='Test Gym' && row.amountIrr===paidPlan.priceIrr && row.trackingCode==='BANK-67890' && row.telegramStatus==='failed' && !('receiptData' in row) || assert.fail());
  ok('telegram error does not leak bot token', !JSON.stringify(list).includes('TESTTOKEN123') || assert.fail());
  const img=await fetch(B+'/api/admin/payments/receipt?id='+mp.json.paymentId,{headers:{cookie}});
  ok('owner can view private receipt image', img.status===200 && img.headers.get('content-type')==='image/jpeg' && Buffer.from(await img.arrayBuffer()).toString()==='fake-receipt' || assert.fail());
  ok('receipt not accessible without login', (await fetch(B+'/api/admin/payments/receipt?id='+mp.json.paymentId)).status===401 || assert.fail());
  tgFail=true; ok('retry still failing reports failure', (await call('POST','/api/admin/payments/telegram-retry',{paymentId:mp2.json.paymentId})).json.telegram==='failed' || assert.fail());
  tgFail=false; ok('telegram retry succeeds later', (await call('POST','/api/admin/payments/telegram-retry',{paymentId:mp2.json.paymentId})).json.telegram==='sent' || assert.fail());
  ok('reject requires reason', (await call('POST','/api/admin/payments/review',{paymentId:mp2.json.paymentId,approve:false})).status===400 || assert.fail());
  ok('owner rejects with reason', (await call('POST','/api/admin/payments/review',{paymentId:mp2.json.paymentId,approve:false,reason:'رسید نامعتبر'})).json.status==='rejected' || assert.fail());
  ok('rejection reason stored', (await call('GET','/api/admin/payments')).json.payments.find(x=>x.id===mp2.json.paymentId).rejectReason==='رسید نامعتبر' || assert.fail());
  ok('admin payment review activates subscription', (await call('POST','/api/admin/payments/review',{paymentId:mp.json.paymentId,approve:true})).json.status==='approved' || assert.fail());
  const ap=(await call('GET','/api/admin/payments')).json.payments.find(x=>x.id===mp.json.paymentId);
  ok('approved subscription has start/end dates for plan duration', ap.endsAt>ap.startsAt && Math.round((ap.endsAt-ap.startsAt)/864e5)>=90 || assert.fail());
  ok('already-reviewed payment cannot be decided twice', (await call('POST','/api/admin/payments/review',{paymentId:mp.json.paymentId,approve:false,reason:'again'})).status===404 || assert.fail());
  const bad = await call('PUT', '/api/state', { state: { members: 1 }, version: 0 });
  ok('invalid state rejected', bad.status === 400 || assert.fail());
  const st = { plans: [], members: [{ id: 1 }], ms: [], pay: [], att: [] };
  ok('save state v1', (await call('PUT', '/api/state', { state: st, version: 0 })).json.version === 1 || assert.fail());
  ok('stale version -> 409', (await call('PUT', '/api/state', { state: st, version: 0 })).status === 409 || assert.fail());
  ok('foreign origin blocked', (await call('PUT', '/api/state', { state: st, version: 1 }, { Origin: 'http://evil.example' })).status === 403 || assert.fail());
  ok('otp off -> 501', (await call('POST', '/api/auth/phone/request', { phone: '09123456789' })).status === 501 || assert.fail());
  const p = await call('POST', '/api/pay/start', { orderId: 'ORD7', amountIrr: 20000, description: 't' });
  ok('pay start', p.json.paymentUrl === 'http://localhost:4599/pg/StartPay/A1' || assert.fail());
  ok('duplicate order blocked', (await call('POST', '/api/pay/start', { orderId: 'ORD7', amountIrr: 20000 })).status === 409 || assert.fail());
  ok('callback cancelled -> failed', (await call('GET', '/api/pay/callback?Authority=A1&Status=NOK')).loc.includes('pay=failed') || assert.fail());
  const p2 = await call('POST', '/api/pay/start', { orderId: 'ORD8', amountIrr: 20000 });
  ok('callback verified -> ok', (await call('GET', '/api/pay/callback?Authority=A2&Status=OK')).loc.includes('pay=ok') || assert.fail());
  const s = await call('GET', '/api/pay/status?order=ORD8');
  ok('status verified with ref and IRR amount', s.json.status === 'verified' && s.json.ref === '4242' && s.json.amountIrr === 20000 || assert.fail());
  await call('POST', '/api/auth/logout'); const old = cookie; cookie = '';
  ok('logged out', (await call('GET', '/api/me')).status === 401 || assert.fail());
  ok('wrong password', (await call('POST', '/api/auth/login', { email: 'owner@test.com', password: 'nope-nope-nope' })).status === 401 || assert.fail());
  ok('login + data persisted', ((await call('POST', '/api/auth/login', { email: 'owner@test.com', password: 'correct-horse-1' })).status === 200 && (await call('GET', '/api/state')).json.version === 1) || assert.fail());
  let last; for (let i = 0; i < 9; i++) last = await call('POST', '/api/auth/login', { email: 'owner@test.com', password: 'x' + i });
  ok('login rate limit', last.status === 429 || assert.fail());
  // --- second server: defaults (no OWNER_EMAIL, no password, no Telegram token) ---
  const env2 = { ...process.env, PORT: '4596', PUBLIC_URL: 'http://localhost:4596', DB_PATH: path.join(tmp, 't2.db') };
  for (const k of ['OWNER_EMAIL','OWNER_PASSWORD','TELEGRAM_BOT_TOKEN','TELEGRAM_OWNER_CHAT_ID']) env2[k] = "";
  const srv2 = spawn(process.execPath, ['--no-warnings', new URL('./fitos.mjs', import.meta.url).pathname], { env: env2, stdio: 'pipe' });
  await new Promise(r => srv2.stdout.on('data', d => /running/.test(d) && r()));
  try {
    const r2 = (p, b, c) => fetch('http://localhost:4596' + p, { method: b ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}) }, body: b && JSON.stringify(b) });
    ok('default Owner e-mail cannot be claimed by public registration', (await r2('/api/auth/register', { email: 'owner@example.com', password: 'correct-horse-1', gymName: 'X', ownerName: 'X' })).status === 409 || assert.fail());
    const rg = await r2('/api/auth/register', { email: 'x@y.com', password: 'correct-horse-1', gymName: 'Y', ownerName: 'Y' });
    const c2 = rg.headers.get('set-cookie').split(';')[0];
    const pl = (await (await r2('/api/saas/plans', null, c2)).json()).plans.find(x => x.priceIrr > 0);
    const m2 = await (await r2('/api/saas/manual-payment', { planId: pl.id, trackingCode: 'ABCD1234', receiptData: rc2(), receiptMime: 'image/png' }, c2)).json();
    ok('without token: honest not_configured status, payment still saved', m2.status === 'pending' && m2.telegram === 'not_configured' || assert.fail());
    ok('role tampering: gym user cannot open owner API', (await r2('/api/admin/overview', null, c2)).status === 403 || assert.fail());
  } finally { srv2.kill(); }
  console.log(`\nAll ${pass} checks passed.`);
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; } finally { srv.kill(); fake.close(); fakeTg.close(); }
