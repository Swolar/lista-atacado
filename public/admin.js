const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (cents) => fmt.format(cents / 100);
const $ = (id) => document.getElementById(id);

// escapa strings vindas do cliente/produto antes de ir para innerHTML (evita XSS no painel)
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let token = localStorage.getItem('adminToken') || '';
let partnerName = localStorage.getItem('adminPartnerName') || ''; // sócio logado
let orders = [];
let products = [];
let productModels = [];
let users = [];
let knownPendingCount = null;
let knownPendingUsers = null;
let es = null; // "conexão" de tempo real (polling do /api/events)

function setPartnerLabel() {
  const el = $('adminPartner');
  if (el) el.textContent = partnerName || 'Admin';
  const mn = $('menuPartnerName');
  if (mn) mn.textContent = partnerName || 'Admin';
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

function hasFinance(o) {
  return o.revenueCents !== null && o.revenueCents !== undefined && o.costCents !== null && o.costCents !== undefined;
}

// ---- categoria (marca) e modelo — mesmo critério da loja ----
const MULTIWORD_BRANDS = ['LOST MARY', 'BLACK SHEEP', 'ELF BAR', 'GEEK BAR', 'AIR BAR', 'PUFF BAR', 'LOST VAPE', 'MR FOG', 'BANG KING', 'HYPPE MAX'];
const IGNITE_MODEL = /^V(\d|MIX|NANO)/i;
function headerOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(0, ix) : name;
}
function brandOf(name) {
  const h = headerOf(name);
  if (!h) return 'OUTROS';
  if (IGNITE_MODEL.test(h)) return 'IGNITE';
  for (const b of MULTIWORD_BRANDS) if (h.startsWith(b + ' ') || h === b) return b;
  const ix = h.indexOf(' ');
  return ix < 0 ? h : h.slice(0, ix);
}

// ---- configurações do sócio (custo por modelo + link do Pushcut) e LUCRO AUTOMÁTICO ----
let settings = { notifyUrl: '', costs: {} };
// custo do pedido = Σ (custo do modelo × qtd). null se faltar o custo de algum modelo.
function autoCostCents(o) {
  let total = 0;
  for (const i of o.items) {
    const c = settings.costs[modelOf(i.name)];
    if (!Number.isFinite(c)) return null;
    total += c * i.qty;
  }
  return total;
}
// faturamento/custo/lucro EFETIVOS: usa o que foi lançado à mão; se não, calcula sozinho
// (faturamento = preço do cliente; custo = custo por modelo). Assim o lucro sai automático.
const effRevenue = (o) => (Number.isFinite(o.revenueCents) ? o.revenueCents : o.totalCents);
const effCost = (o) => (Number.isFinite(o.costCents) ? o.costCents : autoCostCents(o));
function effProfit(o) {
  const r = effRevenue(o);
  const c = effCost(o);
  return Number.isFinite(r) && Number.isFinite(c) ? r - c : null;
}
const isAccounted = (o) => effProfit(o) !== null; // já tem faturamento E custo (auto ou manual)

// ---- auth ----

function showLogin() {
  token = '';
  partnerName = '';
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminPartnerName');
  if (es) {
    es.close();
    es = null;
  }
  $('live').classList.remove('on');
  $('adminMenuBackdrop').classList.add('hidden');
  $('adminMenuBtn').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('panelView').classList.add('hidden');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-token': token, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('sessão expirada');
  }
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || 'Erro na operação.', true);
    throw new Error(data.error || 'erro');
  }
  return data;
}

$('loginBtn').addEventListener('click', login);
$('password').addEventListener('keydown', (e) => e.key === 'Enter' && login());
$('adminUser').addEventListener('keydown', (e) => e.key === 'Enter' && login());

async function login() {
  $('loginError').textContent = '';
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('adminUser').value, password: $('password').value }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('loginError').textContent = data.error || 'Erro ao entrar.';
    return;
  }
  token = data.token;
  partnerName = (data.partner && data.partner.name) || 'Admin';
  localStorage.setItem('adminToken', token);
  localStorage.setItem('adminPartnerName', partnerName);
  $('password').value = '';
  enterPanel();
}

$('logoutBtn').addEventListener('click', showLogin);

async function enterPanel() {
  setPartnerLabel();
  $('adminMenuBtn').classList.remove('hidden');
  showTab('dashboard');
  $('loginView').classList.add('hidden');
  $('panelView').classList.remove('hidden');
  await loadAll();
  connectSse();
}

// ---- dados ----

async function loadAll() {
  [orders, products, users, productModels, settings] = await Promise.all([
    api('/api/admin/orders'),
    api('/api/admin/products'),
    api('/api/admin/users'),
    api('/api/admin/models'),
    api('/api/admin/settings'),
  ]);
  if (!settings || typeof settings !== 'object') settings = { notifyUrl: '', costs: {} };
  if (!settings.costs || typeof settings.costs !== 'object') settings.costs = {};
  notifyIfNewOrder();
  // não re-renderiza enquanto o admin digita/edita um campo (evita perder o que foi digitado)
  const el = document.activeElement;
  if (
    el &&
    el.closest('#panelView') &&
    (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text')))
  ) {
    return;
  }
  renderDashboard();
  renderPedidos();
  renderClientes();
  renderLeads();
  renderEstoque();
  renderContabilidade();
  renderSettings();
}

function notifyIfNewOrder() {
  const pending = orders.filter((o) => o.status === 'pendente').length;
  const badge = $('pendingBadge');
  badge.textContent = pending;
  badge.classList.toggle('hidden', pending === 0);

  const toLaunch = orders.filter((o) => o.status === 'aceito' && !isAccounted(o)).length;
  const finBadge = $('financeBadge');
  finBadge.textContent = toLaunch;
  finBadge.classList.toggle('hidden', toLaunch === 0);

  document.title = (pending > 0 ? `(${pending}) ` : '') + `Painel ${partnerName || 'Admin'} – Lista De Pods`;

  if (knownPendingCount !== null && pending > knownPendingCount) {
    beep();
    toast('Novo pedido recebido!');
  }
  knownPendingCount = pending;

  const pendingUsers = users.filter((u) => u.status === 'pendente').length;
  const uBadge = $('usersBadge');
  uBadge.textContent = pendingUsers;
  uBadge.classList.toggle('hidden', pendingUsers === 0);
  if (knownPendingUsers !== null && pendingUsers > knownPendingUsers) {
    beep();
    toast('Novo cadastro de cliente para aprovar!');
  }
  knownPendingUsers = pendingUsers;

  // aviso combinado no botão ☰ (pra ver que tem algo mesmo com o menu fechado)
  const alerts = pending + pendingUsers;
  const ab = $('menuAlertBadge');
  if (ab) {
    ab.textContent = alerts;
    ab.classList.toggle('hidden', alerts === 0);
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

// ---- abas ----

// ---- navegação pelo menu lateral (☰) ----
const TABS = ['dashboard', 'pedidos', 'clientes', 'leads', 'estoque', 'contabilidade'];
function showTab(name) {
  TABS.forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== name));
  document.querySelectorAll('.menu-item[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
}
function openAdminMenu() {
  $('adminMenuBackdrop').classList.remove('hidden');
}
function closeAdminMenu() {
  $('adminMenuBackdrop').classList.add('hidden');
}
$('adminMenuBtn').addEventListener('click', openAdminMenu);
$('adminMenuBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeAdminMenu();
});
document.querySelectorAll('.menu-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => {
    showTab(btn.dataset.nav);
    closeAdminMenu();
  });
});

