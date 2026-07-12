// Varredura de cenários extremos/hostis — tudo que um usuário real (ou mal-intencionado)
// pode fazer e que ainda não estava travado pela suíte principal. Cada bloco agrupa
// cenários relacionados num mesmo servidor para a rodada ficar rápida.
const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, req, adminLogin, createApprovedUser, assertConservation, snapshotStock, dbPool } = require('./helpers');
const { baseSeed } = require('./fixtures/seeds');

const prod = (list, id) => list.find((p) => p.id === id);
const clearThrottle = (s) => dbPool().query(`delete from "${s.schema}".throttle`);

// ---------- cadastro: todas as validações ----------

test('cadastro: cada validação rejeita com 400/409 e não cria lixo', async () => {
  const s = await startServer(baseSeed());
  try {
    const reg = (body) => req(s.base, 'POST', '/api/register', { body });
    const ok = { name: 'Cliente', whatsapp: '5541999990000', username: 'valido1', password: '1234', partner: 'krauz' };

    assert.strictEqual((await reg({ ...ok, whatsapp: '1234567' })).status, 400, 'whatsapp curto (7 dígitos)');
    assert.strictEqual((await reg({ ...ok, whatsapp: '1234567890123456' })).status, 400, 'whatsapp longo (16 dígitos)');
    assert.strictEqual((await reg({ ...ok, whatsapp: 'abc' })).status, 400, 'whatsapp sem dígito');
    assert.strictEqual((await reg({ ...ok, name: '' })).status, 400, 'sem nome');
    assert.strictEqual((await reg({ ...ok, username: 'ab' })).status, 400, 'usuário curto');
    assert.strictEqual((await reg({ ...ok, username: 'a'.repeat(21) })).status, 400, 'usuário longo');
    assert.strictEqual((await reg({ ...ok, username: 'com espaço' })).status, 400, 'usuário com espaço');
    assert.strictEqual((await reg({ ...ok, username: 'açúcar' })).status, 400, 'usuário com acento');
    assert.strictEqual((await reg({ ...ok, password: '123' })).status, 400, 'senha curta');
    assert.strictEqual((await reg({ ...ok, partner: undefined })).status, 400, 'sem sócio');
    assert.strictEqual((await reg({ ...ok, partner: 'KRAUZ ' })).status, 201, 'slug com maiúscula/espaço normaliza');
    assert.strictEqual((await reg({ ...ok, username: 'valido2' })).status, 201, 'cadastro válido passa');
    assert.strictEqual((await reg({ ...ok, username: 'valido2' })).status, 409, 'usuário duplicado');
    // WhatsApp com máscara vira dígitos
    const masked = await reg({ ...ok, username: 'valido3', whatsapp: '+55 (41) 99999-0000' });
    assert.strictEqual(masked.status, 201, 'whatsapp com máscara é aceito');
    // username em MAIÚSCULO é normalizado e loga em qualquer caixa
    await reg({ ...ok, username: 'CaseTest1'.toLowerCase() === 'casetest1' ? 'CaseTest1' : 'casetest1' });
    const kt = await adminLogin(s.base);
    const users = (await req(s.base, 'GET', '/api/admin/users', { token: kt })).json;
    const cased = users.find((u) => u.username === 'casetest1');
    assert.ok(cased, 'username salvo em minúsculas');
    await req(s.base, 'PUT', `/api/admin/users/${cased.id}`, { token: kt, body: { status: 'aprovado' } });
    const login = await req(s.base, 'POST', '/api/login', { body: { username: 'CASETEST1', password: '1234' } });
    assert.strictEqual(login.status, 200, 'login com usuário em caixa alta funciona');
    // nome gigante é truncado em 80 (não explode)
    await clearThrottle(s);
    const big = await reg({ ...ok, username: 'grande1', name: 'N'.repeat(500) });
    assert.strictEqual(big.status, 201);
    const bigU = (await req(s.base, 'GET', '/api/admin/users', { token: kt })).json.find((u) => u.username === 'grande1');
    assert.strictEqual(bigU.name.length, 80, 'nome truncado em 80');
  } finally {
    s.stop();
  }
});

// ---------- pedidos: entradas hostis ----------

