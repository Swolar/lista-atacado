// Lista de Pods — núcleo da API, portado do server.js single-process para Postgres
// (Supabase). Roda igual no Vercel (api/[[...path]].js) e localmente (server.js).
//
// Diferenças estruturais em relação à versão de arquivo:
// - dados em Postgres; sessões (admin e cliente) e rate-limit em tabelas (serverless
//   não tem memória entre requests);
// - toda mutação de estoque roda em transação com advisory lock (withTx stockLock),
//   reproduzindo a semântica single-process — impossível vender a mesma unidade 2x;
// - tempo real: SSE virou polling — GET /api/events devolve {v: <versão dos dados>}
//   e o front recarrega quando o número muda;
// - logos enviadas pelo painel vão para o banco (bytea) e saem por /api/brand-img/:marca
//   (o disco do Vercel é somente leitura).
const crypto = require('crypto');
const { q, withTx, T } = require('./db');

// ---------- sócios (partners) ----------
// Dois sócios dividem o MESMO estoque, mas cada um tem seus clientes, preços, lucro e
// notificação. Tudo configurável por ambiente; os defaults deixam o app bootar.
const DEFAULT_PUSHCUT = 'https://api.pushcut.io/JEB2ayHIxCgeVR86LTMO5/notifications/Minha%20Primeira%20Notificação';
const firstUrl = (v) => (v ? String(v).split(',')[0].trim() : '');
const PARTNERS = [
  {
    slug: 'krauz',
    name: process.env.P1_NAME || 'Krauz',
    login: (process.env.P1_USER || 'krauz').trim().toLowerCase(),
    password: process.env.P1_PASSWORD || process.env.ADMIN_PASSWORD || 'Krauz#',
    notifyUrl: process.env.P1_NOTIFY !== undefined ? process.env.P1_NOTIFY : firstUrl(process.env.NOTIFY_URLS) || DEFAULT_PUSHCUT,
  },
  {
    slug: 'boss',
    name: process.env.P2_NAME || 'Boss',
    login: (process.env.P2_USER || 'boss').trim().toLowerCase(),
    password: process.env.P2_PASSWORD || 'Boss#',
    notifyUrl: process.env.P2_NOTIFY !== undefined ? process.env.P2_NOTIFY : DEFAULT_PUSHCUT,
  },
];
const PARTNER_SLUGS = new Set(PARTNERS.map((p) => p.slug));
function partnerBySlug(slug) {
  return PARTNERS.find((p) => p.slug === slug) || null;
}

// erro de API com status HTTP — o handler central converte em resposta JSON
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- schema pronto? (uma checagem por instância) ----------
// Se as tabelas ainda não existem (primeiro deploy), cria — remove a dependência de
// rodar a migração manualmente antes de o primeiro request chegar.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      try {
        await q(`select 1 from ${T('meta')} limit 1`);
      } catch (err) {
        if (err.code !== '42P01') throw err; // 42P01 = tabela não existe
        const { ensureSchema } = require('../scripts/migrate');
        const { getPool, SCHEMA } = require('./db');
        await ensureSchema(getPool(), SCHEMA);
      }
    })().catch((err) => {
      readyPromise = null; // tenta de novo no próximo request
      throw err;
    });
  }
  return readyPromise;
}

// ---------- helpers ----------

function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(8).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1e5) {
  // no Vercel o body já chega parseado (req.body); localmente lemos o stream
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      try {
        return Promise.resolve(req.body.length ? JSON.parse(req.body.toString('utf8')) : {});
      } catch {
        return Promise.reject(new ApiError(400, 'JSON inválido'));
      }
    }
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(req.body ? JSON.parse(req.body) : {});
      } catch {
        return Promise.reject(new ApiError(400, 'JSON inválido'));
      }
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        // drena o resto em vez de destruir o socket — assim o cliente recebe um 400
        // limpo ("payload muito grande") em vez de uma conexão resetada
        raw = '';
        req.removeAllListeners('data');
        req.resume();
        reject(new ApiError(400, 'payload muito grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new ApiError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'local').split(',')[0].trim();
}

// ---------- rate-limit por IP (tabela; serverless não tem memória entre requests) ----------
// Mesma semântica do original: ao acumular `max` eventos numa janela de 60s, o IP fica
// bloqueado por 60s.
async function throttled(kind, ip) {
  const r = await q(`select until_ms from ${T('throttle')} where key = $1`, [kind + ':' + ip]);
  return Boolean(r.rows[0] && Number(r.rows[0].until_ms) > Date.now());
}
async function throttleHit(kind, ip, max = 5) {
  const now = Date.now();
  await q(
    `insert into ${T('throttle')} (key, fails, last_ms, until_ms) values ($1, 1, $2, 0)
     on conflict (key) do update set
       fails = case when ${T('throttle')}.last_ms > $2 - 60000 then ${T('throttle')}.fails + 1 else 1 end,
       last_ms = $2,
       until_ms = case
         when (case when ${T('throttle')}.last_ms > $2 - 60000 then ${T('throttle')}.fails + 1 else 1 end) >= $3
         then $2 + 60000 else 0 end`,
    [kind + ':' + ip, now, max]
  );
  if (Math.random() < 0.05) {
    q(`delete from ${T('throttle')} where last_ms < $1`, [now - 600000]).catch(() => {});
  }
}
async function throttleClear(kind, ip) {
  await q(`delete from ${T('throttle')} where key = $1`, [kind + ':' + ip]);
}

// ---------- sessões (tabela) ----------

const SESSION_DAYS = 30;

// impressão digital da senha do sócio gravada na sessão de admin: trocar a senha
// (P1_PASSWORD/P2_PASSWORD) invalida na hora todas as sessões antigas daquele sócio
function passFingerprint(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex').slice(0, 16);
}

async function createSession(kind, subject, fingerprint = '') {
  const token = newId(16);
  await q(
    `insert into ${T('sessions')} (token, kind, subject, fingerprint, expires_at) values ($1, $2, $3, $4, now() + interval '${SESSION_DAYS} days')`,
    [token, kind, subject, fingerprint]
  );
  if (Math.random() < 0.05) {
    q(`delete from ${T('sessions')} where expires_at < now()`).catch(() => {});
  }
  return token;
}

// slug do sócio dono do token de admin (ou null)
async function partnerOf(req, url) {
  const token = url.searchParams.get('token') || req.headers['x-token'];
  if (!token) return null;
  const r = await q(
    `select subject, fingerprint from ${T('sessions')} where token = $1 and kind = 'admin' and expires_at > now()`,
    [token]
  );
  const row = r.rows[0];
  if (!row || !PARTNER_SLUGS.has(row.subject)) return null;
  const partner = partnerBySlug(row.subject);
  if (row.fingerprint && row.fingerprint !== passFingerprint(partner.password)) {
    q(`delete from ${T('sessions')} where token = $1`, [token]).catch(() => {});
    return null; // a senha do sócio mudou → sessão antiga cai
  }
  return row.subject;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    whatsapp: row.whatsapp,
    salt: row.salt,
    hash: row.hash,
    status: row.status,
    prices: row.prices || {},
    partnerId: row.partner_id,
    lastAddress: row.last_address || '',
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
  };
}