// ---- pedidos ----

const STATUS_LABEL = { pendente: 'Pendente', aceito: 'Aceito', recusado: 'Recusado' };

function dt(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function dtFull(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// pedidos antigos guardavam o endereço como objeto (com CEP); os novos são texto simples
function addressText(a) {
  if (typeof a === 'string') return a;
  return `${a.street}, ${a.number}${a.complement ? ' – ' + a.complement : ''} · ${[a.neighborhood, a.city].filter(Boolean).join(' · ')} · CEP ${a.cep}`;
}

// o número já é guardado com o código do país (ex: 55..., 595...) — usa direto no wa.me
function waDigits(phone) {
  return String(phone).replace(/\D/g, '');
}

function waLink(phone) {
  const d = waDigits(phone);
  return d ? `<a class="wa" href="https://wa.me/${d}" target="_blank" rel="noopener">+${escHtml(d)}</a>` : escHtml(phone);
}

// abre o WhatsApp do cliente com o resumo do pedido pronto para enviar
function orderWhatsAppMessage(o) {
  const itens = o.items.map((i) => `• ${i.qty}x ${i.name}`).join('\n');
  const valor = Number.isFinite(effRevenue(o)) ? money(effRevenue(o)) : 'R$ X,XX';
  return [
    '✅ *Pedido confirmado!*',
    '',
    `Olá, *${o.customer.name}*.`,
    '',
    'Recebemos seu pedido com sucesso e ele já está sendo separado.',
    '',
    '📍 *Endereço de entrega*',
    o.customer.address ? addressText(o.customer.address) : '—',
    '',
    `*Resumo do pedido #${o.id}*`,
    '',
    itens,
    '',
    `*Total de peças:* ${units(o)}`,
    '',
    '💳 *Valor total*',
    `*${valor}*`,
    '',
    '*Status do pedido*',
    'Assim que o motoboy sair para a entrega, enviaremos uma nova atualização informando que seu pedido está a caminho.',
    '',
    'Obrigado pela preferência!',
  ].join('\n');
}

function waSummaryLink(o) {
  const d = waDigits(o.customer.phone);
  if (!d) return '';
  const url = `https://wa.me/${d}?text=${encodeURIComponent(orderWhatsAppMessage(o))}`;
  return `<a class="wa" href="${url}" target="_blank" rel="noopener">Enviar resumo</a>`;
}

function units(o) {
  return o.items.reduce((s, i) => s + i.qty, 0);
}

function orderCard(o, mode) {
  const financeBlock =
    mode === 'finance'
      ? `<div class="finance-row" data-fin-card="${o.id}">
           <div>
             <label>Faturamento (R$)</label>
             <input type="number" class="fin-revenue" min="0" step="0.01" placeholder="0,00" value="${Number.isFinite(effRevenue(o)) ? (effRevenue(o) / 100).toFixed(2) : ''}" />
           </div>
           <div>
             <label>Custo (R$)</label>
             <input type="number" class="fin-cost" min="0" step="0.01" placeholder="0,00" value="${Number.isFinite(effCost(o)) ? (effCost(o) / 100).toFixed(2) : ''}" />
           </div>
           <button class="btn-accept" data-finance="${o.id}">Lançar</button>
         </div>`
      : '';
  const actions =
    mode === 'pending'
      ? `<div class="order-actions">
           <button class="btn-accept" data-accept="${o.id}">Aceitar</button>
           <button class="btn-reject" data-reject="${o.id}">Recusar</button>
         </div>`
      : '';
  const financeSummary =
    mode === 'history' && o.status === 'aceito' && effProfit(o) !== null
      ? `<div class="total-row"><span>Lucro</span><span class="${effProfit(o) >= 0 ? 'profit-pos' : 'profit-neg'}">${money(effProfit(o))}</span></div>`
      : '';
  return `<div class="order-card clickable ${o.status === 'pendente' ? 'pending' : ''}" data-open="${o.id}" title="Clique para ver os detalhes">
    <div class="order-head">
      <span class="code">#${o.id}</span>
      <span class="status ${o.status}">${STATUS_LABEL[o.status]}</span>
    </div>
    <div class="order-head">
      <span>${escHtml(o.customer.name)} · ${waLink(o.customer.phone)} · ${waSummaryLink(o)}</span>
      <span class="muted">${dt(o.createdAt)}</span>
    </div>
    ${o.customer.address ? `<div class="order-head"><span class="muted">${escHtml(addressText(o.customer.address))}</span></div>` : ''}
    <ul class="order-items">
      ${o.items.map((i) => `<li><span>${i.qty}× ${escHtml(i.name)}</span></li>`).join('')}
    </ul>
    <div class="total-row"><span>Total de peças</span><span>${units(o)}</span></div>
    ${o.totalCents != null ? `<div class="total-row" style="padding-top:0"><span>Total (preços do cliente)</span><span>${money(o.totalCents)}</span></div>` : ''}
    ${financeSummary}
    ${actions}
    ${financeBlock}
  </div>`;
}

// ---- detalhes completos do pedido (clique no card) ----

function openOrderModal(id) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  const profit = effProfit(o);
  $('orderModalBody').innerHTML = `
    <div class="order-head">
      <h3>Pedido #${o.id}</h3>
      <span class="status ${o.status}">${STATUS_LABEL[o.status]}</span>
    </div>
    <div class="review-data">
      <div class="review-line"><div><small>Recebido em</small><div>${dtFull(o.createdAt)}</div></div></div>
      <div class="review-line"><div><small>Cliente</small><div>${escHtml(o.customer.name)}</div></div></div>
      <div class="review-line"><div><small>WhatsApp</small><div>${waLink(o.customer.phone)} &nbsp;·&nbsp; ${waSummaryLink(o)}</div></div></div>
      ${o.customer.address ? `<div class="review-line"><div><small>Endereço</small><div>${escHtml(addressText(o.customer.address))}</div></div></div>` : ''}
      ${o.decidedAt ? `<div class="review-line"><div><small>${o.status === 'aceito' ? 'Aceito em' : 'Recusado em'}</small><div>${dtFull(o.decidedAt)}</div></div></div>` : ''}
      ${o.editedAt ? `<div class="review-line"><div><small>Itens alterados em</small><div>${dtFull(o.editedAt)}</div></div></div>` : ''}
    </div>
    <div class="total-row" style="padding-bottom:4px"><span>Itens</span><span></span></div>
    ${o.items.map((i) => `<div class="cart-item"><div>${escHtml(i.name)}${Number.isFinite(i.priceCents) ? `<div class="muted">${i.qty} × ${money(i.priceCents)}</div>` : ''}</div><div><strong>${Number.isFinite(i.priceCents) ? money(i.priceCents * i.qty) : i.qty + '×'}</strong></div></div>`).join('')}
    <div class="total-row"><span>Total de peças</span><span>${units(o)}</span></div>
    ${o.totalCents != null ? `<div class="total-row" style="padding-top:0"><span>Total (preços do cliente)</span><span>${money(o.totalCents)}</span></div>` : ''}
    ${
      profit !== null
        ? `<div class="review-data">
            <div class="review-line"><div><small>Faturamento</small><div>${money(effRevenue(o))}</div></div></div>
            <div class="review-line"><div><small>Custo${hasFinance(o) ? '' : ' (automático)'}</small><div>${money(effCost(o))}</div></div></div>
            <div class="review-line"><div><small>Lucro</small><div class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}"><strong>${money(profit)}</strong></div></div></div>
            ${o.financeAt ? `<div class="review-line"><div><small>Lançado em</small><div>${dtFull(o.financeAt)}</div></div></div>` : ''}
          </div>`
        : ''
    }
    ${o.status !== 'recusado' ? `<button class="btn-primary" data-edit-order="${o.id}" style="margin-top:14px">Editar itens do pedido</button>` : ''}`;
  $('orderModalBackdrop').classList.remove('hidden');
}

