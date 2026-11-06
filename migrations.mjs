import { DatabaseSync } from 'node:sqlite';
/** Versioned, idempotent schema migrations for FitOS. */
export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(x=>x.version));
  const migrations = [
    [1, `CREATE TABLE IF NOT EXISTS gyms(id INTEGER PRIMARY KEY AUTOINCREMENT, owner_uid INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT 'My Gym', created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS gym_members(id TEXT NOT NULL, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, payload TEXT NOT NULL, PRIMARY KEY(gym_id,id));
     CREATE TABLE IF NOT EXISTS gym_plans(id TEXT NOT NULL, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, payload TEXT NOT NULL, PRIMARY KEY(gym_id,id));
     CREATE TABLE IF NOT EXISTS gym_memberships(id TEXT NOT NULL, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, member_id TEXT, plan_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(gym_id,id));
     CREATE TABLE IF NOT EXISTS gym_payments(id TEXT NOT NULL, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, member_id TEXT, membership_id TEXT, amount INTEGER, status TEXT, payload TEXT NOT NULL, PRIMARY KEY(gym_id,id));
     CREATE TABLE IF NOT EXISTS gym_attendance(id TEXT NOT NULL, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, member_id TEXT, attended_at TEXT, payload TEXT NOT NULL, PRIMARY KEY(gym_id,id));
     CREATE INDEX IF NOT EXISTS idx_members_gym ON gym_members(gym_id);
     CREATE INDEX IF NOT EXISTS idx_memberships_gym ON gym_memberships(gym_id);
     CREATE INDEX IF NOT EXISTS idx_payments_gym_status ON gym_payments(gym_id,status);
     CREATE INDEX IF NOT EXISTS idx_attendance_gym_date ON gym_attendance(gym_id,attended_at);
     CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER REFERENCES gyms(id) ON DELETE CASCADE, actor_uid INTEGER, action TEXT NOT NULL, details TEXT, created_at INTEGER NOT NULL);`
    ],
    [2, `ALTER TABLE users ADD COLUMN owner_name TEXT NOT NULL DEFAULT '';
     ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'gym_owner';
     CREATE TABLE IF NOT EXISTS saas_plans(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price_toman INTEGER NOT NULL CHECK(price_toman>=0), duration_days INTEGER NOT NULL CHECK(duration_days>0), active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER NOT NULL REFERENCES gyms(id), plan_id INTEGER NOT NULL REFERENCES saas_plans(id), starts_at INTEGER, ends_at INTEGER, status TEXT NOT NULL CHECK(status IN ('pending','active','expired','cancelled')), created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS manual_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER NOT NULL REFERENCES gyms(id), subscription_id INTEGER NOT NULL REFERENCES subscriptions(id), amount_toman INTEGER NOT NULL CHECK(amount_toman>0), tracking_code TEXT NOT NULL, receipt_path TEXT, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), reviewed_by INTEGER REFERENCES users(id), reviewed_at INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_subscriptions_gym ON subscriptions(gym_id,status,ends_at);
     CREATE INDEX IF NOT EXISTS idx_manual_payments_status ON manual_payments(status,created_at);
     CREATE TABLE IF NOT EXISTS platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_uid INTEGER, action TEXT NOT NULL, target_id INTEGER, details TEXT, created_at INTEGER NOT NULL);` ],
    [3, `ALTER TABLE saas_plans ADD COLUMN price_irr INTEGER NOT NULL DEFAULT 0 CHECK(price_irr>=0);
     ALTER TABLE subscriptions ADD COLUMN buyer_email TEXT NOT NULL DEFAULT '';
     ALTER TABLE subscriptions ADD COLUMN purchase_amount_irr INTEGER NOT NULL DEFAULT 0 CHECK(purchase_amount_irr>=0);
     ALTER TABLE manual_payments ADD COLUMN amount_irr INTEGER NOT NULL DEFAULT 0 CHECK(amount_irr>=0);
     UPDATE saas_plans SET price_irr=price_toman*10;
     UPDATE manual_payments SET amount_irr=amount_toman*10;
     UPDATE subscriptions SET buyer_email=COALESCE((SELECT u.email FROM gyms g JOIN users u ON u.id=g.owner_uid WHERE g.id=subscriptions.gym_id),''), purchase_amount_irr=COALESCE((SELECT p.price_irr FROM saas_plans p WHERE p.id=subscriptions.plan_id),0);
     CREATE INDEX IF NOT EXISTS idx_subscriptions_buyer_email ON subscriptions(buyer_email,created_at);
     CREATE TABLE IF NOT EXISTS buffet_items(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', price_irr INTEGER NOT NULL CHECK(price_irr>=0), stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0), unit TEXT NOT NULL DEFAULT 'عدد', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS buffet_sales(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES buffet_items(id), item_name TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), unit_price_irr INTEGER NOT NULL CHECK(unit_price_irr>=0), total_irr INTEGER NOT NULL CHECK(total_irr>=0), member_id TEXT, sold_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_buffet_items_gym ON buffet_items(gym_id,active);
     CREATE INDEX IF NOT EXISTS idx_buffet_sales_gym_date ON buffet_sales(gym_id,created_at);`
    ],
    [4, `ALTER TABLE pay_tx ADD COLUMN amount_irr INTEGER NOT NULL DEFAULT 0 CHECK(amount_irr>=0);
     UPDATE pay_tx SET amount_irr=amount_toman*10 WHERE amount_irr=0;
     CREATE INDEX IF NOT EXISTS idx_pay_tx_uid_status ON pay_tx(uid,status,created);`
    ],
    [5, `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
     ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
     ALTER TABLE users ADD COLUMN avatar_data TEXT NOT NULL DEFAULT '';
     ALTER TABLE users ADD COLUMN telegram_username TEXT NOT NULL DEFAULT '';
     ALTER TABLE manual_payments ADD COLUMN receipt_data TEXT NOT NULL DEFAULT '';
     ALTER TABLE manual_payments ADD COLUMN receipt_mime TEXT NOT NULL DEFAULT '';
     CREATE TABLE IF NOT EXISTS gym_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, gym_id INTEGER NOT NULL REFERENCES gyms(id) ON DELETE CASCADE, sender_uid INTEGER NOT NULL REFERENCES users(id), recipient_uid INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_gym_messages_thread ON gym_messages(gym_id,sender_uid,recipient_uid,created_at);
     CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`],
    [6, `ALTER TABLE manual_payments ADD COLUMN telegram_status TEXT NOT NULL DEFAULT 'pending';
     ALTER TABLE manual_payments ADD COLUMN telegram_error TEXT NOT NULL DEFAULT '';
     ALTER TABLE manual_payments ADD COLUMN telegram_sent_at INTEGER;
     ALTER TABLE manual_payments ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
     CREATE INDEX IF NOT EXISTS idx_manual_payments_status ON manual_payments(status,created_at);`]
  ];
  for (const [version, sql] of migrations) if (!applied.has(version)) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(sql); db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version,Date.now()); db.exec('COMMIT'); }
    catch(e){ db.exec('ROLLBACK'); throw e; }
  }
}
