// lê o carrinho salvo de forma defensiva: se o localStorage estiver corrompido (extensão,
// manipulação manual, valor não-array), limpa e começa vazio em vez de derrubar a página.
function loadCart() {
  try {
    const v = JSON.parse(localStorage.getItem('cart') || '[]');
    return new Map(Array.isArray(v) ? v : []);
  } catch {
    localStorage.removeItem('cart');
    return new Map();
  }
}

const state = {
  products: [],
  cart: loadCart(),
  user: null,
};

const $ = (id) => document.getElementById(id);

let userToken = localStorage.getItem('userToken') || '';

// sócio do link /login/<slug> — define de quem o cliente vira ao se cadastrar.
// Cadastro só é liberado quando a página tem um slug de sócio VÁLIDO.
let partners = [];
let regPartner = null; // { slug, name } ou null (domínio pelado → só login)

function slugFromUrl() {
  const m = location.pathname.match(/^\/login\/([a-z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

async function loadPartners() {
  const slug = slugFromUrl();
  let loaded = false;
  for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
    try {
      const res = await fetch('/api/partners');
      if (res.ok) {
        partners = await res.json();
        loaded = true;
      }
    } catch {}
    if (!loaded && attempt === 0) await new Promise((r) => setTimeout(r, 800)); // 1 retry
  }
  regPartner = partners.find((p) => p.slug === slug) || null;
  // mostra "Criar conta" só quando veio pelo link de um sócio; senão, só login
  $('showRegisterBtn').classList.toggle('hidden', !regPartner);
  const hint = $('noRegisterHint');
  hint.classList.toggle('hidden', Boolean(regPartner));
  if (slug && !loaded) {
    // veio pelo link de um sócio, mas a lista não carregou (servidor reiniciando/sem rede):
    // NÃO diz "use o link do vendedor" (ele já está usando) — oferece tentar de novo.
    hint.innerHTML = 'Não consegui carregar o cadastro agora. <a href="#" id="retryPartners">Tentar de novo</a>';
    const r = $('retryPartners');
    if (r) r.addEventListener('click', (e) => { e.preventDefault(); loadPartners(); });
  } else if (!regPartner) {
    hint.innerHTML = 'Para criar uma conta, use o <strong>link do seu vendedor</strong>.';
  }
  if (regPartner) {
    const v = $('regVendor');
    v.classList.remove('hidden');
    v.innerHTML = `Cadastro para clientes de <strong>${escHtml(regPartner.name)}</strong>.`;
  }
}

const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cents) => fmtBRL.format(cents / 100);

function authHeaders(extra = {}) {
  return { 'x-user-token': userToken, ...extra };
}

function saveCart() {
  localStorage.setItem('cart', JSON.stringify([...state.cart]));
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

// ---- produtos ----

async function refreshProducts() {
  if (!userToken) return;
  const res = await fetch('/api/products', { headers: authHeaders() });
  if (res.status === 401) return doLogout();
  state.products = await res.json();

  // se o estoque diminuiu, ajusta o carrinho para não passar do disponível
  let adjusted = false;
  for (const [id, qty] of state.cart) {
    const prod = state.products.find((p) => p.id === id);
    if (!prod || prod.stock === 0) {
      state.cart.delete(id);
      adjusted = true;
    } else if (qty > prod.stock) {
      state.cart.set(id, prod.stock);
      adjusted = true;
    }
  }
  if (adjusted) {
    saveCart();
    toast('O estoque mudou e seu pedido foi ajustado.');
  }
  renderSelectors();
  renderProducts();
  renderCartBar();
}

function stockBadge(stock) {
  if (stock === 0) return '<span class="stock-badge out">Esgotado</span>';
  if (stock <= 5) return `<span class="stock-badge low">Últimas ${stock} un.</span>`;
  return `<span class="stock-badge">Estoque: ${stock}</span>`;
}

function stockBar(stock) {
  if (stock === 0) return '';
  const pct = Math.max(5, Math.min(100, Math.round((stock / 60) * 100)));
  const cls = stock <= 5 ? ' low' : stock <= 15 ? ' mid' : '';
  return `<div class="stock-bar${cls}"><span style="width:${pct}%"></span></div>`;
}

function productCard(p, displayName) {
  const qty = state.cart.get(p.id) || 0;
  // a logo da marca vem do servidor (padrões do site + as enviadas pelo admin).
  // caminho absoluto (leading /) para carregar certo mesmo sob a URL /login/<slug>.
  const logoSrc = p.logo ? (p.logo.startsWith('/') ? p.logo : '/' + p.logo) : '';
  const logo = logoSrc ? `<img class="card-logo" src="${escHtml(logoSrc)}" alt="" loading="lazy" />` : '';
  const controls =
    p.stock === 0
      ? '<button class="btn-primary" disabled>Esgotado</button>'
      : `<div class="qty-row">
           <button class="btn-qty" data-dec="${p.id}" ${qty === 0 ? 'disabled' : ''}>−</button>
           <span class="qty-num" data-qty-for="${p.id}">${qty}</span>
           <button class="btn-qty" data-inc="${p.id}" ${qty >= p.stock ? 'disabled' : ''}>+</button>
         </div>`;
  return `<div class="card">
    <div class="card-info">
      <div class="name">${escHtml(displayName)}</div>
      ${p.price != null ? `<div class="price">${money(p.price)}</div>` : '<div class="price muted-price">valor a combinar</div>'}
      ${stockBadge(p.stock)}
    </div>
    ${logo}
    <div class="card-actions">${controls}</div>
  </div>`;
}

// marcas com nome composto (o resto do título vira o modelo);
// marcas de uma palavra só (IGNITE, ELFBAR, NIK, OXBAR, FUME...) são reconhecidas sozinhas
const MULTIWORD_BRANDS = [
  'LOST MARY',
  'BLACK SHEEP',
  'ELF BAR',
  'GEEK BAR',
  'AIR BAR',
  'PUFF BAR',
  'LOST VAPE',
  'MR FOG',
  'BANG KING',
  'HYPPE MAX',
];

// a linha V (V55, V80, V155, V300, V400, VMIX, VNANO...) são modelos da IGNITE
const IGNITE_MODEL = /^V(\d|MIX|NANO)/i;

function headerOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(0, ix) : '';
}

function flavorOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(ix + 3) : name;
}

function splitBrandModel(header) {
  if (!header) return ['OUTROS', 'OUTROS'];
  if (IGNITE_MODEL.test(header)) return ['IGNITE', header];
  for (const b of MULTIWORD_BRANDS) {
    if (header.startsWith(b + ' ')) return [b, header.slice(b.length + 1)];
    if (header === b) return [b, b];
  }
  const ix = header.indexOf(' ');
  if (ix < 0) return [header, header]; // marca de modelo único
  return [header.slice(0, ix), header.slice(ix + 1)];
}

// catálogo hierárquico: marca → modelo → produtos
function catalog() {
  const brands = new Map();
  for (const p of state.products) {
    const [brand, model] = splitBrandModel(headerOf(p.name));
    if (!brands.has(brand)) brands.set(brand, new Map());
    const models = brands.get(brand);
    if (!models.has(model)) models.set(model, []);
    models.get(model).push(p);
  }
  return brands;
}

// escapa texto (nome de produto, título) antes de ir para innerHTML
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const esc = (s) => escHtml(s); // atributos data-* também recebem escape completo

function renderSelectors() {
  const brands = catalog();
  if (state.brandSel && !brands.has(state.brandSel)) {
    state.brandSel = null;
    state.modelSel = null;
  }

  $('brandChips').innerHTML =
    `<button class="chip ${!state.brandSel ? 'active' : ''}" data-brand="">Todas</button>` +
    [...brands.entries()]
      .map(([b, models]) => {
        const count = [...models.values()].reduce((s, l) => s + l.length, 0);
        return `<button class="chip ${state.brandSel === b ? 'active' : ''}" data-brand="${esc(b)}">${escHtml(b)} <span class="chip-count">${count}</span></button>`;
      })
      .join('');

  const modelWrap = $('modelChips');
  const modelLabel = $('stepModelLabel');
  if (!state.brandSel) {
    state.modelSel = null;
    modelWrap.classList.add('hidden');
    modelLabel.classList.add('hidden');
    modelWrap.innerHTML = '';
    return;
  }

  const models = brands.get(state.brandSel);
  if (state.modelSel && !models.has(state.modelSel)) state.modelSel = null;
  modelWrap.classList.remove('hidden');
  modelLabel.classList.remove('hidden');
  modelWrap.innerHTML =
    `<button class="chip ${!state.modelSel ? 'active' : ''}" data-model="">Todos</button>` +
    [...models.entries()]
      .map(([m, list]) => {
        const label = m.replace(/\s*\(.+\)\s*$/, ''); // chip mostra só o modelo, sem a observação
        return `<button class="chip ${state.modelSel === m ? 'active' : ''}" data-model="${esc(m)}">${escHtml(label)} <span class="chip-count">${list.length}</span></button>`;
      })
      .join('');
}

const titleOf = (header) => {
  const [b, m] = splitBrandModel(header);
  return b === m ? b : `${b} ${m}`;
};

function renderProducts() {
  const grid = $('productGrid');
  const q = (state.filter || '').trim().toLowerCase();

  let groups = []; // pares [título, produtos]

  if (q) {
    // busca vale para o catálogo inteiro, ignorando os filtros
    const map = new Map();
    for (const p of state.products.filter((x) => x.name.toLowerCase().includes(q))) {
      const h = headerOf(p.name);
      if (!map.has(h)) map.set(h, []);
      map.get(h).push(p);
    }
    groups = [...map.entries()].map(([h, list]) => [titleOf(h), list]);
  } else {
    // lista inteira por padrão; filtros de marca/modelo estreitam a exibição
    for (const [b, models] of catalog()) {
      if (state.brandSel && b !== state.brandSel) continue;
      for (const [m, list] of models) {
        if (state.brandSel && state.modelSel && m !== state.modelSel) continue;
        groups.push([b === m ? b : `${b} ${m}`, list]);
      }
    }
  }

  $('emptyProducts').classList.toggle('hidden', groups.length > 0);
  if (!state.didIntro && state.products.length > 0) {
    state.didIntro = true;
    grid.classList.add('first-load');
    setTimeout(() => grid.classList.remove('first-load'), 1000);
  }
  grid.innerHTML = groups
    .map(([title, list]) => {
      // "(OBSERVAÇÃO)" no título vira uma linha própria abaixo dele, sem negrito
      const m = title.match(/^(.*?)\s*\((.+)\)\s*$/);
      const main = m ? m[1] : title;
      const note = m ? m[2] : '';
      return `<div class="brand-group">
        <h3 class="brand-title">${escHtml(main)} <span class="brand-count">${list.length} ${list.length === 1 ? 'sabor' : 'sabores'}</span></h3>
        ${note ? `<p class="brand-note">${escHtml(note)}</p>` : ''}
        <div class="grid">${list.map((p) => productCard(p, flavorOf(p.name))).join('')}</div>
      </div>`;
    })
    .join('');
}

// ---- animação rápida de carregamento (skeleton) ----

function showGridSkeleton(n = 6) {
  const card = `<div class="skeleton-card">
    <div style="flex:1">
      <div class="sk-line" style="width:60%"></div>
      <div class="sk-line" style="width:35%;margin-top:9px"></div>
    </div>
    <div class="sk-line" style="width:96px;height:34px;border-radius:10px"></div>
  </div>`;
  $('productGrid').innerHTML = `<div class="grid">${card.repeat(n)}</div>`;
  $('emptyProducts').classList.add('hidden');
}

let filterAnimTimer;
function renderProductsWithLoading() {
  showGridSkeleton();
  clearTimeout(filterAnimTimer);
  filterAnimTimer = setTimeout(renderProducts, 250);
}

$('searchBox').addEventListener('input', (e) => {
  state.filter = e.target.value.trim();
  renderProducts();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { add, inc, dec, brand, model } = btn.dataset;
  if (add) changeQty(add, 1);
  if (inc) changeQty(inc, 1);
  if (dec) changeQty(dec, -1);
  if (brand !== undefined) {
    state.brandSel = brand && state.brandSel !== brand ? brand : null; // tocar de novo (ou "Todas") desmarca
    state.modelSel = null;
    renderSelectors();
    renderProductsWithLoading();
  }
  if (model !== undefined) {
    state.modelSel = model && state.modelSel !== model ? model : null; // tocar de novo (ou "Todos") desmarca
    renderSelectors();
    renderProductsWithLoading();
  }
});

function changeQty(productId, delta) {
  const prod = state.products.find((p) => p.id === productId);
  if (!prod) return;
  const next = (state.cart.get(productId) || 0) + delta;
  if (next <= 0) state.cart.delete(productId);
  else state.cart.set(productId, Math.min(next, prod.stock));
  saveCart();
  renderProducts();
  renderCartBar();
  if ($('cartModalBackdrop').classList.contains('hidden') === false) renderCartModal();
  document
    .querySelectorAll(`.qty-num[data-qty-for="${productId}"]`)
    .forEach((el) => el.classList.add('pop'));
}

// ---- carrinho ----

function cartEntries() {
  return [...state.cart]
    .map(([id, qty]) => {
      const prod = state.products.find((p) => p.id === id);
      return prod ? { prod, qty } : null;
    })
    .filter(Boolean);
}

function cartUnits() {
  return cartEntries().reduce((s, e) => s + e.qty, 0);
}

// total em R$ — só quando todos os itens do carrinho têm preço definido
function cartTotalCents() {
  const entries = cartEntries();
  if (entries.length === 0 || entries.some(({ prod }) => prod.price == null)) return null;
  return entries.reduce((s, { prod, qty }) => s + prod.price * qty, 0);
}

let lastUnits = 0;
function renderCartBar() {
  const units = cartUnits();
  const topCount = $('cartTopCount');
  topCount.textContent = units;
  topCount.classList.toggle('hidden', units === 0);
  $('cartBar').classList.toggle('hidden', units === 0);
  if (units === 0) {
    lastUnits = 0;
    $('cartModalBackdrop').classList.add('hidden');
    return;
  }
  const total = cartTotalCents();
  const summary = $('cartSummary');
  summary.textContent = `🛒 ${units} ${units === 1 ? 'peça' : 'peças'}${total != null ? ' · ' + money(total) : ''}`;
  if (units !== lastUnits) {
    summary.classList.remove('pop');
    void summary.offsetWidth;
    summary.classList.add('pop');
  }
  lastUnits = units;
}

function renderCartModal() {
  $('cartItems').innerHTML = cartEntries()
    .map(
      ({ prod, qty }) => `<div class="cart-item">
        <div>
          <div>${escHtml(prod.name)}</div>
          <div class="muted">${prod.price != null ? `${qty} × ${money(prod.price)} = ${money(prod.price * qty)}` : `${qty} ${qty === 1 ? 'peça' : 'peças'} · valor a combinar`}</div>
        </div>
        <div class="qty-row" style="margin:0">
          <button class="btn-qty" data-dec="${prod.id}">−</button>
          <span class="qty-num" data-qty-for="${prod.id}" style="min-width:24px">${qty}</span>
          <button class="btn-qty" data-inc="${prod.id}" ${qty >= prod.stock ? 'disabled' : ''}>+</button>
        </div>
      </div>`
    )
    .join('');
  $('modalUnits').textContent = String(cartUnits());
  const total = cartTotalCents();
  $('modalTotal').textContent = total != null ? money(total) : 'a combinar';
}

function openCartModal() {
  renderCartModal();
  $('custAddress').value =
    (state.user && state.user.lastAddress) || localStorage.getItem('custAddress') || '';
  $('cartModalBackdrop').classList.remove('hidden');
}

// ---- WhatsApp internacional: código do país + DDD + número ----

// código do país escolhido no seletor (ou o digitado, quando "Outro país")
function selectedCountryCode() {
  const sel = $('regCountry').value;
  if (sel === '0') return $('regCountryCustom').value.replace(/\D/g, '');
  return sel;
}

// retorna { code, local, full, error } — full são só os dígitos com o código do país
function collectPhone() {
  const code = selectedCountryCode();
  const local = $('regPhone').value.replace(/\D/g, '');
  const full = code + local;
  let error = null;
  if (!code) error = 'Escolha o país ou informe o código dele.';
  else if (!local) error = 'Informe o DDD e o número.';
  else if (local.length < 6) error = 'Número muito curto. Digite o DDD junto com o número.';
  else if (full.length > 15) error = 'Número muito longo. Confira o DDD e o número.';
  return { code, local, full, error };
}

function validateRegPhone() {
  const { code, local, full, error } = collectPhone();
  const st = $('regPhoneStatus');
  if (!local && !error) {
    st.classList.add('hidden');
    st.textContent = '';
    return null;
  }
  st.classList.remove('hidden');
  st.classList.toggle('warn', Boolean(error));
  st.textContent = error || `WhatsApp: +${full}`;
  return error;
}

$('regPhone').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d\s()-]/g, '');
  validateRegPhone();
});
$('regCountry').addEventListener('change', () => {
  $('regCountryCustom').classList.toggle('hidden', $('regCountry').value !== '0');
  validateRegPhone();
});
$('regCountryCustom').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d]/g, '');
  validateRegPhone();
});

