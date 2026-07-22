// Mostra um resumo do que está no banco (produtos, modelos, clientes, pedidos).
// Uso: node scripts/inspect-db.js   (lê DATABASE_URL do ambiente ou do .env da raiz)
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) process.env.DATABASE_URL = m[1].trim();
  } catch {}
}

const { q } = require('../lib/db');

(async () => {
  const products = (await q('select count(*)::int as total, count(*) filter (where active)::int as ativos from ' + tbl('products'))).rows[0];
  const models = (await q('select name from ' + tbl('models') + ' order by seq')).rows.map((r) => r.name);
  const users = (await q('select username, name, status, partner_id from ' + tbl('users') + ' order by created_at')).rows;
  const orders = (await q('select partner_id, status, count(*)::int as n from ' + tbl('orders') + ' group by 1,2 order by 1,2')).rows;
  const partnerData = (await q("select slug, notify_url <> '' as tem_notify from " + tbl('partner_data'))).rows;
  console.log('produtos:', products);
  console.log('modelos:', models);
  console.log('clientes:', users);
  console.log('pedidos:', orders);
  console.log('partner_data:', partnerData);
  process.exit(0);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});

function tbl(name) {
  const schema = (process.env.PGSCHEMA || 'public').trim();
  return `"${schema}"."${name}"`;
}
