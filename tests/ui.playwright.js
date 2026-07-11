// E2E de interface real no navegador: dirige a LOJA e o PAINEL como um usuário de verdade.
// Cobre o que os testes de API não alcançam: cadastro pela tela, carrinho → revisão →
// confirmação, "meus pedidos", menu lateral, logout limpando os dados do cliente, e no
// admin aceitar o pedido + lançar faturamento. Roda contra um data.json isolado.
const { chromium } = require('playwright');
const assert = require('node:assert');
const { startServer, createApprovedUser } = require('./helpers');
const { baseSeed } = require('./fixtures/seeds');

(async () => {
  const s = await startServer(baseSeed());
  let browser;
  try {
    const { username } = await createApprovedUser(s.base, { prices: { V55: 5500, V80: 7000, 'NIK N8000': 8000 } });
    try {
      browser = await chromium.launch({ channel: 'chrome' });
    } catch {
      browser = await chromium.launch();
    }

    // ===== LOJA =====
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // abre pelo LINK DO SÓCIO (krauz) — é onde o cadastro fica liberado
    await page.goto(s.base + '/login/krauz', { waitUntil: 'load' });

    // cadastro pela tela chega em "cadastro enviado"
    await page.waitForSelector('#showRegisterBtn:not(.hidden)', { timeout: 5000 });
    await page.click('#showRegisterBtn');
    await page.fill('#regName', 'Novo Cliente UI');
    await page.fill('#regPhone', '41988887777');
    await page.fill('#regUser', 'novoui');
    await page.fill('#regPass', '1234');
    await page.click('#registerSubmitBtn');
    await page.waitForSelector('#registerDone:not(.hidden)', { timeout: 5000 });
    await page.click('#backToLoginBtn');

    // login com cliente aprovado
    await page.fill('#loginUser', username);
    await page.fill('#loginPass', '1234');
    await page.click('#loginSubmitBtn');
    await page.waitForSelector('#storeMain:not(.hidden)', { timeout: 8000 });
    await page.waitForSelector('#productGrid .card', { timeout: 8000 });

    // adiciona 2 unidades do primeiro produto
    const inc = page.locator('#productGrid button[data-inc]').first();
    await inc.click();
    await inc.click();
    await page.waitForSelector('#cartBar:not(.hidden)', { timeout: 4000 });

    // carrinho → endereço → revisão → confirmação → sucesso
    await page.click('#openCartBtn');
    await page.waitForSelector('#cartModalBackdrop:not(.hidden)');
    await page.fill('#custAddress', 'Rua Teste UI, 123, Curitiba');
    await page.click('#submitOrderBtn');
    await page.waitForSelector('#reviewBackdrop:not(.hidden)');
    await page.click('#confirmOrderBtn');
    await page.waitForSelector('#successOverlay:not(.hidden)', { timeout: 6000 });
    await page.click('#successCloseBtn');

    // "meus pedidos" mostra o pedido pendente
    await page.waitForSelector('#myOrdersSection:not(.hidden)', { timeout: 4000 });
    const last = await page.locator('#myOrdersList').innerText();
    assert.ok(/Pendente/i.test(last), 'meus pedidos mostra o pedido pendente');

    // menu lateral: abre modal de pedidos, fecha, e sai
    await page.click('#menuBtn');
    await page.waitForSelector('#menuBackdrop:not(.hidden)');
    await page.click('#menuMyOrders');
    await page.waitForSelector('#myOrdersModalBackdrop:not(.hidden)');
    await page.click('#closeMyOrdersBtn');
    await page.click('#menuBtn');
    await page.click('#menuLogout');
    await page.waitForSelector('#authView:not(.hidden)', { timeout: 4000 });

    // logout limpou carrinho e endereço (não vazam para o próximo cliente no mesmo device)
    const leftover = await page.evaluate(() => ({ cart: localStorage.getItem('cart'), addr: localStorage.getItem('custAddress') }));
    assert.ok(!leftover.cart && !leftover.addr, 'logout limpou carrinho e endereço do device');
    await ctx.close();

    // ===== PAINEL: vê o pedido, aceita, lança faturamento, abre contabilidade =====
    const actx = await browser.newContext();
    const ap = await actx.newPage();
    await ap.goto(s.base + '/admin', { waitUntil: 'load' });
    await ap.fill('#adminUser', 'krauz');
    await ap.fill('#password', 'test-pw');
    await ap.click('#loginBtn');
    await ap.waitForSelector('#panelView:not(.hidden)', { timeout: 8000 });
    await ap.click('#adminMenuBtn'); // navegação agora é pelo menu lateral
    await ap.click('.menu-item[data-nav="pedidos"]');
    await ap.waitForSelector('#pendingOrders .order-card', { timeout: 8000 });
    await ap.click('#pendingOrders button[data-accept]');
    await ap.waitForSelector('#financeOrders .order-card', { timeout: 6000 });
    await ap.fill('#financeOrders .fin-cost', '80.00');
    await ap.click('#financeOrders button[data-finance]');
    await ap.waitForTimeout(500);
    await ap.click('#adminMenuBtn');
    await ap.click('.menu-item[data-nav="contabilidade"]');
    await ap.waitForTimeout(300);
    const stats = await ap.locator('#statsGrid').innerText();
    assert.ok(/lucro/i.test(stats), 'contabilidade renderiza o resumo');
    await actx.close();

    console.log('✔ UI E2E OK: cadastro, login, carrinho→revisão→confirmação, meus pedidos, menu, logout(limpa), admin aceita+finance');
  } catch (e) {
    console.error('✖ UI E2E FALHOU:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
})();