// ---- login / cadastro ----

function showAuth(form = 'login') {
  $('storeMain').classList.add('hidden');
  $('cartBar').classList.add('hidden');
  $('cartTopBtn').classList.add('hidden');
  $('menuBtn').classList.add('hidden');
  $('menuBackdrop').classList.add('hidden');
  $('authView').classList.remove('hidden');
  $('loginForm').classList.toggle('hidden', form !== 'login');
  $('registerForm').classList.toggle('hidden', form !== 'register');
  $('registerDone').classList.toggle('hidden', form !== 'done');
}

function showStore() {
  $('authView').classList.add('hidden');
  $('storeMain').classList.remove('hidden');
  $('cartTopBtn').classList.remove('hidden');
  $('menuBtn').classList.remove('hidden');
  $('menuUserName').textContent = state.user.name;
  showGridSkeleton();
  refreshProducts();
  refreshMyOrders();
  connectSse();
}

function doLogout() {
  userToken = '';
  state.user = null;
  // limpa o carrinho e o endereço deste cliente — num aparelho compartilhado (balcão),
  // o próximo cliente NÃO pode herdar o pedido nem o endereço de entrega do anterior.
  state.cart.clear();
  localStorage.removeItem('userToken');
  localStorage.removeItem('cart');
  localStorage.removeItem('custAddress');
  if ($('custAddress')) $('custAddress').value = '';
  if (es) {
    es.close();
    es = null;
  }
  renderCartBar();
  $('live').classList.remove('on');
  showAuth('login');
}

