#!/usr/bin/env node
// FitOS - zero-dependency server (Node >= 22.13). Run: node fitos.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
try { // tiny .env loader
  for (const l of fs.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }
const E = process.env;
const PORT = +E.PORT || 3000, HOST = E.HOST || '0.0.0.0';
const PUBLIC_URL = (E.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = PUBLIC_URL.startsWith('https://');
const ZP = E.ZARINPAL_BASE || (E.ZARINPAL_SANDBOX === '1' ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com');
const features = () => ({ gateway: !!E.ZARINPAL_MERCHANT, otp: !!(E.KAVENEGAR_API_KEY && E.KAVENEGAR_TEMPLATE) });

const db = new DatabaseSync(E.DB_PATH || path.join(dir, 'fitos.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL, phone TEXT UNIQUE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, uid INTEGER NOT NULL REFERENCES users(id), exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS states(uid INTEGER PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps(uid INTEGER PRIMARY KEY, phone TEXT, code_hash TEXT, exp INTEGER, tries INTEGER, sent INTEGER);
CREATE TABLE IF NOT EXISTS pay_tx(uid INTEGER NOT NULL, order_id TEXT NOT NULL, authority TEXT UNIQUE, amount_toman INTEGER NOT NULL, status TEXT NOT NULL, ref TEXT, created INTEGER NOT NULL, PRIMARY KEY(uid, order_id));
`);
migrate(db);
const q = (sql) => db.prepare(sql);
// Bootstrap the platform administrator only when its email is explicitly configured.
// Single central Owner: fixed default e-mail, password only from the environment.
const OWNER_EMAIL = String(E.OWNER_EMAIL || 'owner@example.com').trim().toLowerCase();
const TRIAL_DAYS = 7;
const SUPPORT_TG = E.SUPPORT_TELEGRAM || '';
// Any superadmin other than the configured Owner is demoted: exactly one Owner may exist.
q("UPDATE users SET role='gym_owner' WHERE role='superadmin' AND email<>? COLLATE NOCASE").run(OWNER_EMAIL);

{
  const now=Date.now();
  const plans=[{code:'trial',name:'Trial',irr:0,days:TRIAL_DAYS},{code:'quarterly',name:'3 Months',irr:18000000,days:90},{code:'half_year',name:'6 Months',irr:45000000,days:180},{code:'yearly',name:'1 Year',irr:80000000,days:365}];
  for(const p of plans){
    const old=q('SELECT id FROM saas_plans WHERE code=?').get(p.code);
    if(old) q('UPDATE saas_plans SET name=?,price_irr=?,price_toman=?,duration_days=?,active=1 WHERE id=?').run(p.name,p.irr,Math.round(p.irr/10),p.days,old.id);
    else q('INSERT INTO saas_plans(code,name,price_toman,price_irr,duration_days,created_at) VALUES(?,?,?,?,?,?)').run(p.code,p.name,Math.round(p.irr/10),p.irr,p.days,now);
  }
  q("UPDATE saas_plans SET active=0 WHERE code IN ('monthly')").run();
}

// Every account owns exactly one gym tenant. Legacy JSON states are imported once into tenant-scoped tables.
const ensureGym = (uid, name='My Gym') => {
  let g=q('SELECT id FROM gyms WHERE owner_uid=?').get(uid);
  if (!g) { const r=q('INSERT INTO gyms(owner_uid,name,created_at) VALUES(?,?,?)').run(uid,String(name||'My Gym').slice(0,100),Date.now()); g={id:Number(r.lastInsertRowid)}; }
  return g.id;
};
const putRows = (table,gid,rows,extra=()=>[]) => {
  const cols = table==='gym_memberships'?'id,gym_id,member_id,plan_id,payload':table==='gym_payments'?'id,gym_id,member_id,membership_id,amount,status,payload':table==='gym_attendance'?'id,gym_id,member_id,attended_at,payload':'id,gym_id,payload';
  const marks=cols.split(',').map(()=>'?').join(',');
  const stmt=q(`INSERT INTO ${table}(${cols}) VALUES(${marks})`);
  for (const x of rows) { const id=String(x.id ?? crypto.randomUUID()); const vals=table==='gym_memberships'?[id,gid,x.mid==null?null:String(x.mid),x.pid==null?null:String(x.pid),JSON.stringify(x)]:table==='gym_payments'?[id,gid,x.mid==null?null:String(x.mid),x.msid==null?null:String(x.msid),Number(x.amt)||0,String(x.status||''),JSON.stringify(x)]:table==='gym_attendance'?[id,gid,x.mid==null?null:String(x.mid),String(x.date||x.at||''),JSON.stringify(x)]:[id,gid,JSON.stringify(x)]; stmt.run(...vals); }
};
const loadRows = (table,gid) => q(`SELECT payload FROM ${table} WHERE gym_id=?`).all(gid).map(x=>JSON.parse(x.payload));
const replaceTenantState = (uid,state) => {
 const gid=ensureGym(uid,state.gym?.name); db.exec('BEGIN IMMEDIATE');
 try { for(const t of ['gym_members','gym_plans','gym_memberships','gym_payments','gym_attendance']) q(`DELETE FROM ${t} WHERE gym_id=?`).run(gid);
 putRows('gym_members',gid,state.members); putRows('gym_plans',gid,state.plans); putRows('gym_memberships',gid,state.ms); putRows('gym_payments',gid,state.pay); putRows('gym_attendance',gid,state.att);
 if(state.gym?.name) q('UPDATE gyms SET name=? WHERE id=?').run(String(state.gym.name).slice(0,100),gid);
 q('INSERT INTO audit_log(gym_id,actor_uid,action,details,created_at) VALUES(?,?,?,?,?)').run(gid,uid,'state.replace',JSON.stringify({counts:{members:state.members.length,plans:state.plans.length,memberships:state.ms.length,payments:state.pay.length,attendance:state.att.length}}),Date.now()); db.exec('COMMIT');
 } catch(e){db.exec('ROLLBACK');throw e;}
};
const readTenantState = (uid) => { const gid=ensureGym(uid); return {gym:{name:q('SELECT name FROM gyms WHERE id=?').get(gid).name},members:loadRows('gym_members',gid),plans:loadRows('gym_plans',gid),ms:loadRows('gym_memberships',gid),pay:loadRows('gym_payments',gid),att:loadRows('gym_attendance',gid)}; };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = pw => { const s = crypto.randomBytes(16); return `scrypt$${s.toString('base64')}$${crypto.scryptSync(pw, s, 64).toString('base64')}`; };
const checkPw = (pw, st) => {
  const [, s, h] = st.split('$'); const x = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64), y = Buffer.from(h, 'base64');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const DUMMY = hashPw('dummy-password');
// Secure owner bootstrap: configure OWNER_EMAIL and OWNER_PASSWORD in the server environment.
if (!E.OWNER_PASSWORD) console.warn('WARNING: OWNER_PASSWORD is not set - the Owner account is NOT created/updated.');
if (E.OWNER_PASSWORD) {
  const email=OWNER_EMAIL, password=String(E.OWNER_PASSWORD);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length<12) throw new Error('OWNER_EMAIL must be valid and OWNER_PASSWORD must be at least 12 characters.');
  const existing=q('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  if(existing) q("UPDATE users SET role='superadmin',pass=?,owner_name=CASE WHEN owner_name='' THEN 'Platform Owner' ELSE owner_name END WHERE id=?").run(hashPw(password),existing.id);
  else q("INSERT INTO users(email,pass,created,owner_name,role) VALUES(?,?,?,'Platform Owner','superadmin')").run(email,hashPw(password),Date.now());
  const owner=q('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email); const ownerGym=ensureGym(Number(owner.id),'FitOS Platform'); const trial=q("SELECT id FROM saas_plans WHERE code='trial'").get(); if(trial&&!q('SELECT 1 FROM subscriptions WHERE gym_id=?').get(ownerGym)) q("INSERT INTO subscriptions(gym_id,plan_id,starts_at,ends_at,status,created_at,buyer_email,purchase_amount_irr) VALUES(?,?,?,?,'active',?,?,0)").run(ownerGym,trial.id,Date.now(),Date.now()+TRIAL_DAYS*86400000,Date.now(),email);
}

// ---- Telegram Bot API (token ONLY from env; never logged) ----
const TG_BASE = (E.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const tgConfigured = () => !!(E.TELEGRAM_BOT_TOKEN && E.TELEGRAM_OWNER_CHAT_ID);
const scrub = m => String(m || '').split(E.TELEGRAM_BOT_TOKEN || '\u0000').join('***').slice(0, 300);
const payInfo = id => q("SELECT m.id,m.amount_irr,m.tracking_code,m.created_at,m.receipt_data,m.receipt_mime,g.id AS gym_id,g.name AS gym_name,u.email,p.name AS plan_name FROM manual_payments m JOIN gyms g ON g.id=m.gym_id JOIN users u ON u.id=g.owner_uid JOIN subscriptions s ON s.id=m.subscription_id JOIN saas_plans p ON p.id=s.plan_id WHERE m.id=?").get(id);
async function telegramSendReceipt(paymentId) {
  const setSt = (st, err) => q('UPDATE manual_payments SET telegram_status=?,telegram_error=?,telegram_sent_at=? WHERE id=?').run(st, err || '', st === 'sent' ? Date.now() : null, paymentId);
  if (!tgConfigured()) { setSt('not_configured', 'TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID is not set'); return 'not_configured'; }
  const p = payInfo(paymentId); if (!p) return 'failed';
  const caption = `FitOS - درخواست پرداخت #${p.id}\nباشگاه: ${p.gym_name} (ID ${p.gym_id})\nخریدار: ${p.email}\nپلن: ${p.plan_name}\nمبلغ: ${new Intl.NumberFormat('en-US').format(p.amount_irr)} ریال\nکد پیگیری: ${p.tracking_code}\nزمان: ${new Date(p.created_at).toISOString()}`.slice(0, 1000);
  try {
    const fd = new FormData(); fd.append('chat_id', String(E.TELEGRAM_OWNER_CHAT_ID)); fd.append('caption', caption);
    fd.append('photo', new Blob([Buffer.from(p.receipt_data, 'base64')], { type: p.receipt_mime }), 'receipt.' + p.receipt_mime.split('/')[1]);
    const r = await fetch(`${TG_BASE}/bot${E.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { setSt('sent'); return 'sent'; }
    setSt('failed', scrub(j.description || ('HTTP ' + r.status))); return 'failed';
  } catch (e) { setSt('failed', scrub(e.message)); return 'failed'; }
}

const isOwner = u => !!u && String(u.email).toLowerCase() === OWNER_EMAIL && q('SELECT role FROM users WHERE id=?').get(u.id)?.role === 'superadmin';
const hits = new Map();
const limited = (key, max, win) => {
  const now = Date.now(); let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + win }; hits.set(key, h); }
  return ++h.n > max;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  q('DELETE FROM sessions WHERE exp<?').run(now); q('DELETE FROM otps WHERE exp<?').run(now);
}, 3600e3).unref();

const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const fail = (res, code, error) => send(res, code, { error });
const body = (req, limit = 1e6) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > limit) { no(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); } else c.push(d); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
});
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
const ip = req => (E.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;
const cookie = (tok, age) => `fitos_sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${SECURE ? '; Secure' : ''}`;
const sessionUser = req => {
  const t = cookies(req).fitos_sid; if (!t) return null;
  return q('SELECT u.id, u.email, u.phone FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.exp>?').get(sha(t), Date.now()) || null;
};
const startSession = (res, uid, extra) => {
  const tok = crypto.randomBytes(32).toString('hex'), age = 30 * 86400;
  q('INSERT INTO sessions(hash,uid,exp) VALUES(?,?,?)').run(sha(tok), uid, Date.now() + age * 1000);
  send(res, 200, { ok: true, ...extra }, { 'Set-Cookie': cookie(tok, age) });
};
const phoneNorm = s => { const m = String(s || '').replace(/[\s-]/g, '').match(/^(?:\+98|0098|98|0)?(9\d{9})$/); return m ? '0' + m[1] : null; };

async function zp(pathname, payload) {
  const r = await fetch(`${ZP}/pg/v4/payment/${pathname}.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ merchant_id: E.ZARINPAL_MERCHANT, ...payload }), signal: AbortSignal.timeout(15000),
  });
  return r.json().catch(() => ({}));
}

const routes = {
  'GET /api/health': async (req, res) => send(res, 200, { ok: true }),

  'POST /api/auth/register': async (req, res) => {
    if (limited('reg:' + ip(req), 10, 3600e3)) return fail(res, 429, 'تلاش‌های زیاد. بعداً دوباره امتحان کنید.');
    const b = await body(req); const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) return fail(res, 400, 'ایمیل معتبر نیست.');
    if (pw.length < 10 || pw.length > 200) return fail(res, 400, 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.');
    if (email === OWNER_EMAIL) return fail(res, 409, 'این ایمیل قبلاً ثبت شده است.');
    try {
      const ownerName=String(b.ownerName||'').trim().slice(0,100); const gymName=String(b.gymName||'').trim().slice(0,100);
      const r = q('INSERT INTO users(email,pass,created,owner_name,role) VALUES(?,?,?,?,?)').run(email, hashPw(pw), Date.now(), ownerName, 'gym_owner');
      const uid=Number(r.lastInsertRowid); const gid=ensureGym(uid,gymName||'My Gym');
      const trial=q("SELECT id FROM saas_plans WHERE code='trial'").get(); if(trial) q("INSERT INTO subscriptions(gym_id,plan_id,starts_at,ends_at,status,created_at,buyer_email,purchase_amount_irr) VALUES(?,?,?,?,'active',?,?,0)").run(gid,trial.id,Date.now(),Date.now()+TRIAL_DAYS*86400000,Date.now(),email);
      startSession(res, uid, { gymName, ownerName });
    } catch (e) { if (/UNIQUE/.test(e.message)) return fail(res, 409, 'این ایمیل قبلاً ثبت شده است.'); throw e; }
  },

  'POST /api/auth/login': async (req, res) => {
    const b = await body(req); const email = String(b.email || '').trim().toLowerCase();
    if (limited(`login:${ip(req)}:${email}`, 8, 15 * 60e3)) return fail(res, 429, 'تلاش‌های زیاد. ۱۵ دقیقه بعد دوباره امتحان کنید.');
    const u = q('SELECT id, pass FROM users WHERE email=?').get(email);
    const ok = checkPw(String(b.password || ''), u ? u.pass : DUMMY);
    if (!u || !ok) return fail(res, 401, 'ایمیل یا رمز عبور درست نیست.');
    startSession(res, u.id, {});
  },

  'POST /api/auth/logout': async (req, res) => {
    const t = cookies(req).fitos_sid; if (t) q('DELETE FROM sessions WHERE hash=?').run(sha(t));
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  },

  'GET /api/me': async (req, res, u) => { const x=q('SELECT owner_name,role FROM users WHERE id=?').get(u.id); send(res, 200, { email:u.email, phone:u.phone, ownerName:x.owner_name, role:x.role, features:features() }); },

  'GET /api/saas/plans': async (req,res) => send(res,200,{plans:q('SELECT id,code,name,price_irr AS priceIrr,duration_days AS durationDays FROM saas_plans WHERE active=1 ORDER BY duration_days').all(),bank:{cardNumber:E.BANK_CARD_NUMBER||'',cardHolder:E.BANK_CARD_HOLDER||'',supportTelegram:SUPPORT_TG ? 'https://t.me/'+SUPPORT_TG.replace(/^@/,'') : '',supportHandle:SUPPORT_TG,trialDays:TRIAL_DAYS}}),
  'GET /api/saas/subscription': async (req,res,u) => { const gid=ensureGym(u.id); const sub=q("SELECT s.id,s.status,s.starts_at AS startsAt,s.ends_at AS endsAt,s.buyer_email AS buyerEmail,s.purchase_amount_irr AS purchaseAmountIrr,p.name AS planName,p.price_irr AS priceIrr FROM subscriptions s JOIN saas_plans p ON p.id=s.plan_id WHERE s.gym_id=? ORDER BY s.id DESC LIMIT 1").get(gid); send(res,200,{subscription:sub||null}); },
  'GET /api/saas/purchases': async (req,res,u) => { const gid=ensureGym(u.id); send(res,200,{purchases:q("SELECT s.id,s.status,s.starts_at AS startsAt,s.ends_at AS endsAt,s.created_at AS createdAt,s.buyer_email AS buyerEmail,s.purchase_amount_irr AS amountIrr,p.name AS planName FROM subscriptions s JOIN saas_plans p ON p.id=s.plan_id WHERE s.gym_id=? ORDER BY s.id DESC LIMIT 100").all(gid)}); },
  'POST /api/saas/manual-payment': async (req,res,u) => { const b=await body(req); const plan=q('SELECT * FROM saas_plans WHERE id=? AND active=1').get(Number(b.planId)); if(!plan) return fail(res,404,'پلن پیدا نشد.'); if(plan.price_irr<=0) return fail(res,400,'پلن رایگان نیاز به پرداخت ندارد.'); const tracking=String(b.trackingCode||'').trim(); if(tracking.length<4||tracking.length>100) return fail(res,400,'کد پیگیری باید بین ۴ تا ۱۰۰ نویسه باشد.'); const receipt=String(b.receiptData||''); const mime=String(b.receiptMime||''); if(!receipt||!['image/jpeg','image/png','image/webp'].includes(mime)||receipt.length>5_000_000||!/^([A-Za-z0-9+/]+={0,2})$/.test(receipt)) return fail(res,400,'تصویر رسید معتبر و حداکثر 3.5 مگابایت ارسال کنید.'); const gid=ensureGym(u.id),now=Date.now(); db.exec('BEGIN IMMEDIATE'); try { const sr=q("INSERT INTO subscriptions(gym_id,plan_id,status,created_at,buyer_email,purchase_amount_irr) VALUES(?,?,'pending',?,?,?)").run(gid,plan.id,now,u.email,plan.price_irr); const pr=q("INSERT INTO manual_payments(gym_id,subscription_id,amount_toman,amount_irr,tracking_code,status,created_at,receipt_data,receipt_mime) VALUES(?,?,?,?,?,'pending',?,?,?)").run(gid,Number(sr.lastInsertRowid),Math.round(plan.price_irr/10),plan.price_irr,tracking,now,receipt,mime); db.exec('COMMIT'); const pid=Number(pr.lastInsertRowid); const tg=await telegramSendReceipt(pid); send(res,201,{ok:true,paymentId:pid,status:'pending',telegram:tg}); } catch(e){db.exec('ROLLBACK');throw e;} },
  'GET /api/admin/overview': async (req,res,u) => { if(!isOwner(u)) return fail(res,403,'دسترسی مدیر کل لازم است.'); send(res,200,{users:q('SELECT COUNT(*) n FROM users').get().n,gyms:q('SELECT COUNT(*) n FROM gyms').get().n,pendingPayments:q("SELECT COUNT(*) n FROM manual_payments WHERE status='pending'").get().n,activeSubscriptions:q("SELECT COUNT(*) n FROM subscriptions WHERE status='active' AND ends_at>?").get(Date.now()).n}); },
  'GET /api/admin/payments': async (req,res,u) => { if(!isOwner(u)) return fail(res,403,'دسترسی مدیر کل لازم است.'); send(res,200,{telegramConfigured:tgConfigured(),payments:q("SELECT m.id,m.amount_irr AS amountIrr,m.tracking_code AS trackingCode,m.status,m.created_at AS createdAt,m.reviewed_at AS reviewedAt,m.reject_reason AS rejectReason,m.telegram_status AS telegramStatus,m.telegram_error AS telegramError,g.id AS gymId,g.name AS gymName,u.email,p.name AS planName,s.starts_at AS startsAt,s.ends_at AS endsAt FROM manual_payments m JOIN gyms g ON g.id=m.gym_id JOIN users u ON u.id=g.owner_uid JOIN subscriptions s ON s.id=m.subscription_id JOIN saas_plans p ON p.id=s.plan_id ORDER BY m.created_at DESC LIMIT 200").all()}); },
  'GET /api/admin/payments/receipt': async (req,res,u,url) => { if(!isOwner(u)) return fail(res,403,'دسترسی مدیر کل لازم است.'); const p=q('SELECT receipt_data,receipt_mime FROM manual_payments WHERE id=?').get(Number(url.searchParams.get('id'))); if(!p||!p.receipt_data) return fail(res,404,'رسید پیدا نشد.'); res.writeHead(200,{'Content-Type':p.receipt_mime,'Cache-Control':'private, no-store','Content-Disposition':'inline'}); res.end(Buffer.from(p.receipt_data,'base64')); },
  'POST /api/admin/payments/telegram-retry': async (req,res,u) => { if(!isOwner(u)) return fail(res,403,'دسترسی مدیر کل لازم است.'); const b=await body(req); const p=q('SELECT id FROM manual_payments WHERE id=?').get(Number(b.paymentId)); if(!p) return fail(res,404,'درخواست پرداخت پیدا نشد.'); const st=await telegramSendReceipt(p.id); send(res,200,{ok:st==='sent',telegram:st}); },
  'POST /api/admin/payments/review': async (req,res,u) => { if(!isOwner(u)) return fail(res,403,'دسترسی مدیر کل لازم است.'); const b=await body(req); const status=b.approve===true?'approved':b.approve===false?'rejected':null; if(!status) return fail(res,400,'تصمیم نامعتبر است.'); const p=q("SELECT * FROM manual_payments WHERE id=? AND status='pending'").get(Number(b.paymentId)); if(!p) return fail(res,404,'درخواست پرداخت پیدا نشد یا قبلاً بررسی شده است.'); const reason=String(b.reason||'').trim().slice(0,300); if(status==='rejected'&&reason.length<3) return fail(res,400,'دلیل رد پرداخت را وارد کنید.'); if(q('SELECT owner_uid FROM gyms WHERE id=?').get(p.gym_id)?.owner_uid===u.id) return fail(res,403,'تأیید پرداخت باشگاه خودتان مجاز نیست.'); db.exec('BEGIN IMMEDIATE'); try { q("UPDATE manual_payments SET status=?,reviewed_by=?,reviewed_at=?,reject_reason=? WHERE id=? AND status='pending'").run(status,u.id,Date.now(),status==='rejected'?reason:'',p.id); if(status==='approved'){const plan=q('SELECT duration_days FROM saas_plans WHERE id=(SELECT plan_id FROM subscriptions WHERE id=?)').get(p.subscription_id); const now=Date.now(); q("UPDATE subscriptions SET status='active',starts_at=?,ends_at=? WHERE id=?").run(now,now+plan.duration_days*86400000,p.subscription_id);} else q("UPDATE subscriptions SET status='cancelled' WHERE id=?").run(p.subscription_id); q('INSERT INTO platform_audit(actor_uid,action,target_id,details,created_at) VALUES(?,?,?,?,?)').run(u.id,'manual_payment_'+status,p.id,status==='rejected'?reason:null,Date.now()); db.exec('COMMIT'); } catch(e){db.exec('ROLLBACK');throw e;} send(res,200,{ok:true,status}); },

  'GET /api/profile': async (req,res,u) => { const p=q('SELECT display_name AS displayName,bio,avatar_data AS avatarData,telegram_username AS telegramUsername FROM users WHERE id=?').get(u.id); send(res,200,{profile:p}); },
  'PUT /api/profile': async (req,res,u) => { const b=await body(req,5e6),name=String(b.displayName||'').trim().slice(0,80),bio=String(b.bio||'').trim().slice(0,500),tg=String(b.telegramUsername||'').replace(/^@/,'').trim(); const avatar=String(b.avatarData||''); if(tg&&!/^[A-Za-z0-9_]{5,32}$/.test(tg))return fail(res,400,'شناسه تلگرام معتبر نیست.'); if(avatar && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)||avatar.length>3_000_000))return fail(res,400,'تصویر پروفایل معتبر نیست یا بیش از حد بزرگ است.'); q('UPDATE users SET display_name=?,bio=?,avatar_data=?,telegram_username=? WHERE id=?').run(name,bio,avatar,tg,u.id); send(res,200,{ok:true}); },
  'GET /api/community/contacts': async (req,res,u) => { const gid=ensureGym(u.id); send(res,200,{contacts:q('SELECT u.id,u.email,u.display_name AS displayName,u.role,u.telegram_username AS telegramUsername FROM users u JOIN gyms g ON g.owner_uid=u.id WHERE g.id=? AND u.id<>?').all(gid,u.id)}); },
  'GET /api/community/messages': async (req,res,u,url) => { const peer=Number(url.searchParams.get('peer')); if(!Number.isSafeInteger(peer)||peer<1)return fail(res,400,'مخاطب نامعتبر است.'); const gid=ensureGym(u.id); const other=q('SELECT owner_uid FROM gyms WHERE id=?').get(gid); if(!other||other.owner_uid!==u.id)return fail(res,403,'دسترسی مجاز نیست.'); send(res,200,{messages:q('SELECT id,sender_uid AS senderId,recipient_uid AS recipientId,message,created_at AS createdAt FROM gym_messages WHERE gym_id=? AND ((sender_uid=? AND recipient_uid=?) OR (sender_uid=? AND recipient_uid=?)) ORDER BY id DESC LIMIT 100').all(gid,u.id,peer,peer,u.id).reverse()}); },
  'POST /api/community/messages': async (req,res,u) => { const b=await body(req),peer=Number(b.peer),message=String(b.message||'').trim(); if(!Number.isSafeInteger(peer)||peer<1||!message||message.length>2000)return fail(res,400,'پیام یا مخاطب نامعتبر است.'); const gid=ensureGym(u.id); const target=q('SELECT id FROM users WHERE id=?').get(peer); if(!target||!q('SELECT 1 FROM gyms WHERE owner_uid=? AND id=?').get(u.id,gid))return fail(res,403,'مخاطب در این باشگاه نیست.'); const r=q('INSERT INTO gym_messages(gym_id,sender_uid,recipient_uid,message,created_at) VALUES(?,?,?,?,?)').run(gid,u.id,peer,message,Date.now()); send(res,201,{ok:true,id:Number(r.lastInsertRowid)}); },

  'GET /api/buffet/items': async (req,res,u) => { const gid=ensureGym(u.id); send(res,200,{items:q('SELECT id,name,category,price_irr AS priceIrr,stock,unit,active FROM buffet_items WHERE gym_id=? ORDER BY active DESC,name').all(gid)}); },
  'POST /api/buffet/items': async (req,res,u) => { const b=await body(req); const name=String(b.name||'').trim(); const price=Number(b.priceIrr),stock=Number(b.stock??0); if(name.length<2||name.length>100||!Number.isSafeInteger(price)||price<0||!Number.isFinite(stock)||stock<0||stock>1e7) return fail(res,400,'اطلاعات کالا معتبر نیست.'); const gid=ensureGym(u.id),now=Date.now(); const r=q('INSERT INTO buffet_items(gym_id,name,category,price_irr,stock,unit,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(gid,name,String(b.category||'').slice(0,60),price,stock,String(b.unit||'عدد').slice(0,20),now,now); send(res,201,{ok:true,id:Number(r.lastInsertRowid)}); },
  'PUT /api/buffet/items': async (req,res,u) => { const b=await body(req); const id=Number(b.id),name=String(b.name||'').trim(),price=Number(b.priceIrr),stock=Number(b.stock); const gid=ensureGym(u.id); if(!Number.isSafeInteger(id)||name.length<2||!Number.isSafeInteger(price)||price<0||!Number.isFinite(stock)||stock<0) return fail(res,400,'اطلاعات کالا معتبر نیست.'); const r=q('UPDATE buffet_items SET name=?,category=?,price_irr=?,stock=?,unit=?,active=?,updated_at=? WHERE id=? AND gym_id=?').run(name,String(b.category||'').slice(0,60),price,stock,String(b.unit||'عدد').slice(0,20),b.active===false?0:1,Date.now(),id,gid); if(!r.changes)return fail(res,404,'کالا پیدا نشد.'); send(res,200,{ok:true}); },
  'DELETE /api/buffet/items': async (req,res,u) => { const b=await body(req),gid=ensureGym(u.id); const r=q('UPDATE buffet_items SET active=0,updated_at=? WHERE id=? AND gym_id=?').run(Date.now(),Number(b.id),gid); if(!r.changes)return fail(res,404,'کالا پیدا نشد.'); send(res,200,{ok:true}); },
  'POST /api/buffet/sales': async (req,res,u) => { const b=await body(req),gid=ensureGym(u.id),id=Number(b.itemId),qty=Number(b.quantity); if(!Number.isFinite(qty)||qty<=0||qty>1e5)return fail(res,400,'تعداد نامعتبر است.'); db.exec('BEGIN IMMEDIATE'); try { const item=q('SELECT * FROM buffet_items WHERE id=? AND gym_id=? AND active=1').get(id,gid); if(!item){db.exec('ROLLBACK');return fail(res,404,'کالا پیدا نشد.');} if(item.stock<qty){db.exec('ROLLBACK');return fail(res,409,'موجودی کافی نیست.');} const total=Math.round(item.price_irr*qty); q('UPDATE buffet_items SET stock=stock-?,updated_at=? WHERE id=? AND gym_id=?').run(qty,Date.now(),id,gid); const r=q('INSERT INTO buffet_sales(gym_id,item_id,item_name,quantity,unit_price_irr,total_irr,member_id,sold_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(gid,id,item.name,qty,item.price_irr,total,b.memberId?String(b.memberId):null,u.id,Date.now()); db.exec('COMMIT'); send(res,201,{ok:true,saleId:Number(r.lastInsertRowid),totalIrr:total}); } catch(e){db.exec('ROLLBACK');throw e;} },
  'GET /api/buffet/sales': async (req,res,u,url) => { const gid=ensureGym(u.id),limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50)); send(res,200,{sales:q('SELECT id,item_name AS itemName,quantity,unit_price_irr AS unitPriceIrr,total_irr AS totalIrr,member_id AS memberId,created_at AS createdAt FROM buffet_sales WHERE gym_id=? ORDER BY id DESC LIMIT ?').all(gid,limit)}); },

  'GET /api/state': async (req, res, u) => {
    const legacy=q('SELECT json,version FROM states WHERE uid=?').get(u.id);
    const gid=ensureGym(u.id);
    const has=q('SELECT COUNT(*) AS n FROM gym_members WHERE gym_id=?').get(gid).n + q('SELECT COUNT(*) AS n FROM gym_plans WHERE gym_id=?').get(gid).n;
    if (legacy && !has) { const old=JSON.parse(legacy.json); replaceTenantState(u.id,old); }
    const r=q('SELECT version FROM states WHERE uid=?').get(u.id);
    const state=readTenantState(u.id); const oldGym=state.gym;
    send(res,200,{state:{...state,...oldGym},version:r?.version??0});
  },

  'PUT /api/state': async (req, res, u) => {
    const b=await body(req,5e6),s=b.state;
    if(!s||typeof s!=='object'||!['members','plans','ms','pay','att'].every(k=>Array.isArray(s[k]))) return fail(res,400,'Invalid state.');
    const cur=q('SELECT version FROM states WHERE uid=?').get(u.id)?.version??0;
    if(cur!==b.version) return fail(res,409,'Version conflict.');
    replaceTenantState(u.id,s);
    q('INSERT INTO states(uid,json,version,updated) VALUES(?,?,?,?) ON CONFLICT(uid) DO UPDATE SET json=excluded.json,version=excluded.version,updated=excluded.updated').run(u.id,JSON.stringify(s),cur+1,Date.now());
    send(res,200,{ok:true,version:cur+1});
  },

  // ---- Phone + OTP (Kavenegar verify/lookup). Active once KAVENEGAR_API_KEY and KAVENEGAR_TEMPLATE are set.
  'POST /api/auth/phone/request': async (req, res, u) => {
    if (!features().otp) return fail(res, 501, 'تأیید پیامکی هنوز فعال نشده است.');
    if (limited('otp:' + u.id, 5, 3600e3)) return fail(res, 429, 'تلاش‌های زیاد.');
    const phone = phoneNorm((await body(req)).phone); if (!phone) return fail(res, 400, 'شماره موبایل معتبر نیست.');
    if (q('SELECT 1 FROM users WHERE phone=? AND id<>?').get(phone, u.id)) return fail(res, 409, 'این شماره قبلاً استفاده شده است.');
    const prev = q('SELECT sent FROM otps WHERE uid=?').get(u.id);
    if (prev && Date.now() - prev.sent < 60e3) return fail(res, 429, 'کمی صبر کنید و دوباره تلاش کنید.');
    const code = String(crypto.randomInt(100000, 1000000));
    const url = `https://api.kavenegar.com/v1/${encodeURIComponent(E.KAVENEGAR_API_KEY)}/verify/lookup.json?receptor=${phone}&token=${code}&template=${encodeURIComponent(E.KAVENEGAR_TEMPLATE)}`;
    const j = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => ({}));
    if (j?.return?.status !== 200) return fail(res, 502, 'ارسال پیامک ناموفق بود.');
    q('INSERT INTO otps(uid,phone,code_hash,exp,tries,sent) VALUES(?,?,?,?,0,?) ON CONFLICT(uid) DO UPDATE SET phone=excluded.phone, code_hash=excluded.code_hash, exp=excluded.exp, tries=0, sent=excluded.sent')
      .run(u.id, phone, sha(code + u.id), Date.now() + 5 * 60e3, Date.now());
    send(res, 200, { ok: true });
  },

  'POST /api/auth/phone/verify': async (req, res, u) => {
    const o = q('SELECT * FROM otps WHERE uid=?').get(u.id);
    if (!o || o.exp < Date.now() || o.tries >= 5) return fail(res, 400, 'کد منقضی شده است. دوباره درخواست دهید.');
    q('UPDATE otps SET tries=tries+1 WHERE uid=?').run(u.id);
    const code = String((await body(req)).code || '');
    const a = Buffer.from(sha(code + u.id)), b = Buffer.from(o.code_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 400, 'کد درست نیست.');
    q('UPDATE users SET phone=? WHERE id=?').run(o.phone, u.id); q('DELETE FROM otps WHERE uid=?').run(u.id);
    send(res, 200, { ok: true, phone: o.phone });
  },

  // ---- Payment gateway (ZarinPal). Active once ZARINPAL_MERCHANT is set.
  'POST /api/pay/start': async (req, res, u) => {
    if (!features().gateway) return fail(res, 501, 'درگاه پرداخت هنوز فعال نشده است.');
    const b = await body(req), amountIrr = Number(b.amountIrr), order = String(b.orderId || '');
    if (!Number.isSafeInteger(amountIrr) || amountIrr < 1000 || amountIrr > 1e10 || !/^[A-Za-z0-9_-]{3,40}$/.test(order)) return fail(res, 400, 'Invalid payment data.');
    if (q('SELECT 1 FROM pay_tx WHERE uid=? AND order_id=?').get(u.id, order)) return fail(res, 409, 'این سفارش قبلاً ایجاد شده است.');
    const j = await zp('request', { amount: amountIrr, callback_url: `${PUBLIC_URL}/api/pay/callback`, description: String(b.description || 'FitOS').slice(0, 200), metadata: { email: u.email } });
    if (j?.data?.code !== 100 || !j.data.authority) return fail(res, 502, 'درگاه درخواست را نپذیرفت.');
    q('INSERT INTO pay_tx(uid,order_id,authority,amount_toman,amount_irr,status,created) VALUES(?,?,?,?,?,?,?)').run(u.id, order, j.data.authority, Math.round(amountIrr/10), amountIrr, 'pending', Date.now());
    send(res, 200, { paymentUrl: `${ZP}/pg/StartPay/${j.data.authority}` });
  },

  'GET /api/pay/status': async (req, res, u, url) => {
    const t = q('SELECT status, ref, amount_irr FROM pay_tx WHERE uid=? AND order_id=?').get(u.id, url.searchParams.get('order') || '');
    t ? send(res, 200, { status: t.status, ref: t.ref, amountIrr: t.amount_irr }) : fail(res, 404, 'Not found.');
  },
};

// Public: the gateway sends the browser back here. Amount and result come from our DB and a server-side verify call.
async function payCallback(req, res, url) {
  const authority = url.searchParams.get('Authority') || '';
  const t = q('SELECT * FROM pay_tx WHERE authority=?').get(authority);
  let outcome = 'failed';
  if (t) {
    if (t.status === 'verified') outcome = 'ok';
    else if (url.searchParams.get('Status') === 'OK') {
      const j = await zp('verify', { amount: t.amount_irr, authority }).catch(() => ({}));
      if (j?.data?.code === 100 || j?.data?.code === 101) {
        q("UPDATE pay_tx SET status='verified', ref=? WHERE authority=? AND status IN ('pending','failed')").run(String(j.data.ref_id ?? ''), authority);
        outcome = 'ok';
      } else q("UPDATE pay_tx SET status='failed' WHERE authority=? AND status='pending'").run(authority);
    } else q("UPDATE pay_tx SET status='failed' WHERE authority=? AND status='pending'").run(authority);
  }
  res.writeHead(302, { Location: `/?pay=${outcome}&order=${encodeURIComponent(t?.order_id || '')}`, 'Cache-Control': 'no-store' });
  res.end();
}

const page = fs.readFileSync(path.join(dir, 'index.html'));
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); const key = `${req.method} ${url.pathname}`;
    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(page);
    }
    if (key === 'GET /api/pay/callback') return await payCallback(req, res, url);
    const h = routes[key];
    if (!h) return fail(res, 404, 'Not found.');
    if (req.method !== 'GET' && req.headers.origin) { // CSRF: same-origin requests only
      let okOrigin = false; try { okOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!okOrigin) return fail(res, 403, 'Origin not allowed.');
    }
    const open = key === 'GET /api/health' || key === 'POST /api/auth/register' || key === 'POST /api/auth/login' || key === 'POST /api/auth/logout';
    const u = open ? null : sessionUser(req);
    if (!open && !u) return fail(res, 401, 'Unauthorized.');
    await h(req, res, u, url);
  } catch (e) {
    console.error('Error:', e.message);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Internal server error.');
  }
}).listen(PORT, HOST, () => {
  console.log(`\nFitOS is running.\nOpen in your browser:  ${PUBLIC_URL}\nGateway: ${features().gateway ? 'ON' : 'off (set ZARINPAL_MERCHANT)'}   OTP: ${features().otp ? 'ON' : 'off (set KAVENEGAR_API_KEY + KAVENEGAR_TEMPLATE)'}   Telegram: ${tgConfigured() ? 'ON' : 'NOT CONFIGURED (set TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID)'}\n`);
});
