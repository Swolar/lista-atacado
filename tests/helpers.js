// Núcleo do harness: sobe o server.js real contra um SCHEMA ISOLADO no Postgres
// (Supabase) — cada teste cria um schema podtest_*, importa o seed e derruba tudo no
// final. Nunca toca no schema "public" (produção).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { Pool } = require('pg');

const PROJECT = path.resolve(__dirname, '..');
const SERVER = path.join(PROJECT, 'server.js');
const ADMIN_PASSWORD = 'test-pw'; // senha do sócio 1 (krauz) nos testes
// usuário + senha de cada sócio no ambiente de teste. O server usa os logins padrão
// (krauz/boss) e lê ADMIN_PASSWORD p/ krauz e P2_PASSWORD p/ boss.
const PARTNER_CRED = {
  krauz: { username: 'krauz', password: ADMIN_PASSWORD },
  boss: { username: 'boss', password: 'test-pw2' },
};

const { ensureSchema } = require('../scripts/migrate');
const { importData } = require('../scripts/import-data');

// string de conexão: env DATABASE_URL ou a linha DATABASE_URL= do .env do projeto
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const txt = fs.readFileSync(path.join(PROJECT, '.env'), 'utf8');
    const m = txt.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error('Defina DATABASE_URL (env ou .env na raiz do projeto) para rodar os testes.');
}
const DB_URL = resolveDbUrl();

let sharedPool = null;
function pool() {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: DB_URL,
      max: 4,
      ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true, // deixa o processo de teste terminar sem pool.end()
    });
  }
  return sharedPool;
}

// base de porta por processo para não colidir entre arquivos de teste paralelos
let nextPort = 3900 + (process.pid % 500);
let schemaSeq = 0;

async function waitReady(base, isDead = () => false, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDead()) throw new Error('o processo do servidor saiu antes de responder');
    try {
      const r = await fetch(base + '/api/products');
      if (r.status) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('servidor não subiu em ' + timeoutMs + 'ms: ' + base);
}

async function startServer(seed, extraEnv = {}) {
  const schema = `podtest_${process.pid}_${schemaSeq++}_${Math.floor(Math.random() * 1e6)}`;
  await ensureSchema(pool(), schema);
  await importData(pool(), schema, seed);

  // Sobe o servidor com até 2 tentativas (porta em uso / máquina sob carga).
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = nextPort++;
    const child = spawn('node', [SERVER], {
      cwd: PROJECT,
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_PASSWORD, // senha do sócio 1 (krauz)
        P2_PASSWORD: PARTNER_CRED.boss.password, // senha do sócio 2 (boss)
        P1_NOTIFY: '', // sem disparar Pushcut real nos testes
        P2_NOTIFY: '',
        DATABASE_URL: DB_URL,
        PGSCHEMA: schema,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let exited = false;
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', () => (exited = true));
    const base = `http://localhost:${port}`;
    try {
      await waitReady(base, () => exited);
    } catch (e) {
      child.kill('SIGKILL');
      lastErr = new Error(e.message + '\n--- stderr ---\n' + stderr);
      continue; // tenta a próxima porta
    }
    return {
      base,
      schema,
      stderr: () => stderr,
      stop() {
        child.kill('SIGKILL');
        // derruba o schema em segundo plano; sobras são varridas por
        // scripts/clean-test-schemas.js no início da próxima rodada
        pool()
          .query(`drop schema if exists "${schema}" cascade`)
          .catch(() => {});
      },
    };
  }
  pool()
    .query(`drop schema if exists "${schema}" cascade`)
    .catch(() => {});
  throw lastErr;
}

async function req(base, method, pathname, { token, utoken, body, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (token) h['x-token'] = token;
  if (utoken) h['x-user-token'] = utoken;
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function adminLogin(base, slug = 'krauz') {
  const c = PARTNER_CRED[slug];
  const r = await req(base, 'POST', '/api/admin/login', { body: { username: c.username, password: c.password } });
  assert.strictEqual(r.status, 200, 'admin login falhou: ' + JSON.stringify(r.json));
  return r.json.token;
}

let userSeq = 0;
async function createApprovedUser(base, { prices = {}, name, username, password = '1234', partner = 'krauz' } = {}) {
  const u = username || `cli${userSeq++}x${process.pid % 1000}`;
  const reg = await req(base, 'POST', '/api/register', {
    body: { name: name || `Cliente ${u}`, whatsapp: '41999990000', username: u, password, partner },
  });
  assert.strictEqual(reg.status, 201, 'register falhou: ' + JSON.stringify(reg.json));
  const token = await adminLogin(base, partner);
  const users = (await req(base, 'GET', '/api/admin/users', { token })).json;
  const created = users.find((x) => x.username === u);
  assert.ok(created, 'usuário cadastrado não apareceu na lista admin');
  await req(base, 'PUT', `/api/admin/users/${created.id}`, {
    token,
    body: { status: 'aprovado', prices },
  });
  const login = await req(base, 'POST', '/api/login', { body: { username: u, password } });
  assert.strictEqual(login.status, 200, 'login do cliente falhou: ' + JSON.stringify(login.json));
  return { utoken: login.json.token, id: created.id, username: u, adminToken: token, partner };
}

// snapshot por produto: available (stock), reserved (Σ qty em pedidos pendente+aceito), physical
async function snapshotStock(base, token) {
  const products = (await req(base, 'GET', '/api/admin/products', { token })).json;
  const orders = (await req(base, 'GET', '/api/admin/orders', { token })).json;
  const reserved = new Map();
  for (const o of orders) {
    if (o.status === 'pendente' || o.status === 'aceito') {
      for (const it of o.items) reserved.set(it.productId, (reserved.get(it.productId) || 0) + it.qty);
    }
  }
  const map = new Map();
  for (const p of products) {
    const r = reserved.get(p.id) || 0;
    map.set(p.id, { available: p.stock, reserved: r, physical: p.stock + r, name: p.name, active: p.active });
  }
  return map;
}

// invariante mestre: physical constante e available nunca negativo
async function assertConservation(base, token, baselinePhysical, label = '') {
  const snap = await snapshotStock(base, token);
  for (const [id, expected] of Object.entries(baselinePhysical)) {
    const s = snap.get(id);
    assert.ok(s, `${label}: produto ${id} desapareceu`);
    assert.strictEqual(s.physical, expected, `${label}: physical(${id})=${s.physical}, esperado ${expected}`);
    assert.ok(s.available >= 0, `${label}: available(${id}) negativo = ${s.available}`);
  }
  return snap;
}

module.exports = {
  PROJECT,
  ADMIN_PASSWORD,
  PARTNER_CRED,
  startServer,
  req,
  adminLogin,
  createApprovedUser,
  snapshotStock,
  assertConservation,
  dbPool: pool, // acesso direto ao banco de teste (ex: forçar expiração de sessão)
};