// ---- edição dos itens do pedido (cliente mudou pelo WhatsApp) ----

let editingOrder = null;

function openOrderEdit(id) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  editingOrder = {
    id: o.id,
    items: o.items.map((i) => ({ ...i })),
    original: new Map(o.items.map((i) => [i.productId, i.qty])),
  };
  renderOrderEdit();
}

function renderOrderEdit() {
  const stockOf = (pid) => {
    const pr = products.find((p) => p.id === pid);
    return pr ? pr.stock : 0;
  };
  // limite = o que já está reservado neste pedido + o que sobra no estoque
  const maxOf = (it) => (editingOrder.original.get(it.productId) || 0) + stockOf(it.productId);

  const rows = editingOrder.items
    .map(
      (it, ix) => `<div class="cart-item">
        <div style="flex:1;min-width:0">
          ${escHtml(it.name)}
          <div class="muted" style="font-size:0.8rem">restam ${stockOf(it.productId)} no estoque</div>
        </div>
        <div class="qty-row" style="margin:0;flex:none">
          <button class="btn-qty" data-edit-dec="${ix}" ${it.qty <= 1 ? 'disabled' : ''}>−</button>
          <span class="qty-num" style="min-width:24px">${it.qty}</span>
          <button class="btn-qty" data-edit-inc="${ix}" ${it.qty >= maxOf(it) ? 'disabled' : ''}>+</button>
          <button class="btn-small danger" data-edit-del="${ix}">Remover</button>
        </div>
      </div>`
    )
    .join('');

  const options = products
    .filter((p) => p.active && p.stock > 0 && !editingOrder.items.some((i) => i.productId === p.id))
    .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)} — ${p.stock} disp.</option>`)
    .join('');

  $('orderModalBody').innerHTML = `
    <div class="order-head"><h3>Editar pedido #${editingOrder.id}</h3></div>
    <p class="muted" style="font-size:0.85rem;margin-bottom:8px">Ao salvar, o estoque é ajustado automaticamente: aumentar desconta, diminuir ou remover devolve.</p>
    ${rows}
    <div class="total-row"><span>Total de peças</span><span>${editingOrder.items.reduce((s, i) => s + i.qty, 0)}</span></div>
    <label for="editAddSelect">Adicionar produto ao pedido</label>
    <div style="display:flex;gap:8px">
      <select id="editAddSelect" style="flex:1" ${options ? '' : 'disabled'}>${options || '<option value="">Nenhum produto disponível</option>'}</select>
      <button class="btn-small" id="editAddBtn" ${options ? '' : 'disabled'}>Adicionar</button>
    </div>
    <button class="btn-primary" id="editSaveBtn" style="margin-top:16px">Salvar alterações</button>
    <button class="btn-small" id="editCancelBtn" style="width:100%;margin-top:10px">Cancelar</button>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.editOrder) return openOrderEdit(btn.dataset.editOrder);
  if (!editingOrder) return;

  if (btn.dataset.editDec !== undefined) {
    const it = editingOrder.items[Number(btn.dataset.editDec)];
    if (it && it.qty > 1) it.qty--;
    return renderOrderEdit();
  }
  if (btn.dataset.editInc !== undefined) {
    const it = editingOrder.items[Number(btn.dataset.editInc)];
    if (it) it.qty++;
    return renderOrderEdit();
  }
  if (btn.dataset.editDel !== undefined) {
    editingOrder.items.splice(Number(btn.dataset.editDel), 1);
    return renderOrderEdit();
  }
  if (btn.id === 'editAddBtn') {
    const pid = $('editAddSelect').value;
    const prod = products.find((p) => p.id === pid);
    if (prod) editingOrder.items.push({ productId: prod.id, name: prod.name, qty: 1 });
    return renderOrderEdit();
  }
  if (btn.id === 'editCancelBtn') {
    const id = editingOrder.id;
    editingOrder = null;
    return openOrderModal(id);
  }
  if (btn.id === 'editSaveBtn') {
    if (editingOrder.items.length === 0) {
      return toast('O pedido precisa de pelo menos um item. Para cancelar tudo, recuse o pedido.', true);
    }
    btn.disabled = true;
    try {
      await api(`/api/admin/orders/${editingOrder.id}/items`, {
        method: 'PUT',
        body: JSON.stringify({ items: editingOrder.items.map(({ productId, qty }) => ({ productId, qty })) }),
      });
      const id = editingOrder.id;
      editingOrder = null;
      toast(`Pedido #${id} atualizado. Estoque ajustado.`);
      await loadAll();
      openOrderModal(id);
    } finally {
      btn.disabled = false;
    }
  }
});