// ---- menu lateral ----
$('menuBtn').addEventListener('click', () => $('menuBackdrop').classList.remove('hidden'));
$('menuBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});
$('menuMyOrders').addEventListener('click', () => {
  $('menuBackdrop').classList.add('hidden');
  openMyOrders();
});
$('menuLogout').addEventListener('click', () => {
  $('menuBackdrop').classList.add('hidden');
  doLogout();
});

async function initAuth() {
  await loadPartners(); // decide se o cadastro fica liberado (veio pelo link de um sócio?)
  if (userToken) {
    try {
      const res = await fetch('/api/me', { headers: authHeaders() });
      if (res.ok) {
        state.user = await res.json();
        return showStore();
      }
    } catch {}
    userToken = '';
    localStorage.removeItem('userToken');
  }
  showAuth('login');
}

async function doLogin() {
  $('loginError').textContent = '';
  const username = $('loginUser').value.trim().toLowerCase();
  const password = $('loginPass').value;
  if (!username || !password) {
    $('loginError').textContent = 'Preencha usuário e senha.';
    return;
  }
  const btn = $('loginSubmitBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('loginError').textContent = data.error || 'Erro ao entrar.';
      return;
    }
    userToken = data.token;
    localStorage.setItem('userToken', userToken);
    state.user = data;
    $('loginPass').value = '';
    showStore();
  } catch {
    $('loginError').textContent = 'Sem conexão. Tente de novo.';
  } finally {
    btn.disabled = false;
  }
}