async function userFromReq(req, url) {
  const token = url.searchParams.get('utoken') || req.headers['x-user-token'];
  if (!token) return null;
  const r = await q(
    `select u.* from ${T('sessions')} s join ${T('users')} u on u.id = s.subject
     where s.token = $1 and s.kind = 'client' and s.expires_at > now()`,
    [token]
  );
  return rowToUser(r.rows[0]);
}

async function dropUserTokens(userId, client = null) {
  const sql = `delete from ${T('sessions')} where kind = 'client' and subject = $1`;
  if (client) await client.query(sql, [userId]);
  else await q(sql, [userId]);
}

// ---------- versão dos dados (substitui o broadcast do SSE) ----------

async function bump(client = null) {
  const sql = `update ${T('meta')} set version = version + 1 where id = 1`;
  if (client) await client.query(sql);
  else await q(sql);
}

async function currentVersion() {
  const r = await q(`select version from ${T('meta')} where id = 1`);
  return r.rows[0] ? Number(r.rows[0].version) : 0;
}

// ---------- notificações (Pushcut, por sócio) ----------
// Em serverless o request precisa esperar o POST terminar (trabalho depois do res.end
// pode ser cortado) — por isso await com timeout curto.
async function postNotify(url, payload) {
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(4000),
    });
    console.log(`Notificação enviada (HTTP ${r.status})`);
  } catch (err) {
    console.error(`Falha ao notificar ${url}:`, err.message);
  }
}

// URL efetiva do sócio: a salva no painel; se vazia, a do ambiente/código
async function notifyUrlFor(slug) {
  const r = await q(`select notify_url from ${T('partner_data')} where slug = $1`, [slug]);
  const saved = r.rows[0] && r.rows[0].notify_url;
  if (saved) return saved;
  const p = partnerBySlug(slug);
  return p ? p.notifyUrl : '';
}

async function notifyNewOrder(order) {
  const url = await notifyUrlFor(order.partnerId);
  if (!url) return;
  const units = order.items.reduce((s, i) => s + i.qty, 0);
  await postNotify(
    url,
    JSON.stringify({
      title: `Novo pedido #${order.id}`,
      text: `${order.customer.name} — ${units} ${units === 1 ? 'peça' : 'peças'} — WhatsApp: ${order.customer.phone}`,
    })
  );
}

async function notifyNewUser(u) {
  const url = await notifyUrlFor(u.partnerId);
  if (!url) return;
  await postNotify(
    url,
    JSON.stringify({
      title: 'Novo cadastro para aprovar',
      text: `${u.name} (@${u.username}) — WhatsApp: ${u.whatsapp}`,
    })
  );
}

// ---------- domínio: modelos, marcas, preços ----------

// "V55 – Pineaple" → "V55" (modelo usado na tabela de preços por cliente)
function modelOf(name) {
  const ix = name.indexOf(' – ');
  return ix > 0 ? name.slice(0, ix) : name;
}

function priceFor(user, productName) {
  const cents = user && user.prices ? user.prices[modelOf(productName)] : undefined;
  return Number.isFinite(cents) ? cents : null;
}

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
const IGNITE_MODEL = /^V(\d|MIX|NANO)/i;

function brandOf(name) {
  const header = modelOf(name);
  if (!header) return 'OUTROS';
  if (IGNITE_MODEL.test(header)) return 'IGNITE';
  for (const b of MULTIWORD_BRANDS) {
    if (header.startsWith(b + ' ') || header === b) return b;
  }
  const ix = header.indexOf(' ');
  return ix < 0 ? header : header.slice(0, ix);
}

// logos que já vêm com o site (arquivos estáticos); as enviadas pelo admin ficam no
// banco (brand_logos) e têm prioridade — servidas por /api/brand-img/:marca
const DEFAULT_BRAND_LOGOS = {
  IGNITE: 'img/ignite.png',
  ELFBAR: 'img/elfbar.svg',
  'LOST MARY': 'img/lostmary.svg',
  'BLACK SHEEP': 'img/blacksheep.png',
  NIK: 'img/nikbar.png',
};

async function customLogoBrands() {
  const r = await q(`select brand from ${T('brand_logos')}`);
  return new Set(r.rows.map((x) => x.brand));
}

function brandLogoFor(productName, customBrands) {
  const brand = brandOf(productName);
  if (customBrands && customBrands.has(brand)) return 'api/brand-img/' + encodeURIComponent(brand);
  return DEFAULT_BRAND_LOGOS[brand] || null;
}

async function registerModels(names, client) {
  const models = [...new Set(names.map(modelOf).filter(Boolean))];
  if (!models.length) return;
  await client.query(
    `insert into ${T('models')} (name) select unnest($1::text[]) on conflict (name) do nothing`,
    [models]
  );
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    whatsapp: u.whatsapp,
    status: u.status,
    prices: u.prices || {},
    createdAt: u.createdAt,
    approvedAt: u.approvedAt || null,
  };
}

function rowToOrder(row) {
  const o = {
    id: row.id,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    userId: row.user_id,
    partnerId: row.partner_id,
    customer: row.customer || {},
    items: row.items || [],
    totalCents: row.total_cents === null ? null : Number(row.total_cents),
    status: row.status,
    revenueCents: row.revenue_cents === null ? null : Number(row.revenue_cents),
    costCents: row.cost_cents === null ? null : Number(row.cost_cents),
  };
  if (row.decided_at) o.decidedAt = row.decided_at.toISOString();
  if (row.edited_at) o.editedAt = row.edited_at.toISOString();
  if (row.finance_at) o.financeAt = row.finance_at.toISOString();
  return o;
}