test('pedido: entradas hostis não quebram nem furam o estoque', async () => {
  const s = await startServer(baseSeed());
  const base = { p1: 40, p2: 30, p3: 15 };
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000 } });
    const order = (items, address = 'Rua X, 1') =>
      req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address }, items } });

    assert.strictEqual((await order([])).status, 400, 'pedido vazio');
    assert.strictEqual((await order([{ productId: 'p1', qty: 0 }])).status, 400, 'qty 0');
    assert.strictEqual((await order([{ productId: 'p1', qty: -5 }])).status, 400, 'qty negativa');
    assert.strictEqual((await order([{ productId: 'p1', qty: 'abc' }])).status, 400, 'qty não numérica');
    assert.strictEqual((await order([{ productId: 'p1', qty: Infinity }])).status, 400, 'qty Infinity');
    assert.strictEqual((await order([{ qty: 1 }])).status, 400, 'sem productId');
    assert.strictEqual((await order([{ productId: 'nao-existe', qty: 1 }])).status, 409, 'produto inexistente');
    assert.strictEqual((await order([{ productId: 'p1', qty: 41 }])).status, 409, 'acima do estoque');
    assert.strictEqual((await order([{ productId: 'p1', qty: 1 }], '')).status, 400, 'sem endereço');

    // qty fracionada arredonda para baixo (2.9 → 2)
    const frac = await order([{ productId: 'p1', qty: 2.9 }]);
    assert.strictEqual(frac.status, 201);
    let snap = await assertConservation(s.base, adminToken, base, 'qty fracionada');
    assert.strictEqual(snap.get('p1').reserved, 2, '2.9 vira 2 peças');

    // linhas duplicadas do mesmo produto no body são somadas
    const dup = await order([{ productId: 'p1', qty: 3 }, { productId: 'p1', qty: 4 }]);
    assert.strictEqual(dup.status, 201);
    snap = await assertConservation(s.base, adminToken, base, 'linhas duplicadas');
    assert.strictEqual(snap.get('p1').reserved, 9, '3+4 somados aos 2 anteriores');

    // duas linhas duplicadas cuja SOMA passa do estoque → 409 e nada reservado a mais
    const overDup = await order([{ productId: 'p2', qty: 20 }, { productId: 'p2', qty: 20 }]);
    assert.strictEqual(overDup.status, 409, 'soma das linhas passa do estoque');
    snap = await assertConservation(s.base, adminToken, base, 'soma duplicada');
    assert.strictEqual(snap.get('p2').reserved, 0);

    // endereço gigante é truncado em 200 e o pedido sai
    const bigAddr = await order([{ productId: 'p2', qty: 1 }], 'R'.repeat(1000));
    assert.strictEqual(bigAddr.status, 201);
    const orders = (await req(s.base, 'GET', '/api/admin/orders', { token: adminToken })).json;
    const oBig = orders.find((o) => o.id === bigAddr.json.id);
    assert.strictEqual(oBig.customer.address.length, 200, 'endereço truncado');

    // produto desativado não pode ser pedido e some da loja
    await req(s.base, 'PUT', '/api/admin/products/p3', { token: adminToken, body: { active: false } });
    assert.strictEqual((await order([{ productId: 'p3', qty: 1 }])).status, 409, 'desativado não vende');
    const list = (await req(s.base, 'GET', '/api/products', { utoken })).json;
    assert.ok(!list.some((p) => p.id === 'p3'), 'desativado some da loja');
  } finally {
    s.stop();
  }
});

// ---------- corpo da requisição: JSON malformado e gigante ----------

test('body hostil: JSON inválido → 400; payload gigante → 400; rota errada → 404/405', async () => {
  const s = await startServer(baseSeed());
  try {
    const bad = await fetch(s.base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{isso não é json',
    });
    assert.strictEqual(bad.status, 400, 'JSON malformado');

    const huge = await fetch(s.base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x'.repeat(200000), password: '1' }),
    });
    assert.strictEqual(huge.status, 400, 'payload acima de 100KB');

    // rota desconhecida SEM token cai no portão de admin (401, igual ao servidor antigo);
    // com token válido responde 404
    assert.strictEqual((await req(s.base, 'GET', '/api/nao-existe')).status, 401, 'rota inexistente sem token');
    const tk = await adminLogin(s.base);
    assert.strictEqual((await req(s.base, 'GET', '/api/nao-existe', { token: tk })).status, 404, 'rota inexistente com token');
    const del = await fetch(s.base + '/', { method: 'DELETE' });
    assert.strictEqual(del.status, 405, 'método errado em página');
    const head = await fetch(s.base + '/', { method: 'HEAD' });
    assert.strictEqual(head.status, 200, 'HEAD na home responde 200');
  } finally {
    s.stop();
  }
});

// ---------- admin: validações de produtos, import e settings ----------