$('loginSubmitBtn').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
$('forgotPassLink').addEventListener('click', (e) => {
  e.preventDefault();
  const vendor = regPartner ? ` (${regPartner.name})` : '';
  toast('Fale com o seu vendedor' + vendor + ' pelo WhatsApp — ele redefine a sua senha na hora.');
});
$('showRegisterBtn').addEventListener('click', () => showAuth('register'));
$('showLoginBtn').addEventListener('click', () => showAuth('login'));
$('backToLoginBtn').addEventListener('click', () => showAuth('login'));

$('registerSubmitBtn').addEventListener('click', async () => {
  $('registerError').textContent = '';
  if (!regPartner) {
    return ($('registerError').textContent = 'Para criar uma conta, use o link do seu vendedor.');
  }
  const name = $('regName').value.trim();
  const username = $('regUser').value.trim().toLowerCase();
  const password = $('regPass').value;
  if (!name) return ($('registerError').textContent = 'Informe seu nome ou apelido.');
  const perr = validateRegPhone();
  const phone = collectPhone();
  if (perr || phone.error) return ($('registerError').textContent = perr || phone.error);
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return ($('registerError').textContent = 'Usuário inválido: 3 a 20 letras/números, sem espaços.');
  }
  if (password.length < 4) {
    return ($('registerError').textContent = 'A senha precisa ter pelo menos 4 caracteres.');
  }
  const btn = $('registerSubmitBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, whatsapp: phone.full, username, password, partner: regPartner.slug }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('registerError').textContent = data.error || 'Erro ao cadastrar.';
      return;
    }
    showAuth('done');
  } catch {
    $('registerError').textContent = 'Sem conexão. Tente de novo.';
  } finally {
    btn.disabled = false;
  }
});