// unidades reservadas por produto = Σ qty em pedidos abertos (pendente + aceito).
// Executa DENTRO da transação/lock quando fizer parte de uma mutação de estoque.
async function reservedByProduct(client) {
  const r = await client.query(
    `select it->>'productId' as pid, sum((it->>'qty')::int)::int as qty
     from ${T('orders')} o, jsonb_array_elements(o.items) it
     where o.status in ('pendente', 'aceito')
     group by 1`
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.pid, Number(row.qty));
  return map;
}

// código curto do pedido (#A1B2C3D4) — a chave primária garante unicidade; em colisão
// (raríssimo) tenta outro código
function orderCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const UNIQUE_VIOLATION = '23505';

// ---------- rotas da API ----------

async function handleApi(req, res, url) {
  const { method } = req;
  const p = url.pathname;

  await ensureReady();

  // tempo real via polling: devolve a versão atual dos dados; o front recarrega quando
  // muda. Exige sessão (admin via ?token, cliente via ?utoken) — anti-abuso.
  if (method === 'GET' && p === '/api/events') {
    const token = url.searchParams.get('token') || req.headers['x-token'] || url.searchParams.get('utoken') || req.headers['x-user-token'];
    if (!token) return json(res, 401, { error: 'Não autorizado.' });
    const r = await q(
      `select version from ${T('meta')} where id = 1
       and exists (select 1 from ${T('sessions')} where token = $1 and expires_at > now())`,
      [token]
    );
    if (!r.rows[0]) return json(res, 401, { error: 'Não autorizado.' });
    return json(res, 200, { v: Number(r.rows[0].version) });
  }

  // lista pública dos sócios (só slug + nome) — a loja usa para o link de cadastro
  if (method === 'GET' && p === '/api/partners') {
    return json(res, 200, PARTNERS.map((pt) => ({ slug: pt.slug, name: pt.name })));
  }

  // batimento cardíaco: toca o banco de verdade — um cron da Vercel chama todo dia para o
  // projeto free do Supabase nunca ser pausado por inatividade
  if (method === 'GET' && p === '/api/health') {
    await q('select 1');
    return json(res, 200, { ok: true });
  }

  // logo de marca enviada pelo painel (fica no banco; o disco do Vercel é read-only)
  const brandImgMatch = p.match(/^\/api\/brand-img\/(.+)$/);
  if (method === 'GET' && brandImgMatch) {
    const brand = decodeURIComponent(brandImgMatch[1]);
    const r = await q(`select mime, data from ${T('brand_logos')} where brand = $1`, [brand]);
    if (!r.rows[0]) return json(res, 404, { error: 'Logo não encontrada.' });
    res.writeHead(200, {
      'Content-Type': r.rows[0].mime,
      'Content-Length': r.rows[0].data.length,
      'Cache-Control': 'public, max-age=300',
    });
    return res.end(r.rows[0].data);
  }

  // cliente cria a conta (fica pendente até o admin aprovar e preencher os preços)
  if (method === 'POST' && p === '/api/register') {
    const ip = ipOf(req);
    if (await throttled('register', ip)) {
      return json(res, 429, { error: 'Muitos cadastros deste dispositivo. Aguarde um minuto e tente de novo.' });
    }
    const body = await readBody(req);
    // o cadastro precisa vir pelo link de um sócio (/login/<slug>)
    const partner = String(body.partner || '').trim().toLowerCase();
    if (!PARTNER_SLUGS.has(partner)) {
      return json(res, 400, { error: 'Cadastro inválido. Use o link do seu vendedor para criar a conta.' });
    }
    const name = String(body.name || '').trim().slice(0, 80);
    const whatsapp = String(body.whatsapp || '').replace(/\D/g, '').slice(0, 18);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name || !whatsapp) return json(res, 400, { error: 'Informe nome e WhatsApp.' });
    if (whatsapp.length < 8 || whatsapp.length > 15) {
      return json(res, 400, { error: 'Informe um WhatsApp válido com o código do país e DDD.' });
    }
    if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
      return json(res, 400, { error: 'Usuário inválido: use de 3 a 20 letras, números, ponto, traço ou _ (sem espaços).' });
    }
    if (password.length < 4) return json(res, 400, { error: 'A senha precisa ter pelo menos 4 caracteres.' });
    await throttleHit('register', ip, 8); // anti-flood: até 8 cadastros por IP em 60s
    const { salt, hash } = hashPassword(password);
    const user = {
      id: newId(),
      username,
      name,
      whatsapp,
      partnerId: partner,
    };
    try {
      await q(
        `insert into ${T('users')} (id, username, name, whatsapp, salt, hash, status, prices, partner_id)
         values ($1,$2,$3,$4,$5,$6,'pendente','{}'::jsonb,$7)`,
        [user.id, username, name, whatsapp, salt, hash, partner]
      );
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return json(res, 409, { error: 'Este usuário já existe. Escolha outro.' });
      }
      throw err;
    }
    await bump();
    await notifyNewUser(user);
    return json(res, 201, { ok: true });
  }

  if (method === 'POST' && p === '/api/login') {
    const ip = ipOf(req);
    if (await throttled('login', ip)) {
      return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
    }
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const r = await q(`select * from ${T('users')} where username = $1`, [username]);
    const user = rowToUser(r.rows[0]);
    const ok = user && hashPassword(String(body.password || ''), user.salt).hash === user.hash;
    if (!ok) {
      await throttleHit('login', ip);
      return json(res, 401, { error: 'Usuário ou senha incorretos.' });
    }
    if (user.status === 'pendente') {
      return json(res, 403, { error: 'Seu cadastro ainda está em análise. Aprovamos em até 2 horas!' });
    }
    if (user.status === 'bloqueado') {
      return json(res, 403, { error: 'Seu acesso está bloqueado. Fale com o vendedor.' });
    }
    await throttleClear('login', ip);
    const token = await createSession('client', user.id);
    return json(res, 200, { token, name: user.name, username: user.username, whatsapp: user.whatsapp, lastAddress: user.lastAddress || '' });
  }

  if (method === 'GET' && p === '/api/me') {
    const user = await userFromReq(req, url);
    if (!user || user.status !== 'aprovado') return json(res, 401, { error: 'Sessão inválida.' });
    return json(res, 200, { name: user.name, username: user.username, whatsapp: user.whatsapp, lastAddress: user.lastAddress || '' });
  }

  // a lista de produtos é exclusiva para clientes aprovados, com os preços do cliente
  if (method === 'GET' && p === '/api/products') {
    const user = await userFromReq(req, url);
    if (!user || user.status !== 'aprovado') {
      return json(res, 401, { error: 'Faça login para ver a lista.' });
    }
    const [r, customBrands] = await Promise.all([
      q(`select id, name, stock from ${T('products')} where active order by seq`),
      customLogoBrands(),
    ]);
    return json(
      res,
      200,
      r.rows.map((pr) => ({
        id: pr.id,
        name: pr.name,
        stock: pr.stock,
        price: priceFor(user, pr.name),
        logo: brandLogoFor(pr.name, customBrands),
      }))
    );
  }

  // cliente consulta o status dos próprios pedidos
  if (method === 'GET' && p === '/api/my-orders') {
    const user = await userFromReq(req, url);
    if (!user) return json(res, 200, []);
    const r = await q(`select * from ${T('orders')} where user_id = $1 order by seq desc`, [user.id]);
    const mine = r.rows.map(rowToOrder);
    // pedidos em aberto nunca são escondidos; o corte de 20 vale só para o histórico
    const open = mine.filter((o) => o.status === 'pendente' || o.status === 'aceito');
    const closed = mine.filter((o) => o.status !== 'pendente' && o.status !== 'aceito').slice(0, 20);
    const found = [...open, ...closed]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((o) => ({
        id: o.id,
        status: o.status,
        createdAt: o.createdAt,
        items: o.items.map(({ name, qty }) => ({ name, qty })),
      }));
    return json(res, 200, found);
  }

  // cliente logado cria pedido: estoque é reservado (abaixado) na hora
  if (method === 'POST' && p === '/api/orders') {
    const user = await userFromReq(req, url);
    if (!user || user.status !== 'aprovado') {
      return json(res, 401, { error: 'Faça login para enviar o pedido.' });
    }
    const body = await readBody(req);
    const address = String((body.customer && body.customer.address) || '').trim().slice(0, 200);
    if (!address) {
      return json(res, 400, { error: 'Informe o endereço.' });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return json(res, 400, { error: 'O pedido está vazio.' });
    }

    const merged = new Map();
    for (const it of body.items) {
      const qty = Math.floor(Number(it.qty));
      if (!it.productId || !Number.isFinite(qty) || qty < 1) {
        return json(res, 400, { error: 'Item inválido no pedido.' });
      }
      merged.set(String(it.productId), (merged.get(String(it.productId)) || 0) + qty);
    }
    if (merged.size > 500) return json(res, 400, { error: 'Pedido grande demais.' });

    const order = await withTx(
      async (client) => {
        const ids = [...merged.keys()];
        const pr = await client.query(`select id, name, stock, active from ${T('products')} where id = any($1)`, [ids]);
        const byId = new Map(pr.rows.map((x) => [x.id, x]));
        for (const [productId, qty] of merged) {
          const prod = byId.get(productId);
          if (!prod || !prod.active) {
            throw new ApiError(409, 'Um dos produtos não está mais disponível.');
          }
          if (prod.stock < qty) {
            throw new ApiError(409, `Estoque insuficiente para "${prod.name}" (disponível: ${prod.stock}).`);
          }
        }
        const items = [];
        const qtys = [];
        for (const [productId, qty] of merged) {
          const prod = byId.get(productId);
          items.push({ productId, name: prod.name, qty, priceCents: priceFor(user, prod.name) });
          qtys.push(qty);
        }
        await client.query(
          `update ${T('products')} p set stock = p.stock - v.qty
           from (select unnest($1::text[]) as id, unnest($2::int[]) as qty) v where p.id = v.id`,
          [ids, qtys]
        );
        const totalCents = items.every((i) => Number.isFinite(i.priceCents))
          ? items.reduce((s, i) => s + i.priceCents * i.qty, 0)
          : null;
        const o = {
          id: null,
          createdAt: new Date().toISOString(),
          userId: user.id,
          partnerId: user.partnerId, // denormalizado: define de qual sócio é o pedido
          customer: { name: user.name, phone: user.whatsapp, address },
          items,
          totalCents,
          status: 'pendente',
          revenueCents: null,
          costCents: null,
        };
        // colisão do código curto: ON CONFLICT DO NOTHING não lança erro (um erro aqui
        // abortaria a transação inteira e o retry seria impossível) — sem linha inserida,
        // gera outro código e tenta de novo
        let inserted = false;
        for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
          o.id = orderCode();
          const ins = await client.query(
            `insert into ${T('orders')} (id, user_id, partner_id, status, customer, items, total_cents)
             values ($1,$2,$3,'pendente',$4,$5,$6) on conflict (id) do nothing returning id`,
            [o.id, o.userId, o.partnerId, JSON.stringify(o.customer), JSON.stringify(o.items), o.totalCents]
          );
          inserted = Boolean(ins.rows[0]);
        }
        if (!inserted) throw new ApiError(500, 'Não foi possível gerar o código do pedido. Tente de novo.');
        await client.query(`update ${T('users')} set last_address = $1 where id = $2`, [address, user.id]);
        await bump(client);
        return o;
      },
      { stockLock: true }
    );
    await notifyNewOrder(order);
    return json(res, 201, { id: order.id, status: order.status });
  }

  if (method === 'POST' && p === '/api/admin/login') {
    const ip = ipOf(req);
    if (await throttled('adminlogin', ip)) {
      return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
    }
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const pass = String(body.password || '');
    // cada sócio tem usuário + senha próprios; casa os dois
    const partner = PARTNERS.find((pt) => pt.login === username && pt.password === pass);
    if (!partner) {
      await throttleHit('adminlogin', ip);
      return json(res, 401, { error: 'Usuário ou senha incorretos.' });
    }
    await throttleClear('adminlogin', ip);
    const token = await createSession('admin', partner.slug, passFingerprint(partner.password));
    return json(res, 200, { token, partner: { slug: partner.slug, name: partner.name } });
  }

  // ---- daqui pra baixo, tudo exige login de admin; `me` = slug do sócio logado ----
  const me = await partnerOf(req, url);
  if (!me) {
    return json(res, 401, { error: 'Não autorizado.' });
  }

  if (method === 'GET' && p === '/api/admin/orders') {
    // cada sócio só enxerga os próprios pedidos
    const r = await q(`select * from ${T('orders')} where partner_id = $1 order by seq desc`, [me]);
    return json(res, 200, r.rows.map(rowToOrder));
  }

  // ---- clientes: aprovação de cadastro e tabela de preços por modelo ----

  if (method === 'GET' && p === '/api/admin/users') {
    const r = await q(`select * from ${T('users')} where partner_id = $1 order by seq`, [me]);
    return json(res, 200, r.rows.map((row) => publicUser(rowToUser(row))));
  }

  // admin cria um cliente direto (lead) já aprovado, com usuário e senha definidos por ele
  if (method === 'POST' && p === '/api/admin/users') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 80);
    const whatsapp = String(body.whatsapp || '').replace(/\D/g, '').slice(0, 18);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name || !whatsapp) return json(res, 400, { error: 'Informe nome e WhatsApp.' });
    if (whatsapp.length < 8 || whatsapp.length > 15) {
      return json(res, 400, { error: 'WhatsApp inválido (código do país + DDD + número).' });
    }
    if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
      return json(res, 400, { error: 'Usuário inválido: 3 a 20 letras, números, ponto, traço ou _ (sem espaços).' });
    }
    if (password.length < 4) return json(res, 400, { error: 'A senha precisa ter pelo menos 4 caracteres.' });
    const { salt, hash } = hashPassword(password);
    const id = newId();
    let row;
    try {
      const r = await q(
        `insert into ${T('users')} (id, username, name, whatsapp, salt, hash, status, prices, partner_id, approved_at)
         values ($1,$2,$3,$4,$5,$6,'aprovado','{}'::jsonb,$7, now()) returning *`,
        [id, username, name, whatsapp, salt, hash, me]
      );
      row = r.rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return json(res, 409, { error: 'Este usuário já existe. Escolha outro.' });
      }
      throw err;
    }
    await bump();
    return json(res, 201, publicUser(rowToUser(row)));
  }

  // ---- modelos permanentes (fonte da tabela de preços, independente do estoque) ----
  if (method === 'GET' && p === '/api/admin/models') {
    const r = await q(`select name from ${T('models')} order by seq`);
    return json(res, 200, r.rows.map((x) => x.name));
  }
  if (method === 'PUT' && p === '/api/admin/models') {
    const body = await readBody(req);
    if (!Array.isArray(body.models)) return json(res, 400, { error: 'Lista de modelos inválida.' });
    const seen = new Set();
    const models = [];
    for (const raw of body.models) {
      const m = String(raw).replace(/^-+\s*/, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 60);
      if (m && !seen.has(m)) {
        seen.add(m);
        models.push(m);
      }
    }
    // stockLock: serializa com registerModels (import/criação de produto) — sem isso, dois
    // saves simultâneos da lista de modelos podiam conflitar (unique) e virar erro 500
    await withTx(
      async (client) => {
        await client.query(`delete from ${T('models')}`);
        if (models.length) {
          await client.query(`insert into ${T('models')} (name) select unnest($1::text[])`, [models]);
        }
        await bump(client);
      },
      { stockLock: true }
    );
    return json(res, 200, models);
  }

  // ---- configurações do SÓCIO logado: link do Pushcut + custo por modelo ----
  if (p === '/api/admin/settings') {
    if (method === 'GET') {
      const r = await q(`select notify_url, costs from ${T('partner_data')} where slug = $1`, [me]);
      const d = r.rows[0] || { notify_url: '', costs: {} };
      return json(res, 200, { notifyUrl: d.notify_url || '', costs: d.costs || {} });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const r = await q(`select notify_url, costs from ${T('partner_data')} where slug = $1`, [me]);
      let notifyUrl = (r.rows[0] && r.rows[0].notify_url) || '';
      let costsSaved = (r.rows[0] && r.rows[0].costs) || {};
      if (body.notifyUrl !== undefined) {
        const u = String(body.notifyUrl || '').trim().slice(0, 300);
        if (u && !/^https?:\/\//i.test(u)) {
          return json(res, 400, { error: 'O link de notificação precisa começar com http:// ou https://' });
        }
        notifyUrl = u;
      }
      if (body.costs !== undefined) {
        const costs = {};
        for (const [model, cents] of Object.entries(body.costs || {})) {
          const v = Math.round(Number(cents));
          if (Number.isFinite(v) && v >= 0) costs[String(model).slice(0, 60)] = v;
        }
        costsSaved = costs;
      }
      await q(
        `insert into ${T('partner_data')} (slug, notify_url, costs) values ($1,$2,$3)
         on conflict (slug) do update set notify_url = excluded.notify_url, costs = excluded.costs`,
        [me, notifyUrl, JSON.stringify(costsSaved)]
      );
      await bump();
      return json(res, 200, { notifyUrl, costs: costsSaved });
    }
  }

  const userMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    // só acha o cliente se ele for do sócio logado (não revela clientes do outro sócio)
    const r0 = await q(`select * from ${T('users')} where id = $1 and partner_id = $2`, [userMatch[1], me]);
    const u = rowToUser(r0.rows[0]);
    if (!u) return json(res, 404, { error: 'Cliente não encontrado.' });

    if (method === 'PUT') {
      const body = await readBody(req);
      const sets = [];
      const vals = [];
      let n = 0;
      const add = (col, val) => {
        vals.push(val);
        sets.push(`${col} = $${++n}`);
      };
      let mustDropTokens = false;
      if (body.prices !== undefined) {
        const prices = {};
        for (const [model, cents] of Object.entries(body.prices || {})) {
          const v = Math.round(Number(cents));
          if (Number.isFinite(v) && v >= 0) prices[String(model).slice(0, 60)] = v;
        }
        add('prices', JSON.stringify(prices));
      }
      if (body.status !== undefined) {
        if (!['pendente', 'aprovado', 'bloqueado'].includes(body.status)) {
          return json(res, 400, { error: 'Status inválido.' });
        }
        add('status', body.status);
        if (body.status === 'aprovado' && !u.approvedAt) add('approved_at', new Date().toISOString());
        if (body.status !== 'aprovado') mustDropTokens = true; // bloqueou → derruba a sessão
      }
      if (body.username !== undefined) {
        const uname = String(body.username).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,20}$/.test(uname)) {
          return json(res, 400, { error: 'Usuário inválido: 3 a 20 letras, números, ponto, traço ou _ (sem espaços).' });
        }
        add('username', uname);
      }
      if (body.password !== undefined) {
        const pw = String(body.password);
        if (pw.length < 4) return json(res, 400, { error: 'A senha precisa ter pelo menos 4 caracteres.' });
        const h = hashPassword(pw);
        add('salt', h.salt);
        add('hash', h.hash);
        mustDropTokens = true; // senha nova → derruba sessões antigas
      }
      if (body.name !== undefined) {
        const nm = String(body.name).trim().slice(0, 80);
        if (nm) add('name', nm);
      }
      let row = r0.rows[0];
      if (sets.length) {
        vals.push(u.id);
        try {
          const r = await q(`update ${T('users')} set ${sets.join(', ')} where id = $${n + 1} returning *`, vals);
          row = r.rows[0];
        } catch (err) {
          if (err.code === UNIQUE_VIOLATION) {
            return json(res, 409, { error: 'Este usuário já existe. Escolha outro.' });
          }
          throw err;
        }
        if (mustDropTokens) await dropUserTokens(u.id);
        await bump();
      }
      return json(res, 200, publicUser(rowToUser(row)));
    }

    if (method === 'DELETE') {
      await q(`delete from ${T('users')} where id = $1`, [u.id]);
      await dropUserTokens(u.id);
      await bump();
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'GET' && p === '/api/admin/products') {
    const r = await q(`select id, name, stock, active from ${T('products')} order by seq`);
    return json(res, 200, r.rows);
  }

  if (method === 'POST' && p === '/api/admin/products') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 120);
    const stock = Math.floor(Number(body.stock));
    if (!name || !Number.isFinite(stock) || stock < 0) {
      return json(res, 400, { error: 'Dados do produto inválidos.' });
    }
    const product = { id: newId(), name, stock, active: true };
    // stockLock: serializa com a importação — sem isso, um POST no meio de um import
    // "replace" criaria um produto duplicado que o import não enxerga (estoque em dobro)
    await withTx(
      async (client) => {
        await client.query(`insert into ${T('products')} (id, name, stock, active) values ($1,$2,$3,true)`, [
          product.id,
          name,
          stock,
        ]);
        await registerModels([name], client);
        await bump(client);
      },
      { stockLock: true }
    );
    return json(res, 201, product);
  }

  // upload da logo da marca (fica no banco; SVG não é aceito — pode conter script/XSS)
  if (method === 'POST' && p === '/api/admin/brand-logo') {
    const body = await readBody(req, 3e6);
    const productName = String(body.productName || '').trim();
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(body.dataUrl || ''));
    if (!productName || !m) {
      return json(res, 400, { error: 'Envie uma imagem PNG, JPG ou WEBP.' });
    }
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2e6) {
      return json(res, 400, { error: 'Imagem grande demais (máx. 2 MB).' });
    }
    const brand = brandOf(productName);
    const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[m[1]];
    await q(
      `insert into ${T('brand_logos')} (brand, mime, data) values ($1,$2,$3)
       on conflict (brand) do update set mime = excluded.mime, data = excluded.data, updated_at = now()`,
      [brand, mime, buf]
    );
    await bump();
    return json(res, 200, { brand, logo: 'api/brand-img/' + encodeURIComponent(brand) });
  }

  // importação em massa de lista de estoque
  if (method === 'POST' && p === '/api/admin/products/import') {
    const body = await readBody(req, 5e6);
    const mode = body.mode === 'add' ? 'add' : 'replace';
    const deactivateMissing = Boolean(body.deactivateMissing);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return json(res, 400, { error: 'A lista está vazia.' });
    }
    if (body.items.length > 2000) {
      return json(res, 400, { error: 'Lista grande demais (máx. 2000 itens).' });
    }

    // mesma normalização do parser (ignora acento) para casar itens com produtos existentes
    const norm = (s) =>
      String(s).replace(/\s+/g, ' ').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const incoming = [];
    for (const it of body.items) {
      const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const stock = Math.floor(Number(it.stock));
      if (!name || !Number.isFinite(stock) || stock < 0) {
        return json(res, 400, { error: `Item inválido na lista: "${it.name}".` });
      }
      incoming.push({ name, stock });
    }

    const result = await withTx(
      async (client) => {
        const pr = await client.query(`select id, name, stock, active from ${T('products')} order by seq`);
        const products = pr.rows;
        const reserved = await reservedByProduct(client);
        const byKey = new Map(products.map((x) => [norm(x.name), x]));
        const importedKeys = new Set();
        let created = 0;
        let updated = 0;
        let deactivated = 0;
        const shortfall = []; // recontagem menor que o já reservado → disponível vai a 0
        const keptActive = []; // produto com pedido em aberto não é desativado
        const toUpdate = []; // {id, stock}
        const toCreate = []; // {id, name, stock}

        for (const it of incoming) {
          const key = norm(it.name);
          importedKeys.add(key);
          const existing = byKey.get(key);
          if (existing) {
            let stock;
            if (mode === 'add') {
              // chegada de mercadoria: unidades novas somam ao disponível
              stock = existing.stock + it.stock;
            } else {
              // recontagem física: inclui o reservado → disponível = físico - reservado
              const r = reserved.get(existing.id) || 0;
              stock = Math.max(0, it.stock - r);
              if (it.stock < r) shortfall.push(existing.name);
            }
            existing.stock = stock;
            existing.active = true;
            toUpdate.push({ id: existing.id, stock });
            updated++;
          } else {
            const product = { id: newId(), name: it.name, stock: it.stock, active: true };
            byKey.set(key, product);
            toCreate.push(product);
            created++;
          }
        }

        const toDeactivate = [];
        if (deactivateMissing) {
          for (const x of products) {
            if (x.active && !importedKeys.has(norm(x.name))) {
              if ((reserved.get(x.id) || 0) > 0) {
                keptActive.push(x.name); // tem pedido em aberto: não some da loja
                continue;
              }
              toDeactivate.push(x.id);
              deactivated++;
            }
          }
        }

        // a mesma lista pode citar o MESMO produto duas vezes (nomes que normalizam igual);
        // o UPDATE em lote com id repetido aplicaria só uma linha arbitrária, então fica o
        // estado FINAL por id (o loop acima já acumulou em memória, igual ao servidor antigo).
        // Produto criado nesta mesma importação já carrega o valor final no INSERT.
        const createIds = new Set(toCreate.map((x) => x.id));
        const finalUpdate = new Map();
        for (const u of toUpdate) if (!createIds.has(u.id)) finalUpdate.set(u.id, u.stock);
        if (finalUpdate.size) {
          const ids = [...finalUpdate.keys()];
          await client.query(
            `update ${T('products')} p set stock = v.stock, active = true
             from (select unnest($1::text[]) as id, unnest($2::int[]) as stock) v where p.id = v.id`,
            [ids, ids.map((id) => finalUpdate.get(id))]
          );
        }
        if (toCreate.length) {
          await client.query(
            `insert into ${T('products')} (id, name, stock, active)
             select unnest($1::text[]), unnest($2::text[]), unnest($3::int[]), true`,
            [toCreate.map((x) => x.id), toCreate.map((x) => x.name), toCreate.map((x) => x.stock)]
          );
        }
        if (toDeactivate.length) {
          await client.query(`update ${T('products')} set active = false where id = any($1)`, [toDeactivate]);
        }
        await registerModels(incoming.map((x) => x.name), client);
        await bump(client);
        return { created, updated, deactivated, shortfall, keptActive };
      },
      { stockLock: true }
    );
    return json(res, 200, result);
  }

  const prodMatch = p.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (prodMatch) {
    if (method === 'PUT') {
      const body = await readBody(req);
      const out = await withTx(
        async (client) => {
          const r = await client.query(`select id, name, stock, active from ${T('products')} where id = $1 for update`, [prodMatch[1]]);
          const prod = r.rows[0];
          if (!prod) throw new ApiError(404, 'Produto não encontrado.');
          if (body.name !== undefined) {
            const name = String(body.name).trim().slice(0, 120);
            if (!name) throw new ApiError(400, 'Nome inválido.');
            prod.name = name;
          }
          if (body.stock !== undefined) {
            const stock = Math.floor(Number(body.stock));
            if (!Number.isFinite(stock) || stock < 0) {
              throw new ApiError(400, 'Estoque inválido.');
            }
            // o número digitado é a contagem física (inclui reservas) → disponível = físico - reservado
            const reserved = (await reservedByProduct(client)).get(prod.id) || 0;
            prod.stock = Math.max(0, stock - reserved);
          }
          if (body.active !== undefined) prod.active = Boolean(body.active);
          await client.query(`update ${T('products')} set name = $1, stock = $2, active = $3 where id = $4`, [
            prod.name,
            prod.stock,
            prod.active,
            prod.id,
          ]);
          await bump(client);
          return prod;
        },
        { stockLock: true }
      );
      return json(res, 200, out);
    }

    if (method === 'DELETE') {
      await withTx(
        async (client) => {
          const r = await client.query(`select id from ${T('products')} where id = $1 for update`, [prodMatch[1]]);
          if (!r.rows[0]) throw new ApiError(404, 'Produto não encontrado.');
          // produto com pedido em aberto não pode ser excluído: perderíamos a reserva
          if (((await reservedByProduct(client)).get(prodMatch[1]) || 0) > 0) {
            throw new ApiError(
              409,
              'Este produto tem pedidos em aberto. Recuse ou finalize esses pedidos antes de excluí-lo — ou apenas desmarque "Ativo" para tirá-lo da loja.'
            );
          }
          await client.query(`delete from ${T('products')} where id = $1`, [prodMatch[1]]);
          await bump(client);
        },
        { stockLock: true }
      );
      return json(res, 200, { ok: true });
    }
  }

  // admin altera os itens de um pedido; o estoque é ajustado pela diferença
  const editMatch = p.match(/^\/api\/admin\/orders\/([^/]+)\/items$/);
  if (method === 'PUT' && editMatch) {
    const body = await readBody(req);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return json(res, 400, { error: 'O pedido precisa ter pelo menos um item. Para cancelar tudo, recuse o pedido.' });
    }
    const merged = new Map();
    for (const it of body.items) {
      const qty = Math.floor(Number(it.qty));
      if (!it.productId || !Number.isFinite(qty) || qty < 1) {
        return json(res, 400, { error: 'Item inválido no pedido.' });
      }
      merged.set(String(it.productId), (merged.get(String(it.productId)) || 0) + qty);
    }
    if (merged.size > 500) return json(res, 400, { error: 'Pedido grande demais.' });

    const out = await withTx(
      async (client) => {
        const ro = await client.query(
          `select * from ${T('orders')} where id = $1 and partner_id = $2 for update`,
          [editMatch[1], me]
        );
        if (!ro.rows[0]) throw new ApiError(404, 'Pedido não encontrado.');
        const order = rowToOrder(ro.rows[0]);
        if (order.status === 'recusado') {
          throw new ApiError(409, 'Não é possível alterar um pedido recusado (o estoque já foi devolvido).');
        }

        const current = new Map(order.items.map((i) => [i.productId, i.qty]));
        const allIds = [...new Set([...merged.keys(), ...current.keys()])];
        const rp = await client.query(`select id, name, stock from ${T('products')} where id = any($1)`, [allIds]);
        const byId = new Map(rp.rows.map((x) => [x.id, x]));

        for (const [productId, qty] of merged) {
          const prod = byId.get(productId);
          if (!prod) throw new ApiError(409, 'Um dos produtos não existe mais.');
          const delta = qty - (current.get(productId) || 0);
          if (delta > 0 && prod.stock < delta) {
            throw new ApiError(409, `Estoque insuficiente para "${prod.name}" (disponível: ${prod.stock}).`);
          }
        }

        // deltas: item removido devolve tudo; item alterado ajusta pela diferença
        const deltaIds = [];
        const deltaQtys = []; // positivo = baixa estoque; negativo = devolve
        for (const [productId, qty] of current) {
          if (!merged.has(productId) && byId.has(productId)) {
            deltaIds.push(productId);
            deltaQtys.push(-qty);
          }
        }
        const owner = order.userId
          ? rowToUser((await client.query(`select * from ${T('users')} where id = $1`, [order.userId])).rows[0])
          : null;
        // preserva o preço CONGELADO para itens que já existiam; só item novo usa o preço atual
        const frozen = new Map(order.items.map((i) => [i.productId, i.priceCents]));
        const items = [];
        for (const [productId, qty] of merged) {
          const prod = byId.get(productId);
          const delta = qty - (current.get(productId) || 0);
          if (delta !== 0) {
            deltaIds.push(productId);
            deltaQtys.push(delta);
          }
          const priceCents = frozen.has(productId) ? frozen.get(productId) : priceFor(owner, prod.name);
          items.push({ productId, name: prod.name, qty, priceCents });
        }
        if (deltaIds.length) {
          await client.query(
            `update ${T('products')} p set stock = p.stock - v.qty
             from (select unnest($1::text[]) as id, unnest($2::int[]) as qty) v where p.id = v.id`,
            [deltaIds, deltaQtys]
          );
        }
        const totalCents = items.every((i) => Number.isFinite(i.priceCents))
          ? items.reduce((s, i) => s + i.priceCents * i.qty, 0)
          : null;
        const editedAt = new Date().toISOString();
        const ru = await client.query(
          `update ${T('orders')} set items = $1, total_cents = $2, edited_at = $3 where id = $4 returning *`,
          [JSON.stringify(items), totalCents, editedAt, order.id]
        );
        await bump(client);
        return rowToOrder(ru.rows[0]);
      },
      { stockLock: true }
    );
    return json(res, 200, out);
  }

  const decideMatch = p.match(/^\/api\/admin\/orders\/([^/]+)\/(accept|reject)$/);
  if (method === 'POST' && decideMatch) {
    const out = await withTx(
      async (client) => {
        const ro = await client.query(
          `select * from ${T('orders')} where id = $1 and partner_id = $2 for update`,
          [decideMatch[1], me]
        );
        if (!ro.rows[0]) throw new ApiError(404, 'Pedido não encontrado.');
        const order = rowToOrder(ro.rows[0]);
        if (order.status !== 'pendente') {
          throw new ApiError(409, 'Este pedido já foi decidido.');
        }
        const status = decideMatch[2] === 'accept' ? 'aceito' : 'recusado';
        if (status === 'recusado') {
          // devolve ao estoque (só de produtos que ainda existem)
          const ids = order.items.map((i) => i.productId);
          const qtys = order.items.map((i) => i.qty);
          if (ids.length) {
            await client.query(
              `update ${T('products')} p set stock = p.stock + v.qty
               from (select unnest($1::text[]) as id, unnest($2::int[]) as qty) v where p.id = v.id`,
              [ids, qtys]
            );
          }
        }
        const decidedAt = new Date().toISOString();
        const ru = await client.query(
          `update ${T('orders')} set status = $1, decided_at = $2 where id = $3 returning *`,
          [status, decidedAt, order.id]
        );
        await bump(client);
        return rowToOrder(ru.rows[0]);
      },
      { stockLock: true }
    );
    return json(res, 200, out);
  }

  // admin lança faturamento e custo de um pedido aceito → lucro na contabilidade
  const finMatch = p.match(/^\/api\/admin\/orders\/([^/]+)\/finance$/);
  if (method === 'POST' && finMatch) {
    const body = await readBody(req);
    const revenueCents = Math.round(Number(body.revenueCents));
    const costCents = Math.round(Number(body.costCents));
    if (!Number.isFinite(revenueCents) || revenueCents < 0 || !Number.isFinite(costCents) || costCents < 0) {
      return json(res, 400, { error: 'Informe faturamento e custo válidos.' });
    }
    const r = await q(
      `update ${T('orders')} set revenue_cents = $1, cost_cents = $2, finance_at = now()
       where id = $3 and partner_id = $4 and status = 'aceito' returning *`,
      [revenueCents, costCents, finMatch[1], me]
    );
    if (!r.rows[0]) {
      const exists = await q(`select status from ${T('orders')} where id = $1 and partner_id = $2`, [finMatch[1], me]);
      if (!exists.rows[0]) return json(res, 404, { error: 'Pedido não encontrado.' });
      return json(res, 409, { error: 'Só é possível lançar valores em pedidos aceitos.' });
    }
    await bump();
    return json(res, 200, rowToOrder(r.rows[0]));
  }

  return json(res, 404, { error: 'Rota não encontrada.' });
}

