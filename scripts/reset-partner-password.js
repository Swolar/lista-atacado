// Zera a senha própria de um sócio — o link de 1º acesso (/senha/<slug>/<token>)
// volta a funcionar para ele criar uma senha nova. Sessões antigas caem sozinhas.
//
// Uso: node scripts/reset-partner-password.js <slug>       (ex.: bross)
//   DATABASE_URL vem do ambiente ou do .env da raiz.
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) process.env.DATABASE_URL = m[1].trim();
  } catch {}
}

const slug = process.argv[2];
if (!slug) {
  console.error('Uso: node scripts/reset-partner-password.js <slug do sócio>');
  process.exit(1);
}

const { q, T } = require('../lib/db');

(async () => {
  const r = await q(`update ${T('partner_data')} set pass_salt = '', pass_hash = '' where slug = $1`, [slug]);
  if (!r.rowCount) {
    console.log(`Nada a zerar: o sócio "${slug}" não tem senha própria gravada.`);
  } else {
    console.log(`✔ Senha do sócio "${slug}" zerada — o link de 1º acesso voltou a funcionar.`);
  }
  await q(`delete from ${T('sessions')} where kind = 'admin' and subject = $1`, [slug]);
  console.log('✔ Sessões antigas desse sócio encerradas.');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
