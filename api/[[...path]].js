// Entrada da API no Vercel: TODA rota /api/* cai aqui e é tratada pelo mesmo núcleo
// (lib/app.js) que o servidor local usa. Os arquivos estáticos saem direto da CDN
// (pasta public/), então esta function só cuida de dados.
const { handleRequest } = require('../lib/app');

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  await handleRequest(req, res, url);
};
