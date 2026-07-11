// Camada de acesso ao Postgres (Supabase). Um pool pequeno por instância — no Vercel
// cada instância da function mantém poucas conexões e o pooler do Supabase (porta 6543,
// transaction mode) multiplexa. Localmente (node server.js / testes) funciona igual.
const { Pool } = require('pg');

const SCHEMA = (process.env.PGSCHEMA || 'public').trim();
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  throw new Error(`PGSCHEMA inválido: "${SCHEMA}" (use só letras minúsculas, números e _)`);
}

// nome de tabela qualificado pelo schema — TODO acesso a tabela passa por aqui, o que
// permite rodar os testes em schemas isolados no mesmo banco sem tocar em "public"
const T = (name) => `"${SCHEMA}"."${name}"`;

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) throw new Error('DATABASE_URL não configurada (string de conexão do Supabase).');
    pool = new Pool({
      connectionString: cs,
      max: Number(process.env.PGPOOL_MAX) || 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      allowExitOnIdle: true, // scripts/testes terminam sem precisar de pool.end()
      ssl: /localhost|127\.0\.0\.1/.test(cs) ? undefined : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => console.error('pg pool error:', err.message));
  }
  return pool;
}

function q(text, params) {
  return getPool().query(text, params);
}

// Transação. Com stockLock=true adquire um advisory lock (por schema) que serializa TODAS
// as mutações de estoque — pedidos, edições, aceite/recusa, importação — reproduzindo a
// semântica single-process do servidor original. Sem ele, duas functions em paralelo
// poderiam vender a mesma unidade duas vezes.
async function withTx(fn, { stockLock = false } = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (stockLock) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stock:' + SCHEMA]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { q, withTx, T, SCHEMA, getPool };
