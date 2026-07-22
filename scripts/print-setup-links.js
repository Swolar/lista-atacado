// Imprime, para cada sócio, o link de primeiro acesso para criar a própria senha.
// O token é derivado da DATABASE_URL (HMAC) — o link só funciona enquanto o sócio
// ainda não criou senha; para reemitir, zere pass_hash na tabela partner_data.
//
// Uso: node scripts/print-setup-links.js [base-url]
//   base-url padrão: https://lista-atacado.vercel.app
//   DATABASE_URL vem do ambiente ou do .env da raiz (precisa ser a MESMA da produção).
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m) process.env.DATABASE_URL = m[1].trim();
  } catch {}
}
if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL (a mesma da produção) — o token do link é derivado dela.');
  process.exit(1);
}

const { PARTNERS, setupToken } = require('../lib/app');

const base = (process.argv[2] || 'https://lista-atacado.vercel.app').replace(/\/$/, '');
for (const pt of PARTNERS) {
  console.log(`Sócio "${pt.name}" (usuário: ${pt.login})`);
  console.log(`  criar senha: ${base}/senha/${pt.slug}/${setupToken(pt.slug)}`);
  console.log(`  cadastro de clientes: ${base}/login/${pt.slug}`);
  console.log(`  painel: ${base}/admin`);
}