// erro de infraestrutura de banco (projeto pausado, rede, timeout) — não é bug do app
const DB_DOWN = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|tenant|Connection terminated|timeout exceeded when trying to connect|EAI_AGAIN/i;

// handler com o tratamento de erro central (mesma resposta do servidor original)
async function handleRequest(req, res, url) {
  try {
    await handleApi(req, res, url);
  } catch (err) {
    let status = err instanceof ApiError ? err.status : 500;
    let message = err instanceof ApiError ? err.message : 'Erro interno. Tente de novo.';
    if (!(err instanceof ApiError) && DB_DOWN.test(String(err.message || ''))) {
      status = 503;
      message = 'O banco de dados está religando. Tente de novo em 1 minuto.';
    }
    if (status >= 500) console.error('Erro na API:', err.message);
    if (!res.headersSent) {
      json(res, status, { error: message });
    }
  }
}

// avisos de configuração (aparecem no boot local e no log da function no Vercel)
function logConfigWarnings(log = console.log) {
  const comPadrao = PARTNERS.filter((pt) => pt.password === 'Krauz#' || pt.password === 'Boss#').map((x) => x.slug);
  if (comPadrao.length) {
    log(`⚠ Senha PADRÃO em: ${comPadrao.join(', ')} — defina P1_PASSWORD/P2_PASSWORD em produção!`);
  }
  const semNotify = PARTNERS.filter((pt) => !pt.notifyUrl).map((x) => x.slug);
  if (semNotify.length) {
    log(`⚠ Sem notificação (Pushcut) em: ${semNotify.join(', ')} — defina P1_NOTIFY/P2_NOTIFY, senão esse(s) sócio(s) NÃO recebe(m) aviso de pedido/cadastro.`);
  }
  const logins = PARTNERS.map((x) => x.login);
  if (new Set(logins).size !== logins.length) {
    log('⚠ Dois sócios estão com o MESMO usuário de painel — defina P1_USER/P2_USER diferentes.');
  }
}

module.exports = { handleRequest, handleApi, PARTNERS, logConfigWarnings, ensureReady };