test('admin: produto/import/settings rejeitam entradas inválidas sem efeito colateral', async () => {
  const s = await startServer(baseSeed());
  try {
    const token = await adminLogin(s.base);
    // produto inválido
    assert.strictEqual((await req(s.base, 'POST', '/api/admin/products', { token, body: { name: '', stock: 1 } })).status, 400);
    assert.strictEqual((await req(s.base, 'POST', '/api/admin/products', { token, body: { name: 'X', stock: -1 } })).status, 400);
    assert.strictEqual((await req(s.base, 'POST', '/api/admin/products', { token, body: { name: 'X', stock: 'nan' } })).status, 400);
    assert.strictEqual((await req(s.base, 'PUT', '/api/admin/products/p1', { token, body: { stock: -3 } })).status, 400);
    assert.strictEqual((await req(s.base, 'PUT', '/api/admin/products/p1', { token, body: { name: '  ' } })).status, 400);
    assert.strictEqual((await req(s.base, 'PUT', '/api/admin/products/nao-existe', { token, body: { stock: 1 } })).status, 404);
    assert.strictEqual((await req(s.base, 'DELETE', '/api/admin/products/nao-existe', { token })).status, 404);

    // import inválido
    const imp = (body) => req(s.base, 'POST', '/api/admin/products/import', { token, body });
    assert.strictEqual((await imp({ mode: 'replace', items: [] })).status, 400, 'lista vazia');
    assert.strictEqual((await imp({ mode: 'replace', items: [{ name: 'X', stock: -1 }] })).status, 400, 'estoque negativo');
    assert.strictEqual((await imp({ mode: 'replace', items: [{ name: '', stock: 1 }] })).status, 400, 'sem nome');
    const tooMany = { mode: 'replace', items: Array.from({ length: 2001 }, (_, i) => ({ name: 'P' + i, stock: 1 })) };
    assert.strictEqual((await imp(tooMany)).status, 400, 'mais de 2000 itens');

    // import casa nomes ignorando acento (não duplica produto)
    const acc = await imp({ mode: 'replace', items: [{ name: 'V55 – Mentá', stock: 7 }] });
    assert.strictEqual(acc.json.updated, 1, 'acento não cria duplicata');
    assert.strictEqual(acc.json.created, 0);

    // nome de produto com emoji/unicode não explode
    const uni = await req(s.base, 'POST', '/api/admin/products', { token, body: { name: '🔥 IGNITE V80 – Açaí 🇧🇷', stock: 3 } });
    assert.strictEqual(uni.status, 201);

    // settings: custos inválidos são filtrados, válidos arredondados
    const set = await req(s.base, 'PUT', '/api/admin/settings', {
      token,
      body: { costs: { V55: 3000.4, V80: 'abc', NIK: -5, OK: 0 } },
    });
    assert.strictEqual(set.status, 200);
    assert.deepStrictEqual(set.json.costs, { V55: 3000, OK: 0 }, 'inválido/negativo filtrado, float arredondado');

    // modelos: normalização (traço inicial, espaços, caixa, 60 chars, dedup)
    const models = await req(s.base, 'PUT', '/api/admin/models', {
      token,
      body: { models: ['-- v55', 'V55', '  geek   bar  ', 'M'.repeat(100)] },
    });
    assert.strictEqual(models.status, 200);
    assert.deepStrictEqual(models.json, ['V55', 'GEEK BAR', 'M'.repeat(60)], 'normaliza e deduplica');

    // brand-logo: SVG e imagem grande são rejeitados
    const svg = await req(s.base, 'POST', '/api/admin/brand-logo', {
      token,
      body: { productName: 'V55 – X', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    });
    assert.strictEqual(svg.status, 400, 'SVG rejeitado (risco de XSS)');
    const bigImg = await req(s.base, 'POST', '/api/admin/brand-logo', {
      token,
      body: { productName: 'V55 – X', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2_800_000) },
    });
    assert.strictEqual(bigImg.status, 400, 'imagem > 2MB rejeitada');
  } finally {
    s.stop();
  }
});

// ---------- pedidos admin: finance, edição além do estoque, cliente excluído ----------

