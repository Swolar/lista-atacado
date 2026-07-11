// Servidor local do Lista de Pods — desenvolvimento e testes.
// Usa o MESMO núcleo de API do deploy no Vercel (lib/app.js) e serve os arquivos
// estáticos de public/. Os dados ficam no Postgres (Supabase): defina DATABASE_URL.
//   DATABASE_URL=postgresql://... node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleRequest, PARTNERS, logConfigWarnings, ensureReady } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- arquivos estáticos ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  // link de cadastro por sócio: /login/<slug> serve a própria loja (a loja lê o slug da URL)
  if (pathname.startsWith('/login/')) pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: 'Proibido.' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Página não encontrada.' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleRequest(req, res, url);
  } else if (req.method === 'GET') {
    serveStatic(res, url.pathname);
  } else {
    json(res, 405, { error: 'Método não permitido.' });
  }
});

ensureReady()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Loja:         http://localhost:${PORT}`);
      console.log(`Painel admin: http://localhost:${PORT}/admin`);
      for (const pt of PARTNERS) {
        console.log(`  Sócio "${pt.name}" — usuário do painel: ${pt.login} — link de cadastro: http://localhost:${PORT}/login/${pt.slug}`);
      }
      logConfigWarnings();
    });
  })
  .catch((err) => {
    console.error('ERRO ao preparar o banco (DATABASE_URL ok?):', err.message);
    process.exit(1);
  });