$('openCartBtn').addEventListener('click', openCartModal);
$('cartTopBtn').addEventListener('click', () => {
  if (cartUnits() === 0) return toast('Seu pedido está vazio. Toque no + dos produtos para adicionar.');
  openCartModal();
});

$('closeCartBtn').addEventListener('click', () => $('cartModalBackdrop').classList.add('hidden'));
$('cartModalBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('cartModalBackdrop').classList.add('hidden');
});

// ---- tela de sucesso ----

let successTimer;

function showSuccess(orderId) {
  $('successMsg').textContent =
    `Seu pedido #${orderId} foi enviado! Ele será aprovado em até 2 horas pelo WhatsApp. Acompanhe o status no topo da página.`;
  $('successOverlay').classList.remove('hidden');
  clearTimeout(successTimer);
  successTimer = setTimeout(() => $('successOverlay').classList.add('hidden'), 5000);
}

$('successCloseBtn').addEventListener('click', () => $('successOverlay').classList.add('hidden'));
$('successOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// ---- enviar pedido: validação → revisão → confirmação ----

function renderReview() {
  const address = $('custAddress').value.trim();
  const itemsHtml = cartEntries()
    .map(
      ({ prod, qty }) =>
        `<div class="cart-item"><div>${escHtml(prod.name)}${prod.price != null ? `<div class="muted">${qty} × ${money(prod.price)}</div>` : ''}</div><div><strong>${prod.price != null ? money(prod.price * qty) : qty + '×'}</strong></div></div>`
    )
    .join('');
  const total = cartTotalCents();
  $('reviewContent').innerHTML = `
    ${itemsHtml}
    <div class="total-row"><span>Total de peças</span><span>${cartUnits()}</span></div>
    <div class="total-row" style="padding-top:0"><span>Total</span><span>${total != null ? money(total) : 'a combinar'}</span></div>
    <div class="review-data">
      <div class="review-line"><span>👤</span><div><small>Nome</small><div>${escHtml(state.user.name)}</div></div></div>
      <div class="review-line"><span>📱</span><div><small>WhatsApp</small><div>${state.user.whatsapp ? '+' + escHtml(state.user.whatsapp) : ''}</div></div></div>
      <div class="review-line"><span>📍</span><div><small>Endereço de entrega</small><div>${escHtml(address)}</div></div></div>
    </div>`;
}

$('submitOrderBtn').addEventListener('click', () => {
  const address = $('custAddress').value.trim();
  if (!address) { toast('Informe o endereço.', true); return $('custAddress').focus(); }
  if (cartEntries().length === 0) return toast('Seu pedido está vazio.', true);

  renderReview();
  $('cartModalBackdrop').classList.add('hidden');
  $('reviewBackdrop').classList.remove('hidden');
});

$('backToCartBtn').addEventListener('click', () => {
  $('reviewBackdrop').classList.add('hidden');
  $('cartModalBackdrop').classList.remove('hidden');
});

$('reviewBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    $('reviewBackdrop').classList.add('hidden');
    $('cartModalBackdrop').classList.remove('hidden');
  }
});