$('orderModalClose').addEventListener('click', () => $('orderModalBackdrop').classList.add('hidden'));
$('orderModalBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, textarea, label, select')) return;
  const card = e.target.closest('[data-open]');
  if (card) openOrderModal(card.dataset.open);
});

function renderPedidos() {
  const pending = orders.filter((o) => o.status === 'pendente');
  // "aguardando lançamento" = aceito mas sem lucro calculável (falta custo do modelo ou preço)
  const toLaunch = orders.filter((o) => o.status === 'aceito' && !isAccounted(o));
  const done = orders.filter((o) => o.status === 'recusado' || (o.status === 'aceito' && isAccounted(o)));

  $('pendingOrders').innerHTML = pending.map((o) => orderCard(o, 'pending')).join('');
  $('emptyPending').classList.toggle('hidden', pending.length > 0);

  $('financeOrders').innerHTML = toLaunch.map((o) => orderCard(o, 'finance')).join('');
  $('emptyFinance').classList.toggle('hidden', toLaunch.length > 0);

  $('orderHistory').innerHTML = done.map((o) => orderCard(o, 'history')).join('');
  $('emptyHistory').classList.toggle('hidden', done.length > 0);
}

async function submitFinance(orderId, revenueInput, costInput, btn) {
  const revenue = parseFloat(revenueInput.value);
  const cost = parseFloat(costInput.value);
  if (!Number.isFinite(revenue) || !Number.isFinite(cost)) {
    return toast('Preencha faturamento e custo.', true);
  }
  btn.disabled = true;
  try {
    await api(`/api/admin/orders/${orderId}/finance`, {
      method: 'POST',
      body: JSON.stringify({
        revenueCents: Math.round(revenue * 100),
        costCents: Math.round(cost * 100),
      }),
    });
    toast(`Lucro do pedido #${orderId}: ${money(Math.round(revenue * 100) - Math.round(cost * 100))}`);
    await loadAll();
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { accept, reject, finance, finRow } = btn.dataset;

  if (accept) {
    btn.disabled = true;
    await api(`/api/admin/orders/${accept}/accept`, { method: 'POST' });
    toast(`Pedido #${accept} aceito. Agora lance o faturamento e o custo.`);
    await loadAll();
  }
  if (reject) {
    btn.disabled = true;
    await api(`/api/admin/orders/${reject}/reject`, { method: 'POST' });
    toast(`Pedido #${reject} recusado. Estoque devolvido.`);
    await loadAll();
  }
  if (finance) {
    const card = document.querySelector(`[data-fin-card="${finance}"]`);
    await submitFinance(finance, card.querySelector('.fin-revenue'), card.querySelector('.fin-cost'), btn);
  }
  if (finRow) {
    const row = btn.closest('tr');
    await submitFinance(finRow, row.querySelector('.fin-revenue'), row.querySelector('.fin-cost'), btn);
  }
});

// ---- clientes: aprovação e tabela de preços por modelo ----

function modelOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(0, ix) : name;
}

// modelos da tabela de preços = lista permanente (independe do estoque) + os que
// eventualmente estejam em produtos ativos, por segurança
function modelList() {
  const set = new Set(productModels || []);
  for (const p of products) if (p.active) set.add(modelOf(p.name));
  return [...set].sort();
}

// gerenciador de modelos (parte de cima da aba Clientes)
function renderModelsManager() {
  const ta = $('modelsText');
  if (!ta) return;
  if (document.activeElement !== ta) {
    ta.value = (productModels || []).map((m) => '-- ' + m).join('\n');
  }
  $('modelsChips').innerHTML = (productModels || []).length
    ? productModels.map((m) => `<span class="chip">${escHtml(m)}</span>`).join('')
    : '<span class="muted" style="font-size:.85rem">Nenhum modelo cadastrado ainda.</span>';
}

function priceInputsHtml(u) {
  return `<div class="prices-grid">${modelList()
    .map(
      (m) => `<div>
        <label>${escHtml(m)} (R$)</label>
        <input type="number" class="u-price" data-model="${escHtml(m)}" min="0" step="0.01"
          value="${Number.isFinite(u.prices[m]) ? (u.prices[m] / 100).toFixed(2) : ''}" placeholder="0,00" />
      </div>`
    )
    .join('')}</div>`;
}

function userCard(u) {
  const isPending = u.status === 'pendente';
  const actions = isPending
    ? `<div class="order-actions">
         <button class="btn-accept" data-approve-user="${u.id}">Aprovar cadastro</button>
         <button class="btn-reject" data-del-user="${u.id}">Recusar</button>
       </div>`
    : `<div class="order-actions">
         <button class="btn-accept" data-save-user="${u.id}">Salvar preços</button>
         ${
           u.status === 'bloqueado'
             ? `<button class="btn-small" data-unblock-user="${u.id}">Desbloquear</button>`
             : `<button class="btn-small danger" data-block-user="${u.id}">Bloquear</button>`
         }
       </div>`;
  return `<div class="order-card" data-user-card="${u.id}">
    <div class="order-head">
      <span class="code">${escHtml(u.name)} <span class="muted">(@${escHtml(u.username)})</span></span>
      <span class="status ${u.status === 'aprovado' ? 'aceito' : u.status === 'bloqueado' ? 'recusado' : 'pendente'}">${u.status}</span>
    </div>
    <div class="order-head">
      <span>${waLink(u.whatsapp)}</span>
      <span class="muted">cadastro: ${dt(u.createdAt)}</span>
    </div>
    <div class="total-row" style="padding-bottom:4px"><span>Preços deste cliente</span><span></span></div>
    ${priceInputsHtml(u)}
    ${actions}
  </div>`;
}

function renderClientes() {
  renderModelsManager();
  const pending = users.filter((u) => u.status === 'pendente');
  const others = users.filter((u) => u.status !== 'pendente');
  $('pendingUsers').innerHTML = pending.map(userCard).join('');
  $('emptyPendingUsers').classList.toggle('hidden', pending.length > 0);
  $('approvedUsers').innerHTML = others.map(userCard).join('');
  $('emptyApprovedUsers').classList.toggle('hidden', others.length > 0);
}

