// Lista os schemas do banco e, onde existir partner_data/products, as contagens —
// para descobrir em qual schema a produção realmente grava.
// Uso: node scripts/list-schemas.js  (DATABASE_URL do ambiente ou do .env)
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
  const schemas = (
    await q(`select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`)
  ).rows.map((r) => r.nspname);
  for (const s of schemas) {
    const has = (
      await q(`select table_name from information_schema.tables where table_schema = $1 and table_name in ('partner_data','products')`, [s])
    ).rows.map((r) => r.table_name);
    if (!has.length) {
      console.log(`${s}: (sem tabelas do app)`);
      continue;
    }
    let line = `${s}:`;
    if (has.includes('products')) {
      const c = (await q(`select count(*)::int n from "${s}"."products"`)).rows[0].n;
      line += ` products=${c}`;
    }
    if (has.includes('partner_data')) {
      const rows = (await q(`select slug, pass_hash <> '' as tem_senha from "${s}"."partner_data"`)).rows;
      line += ` partner_data=${JSON.stringify(rows)}`;
    }
    console.log(line);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
