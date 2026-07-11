// Puxa TODOS os dados do site antigo (cPanel) pelas APIs de admin dos dois sócios e importa
// no Postgres novo (Supabase). Re-rodável: use --wipe para substituir o conteúdo atual do
// banco pela cópia fiel do site antigo (ideal na hora da virada de domínio).
//
// A API de admin não expõe hash de senha dos clientes (de propósito) — então cada cliente
// importado recebe uma SENHA TEMPORÁRIA, gravada em ~/Desktop/senhas-temporarias-lista-de-pods.txt
// para o sócio repassar (ou trocar na aba Leads). Para migrar preservando as senhas originais,
// use o data.json do cPanel com scripts/import-data.js.
//
// Uso: DATABASE_URL=... node scripts/sync-from-old-site.js [--wipe]
//   env opcionais: OLD_BASE (padrão https://lista-de-pod.online),
//   OLD_KRAUZ_USER/OLD_KRAUZ_PASS (padrão krauz/Krauz#), OLD_BOSS_USER/OLD_BOSS_PASS (boss/Boss#)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { ensureSchema } = require('./migrate');
const { importData } = require('./import-data');

const OLD_BASE = process.env.OLD_BASE || 'https://lista-de-pod.online';
const PARTNERS = [
  { slug: 'krauz', username: process.env.OLD_KRAUZ_USER || 'krauz', password: process.env.OLD_KRAUZ_PASS || 'Krauz#' },
  { slug: 'boss', username: process.env.OLD_BOSS_USER || 'boss', password: process.env.OLD_BOSS_PASS || 'Boss#' },
];

function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = txt.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function hashPassword(password, salt = crypto.randomBytes(8).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}

async function getJson(pathname, token) {
  const r = await fetch(OLD_BASE + pathname, { headers: token ? { 'x-token': token } : {} });
  if (!r.ok) throw new Error(`GET ${pathname} → HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const cs = resolveDbUrl();
  if (!cs) {
    console.error('Defina DATABASE_URL.');
    process.exit(1);
  }
  const wipe = process.argv.includes('--wipe');

  // 1. login nos dois painéis do site antigo
  const tokens = {};
  for (const p of PARTNERS) {
    const r = await fetch(OLD_BASE + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: p.username, password: p.password }),
    });
    if (!r.ok) {
      console.error(`Login do sócio "${p.slug}" falhou no site antigo (HTTP ${r.status}). Senha mudou? Use OLD_${p.slug.toUpperCase()}_PASS.`);
      process.exit(1);
    }
    tokens[p.slug] = (await r.json()).token;
    console.log(`✔ login no painel antigo: ${p.slug}`);
  }

  // 2. baixa tudo
  const products = await getJson('/api/admin/products', tokens.krauz);
  let models = [];
  try {
    models = await getJson('/api/admin/models', tokens.krauz);
  } catch {}
  const users = [];
  const orders = [];
  const tempPasswords = [];
  for (const p of PARTNERS) {
    const us = await getJson('/api/admin/users', tokens[p.slug]);
    for (const u of us) {
      const tempPass = 'pods' + String(Math.floor(1000 + Math.random() * 9000));
      const { salt, hash } = hashPassword(tempPass);
      users.push({ ...u, salt, hash, partnerId: p.slug });
      tempPasswords.push(`${u.name} (@${u.username}) [sócio ${p.slug}] → senha temporária: ${tempPass}`);
    }
    const os_ = await getJson('/api/admin/orders', tokens[p.slug]);
    for (const o of os_) orders.push({ ...o, partnerId: p.slug });
    console.log(`  ${p.slug}: ${us.length} cliente(s), ${os_.length} pedido(s)`);
  }
  console.log(`  compartilhado: ${products.length} produto(s), ${models.length} modelo(s)`);

  // 3. logos customizadas (img/brands/<slug>.<ext>) — só as que existirem no site antigo
  const brandLogos = {};
  const modelOf = (n) => (n.indexOf(' – ') > 0 ? n.slice(0, n.indexOf(' – ')) : n);
  const brands = [...new Set(products.map((x) => modelOf(x.name).split(' ')[0]))];
  for (const brand of brands) {
    const slug = brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    for (const ext of ['png', 'jpg', 'webp']) {
      const rel = `img/brands/${slug}.${ext}`;
      try {
        const r = await fetch(`${OLD_BASE}/${rel}`);
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
          brandLogos[brand] = rel; // importData resolve pelo public/ local; aqui salvamos o arquivo
          const buf = Buffer.from(await r.arrayBuffer());
          const dir = path.join(__dirname, '..', 'public', 'img', 'brands');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${slug}.${ext}`), buf);
          break;
        }
      } catch {}
    }
  }
  if (Object.keys(brandLogos).length) console.log(`  logos customizadas: ${Object.keys(brandLogos).join(', ')}`);

  // 4. importa no banco novo
  const pool = new Pool({ connectionString: cs, max: 1, ssl: { rejectUnauthorized: false }, allowExitOnIdle: true });
  await ensureSchema(pool, 'public');
  if (wipe) {
    await pool.query(
      'truncate public.products, public.users, public.orders, public.models, public.brand_logos, public.sessions'
    );
    console.log('✔ banco novo limpo (--wipe)');
  }
  const res = await importData(pool, 'public', { products, users, orders, models, brandLogos, partnerData: {} }, {
    publicDir: path.join(__dirname, '..', 'public'),
  });
  for (const w of res.warnings) console.warn('  AVISO:', w);
  console.log('✔ importado:', res.counts);

  // 5. senhas temporárias para o sócio repassar
  if (tempPasswords.length) {
    const file = path.join(os.homedir(), 'Desktop', 'senhas-temporarias-lista-de-pods.txt');
    fs.writeFileSync(
      file,
      `Clientes migrados do site antigo em ${new Date().toLocaleString('pt-BR')}\n` +
        `As senhas antigas não podem ser copiadas (ficam protegidas por hash) — repasse a senha\n` +
        `temporária a cada cliente, ou defina outra na aba Leads do painel.\n\n` +
        tempPasswords.join('\n') +
        '\n'
    );
    console.log(`✔ senhas temporárias salvas em: ${file}`);
  }
  await pool.end();
})().catch((err) => {
  console.error('ERRO na sincronização:', err.message);
  process.exit(1);
});