$('confirmOrderBtn').addEventListener('click', async () => {
  const address = $('custAddress').value.trim();
  localStorage.setItem('custAddress', address);
  if (state.user) state.user.lastAddress = address;

  const items = cartEntries().map(({ prod, qty }) => ({ productId: prod.id, qty }));
  if (items.length === 0) return toast('Seu pedido está vazio.', true);

  const btn = $('confirmOrderBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ customer: { address }, items }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Erro ao enviar pedido.', true);
      $('reviewBackdrop').classList.add('hidden');
      await refreshProducts();
      return;
    }
    state.cart.clear();
    saveCart();
    $('reviewBackdrop').classList.add('hidden');
    $('cartModalBackdrop').classList.add('hidden');
    renderCartBar();
    showSuccess(data.id);
    await Promise.all([refreshProducts(), refreshMyOrders()]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    // servidor fora do ar / sem conexão / resposta não-JSON: avisa e mantém o carrinho
    // para o cliente tentar de novo, em vez de travar sem feedback nenhum.
    toast('Não foi possível enviar agora. Confira sua conexão e tente de novo.', true);
  } finally {
    btn.disabled = false;
  }
});

// ---- meus pedidos ----

const STATUS_LABEL = { pendente: 'Pendente', aceito: 'Aceito ✔', recusado: 'Recusado' };

