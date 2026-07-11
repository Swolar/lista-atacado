// Importa um data.json (formato legado do servidor de arquivo) para o Postgres.
// CLI:    DATABASE_URL=... node scripts/import-data.js caminho/do/data.json [schema]
// Módulo: const { importData } = require('./import-data')  (usado pelos testes)
//
// Aplica a mesma migração multi-sócio do servidor antigo: cliente/pedido sem partnerId
// ou com slug desconhecido cai no sócio 1 (krauz) e avisa — nada some.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const KNOWN_SLUGS = ['krauz', 'boss'];
const DEFAULT_SLUG = 'krauz';

function fixPartner(rec, warnings) {
  if (!rec.partnerId) {
    rec.partnerId = DEFAULT_SLUG;
  } else if (!KNOWN_SLUGS.includes(rec.partnerId)) {
    warnings.push(`partnerId desconhecido "${rec.partnerId}" reatribuído a "${DEFAULT_SLUG}"`);
    rec.partnerId = DEFAULT_SLUG;
  }
}

async function importData(pool, schema, data, { publicDir } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('schema inválido: ' + schema);
  const T = (n) => `"${schema}"."${n}"`;
  const warnings = [];
  const users = Array.isArray(data.users) ? data.users : [];
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const products = Array.isArray(data.products) ? data.products : [];
  const models = Array.isArray(data.models) ? data.models : [];
  const brandLogos = data.brandLogos && typeof data.brandLogos === 'object' ? data.brandLogos : {};
  const partnerData = data.partnerData && typeof data.partnerData === 'object' ? data.partnerData : {};
  for (const u of users) fixPartner(u, warnings);
  for (const o of orders) fixPartner(o, warnings);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of products) {
      await client.query(
        `insert into ${T('products')} (id, name, stock, active) values ($1,$2,$3,$4)
         on conflict (id) do update set name=excluded.name, stock=excluded.stock, active=excluded.active`,
        [p.id, p.name, Math.max(0, Math.floor(Number(p.stock) || 0)), p.active !== false]
      );
    }
    for (const u of users) {
      await client.query(
        `insert into ${T('users')} (id, username, name, whatsapp, salt, hash, status, prices, partner_id, last_address, created_at, approved_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, now()),$12)
         on conflict (id) do nothing`,
        [
          u.id,
          u.username,
          u.name || '',
          u.whatsapp || '',
          u.salt || '',
          u.hash || '',
          u.status || 'pendente',
          JSON.stringify(u.prices || {}),
          u.partnerId,
          u.lastAddress || '',
          u.createdAt || null,
          u.approvedAt || null,
        ]
      );
    }
    // data.json guarda pedidos do mais novo para o mais antigo; inserimos invertido para
    // que a ordem de inserção (seq) cresça do mais antigo ao mais novo
    for (const o of [...orders].reverse()) {
      await client.query(
        `insert into ${T('orders')} (id, user_id, partner_id, status, customer, items, total_cents, revenue_cents, cost_cents, created_at, decided_at, edited_at, finance_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11,$12,$13)
         on conflict (id) do nothing`,
        [
          o.id,
          o.userId || null,
          o.partnerId,
          o.status || 'pendente',
          JSON.stringify(o.customer || {}),
          JSON.stringify(o.items || []),
          Number.isFinite(o.totalCents) ? o.totalCents : null,
          Number.isFinite(o.revenueCents) ? o.revenueCents : null,
          Number.isFinite(o.costCents) ? o.costCents : null,
          o.createdAt || null,
          o.decidedAt || null,
          o.editedAt || null,
          o.financeAt || null,
        ]
      );
    }
    for (const m of models) {
      await client.query(`insert into ${T('models')} (name) values ($1) on conflict (name) do nothing`, [String(m)]);
    }
    for (const [slug, d] of Object.entries(partnerData)) {
      await client.query(
        `insert into ${T('partner_data')} (slug, notify_url, costs) values ($1,$2,$3)
         on conflict (slug) do update set notify_url=excluded.notify_url, costs=excluded.costs`,
        [slug, (d && d.notifyUrl) || '', JSON.stringify((d && d.costs) || {})]
      );
    }
    // logos legadas eram arquivos em public/img/brands — se o arquivo existir aqui, sobe pro banco
    for (const [brand, rel] of Object.entries(brandLogos)) {
      const file = publicDir ? path.join(publicDir, rel) : null;
      if (file && fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
        if (mime) {
          await client.query(
            `insert into ${T('brand_logos')} (brand, mime, data) values ($1,$2,$3)
             on conflict (brand) do update set mime=excluded.mime, data=excluded.data, updated_at=now()`,
            [brand, mime, fs.readFileSync(file)]
          );
          continue;
        }
      }
      warnings.push(`logo da marca "${brand}" (${rel}) não encontrada em public/ — pulei`);
    }
    await client.query(`update ${T('meta')} set version = version + 1 where id = 1`);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
  return { warnings, counts: { products: products.length, users: users.length, orders: orders.length, models: models.length } };
}

if (require.main === module) {
  const file = process.argv[2];
  const schema = process.argv[3] || process.env.PGSCHEMA || 'public';
  const cs = process.env.DATABASE_URL;
  if (!file || !cs) {
    console.error('Uso: DATABASE_URL=... node scripts/import-data.js caminho/do/data.json [schema]');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pool = new Pool({ connectionString: cs, max: 1, ssl: { rejectUnauthorized: false }, allowExitOnIdle: true });
  const { ensureSchema } = require('./migrate');
  ensureSchema(pool, schema)
    .then(() => importData(pool, schema, data, { publicDir: path.join(__dirname, '..', 'public') }))
    .then((r) => {
      console.log(`✔ importado no schema "${schema}":`, r.counts);
      for (const w of r.warnings) console.warn('  AVISO:', w);
      return pool.end();
    })
    .catch((err) => {
      console.error('ERRO na importação:', err.message);
      process.exit(1);
    });
}

module.exports = { importData };