// ---- Leads: criar cliente direto + editar usuário/senha ----

let leadFilter = '';
$('leadSearch').addEventListener('input', (e) => {
  leadFilter = e.target.value.trim().toLowerCase();
  renderLeads();
});

const STATUS_PILL = { aprovado: 'aceito', bloqueado: 'recusado', pendente: 'pendente' };

function leadCard(u) {
  return `<div class="order-card" data-lead-card="${u.id}">
    <div class="order-head">
      <span class="code">${escHtml(u.name)}</span>
      <span class="status ${STATUS_PILL[u.status] || 'pendente'}">${u.status}</span>
    </div>
    <div class="order-head"><span>${waLink(u.whatsapp)}</span><span class="muted">desde ${dt(u.createdAt)}</span></div>
    <label style="margin-top:6px">Usuário de login</label>
    <input type="text" class="lead-username" value="${escHtml(u.username)}" autocomplete="off" />
    <div class="order-actions">
      <button class="btn-accept" data-save-username="${u.id}">Salvar usuário</button>
      <button class="btn-small" data-reset-pw="${u.id}">🔑 Redefinir senha</button>
    </div>
  </div>`;
}

function renderLeads() {
  const list = $('leadsList');
  if (!list) return;
  if (list.contains(document.activeElement)) return; // não re-renderiza enquanto digita o usuário
  const shown = users.filter((u) => !leadFilter || u.name.toLowerCase().includes(leadFilter) || u.username.includes(leadFilter));
  list.innerHTML = shown.map(leadCard).join('');
  $('emptyLeads').classList.toggle('hidden', shown.length > 0);
}

// senha simples sugerida (o admin pode trocar antes de criar/redefinir)
function suggestPassword() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6) || 'pod123';
}

$('createLeadBtn').addEventListener('click', async () => {
  const name = $('leadName').value.trim();
  const whatsapp = $('leadPhone').value.replace(/\D/g, '');
  const username = $('leadUser').value.trim().toLowerCase();
  const password = $('leadPass').value || suggestPassword();
  if (!name || !whatsapp) return toast('Preencha nome e WhatsApp.', true);
  if (whatsapp.length < 8) return toast('WhatsApp inválido (país + DDD + número).', true);
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) return toast('Usuário inválido: 3 a 20 letras/números, sem espaços.', true);
  if (password.length < 4) return toast('A senha precisa ter pelo menos 4 caracteres.', true);
  const btn = $('createLeadBtn');
  btn.disabled = true;
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name, whatsapp, username, password }) });
    $('leadName').value = $('leadPhone').value = $('leadUser').value = $('leadPass').value = '';
    window.prompt('✅ Cliente criado! Copie o login e mande pro cliente pelo WhatsApp:', `Usuário: ${username}\nSenha: ${password}`);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // solta o foco p/ o loadAll re-renderizar a lista
    await loadAll();
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { saveUsername, resetPw } = btn.dataset;

  if (saveUsername) {
    const card = document.querySelector(`[data-lead-card="${saveUsername}"]`);
    const username = card.querySelector('.lead-username').value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,20}$/.test(username)) return toast('Usuário inválido: 3 a 20 letras/números, sem espaços.', true);
    btn.disabled = true;
    try {
      await api(`/api/admin/users/${saveUsername}`, { method: 'PUT', body: JSON.stringify({ username }) });
      toast('Usuário atualizado.');
      await loadAll();
    } finally {
      btn.disabled = false;
    }
  }

  if (resetPw) {
    const u = users.find((x) => x.id === resetPw);
    const nova = window.prompt(`Nova senha para ${u ? u.name : 'o cliente'} (mín. 4):`, suggestPassword());
    if (nova === null) return;
    if (nova.length < 4) return toast('A senha precisa ter pelo menos 4 caracteres.', true);
    await api(`/api/admin/users/${resetPw}`, { method: 'PUT', body: JSON.stringify({ password: nova }) });
    window.prompt('✅ Senha redefinida! Copie e mande pro cliente pelo WhatsApp:', `Usuário: ${u ? u.username : ''}\nNova senha: ${nova}`);
    await loadAll();
  }
});

function collectPrices(userId) {
  const card = document.querySelector(`[data-user-card="${userId}"]`);
  const prices = {};
  card.querySelectorAll('.u-price').forEach((inp) => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v >= 0) prices[inp.dataset.model] = Math.round(v * 100);
  });
  return prices;
}

