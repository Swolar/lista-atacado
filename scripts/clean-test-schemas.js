// Remove schemas podtest_* que sobraram de rodadas de teste interrompidas.
// Uso: DATABASE_URL=... node scripts/clean-test-schemas.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = txt.match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

(async () => {
  const cs = resolveDbUrl();
  if (!cs) {
    console.error('Defina DATABASE_URL.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: cs, max: 1, ssl: { rejectUnauthorized: false }, allowExitOnIdle: true });
  const r = await pool.query(`select nspname from pg_namespace where nspname like 'podtest\\_%'`);
  for (const row of r.rows) {
    await pool.query(`drop schema if exists "${row.nspname}" cascade`);
  }
  console.log(`✔ ${r.rows.length} schema(s) de teste removido(s).`);
  await pool.end();
})().catch((err) => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