test('admin pedidos: finance fora de hora, edição além do estoque, cliente excluído no meio', async () => {
  const s = await startServer(baseSeed());
  const base = { p1: 40, p2: 30, p3: 15 };
  try {
    const { utoken, id: userId, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000 } });
    const o1 = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 5 }] } });

    // finance em pedido pendente → 409; valores inválidos → 400
    const fin = (id, body) => req(s.base, 'POST', `/api/admin/orders/${id}/finance`, { token: adminToken, body });
    assert.strictEqual((await fin(o1.json.id, { revenueCents: 100, costCents: 50 })).status, 409, 'finance em pendente');
    await req(s.base, 'POST', `/api/admin/orders/${o1.json.id}/accept`, { token: adminToken });
    assert.strictEqual((await fin(o1.json.id, { revenueCents: -1, costCents: 0 })).status, 400, 'faturamento negativo');
    assert.strictEqual((await fin(o1.json.id, { revenueCents: 'x', costCents: 0 })).status, 400, 'não numérico');
    assert.strictEqual((await fin(o1.json.id, { revenueCents: 100, costCents: 50 })).status, 200, 'finance ok');
    assert.strictEqual((await fin('ZZZZ', { revenueCents: 1, costCents: 1 })).status, 404, 'pedido inexistente');

    // edição pedindo mais do que o disponível → 409 e nada muda
    const edit = (id, items) => req(s.base, 'PUT', `/api/admin/orders/${id}/items`, { token: adminToken, body: { items } });
    assert.strictEqual((await edit(o1.json.id, [{ productId: 'p1', qty: 999 }])).status, 409, 'edição acima do estoque');
    let snap = await assertConservation(s.base, adminToken, base, 'edição negada');
    assert.strictEqual(snap.get('p1').reserved, 5, 'reserva intacta após 409');
    assert.strictEqual((await edit(o1.json.id, [{ productId: 'p1', qty: 0 }])).status, 400, 'qty 0 na edição');

    // cliente é EXCLUÍDO com pedido em aberto: pedido continua gerenciável
    const o2 = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p2', qty: 4 }] } });
    await req(s.base, 'DELETE', `/api/admin/users/${userId}`, { token: adminToken });
    assert.strictEqual((await req(s.base, 'GET', '/api/me', { utoken })).status, 401, 'sessão do excluído cai');
    const e2 = await edit(o2.json.id, [{ productId: 'p2', qty: 2 }, { productId: 'p3', qty: 1 }]);
    assert.strictEqual(e2.status, 200, 'edição funciona sem o dono');
    const p3item = e2.json.items.find((i) => i.productId === 'p3');
    assert.strictEqual(p3item.priceCents, null, 'item novo sem dono fica sem preço (total null)');
    assert.strictEqual(e2.json.totalCents, null);
    const rej = await req(s.base, 'POST', `/api/admin/orders/${o2.json.id}/reject`, { token: adminToken });
    assert.strictEqual(rej.status, 200, 'recusa funciona sem o dono');
    snap = await assertConservation(s.base, adminToken, base, 'após recusa sem dono');
    assert.strictEqual(snap.get('p2').reserved, 0, 'estoque devolvido');
    assert.strictEqual(snap.get('p3').reserved, 0);
  } finally {
    s.stop();
  }
});

// ---------- produto excluído no meio do caminho ----------

test('produto excluído: pedidos antigos seguem legíveis; edição avisa; recusa não explode', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000, 'NIK N8000': 2000 } });
    // pedido com p3, recusa (libera reserva), exclui p3
    const o1 = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p3', qty: 2 }] } });
    await req(s.base, 'POST', `/api/admin/orders/${o1.json.id}/reject`, { token: adminToken });
    assert.strictEqual((await req(s.base, 'DELETE', '/api/admin/products/p3', { token: adminToken })).status, 200);

    // histórico do cliente ainda mostra o nome do produto excluído
    const my = (await req(s.base, 'GET', '/api/my-orders', { utoken })).json;
    assert.ok(my.some((o) => o.items.some((i) => i.name === 'NIK N8000 – Uva')), 'nome preservado no histórico');

    // pedido aberto com p1; excluir p1 é bloqueado; editar para incluir p3 (excluído) → 409
    const o2 = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 1 }] } });
    assert.strictEqual((await req(s.base, 'DELETE', '/api/admin/products/p1', { token: adminToken })).status, 409, 'excluir com reserva é bloqueado');
    const e = await req(s.base, 'PUT', `/api/admin/orders/${o2.json.id}/items`, { token: adminToken, body: { items: [{ productId: 'p1', qty: 1 }, { productId: 'p3', qty: 1 }] } });
    assert.strictEqual(e.status, 409, 'editar com produto excluído avisa');
  } finally {
    s.stop();
  }
});

// ---------- aprovação/bloqueio: transições de status ----------