// salvar a lista de modelos (aceita "-- Modelo" por linha; linhas sem "--" são notas)
$('saveModelsBtn').addEventListener('click', async () => {
  const raw = $('modelsText').value.split(/\r?\n/);
  const hasHeaders = raw.some((l) => l.trim().startsWith('--'));
  const models = raw
    .filter((l) => (hasHeaders ? l.trim().startsWith('--') : l.trim()))
    .map((l) => l.replace(/^-+\s*/, '').replace(/\s+/g, ' ').trim().toUpperCase())
    .filter(Boolean);
  const btn = $('saveModelsBtn');
  btn.disabled = true;
  try {
    await api('/api/admin/models', { method: 'PUT', body: JSON.stringify({ models }) });
    toast(`${models.length} modelo(s) salvo(s).`);
    await loadAll();
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { approveUser, saveUser, blockUser, unblockUser, delUser } = btn.dataset;

  if (approveUser) {
    btn.disabled = true;
    try {
      await api(`/api/admin/users/${approveUser}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'aprovado', prices: collectPrices(approveUser) }),
      });
      toast('Cliente aprovado! Ele já pode entrar e ver os preços.');
      await loadAll();
    } finally {
      btn.disabled = false;
    }
  }
  if (saveUser) {
    btn.disabled = true;
    try {
      await api(`/api/admin/users/${saveUser}`, {
        method: 'PUT',
        body: JSON.stringify({ prices: collectPrices(saveUser) }),
      });
      toast('Preços atualizados.');
      await loadAll();
    } finally {
      btn.disabled = false;
    }
  }
  if (blockUser) {
    await api(`/api/admin/users/${blockUser}`, { method: 'PUT', body: JSON.stringify({ status: 'bloqueado' }) });
    toast('Cliente bloqueado.');
    await loadAll();
  }
  if (unblockUser) {
    await api(`/api/admin/users/${unblockUser}`, { method: 'PUT', body: JSON.stringify({ status: 'aprovado' }) });
    toast('Cliente desbloqueado.');
    await loadAll();
  }
  if (delUser) {
    const u = users.find((x) => x.id === delUser);
    if (!confirm(`Recusar e excluir o cadastro de "${u ? u.name : delUser}"?`)) return;
    await api(`/api/admin/users/${delUser}`, { method: 'DELETE' });
    toast('Cadastro excluído.');
    await loadAll();
  }
});

// ---- importação de lista de estoque ----

let pendingImport = null;

$('parseListBtn').addEventListener('click', () => {
  const text = $('importText').value;
  if (!text.trim()) return toast('Cole a lista de estoque primeiro.', true);
  pendingImport = parseStockList(text);
  if (pendingImport.items.length === 0) {
    pendingImport = null;
    return toast('Não encontrei nenhum item na lista. Confira o formato.', true);
  }
  renderImportPreview();
});

function renderImportPreview() {
  const { items, ignored } = pendingImport;
  // MESMA normalização do backend (server.js) — tira acento — para o preview mostrar
  // "Novo/Existe" e a contagem exatamente como a importação vai casar de fato.
  const norm = (s) =>
    String(s).replace(/\s+/g, ' ').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const byKey = new Map(products.map((p) => [norm(p.name), p]));

  let news = 0;
  let updates = 0;
  let totalUnits = 0;
  const brands = new Map();

  const rows = items
    .map((it) => {
      const existing = byKey.get(norm(it.name));
      totalUnits += it.qty;
      if (existing) updates++;
      else news++;
      if (!brands.has(it.brand)) brands.set(it.brand, { count: 0, units: 0 });
      const b = brands.get(it.brand);
      b.count++;
      b.units += it.qty;
      const status = existing
        ? `<span class="status pendente">Existe (estoque atual: ${existing.stock})</span>`
        : '<span class="status aceito">Novo</span>';
      return `<tr><td>${escHtml(it.brand)}</td><td>${escHtml(it.flavor)}</td><td><strong>${it.qty}</strong></td><td>${status}</td></tr>`;
    })
    .join('');

  const brandSummary = [...brands.entries()]
    .map(([b, s]) => `<div class="stat"><div class="label">${escHtml(b)}</div><div class="value" style="font-size:1.05rem">${s.count} sabores · ${s.units} un.</div></div>`)
    .join('');

  const ignoredBlock = ignored.length
    ? `<div class="ignored-block"><strong>Linhas ignoradas (confira se não falta nada):</strong><ul>${ignored.map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul></div>`
    : '';

  $('importPreview').innerHTML = `
    <div class="import-preview">
      <h3>Confira antes de aplicar</h3>
      <p class="import-totals"><strong>${brands.size}</strong> marcas · <strong>${items.length}</strong> produtos (${news} novos, ${updates} já existem) · <strong>${totalUnits}</strong> peças no total</p>
      <div class="stats-grid">${brandSummary}</div>
      ${ignoredBlock}
      <div class="table-wrap" style="max-height:340px;overflow-y:auto">
        <table>
          <thead><tr><th>Marca</th><th>Sabor</th><th>Qtd.</th><th>Situação</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="import-options">
        <label class="opt"><input type="radio" name="importMode" value="replace" checked /> Substituir o estoque pelo da lista (recomendado para lista completa)</label>
        <label class="opt"><input type="radio" name="importMode" value="add" /> Somar ao estoque atual (para lista de chegada de mercadoria)</label>
        <label class="opt"><input type="checkbox" id="importDeactivate" /> Desativar produtos do site que não estão nesta lista</label>
      </div>
      <div class="order-actions">
        <button class="btn-accept" id="importApproveBtn">Aprovar e aplicar no estoque</button>
        <button class="btn-reject" id="importCancelBtn">Cancelar</button>
      </div>
    </div>`;
  $('importPreview').classList.remove('hidden');
  $('importPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeImportPreview() {
  pendingImport = null;
  $('importPreview').innerHTML = '';
  $('importPreview').classList.add('hidden');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.id === 'importCancelBtn') closeImportPreview();

  if (btn.id === 'importApproveBtn' && pendingImport) {
    const mode = document.querySelector('input[name="importMode"]:checked').value;
    const deactivateMissing = $('importDeactivate').checked;
    btn.disabled = true;
    try {
      const r = await api('/api/admin/products/import', {
        method: 'POST',
        body: JSON.stringify({
          items: pendingImport.items.map((i) => ({ name: i.name, stock: i.qty })),
          mode,
          deactivateMissing,
        }),
      });
      closeImportPreview();
      $('importText').value = '';
      toast(`Estoque atualizado: ${r.created} novos, ${r.updated} atualizados${r.deactivated ? `, ${r.deactivated} desativados` : ''}.`);
      await loadAll();
    } finally {
      btn.disabled = false;
    }
  }
});

// ---- estoque ----

let prodFilter = '';
let prodCategory = ''; // categoria (marca) selecionada no filtro

$('prodSearch').addEventListener('input', (e) => {
  prodFilter = e.target.value.trim().toLowerCase();
  renderEstoque();
});
$('prodCategories').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  prodCategory = b.dataset.cat === prodCategory ? '' : b.dataset.cat;
  renderEstoque();
});

function renderCategoryChips() {
  const brands = new Map();
  for (const p of products) {
    const b = brandOf(p.name);
    brands.set(b, (brands.get(b) || 0) + 1);
  }
  const chips = [`<button class="chip ${!prodCategory ? 'active' : ''}" data-cat="">Todas <span class="chip-count">${products.length}</span></button>`].concat(
    [...brands.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(
      ([b, n]) => `<button class="chip ${prodCategory === b ? 'active' : ''}" data-cat="${escHtml(b)}">${escHtml(b)} <span class="chip-count">${n}</span></button>`
    )
  );
  $('prodCategories').innerHTML = chips.join('');
}

function renderEstoque() {
  renderCategoryChips();
  if (prodCategory && !products.some((p) => brandOf(p.name) === prodCategory)) prodCategory = '';
  $('productRows').innerHTML = products
    .filter((p) => (!prodFilter || p.name.toLowerCase().includes(prodFilter)) && (!prodCategory || brandOf(p.name) === prodCategory))
    .map(
      (p) => `<tr data-id="${p.id}">
        <td><input type="text" class="p-name" value="${escHtml(p.name)}" /></td>
        <td><input type="number" class="p-stock" min="0" step="1" value="${p.stock}" /></td>
        <td><input type="checkbox" class="p-active" ${p.active ? 'checked' : ''} /></td>
        <td style="white-space:nowrap">
          <button class="btn-small" data-save="${p.id}">Salvar</button>
          <button class="btn-small danger" data-del="${p.id}">Excluir</button>
        </td>
      </tr>`
    )
    .join('');
}

// ---- copiar a lista atual (com estoque) no formato do WhatsApp/importação ----
function flavorOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(ix + 3) : name;
}
function buildListText() {
  const byHeader = new Map();
  for (const p of products) {
    if (!p.active) continue;
    const h = headerOf(p.name);
    if (!byHeader.has(h)) byHeader.set(h, []);
    byHeader.get(h).push(p);
  }
  const lines = [];
  for (const [h, list] of [...byHeader.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('-- ' + h);
    for (const p of list) lines.push(p.stock + ' ' + flavorOf(p.name));
    lines.push('');
  }
  return lines.join('\n').trim();
}
$('copyListBtn').addEventListener('click', async () => {
  const text = buildListText();
  if (!text) return toast('Nenhum produto ativo para copiar.', true);
  try {
    await navigator.clipboard.writeText(text);
    toast('Lista copiada! É só colar no WhatsApp.');
  } catch {
    window.prompt('Copie a lista (Ctrl/Cmd + C):', text);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { save, del } = btn.dataset;

  if (save) {
    const row = btn.closest('tr');
    btn.disabled = true;
    try {
      await api(`/api/admin/products/${save}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: row.querySelector('.p-name').value,
          stock: parseInt(row.querySelector('.p-stock').value || '0', 10),
          active: row.querySelector('.p-active').checked,
        }),
      });
      toast('Produto atualizado.');
    } finally {
      btn.disabled = false;
    }
  }

  if (del) {
    const prod = products.find((p) => p.id === del);
    if (!confirm(`Excluir "${prod ? prod.name : del}"? Essa ação não pode ser desfeita.`)) return;
    await api(`/api/admin/products/${del}`, { method: 'DELETE' });
    toast('Produto excluído.');
  }
});

