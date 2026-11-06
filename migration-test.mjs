import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.mjs';
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT); CREATE TABLE pay_tx(uid INTEGER NOT NULL,order_id TEXT NOT NULL,authority TEXT UNIQUE,amount_toman INTEGER NOT NULL,status TEXT NOT NULL,ref TEXT,created INTEGER NOT NULL,PRIMARY KEY(uid,order_id));`);
db.prepare(`INSERT INTO pay_tx(uid,order_id,authority,amount_toman,status,created) VALUES(1,'OLD1','OLD_AUTH',2000,'verified',1)`).run();
migrate(db); migrate(db);
const versions=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x=>x.version);
assert.deepEqual(versions,[1,2,3,4,5,6]);
for(const t of ['gyms','gym_members','gym_plans','gym_memberships','gym_payments','gym_attendance','audit_log','saas_plans','subscriptions','manual_payments','platform_audit','buffet_items','buffet_sales','gym_messages'])
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t),`missing ${t}`);
for(const [table,column] of [['saas_plans','price_irr'],['subscriptions','buyer_email'],['subscriptions','purchase_amount_irr'],['manual_payments','amount_irr'],['pay_tx','amount_irr'],['users','bio'],['users','avatar_data'],['manual_payments','receipt_data'],['manual_payments','telegram_status'],['manual_payments','reject_reason']])
  assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column),`missing ${table}.${column}`);
assert.equal(db.prepare(`SELECT amount_irr FROM pay_tx WHERE order_id='OLD1'`).get().amount_irr,20000,'legacy payment converted to IRR');
db.close(); console.log('Migration tests passed (v1-v6, idempotent).');