test('status do cliente: transições e efeitos nas sessões e na loja', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, id, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000 } });
    const put = (body) => req(s.base, 'PUT', `/api/admin/users/${id}`, { token: adminToken, body });

    assert.strictEqual((await put({ status: 'qualquer' })).status, 400, 'status inválido');
    // bloqueia → sessão cai e login recusa
    await put({ status: 'bloqueado' });
    assert.strictEqual((await req(s.base, 'GET', '/api/products', { utoken })).status, 401, 'bloqueado perde a lista');
    // reaprova → login volta (nova sessão), preços preservados
    await put({ status: 'aprovado' });
    const users = (await req(s.base, 'GET', '/api/admin/users', { token: adminToken })).json;
    const u = users.find((x) => x.id === id);
    const relogin = await req(s.base, 'POST', '/api/login', { body: { username: u.username, password: '1234' } });
    assert.strictEqual(relogin.status, 200, 'reaprovado loga de novo');
    const list = (await req(s.base, 'GET', '/api/products', { utoken: relogin.json.token })).json;
    assert.strictEqual(list.find((p) => p.id === 'p1').price, 5000, 'preços preservados no ciclo bloquear/reaprovar');
    // volta para pendente → some o acesso mas o cadastro fica
    await put({ status: 'pendente' });
    assert.strictEqual((await req(s.base, 'POST', '/api/login', { body: { username: u.username, password: '1234' } })).status, 403, 'pendente não loga');
  } finally {
    s.stop();
  }
});

// ---------- concorrência extra: edição × aceite, pedidos × import ----------

test('concorrência: edição simultânea ao aceite e pedidos durante import conservam estoque', async () => {
  const s = await startServer(baseSeed());
  const base = { p1: 40, p2: 30, p3: 15 };
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000 } });
    const o = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 5 }] } });
    // edição e aceite disparados juntos: as duas podem passar (ordem livre), mas o
    // estoque tem que conservar e o pedido terminar consistente
    const [ed, ac] = await Promise.all([
      req(s.base, 'PUT', `/api/admin/orders/${o.json.id}/items`, { token: adminToken, body: { items: [{ productId: 'p1', qty: 8 }] } }),
      req(s.base, 'POST', `/api/admin/orders/${o.json.id}/accept`, { token: adminToken }),
    ]);
    assert.ok([200, 409].includes(ed.status) && [200, 409].includes(ac.status), 'nenhum 500');
    const snap = await assertConservation(s.base, adminToken, base, 'edição × aceite');
    const orders = (await req(s.base, 'GET', '/api/admin/orders', { token: adminToken })).json;
    const oFinal = orders.find((x) => x.id === o.json.id);
    const reservado = snap.get('p1').reserved;
    const somaItens = oFinal.items.reduce((t, i) => t + i.qty, 0);
    assert.strictEqual(reservado, somaItens, 'reserva bate com os itens do pedido');

    // 6 pedidos disparados JUNTO com um import replace: conservação e nenhum 500
    const jobs = [
      req(s.base, 'POST', '/api/admin/products/import', {
        token: adminToken,
        body: { mode: 'replace', items: [{ name: 'V55 – Menta', stock: 40 }, { name: 'V80 – Melancia', stock: 30 }] },
      }),
      ...Array.from({ length: 6 }, () =>
        req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p2', qty: 2 }] } })
      ),
    ];
    const results = await Promise.all(jobs);
    assert.ok(results.every((r) => r.status !== 500), 'sem erro 500 na corrida import × pedidos');
    const snap2 = await snapshotStock(s.base, adminToken);
    assert.ok(snap2.get('p2').available >= 0, 'disponível nunca negativo');
  } finally {
    s.stop();
  }
});

// ---------- histórico do cliente: corte de 20 e pedidos abertos sempre visíveis ----------

test('my-orders: recusados antigos saem do histórico, abertos nunca somem', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    // 23 pedidos recusados + 1 aberto
    const abertos = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 1 }] } });
    for (let i = 0; i < 23; i++) {
      const o = await req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p2', qty: 1 }] } });
      await req(s.base, 'POST', `/api/admin/orders/${o.json.id}/reject`, { token: adminToken });
    }
    const my = (await req(s.base, 'GET', '/api/my-orders', { utoken })).json;
    const abertosVisiveis = my.filter((o) => o.status === 'pendente');
    const fechados = my.filter((o) => o.status === 'recusado');
    assert.strictEqual(abertosVisiveis.length, 1, 'pedido aberto sempre aparece');
    assert.strictEqual(abertosVisiveis[0].id, abertos.json.id);
    assert.strictEqual(fechados.length, 20, 'histórico fechado corta em 20');
  } finally {
    s.stop();
  }
});