$('addProductBtn').addEventListener('click', async () => {
  const name = $('npName').value.trim();
  const stock = parseInt($('npStock').value, 10);
  if (!name || !Number.isFinite(stock)) {
    return toast('Preencha nome e estoque.', true);
  }
  await api('/api/admin/products', {
    method: 'POST',
    body: JSON.stringify({ name, stock }),
  });

  // logo opcional da marca, enviada junto
  const file = $('npLogo').files[0];
  if (file) {
    if (file.size > 2e6) {
      toast('Produto adicionado, mas a logo não foi enviada: imagem maior que 2 MB.', true);
    } else {
      const dataUrl = await new Promise((ok, err) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = err;
        r.readAsDataURL(file);
      });
      await api('/api/admin/brand-logo', {
        method: 'POST',
        body: JSON.stringify({ productName: name, dataUrl }),
      });
      toast('Produto adicionado com a logo da marca.');
    }
    $('npLogo').value = '';
  } else {
    toast('Produto adicionado.');
  }
  $('npName').value = $('npStock').value = '';
});

// ---- contabilidade ----

// ---- filtro por data da contabilidade ----

let accPeriod = 'mes'; // hoje | 7dias | mes | max | custom
let accFrom = '';
let accTo = '';

// data de referência da venda = quando foi aceita (ou criada, como fallback)
function orderRefMs(o) {
  return new Date(o.decidedAt || o.createdAt).getTime();
}

function periodRange() {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (accPeriod === 'hoje') return [startOfDay(now), Infinity];
  if (accPeriod === '7dias') return [startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), Infinity];
  if (accPeriod === 'mes') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Infinity];
  if (accPeriod === 'custom') {
    const a = accFrom ? new Date(accFrom + 'T00:00:00').getTime() : -Infinity;
    // borda superior inclusiva no dia inteiro (.999): um pedido aceito às 23:59:59.500
    // do dia "até" precisa entrar no período — decidedAt (toISOString) tem milissegundos.
    const b = accTo ? new Date(accTo + 'T23:59:59.999').getTime() : Infinity;
    return [a, b];
  }
  return [-Infinity, Infinity]; // máximo
}

function inPeriod(o) {
  const [a, b] = periodRange();
  const t = orderRefMs(o);
  return t >= a && t <= b;
}

function setAccActiveChip() {
  document.querySelectorAll('#accPeriods .chip').forEach((c) => c.classList.toggle('active', c.dataset.period === accPeriod));
  $('accCustom').classList.toggle('hidden', accPeriod !== 'custom');
}

const PERIOD_LABEL = { hoje: 'hoje', '7dias': 'nos últimos 7 dias', mes: 'neste mês', max: 'no total', custom: 'no período' };

$('accPeriods').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-period]');
  if (!b) return;
  accPeriod = b.dataset.period;
  renderContabilidade();
});
$('accApply').addEventListener('click', () => {
  accFrom = $('accFrom').value;
  accTo = $('accTo').value;
  accPeriod = 'custom';
  renderContabilidade();
});

function renderContabilidade() {
  const accepted = orders.filter((o) => o.status === 'aceito');
  const toLaunch = accepted.filter((o) => !isAccounted(o));
  const pending = orders.filter((o) => o.status === 'pendente');

  setAccActiveChip();
  const inRange = accepted.filter(inPeriod);
  const accountable = inRange.filter(isAccounted); // lucro já calculável (auto ou manual)

  const revenue = accountable.reduce((s, o) => s + effRevenue(o), 0);
  const cost = accountable.reduce((s, o) => s + effCost(o), 0);
  const profit = revenue - cost;
  const unitsSold = inRange.reduce((s, o) => s + units(o), 0);
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) + '%' : '—';
  const per = PERIOD_LABEL[accPeriod] || 'no período';

  const stats = [
    [`Lucro ${per}`, money(profit), profit >= 0 ? 'green' : 'red'],
    [`Faturamento ${per}`, money(revenue), ''],
    [`Custo ${per}`, money(cost), ''],
    ['Margem', margin, ''],
    ['Peças vendidas', String(unitsSold), ''],
    ['Aguardando lançamento', String(toLaunch.length), toLaunch.length > 0 ? 'yellow' : ''],
    ['Pedidos pendentes', String(pending.length), pending.length > 0 ? 'yellow' : ''],
  ];

  $('statsGrid').innerHTML = stats
    .map(
      ([label, value, cls]) =>
        `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`
    )
    .join('');

  $('emptyLedger').textContent = accepted.length ? 'Nenhuma venda neste período.' : 'Nenhum pedido aceito ainda.';
  $('ledgerRows').innerHTML = inRange
    .map((o) => {
      const pr = effProfit(o);
      const r = effRevenue(o);
      const c = effCost(o);
      return `<tr>
        <td>${dt(o.decidedAt || o.createdAt)}</td>
        <td><strong>#${o.id}</strong></td>
        <td>${escHtml(o.customer.name)}</td>
        <td>${units(o)}</td>
        <td><input type="number" class="fin-revenue" min="0" step="0.01" value="${Number.isFinite(r) ? (r / 100).toFixed(2) : ''}" placeholder="0,00" /></td>
        <td><input type="number" class="fin-cost" min="0" step="0.01" value="${Number.isFinite(c) ? (c / 100).toFixed(2) : ''}" placeholder="0,00" /></td>
        <td class="${pr === null ? '' : pr >= 0 ? 'profit-pos' : 'profit-neg'}"><strong>${pr === null ? '—' : money(pr)}</strong></td>
        <td><button class="btn-small" data-fin-row="${o.id}">Salvar</button></td>
      </tr>`;
    })
    .join('');
  $('emptyLedger').classList.toggle('hidden', inRange.length > 0);
}

