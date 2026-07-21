// Servidor local do Lista de Pods — desenvolvimento e testes.
// Usa o MESMO núcleo de API do deploy no Vercel (lib/app.js) e serve os arquivos
// estáticos de public/. Os dados ficam no Postgres (Supabase): defina DATABASE_URL.
//   DATABASE_URL=postgresql://... node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleRequest, PARTNERS, logConfigWarnings, ensureReady } = require('./lib/app');

// PORT=0 é válido (o SO escolhe uma porta livre — usado nos testes); só cai no 3000
// quando a variável não existe ou não é um número
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 3000;
})();
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

function serveStatic(res, pathname, headOnly = false) {
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(headOnly ? undefined : data);
  });
}

// ---------- servidor ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleRequest(req, res, url);
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    // HEAD atendido igual ao GET (sem corpo) — monitores de uptime usam HEAD
    serveStatic(res, url.pathname, req.method === 'HEAD');
  } else {
    json(res, 405, { error: 'Método não permitido.' });
  }
});

// Banco fora do ar NÃO derruba o site: os estáticos continuam servindo e a API
// tenta reconectar a cada request (o ensureReady do lib/app.js se rearma sozinho).
ensureReady()
  .catch((err) => {
    console.error(`AVISO: banco indisponível no boot (${err.message}) — servindo o site assim mesmo; a API reconecta sozinha.`);
  })
  .then(() => {
    server.listen(PORT, () => {
      // com PORT=0 o sistema escolhe uma porta livre (usado nos testes) — loga a real
      const port = server.address().port;
      console.log(`Loja:         http://localhost:${port}`);
      console.log(`Painel admin: http://localhost:${port}/admin`);
      for (const pt of PARTNERS) {
        console.log(`  Sócio "${pt.name}" — usuário do painel: ${pt.login} — link de cadastro: http://localhost:${port}/login/${pt.slug}`);
      }
      logConfigWarnings();
    });
  });