function orderChipHtml(o) {
  return `<div class="order-chip">
    <div>
      <div><strong>#${o.id}</strong></div>
      <div class="muted">${o.items.map((i) => `${i.qty}× ${escHtml(i.name)}`).join(' · ')}</div>
    </div>
    <span class="status ${o.status}">${STATUS_LABEL[o.status] || o.status}</span>
  </div>`;
}

async function refreshMyOrders() {
  if (!userToken) return;
  const res = await fetch('/api/my-orders', { headers: authHeaders() });
  if (!res.ok) return;
  const orders = await res.json();
  state.myOrders = orders;
  // na tela principal aparece só o último pedido; o resto fica em "Meus pedidos" (menu)
  $('myOrdersSection').classList.toggle('hidden', orders.length === 0);
  $('myOrdersList').innerHTML = orders.length ? orderChipHtml(orders[0]) : '';
  const viewAll = $('viewAllOrders');
  viewAll.classList.toggle('hidden', orders.length <= 1);
  viewAll.textContent = `Ver todos os ${orders.length} pedidos →`;
  if (!$('myOrdersModalBackdrop').classList.contains('hidden')) renderMyOrdersFull();
}

function renderMyOrdersFull() {
  const orders = state.myOrders || [];
  $('myOrdersFullList').innerHTML = orders.length
    ? orders.map(orderChipHtml).join('')
    : '<p class="empty">Nenhum pedido ainda.</p>';
}

function openMyOrders() {
  renderMyOrdersFull();
  $('myOrdersModalBackdrop').classList.remove('hidden');
}

$('viewAllOrders').addEventListener('click', (e) => {
  e.preventDefault();
  openMyOrders();
});
$('closeMyOrdersBtn').addEventListener('click', () => $('myOrdersModalBackdrop').classList.add('hidden'));
$('myOrdersModalBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// ---- tempo real ----

// O servidor (Vercel) não mantém conexões abertas; em vez de SSE, consultamos a versão
// dos dados a cada poucos segundos e recarregamos quando ela muda.
let es = null;
function connectSse() {
  if (!userToken) return;
  if (es) es.close();
  let ver = null;
  let busy = false;
  const tick = async () => {
    if (!userToken || busy) return;
    busy = true;
    try {
      const r = await fetch('/api/events?utoken=' + encodeURIComponent(userToken));
      if (!r.ok) throw new Error('offline');
      const data = await r.json();
      $('live').classList.add('on');
      if (ver !== null && data.v !== ver) {
        refreshProducts();
        refreshMyOrders();
      }
      ver = data.v;
    } catch {
      $('live').classList.remove('on');
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, 5000);
  es = { close: () => clearInterval(timer) };
}

initAuth();
