const $ = id => document.getElementById(id);
const inr = n => '₹' + n.toLocaleString('en-IN');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let products = [], user = null, mode = 'login';
let cart = JSON.parse(localStorage.getItem('cart') || '{}'); // {id: {product, qty}}

async function api(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

// ---------- Products ----------
async function load() {
  const params = new URLSearchParams({ q: $('search').value, category: $('category').value, sort: $('sort').value, max: $('max').value });
  products = (await api('/api/products?' + params)).data;
  renderGrid();
}

function renderGrid() {
  const admin = user && user.role === 'admin';
  $('grid').innerHTML = products.length ? products.map(p => `
    <div class="card">
      <div class="emoji">${p.emoji}</div>
      <b>${esc(p.name)}</b>
      <span class="tag">${p.category} · ⭐ ${p.rating}</span>
      <small>${esc(p.desc)}</small>
      ${p.colour ? `<small>🎨 ${esc(p.colour)}</small>` : ''}
      <span class="price">${inr(p.price)}</span>
      <div class="row">
        <button onclick="addToCart(${p.id})">Add to Cart</button>
        ${admin ? `<button class="del" onclick="removeProduct(${p.id})" title="Delete">🗑</button>` : ''}
      </div>
    </div>`).join('') : '<p class="empty">No products found.</p>';
}

async function removeProduct(id) {
  if (!confirm('Delete this product?')) return;
  const r = await api('/api/products/' + id, 'DELETE');
  if (!r.ok) return alert(r.data.error);
  delete cart[id]; saveCart(); load();
}

$('addForm').onsubmit = async e => {
  e.preventDefault();
  const r = await api('/api/products', 'POST', Object.fromEntries(new FormData(e.target)));
  if (!r.ok) return alert(r.data.error);
  e.target.reset(); load();
};

// ---------- Cart ----------
function saveCart() { localStorage.setItem('cart', JSON.stringify(cart)); renderCart(); }
function addToCart(id) {
  const p = products.find(x => x.id === id);
  cart[id] = cart[id] ? { ...cart[id], qty: cart[id].qty + 1 } : { product: p, qty: 1 };
  saveCart();
}
function changeQty(id, d) {
  cart[id].qty += d;
  if (cart[id].qty <= 0) delete cart[id];
  saveCart();
}
function renderCart() {
  const entries = Object.entries(cart);
  $('count').textContent = entries.reduce((s, [, c]) => s + c.qty, 0);
  $('items').innerHTML = entries.length ? entries.map(([id, c]) => `
    <div class="item">
      <span>${c.product.emoji} ${esc(c.product.name)}<br><small>${inr(c.product.price)}</small></span>
      <span><button onclick="changeQty(${id},-1)">−</button>${c.qty}<button onclick="changeQty(${id},1)">+</button></span>
    </div>`).join('') : '<p class="empty">Your cart is empty.</p>';
  $('total').textContent = inr(entries.reduce((s, [, c]) => s + c.product.price * c.qty, 0));
}

$('checkout').onclick = async () => {
  const items = Object.values(cart).map(c => ({ id: c.product.id, qty: c.qty }));
  if (!items.length) return alert('Cart is empty');
  if (!user) { $('drawer').classList.add('hidden'); return openAuth('login'); }
  const r = await api('/api/orders', 'POST', { items });
  if (!r.ok) return alert(r.data.error);
  alert('Order #' + r.data.orderId + ' placed! 🎉 Saved in the database.');
  cart = {}; saveCart(); $('drawer').classList.add('hidden');
};

// ---------- Login / signup ----------
function renderUser() {
  const admin = user && user.role === 'admin';
  $('userBox').innerHTML = user
    ? `<span>👤 ${esc(user.name)}${admin ? ' (admin)' : ''}</span><button id="ordersBtn">Orders</button><button id="logoutBtn">Logout</button>`
    : '<button id="loginBtn">Login / Sign up</button>';
  $('adminBox').classList.toggle('hidden', !admin);
  if (user) { $('ordersBtn').onclick = showOrders; $('logoutBtn').onclick = logout; }
  else $('loginBtn').onclick = () => openAuth('login');
  renderGrid();
}

function openAuth(m) {
  mode = m;
  const signup = m === 'signup';
  $('authTitle').textContent = signup ? 'Create account' : 'Login';
  $('authSubmit').textContent = signup ? 'Sign up' : 'Login';
  $('authSwitch').textContent = signup ? 'Already have an account? Login' : 'New here? Create an account';
  document.querySelectorAll('.su').forEach(el => el.classList.toggle('hidden', !signup));
  $('f_name').required = signup;
  $('authErr').textContent = '';
  $('authModal').classList.remove('hidden');
}
$('authSwitch').onclick = () => openAuth(mode === 'login' ? 'signup' : 'login');
$('authClose').onclick = () => $('authModal').classList.add('hidden');

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const r = await api(mode === 'login' ? '/api/login' : '/api/signup', 'POST', Object.fromEntries(new FormData(e.target)));
  if (!r.ok) { $('authErr').textContent = r.data.error; return; }
  user = r.data; e.target.reset();
  $('authModal').classList.add('hidden');
  renderUser();
};

async function logout() { await api('/api/logout', 'POST'); user = null; renderUser(); }

async function showOrders() {
  const r = await api('/api/orders');
  $('ordersList').innerHTML = r.data.length ? r.data.map(o => `
    <div class="order"><b>Order #${o.id}</b> · ${inr(o.total)} · ${esc(o.created_at)}
      ${user.role === 'admin' ? `<br><small>Customer: ${esc(o.customer || 'unknown')}</small>` : ''}
      <br><small>${o.items.map(i => esc(i.name) + ' × ' + i.qty).join(', ')}</small></div>`).join('')
    : '<p class="empty">No orders yet.</p>';
  $('ordersModal').classList.remove('hidden');
}
$('ordersClose').onclick = () => $('ordersModal').classList.add('hidden');

// ---------- Filters / drawer ----------
['category', 'sort'].forEach(id => $(id).onchange = load);
$('search').oninput = load;
$('max').oninput = () => { $('maxLabel').textContent = $('max').value; load(); };
$('cartBtn').onclick = () => $('drawer').classList.remove('hidden');
$('close').onclick = () => $('drawer').classList.add('hidden');

(async () => { user = (await api('/api/me')).data; renderUser(); renderCart(); load(); })();
