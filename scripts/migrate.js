// Cria (idempotente) o schema e as tabelas no Postgres/Supabase.
// CLI:    DATABASE_URL=... node scripts/migrate.js [schema]      (padrão: public)
// Módulo: const { ddl, ensureSchema } = require('./migrate')
const { Pool } = require('pg');

function ddl(schema = 'public') {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('schema inválido: ' + schema);
  const S = `"${schema}"`;
  return `
create schema if not exists ${S};

create table if not exists ${S}.products (
  id text primary key,
  name text not null,
  stock integer not null default 0,
  active boolean not null default true,
  seq bigint generated always as identity
);

create table if not exists ${S}.users (
  id text primary key,
  username text not null unique,
  name text not null,
  whatsapp text not null default '',
  salt text not null default '',
  hash text not null default '',
  status text not null default 'pendente',
  prices jsonb not null default '{}'::jsonb,
  partner_id text not null,
  last_address text not null default '',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  seq bigint generated always as identity
);

create table if not exists ${S}.orders (
  id text primary key,
  user_id text,
  partner_id text not null,
  status text not null default 'pendente',
  customer jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  total_cents integer,
  revenue_cents integer,
  cost_cents integer,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  edited_at timestamptz,
  finance_at timestamptz,
  seq bigint generated always as identity
);
create index if not exists orders_partner_idx on ${S}.orders (partner_id);
create index if not exists orders_user_idx on ${S}.orders (user_id);
create index if not exists orders_status_idx on ${S}.orders (status);

create table if not exists ${S}.models (
  name text primary key,
  seq bigint generated always as identity
);

create table if not exists ${S}.partner_data (
  slug text primary key,
  notify_url text not null default '',
  costs jsonb not null default '{}'::jsonb
);

create table if not exists ${S}.brand_logos (
  brand text primary key,
  mime text not null,
  data bytea not null,
  updated_at timestamptz not null default now()
);

create table if not exists ${S}.sessions (
  token text primary key,
  kind text not null,
  subject text not null,
  fingerprint text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table ${S}.sessions add column if not exists fingerprint text not null default '';
create index if not exists sessions_subject_idx on ${S}.sessions (kind, subject);

create table if not exists ${S}.throttle (
  key text primary key,
  fails integer not null default 0,
  last_ms bigint not null default 0,
  until_ms bigint not null default 0
);

create table if not exists ${S}.meta (
  id integer primary key,
  version bigint not null default 1
);
insert into ${S}.meta (id, version) values (1, 1) on conflict (id) do nothing;
`;
}

// Executa o DDL. Tenta em uma tacada só (1 ida ao banco); se o pooler não aceitar
// multi-statement, cai para statement a statement dentro de uma transação.
async function ensureSchema(pool, schema = 'public') {
  const sql = ddl(schema);
  try {
    await pool.query(sql);
    return;
  } catch (err) {
    if (!/multiple commands|prepared statement|cannot insert multiple commands/i.test(err.message)) throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of sql.split(';')) {
      const s = stmt.trim();
      if (s) await client.query(s);
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const schema = process.argv[2] || process.env.PGSCHEMA || 'public';
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    console.error('Defina DATABASE_URL (string de conexão do Supabase).');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: cs, max: 1, ssl: { rejectUnauthorized: false }, allowExitOnIdle: true });
  ensureSchema(pool, schema)
    .then(() => {
      console.log(`✔ schema "${schema}" pronto (tabelas criadas/confirmadas).`);
      return pool.end();
    })
    .catch((err) => {
      console.error('ERRO na migração:', err.message);
      process.exit(1);
    });
}

module.exports = { ddl, ensureSchema };