// ---- configurações do sócio: custo por modelo + link do Pushcut ----

function renderSettings() {
  const ni = $('notifyUrlInput');
  if (ni && document.activeElement !== ni) ni.value = settings.notifyUrl || '';
  const grid = $('costsGrid');
  if (!grid) return;
  if (grid.contains(document.activeElement)) return; // não sobrescreve enquanto digita
  const models = modelList();
  grid.innerHTML = models.length
    ? models
        .map(
          (m) => `<div>
        <label>${escHtml(m)} (R$)</label>
        <input type="number" class="m-cost" data-model="${escHtml(m)}" min="0" step="0.01"
          value="${Number.isFinite(settings.costs[m]) ? (settings.costs[m] / 100).toFixed(2) : ''}" placeholder="0,00" />
      </div>`
        )
        .join('')
    : '<span class="muted" style="font-size:.85rem">Cadastre modelos na aba Clientes para definir os custos.</span>';
}

$('saveSettingsBtn').addEventListener('click', async () => {
  const costs = {};
  document.querySelectorAll('#costsGrid .m-cost').forEach((inp) => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && v >= 0) costs[inp.dataset.model] = Math.round(v * 100);
  });
  const btn = $('saveSettingsBtn');
  btn.disabled = true;
  try {
    settings = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ notifyUrl: $('notifyUrlInput').value.trim(), costs }),
    });
    if (!settings.costs) settings.costs = {};
    toast('Configurações salvas. O lucro já usa esses custos.');
    await loadAll();
  } finally {
    btn.disabled = false;
  }
});

// ---- dashboard (início) ----

function renderDashboard() {
  const body = $('dashboardBody');
  if (!body) return;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const ref = (o) => new Date(o.decidedAt || o.createdAt).getTime();
  const sum = (list, fn) => list.reduce((s, o) => s + fn(o), 0);

  const accepted = orders.filter((o) => o.status === 'aceito');
  const pending = orders.filter((o) => o.status === 'pendente');
  const toLaunch = accepted.filter((o) => !isAccounted(o));

  const dayAcc = accepted.filter((o) => ref(o) >= startOfDay && isAccounted(o));
  const monAcc = accepted.filter((o) => ref(o) >= startOfMonth && isAccounted(o));
  const monUnits = sum(accepted.filter((o) => ref(o) >= startOfMonth), units);

  const low = products.filter((p) => p.active && p.stock <= 5).sort((a, b) => a.stock - b.stock);

  const sold = new Map();
  for (const o of accepted) for (const i of o.items) sold.set(modelOf(i.name), (sold.get(modelOf(i.name)) || 0) + i.qty);
  const top = [...sold.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const card = (label, value, cls) => `<div class="stat"><div class="label">${label}</div><div class="value ${cls || ''}">${value}</div></div>`;
  const dayProfit = sum(dayAcc, effProfit);
  const monProfit = sum(monAcc, effProfit);

  body.innerHTML = `
    <h2>Hoje</h2>
    <div class="stats-grid">
      ${card('Lucro hoje', money(dayProfit), dayProfit >= 0 ? 'green' : 'red')}
      ${card('Faturamento hoje', money(sum(dayAcc, effRevenue)), '')}
      ${card('Pedidos pendentes', String(pending.length), pending.length ? 'yellow' : '')}
      ${card('Aguardando custo', String(toLaunch.length), toLaunch.length ? 'yellow' : '')}
    </div>
    <h2>Este mês</h2>
    <div class="stats-grid">
      ${card('Lucro no mês', money(monProfit), monProfit >= 0 ? 'green' : 'red')}
      ${card('Faturamento no mês', money(sum(monAcc, effRevenue)), '')}
      ${card('Peças vendidas', String(monUnits), '')}
      ${card('Produtos ativos', String(products.filter((p) => p.active).length), '')}
    </div>
    <h2>⚠️ Estoque baixo (5 ou menos)</h2>
    ${
      low.length
        ? `<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Estoque</th></tr></thead><tbody>${low
            .slice(0, 15)
            .map((p) => `<tr><td>${escHtml(p.name)}</td><td><strong class="${p.stock === 0 ? 'profit-neg' : ''}">${p.stock}</strong></td></tr>`)
            .join('')}</tbody></table></div>${low.length > 15 ? `<p class="muted" style="font-size:.85rem;margin-top:6px">+${low.length - 15} outros produtos baixos</p>` : ''}`
        : '<p class="empty">Nenhum produto acabando. 👍</p>'
    }
    <h2>🔥 Mais vendidos</h2>
    ${
      top.length
        ? `<div class="table-wrap"><table><thead><tr><th>Modelo</th><th>Peças vendidas</th></tr></thead><tbody>${top
            .map(([m, q]) => `<tr><td>${escHtml(m)}</td><td><strong>${q}</strong></td></tr>`)
            .join('')}</tbody></table></div>`
        : '<p class="empty">Ainda sem vendas.</p>'
    }`;
}

// ---- tempo real ----

// O servidor (Vercel) não mantém conexões abertas; em vez de SSE, consultamos a versão
// dos dados a cada poucos segundos e recarregamos quando ela muda.
function connectSse() {
  if (!token) return;
  if (es) es.close();
  let ver = null;
  let busy = false;
  const tick = async () => {
    if (!token || busy) return;
    busy = true;
    try {
      const r = await fetch('/api/events?token=' + encodeURIComponent(token));
      if (!r.ok) throw new Error('offline');
      const data = await r.json();
      $('live').classList.add('on');
      if (ver !== null && data.v !== ver) loadAll().catch(() => {});
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

setPartnerLabel();
if (token) {
  enterPanel().catch(() => showLogin());
} else {
  showLogin();
}
