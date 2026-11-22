// Gen-Z-Store backend: Node.js built-in modules only (http + SQLite). NO npm install needed.
// Needs Node.js 22.13 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3000;
const PUB = path.join(__dirname, 'public');
const db = new DatabaseSync(path.join(__dirname, 'data', 'shop.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---------- Database schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL CHECK (price > 0),
  category TEXT NOT NULL,
  emoji TEXT DEFAULT '📦',
  rating REAL DEFAULT 4,
  description TEXT DEFAULT '',
  colour TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  total REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0)
);`);

// ---------- Seed products from data/products.json on first run ----------
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'products.json'), 'utf8'));
  const ins = db.prepare('INSERT INTO products (name, price, category, emoji, rating, description, colour) VALUES (?, ?, ?, ?, ?, ?, ?)');
  seed.forEach(p => ins.run(p.name, p.price, p.category, p.emoji || '📦', p.rating || 4, p.desc || '', p.colour || ''));
  console.log('Database seeded with', seed.length, 'products');
}

// ---------- Helpers ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const transaction = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const getCookie = (req, name) => {
  const part = (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([k]) => k === name);
  return part && part[1];
};
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, address: u.address, role: u.role });
const startSession = (res, userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
};
const needLogin = c => c.user ? true : (send(c.res, 401, { error: 'Please login first' }), false);
const needAdmin = c => c.user && c.user.role === 'admin' ? true : (send(c.res, 403, { error: 'Admin only' }), false);

// ---------- Routes ----------
const routes = [];
const route = (method, p, handler) => routes.push({ method, handler, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

route('POST', '/api/signup', ({ res, body }) => {
  const { name, email, phone, address, password } = body;
  if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: 'Valid name and email are required' });
  if (!password || password.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
  const mail = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) return send(res, 409, { error: 'This email is already registered' });
  const role = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 ? 'admin' : 'customer'; // first user = admin
  const id = db.prepare('INSERT INTO users (name, email, phone, address, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(name).slice(0, 60), mail, String(phone || '').slice(0, 20), String(address || '').slice(0, 200), hashPw(password), role).lastInsertRowid;
  startSession(res, id);
  send(res, 201, safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

route('POST', '/api/login', ({ res, body }) => {
  const { email, password } = body;
  const u = email && db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!u || !password || !checkPw(password, u.password_hash)) return send(res, 401, { error: 'Wrong email or password' });
  startSession(res, u.id);
  send(res, 200, safeUser(u));
});

route('POST', '/api/logout', ({ req, res }) => {
  const t = getCookie(req, 'token');
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
});

route('GET', '/api/me', ({ res, user }) => send(res, 200, user ? safeUser(user) : null));

const ORDER = { low: 'price ASC', high: 'price DESC', rating: 'rating DESC' };
route('GET', '/api/products', ({ res, query }) => {
  const { q, category, max, sort } = query;
  let sql = 'SELECT id, name, price, category, emoji, rating, description AS "desc", colour FROM products WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND name LIKE ?'; params.push(`%${q}%`); }
  if (category && category !== 'All') { sql += ' AND category = ?'; params.push(category); }
  if (Number(max)) { sql += ' AND price <= ?'; params.push(Number(max)); }
  sql += ' ORDER BY ' + (ORDER[sort] || 'id ASC');
  send(res, 200, db.prepare(sql).all(...params).map(r => ({ ...r })));
});

route('POST', '/api/products', c => {
  if (!needAdmin(c)) return;
  const { name, price, category, emoji, rating, desc, colour } = c.body;
  if (!name || !(Number(price) > 0) || !category) return send(c.res, 400, { error: 'name, price (>0) and category are required' });
  const r = db.prepare('INSERT INTO products (name, price, category, emoji, rating, description, colour) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(name).slice(0, 80), Number(price), category, emoji || '📦', Number(rating) || 4, String(desc || '').slice(0, 200), String(colour || '').slice(0, 40));
  send(c.res, 201, { id: r.lastInsertRowid });
});

route('DELETE', '/api/products/:id', c => {
  if (!needAdmin(c)) return;
  const r = db.prepare('DELETE FROM products WHERE id = ?').run(c.params.id);
  r.changes ? send(c.res, 200, { ok: true }) : send(c.res, 404, { error: 'Not found' });
});

route('POST', '/api/orders', c => {
  if (!needLogin(c)) return;
  const items = c.body.items;
  if (!Array.isArray(items) || !items.length) return send(c.res, 400, { error: 'Cart is empty' });
  try {
    const orderId = transaction(() => {
      const rows = items.map(i => {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(i.id); // price always comes from the database
        if (!p || !(i.qty > 0)) throw new Error('Invalid item in cart');
        return { p, qty: Math.floor(i.qty) };
      });
      const total = rows.reduce((s, r) => s + r.p.price * r.qty, 0);
      const id = db.prepare('INSERT INTO orders (user_id, total) VALUES (?, ?)').run(c.user.id, total).lastInsertRowid;
      rows.forEach(r => db.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)').run(id, r.p.id, r.p.name, r.p.price, r.qty));
      return id;
    });
    send(c.res, 201, { orderId });
  } catch (e) { send(c.res, 400, { error: e.message }); }
});

// Customers see their own orders; admin sees everyone's
route('GET', '/api/orders', c => {
  if (!needLogin(c)) return;
  const admin = c.user.role === 'admin';
  const orders = db.prepare(`SELECT o.*, u.name AS customer FROM orders o LEFT JOIN users u ON u.id = o.user_id
                             ${admin ? '' : 'WHERE o.user_id = ?'} ORDER BY o.id DESC`).all(...(admin ? [] : [c.user.id]));
  const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  send(c.res, 200, orders.map(o => ({ ...o, items: getItems.all(o.id).map(i => ({ ...i })) })));
});

// ---------- Server ----------
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    const t = getCookie(req, 'token');
    const user = t ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(t) : null;

    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) return r.handler({ req, res, user: user && { ...user }, body, query: Object.fromEntries(url.searchParams), params: m.groups || {} });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const file = path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log(`Gen-Z-Store running at http://localhost:${PORT}`));
