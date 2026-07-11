// Testa XSS de verdade no navegador: um cliente cujo NOME e cujo produto contêm
// um payload <img onerror> não pode executar script no painel admin nem na loja.
const { chromium } = require('playwright');
const assert = require('node:assert');
const { startServer, req, createApprovedUser } = require('./helpers');
const { baseSeed } = require('./fixtures/seeds');

const PAYLOAD = '<img src=x onerror="window.__xss=1">';

(async () => {
  const s = await startServer(baseSeed());
  let browser;
  try {
    // cliente com nome-payload + pedido (o payload cai nos cards/modal do admin)
    const { utoken, adminToken, username } = await createApprovedUser(s.base, {
      name: PAYLOAD,
      username: 'xssuser',
      prices: {},
    });
    await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: PAYLOAD }, items: [{ productId: 'p1', qty: 1 }] },
    });
    // produto com nome-payload (o payload cai na lista da loja)
    await req(s.base, 'POST', '/api/admin/products', { token: adminToken, body: { name: PAYLOAD, stock: 5 } });

    try {
      browser = await chromium.launch({ channel: 'chrome' });
    } catch {
      browser = await chromium.launch();
    }

    // ----- ADMIN -----
    const actx = await browser.newContext();
    const ap = await actx.newPage();
    await ap.addInitScript(() => {
      window.__xss = 0;
    });
    await ap.goto(s.base + '/admin', { waitUntil: 'load' });
    await ap.fill('#adminUser', 'krauz');
    await ap.fill('#password', 'test-pw');
    await ap.click('#loginBtn');
    await ap.waitForSelector('#panelView:not(.hidden)', { timeout: 8000 });
    await ap.click('#adminMenuBtn'); // navegação agora é pelo menu lateral
    await ap.click('.menu-item[data-nav="pedidos"]');
    await ap.waitForSelector('.order-card', { timeout: 8000 });
    await ap.waitForTimeout(300);
    assert.strictEqual(await ap.evaluate(() => window.__xss), 0, 'admin: onerror disparou no card de pedido');
    assert.strictEqual(await ap.locator('img[onerror]').count(), 0, 'admin: <img onerror> parseado no DOM');
    const cardText = await ap.locator('.order-card').first().innerText();
    assert.ok(cardText.includes('<img'), 'admin: payload deve aparecer como texto literal escapado');

    // abre o modal do pedido e a aba Clientes (renderizam nome/endereço/username payload)
    await ap.locator('.order-card').first().click();
    await ap.waitForTimeout(200);
    await ap.evaluate(() => (window.__xss = 0));
    await ap.locator('#orderModalClose').click().catch(() => {});
    await ap.click('#adminMenuBtn');
    await ap.click('.menu-item[data-nav="clientes"]');
    await ap.waitForTimeout(300);
    assert.strictEqual(await ap.evaluate(() => window.__xss), 0, 'admin: onerror disparou na aba Clientes');
    assert.strictEqual(await ap.locator('img[onerror]').count(), 0, 'admin: <img onerror> na aba Clientes');

    // aba Estoque: colar lista com NOME DE MARCA-payload e conferir o preview de importação
    // (o resumo por marca ia cru para innerHTML — agora deve aparecer escapado)
    await ap.evaluate(() => (window.__xss = 0));
    await ap.click('#adminMenuBtn');
    await ap.click('.menu-item[data-nav="estoque"]');
    await ap.fill('#importText', '-- <img src=x onerror="window.__xss=1">\n17 Menta');
    await ap.click('#parseListBtn');
    await ap.waitForSelector('#importPreview:not(.hidden)', { timeout: 5000 });
    await ap.waitForTimeout(300);
    assert.strictEqual(await ap.evaluate(() => window.__xss), 0, 'admin: onerror disparou no preview de import (marca)');
    assert.strictEqual(await ap.locator('#importPreview img[onerror]').count(), 0, 'admin: <img onerror> no preview de import');
    await actx.close();

    // ----- LOJA -----
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await sp.addInitScript(() => {
      window.__xss = 0;
    });
    await sp.goto(s.base + '/', { waitUntil: 'load' });
    await sp.fill('#loginUser', username);
    await sp.fill('#loginPass', '1234');
    await sp.click('#loginSubmitBtn');
    await sp.waitForSelector('#storeMain:not(.hidden)', { timeout: 8000 });
    await sp.waitForTimeout(600);
    assert.strictEqual(await sp.evaluate(() => window.__xss), 0, 'loja: onerror disparou no nome do produto');
    assert.strictEqual(await sp.locator('#productGrid img[onerror]').count(), 0, 'loja: <img onerror> no grid');
    await sctx.close();

    console.log('✔ XSS OK: nenhum payload executou (admin: card+modal+clientes; loja: produto)');
  } catch (e) {
    console.error('✖ XSS TEST FALHOU:', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
})();
