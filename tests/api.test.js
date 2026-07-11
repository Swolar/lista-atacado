// Testes de integração da API contra um servidor isolado (data.json temporário).
// Cobrem: importação de lista (replace/add/deactivate + estoque-fantasma),
// ciclo de vida do pedido com conservação de estoque, preços por cliente,
// concorrência (sem venda a mais) e autenticação.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startServer, req, adminLogin, createApprovedUser, snapshotStock, assertConservation, PARTNER_CRED } = require('./helpers');
const { baseSeed, singleProductSeed } = require('./fixtures/seeds');

const prod = (list, id) => list.find((p) => p.id === id);

// ---------- Importação ----------

test('import replace grava valor absoluto quando não há reserva', async () => {
  const s = await startServer(baseSeed());
  try {
    const token = await adminLogin(s.base);
    const r = await req(s.base, 'POST', '/api/admin/products/import', {
      token,
      body: {
        mode: 'replace',
        items: [{ name: 'V55 – Menta', stock: 12 }, { name: 'V80 – Melancia', stock: 9 }],
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.updated, 2);
    assert.strictEqual(r.json.created, 0);
    const products = (await req(s.base, 'GET', '/api/admin/products', { token })).json;
    assert.strictEqual(prod(products, 'p1').stock, 12);
    assert.strictEqual(prod(products, 'p2').stock, 9);
    assert.strictEqual(prod(products, 'p3').stock, 15);
  } finally {
    s.stop();
  }
});

test('import add soma ao estoque (chegada de mercadoria)', async () => {
  const s = await startServer(baseSeed());
  try {
    const token = await adminLogin(s.base);
    await req(s.base, 'POST', '/api/admin/products/import', {
      token,
      body: { mode: 'add', items: [{ name: 'V55 – Menta', stock: 12 }] },
    });
    const products = (await req(s.base, 'GET', '/api/admin/products', { token })).json;
    assert.strictEqual(prod(products, 'p1').stock, 52);
  } finally {
    s.stop();
  }
});

test('import cria produto novo', async () => {
  const s = await startServer(baseSeed());
  try {
    const token = await adminLogin(s.base);
    const r = await req(s.base, 'POST', '/api/admin/products/import', {
      token,
      body: { mode: 'replace', items: [{ name: 'OXBAR G8000 – Blue', stock: 5 }] },
    });
    assert.strictEqual(r.json.created, 1);
    const products = (await req(s.base, 'GET', '/api/admin/products', { token })).json;
    const novo = products.find((p) => p.name === 'OXBAR G8000 – Blue');
    assert.ok(novo && novo.active && novo.stock === 5);
  } finally {
    s.stop();
  }
});

test('ESTOQUE reservado no pedido; recusa DEVOLVE; aceite mantém', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5500 } });
    const create = await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'Rua X, 1 - Curitiba' }, items: [{ productId: 'p1', qty: 5 }] },
    });
    assert.strictEqual(create.status, 201);

    // pedido pendente JÁ reserva → estoque baixa na hora
    let snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('p1').available, 35, 'pendente reserva 5');
    assert.strictEqual(snap.get('p1').reserved, 5);

    // recusar DEVOLVE ao estoque (o ponto crítico do cliente)
    const rej = await req(s.base, 'POST', `/api/admin/orders/${create.json.id}/reject`, { token: adminToken });
    assert.strictEqual(rej.status, 200);
    snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('p1').available, 40, 'recusa devolveu ao estoque');

    // novo pedido + aceite → mantém reservado (não devolve)
    const o2 = await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 8 }] },
    });
    await req(s.base, 'POST', `/api/admin/orders/${o2.json.id}/accept`, { token: adminToken });
    snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('p1').available, 32, 'aceite mantém a baixa');

    // recontagem física 40 → disponível = 40 - 8 reservado = 32 (sem fantasma)
    const imp = await req(s.base, 'POST', '/api/admin/products/import', {
      token: adminToken,
      body: { mode: 'replace', items: [{ name: 'V55 – Menta', stock: 40 }] },
    });
    assert.strictEqual(imp.status, 200);
    snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('p1').available, 32, 'disponível = físico(40) - reservado(8)');
  } finally {
    s.stop();
  }
});

test('import replace com físico < reservado clampa a 0 e reporta shortfall', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 10 }] },
    });
    const imp = await req(s.base, 'POST', '/api/admin/products/import', {
      token: adminToken,
      body: { mode: 'replace', items: [{ name: 'V55 – Menta', stock: 4 }] },
    });
    assert.deepStrictEqual(imp.json.shortfall, ['V55 – Menta']);
    const snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('p1').available, 0);
  } finally {
    s.stop();
  }
});

test('deactivateMissing não desativa produto com pedido em aberto', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p2', qty: 3 }] },
    });
    const imp = await req(s.base, 'POST', '/api/admin/products/import', {
      token: adminToken,
      body: { mode: 'replace', items: [{ name: 'V55 – Menta', stock: 40 }], deactivateMissing: true },
    });
    assert.ok(imp.json.keptActive.includes('V80 – Melancia'), 'p2 mantido ativo (tem reserva)');
    const products = (await req(s.base, 'GET', '/api/admin/products', { token: adminToken })).json;
    assert.strictEqual(prod(products, 'p2').active, true);
    assert.strictEqual(prod(products, 'p3').active, false, 'p3 sem reserva foi desativado');
  } finally {
    s.stop();
  }
});

// ---------- Ciclo de vida + conservação + preço ----------

test('ciclo completo conserva estoque e recalcula preço/total ao editar', async () => {
  const s = await startServer(baseSeed());
  const base = { p1: 40, p2: 30, p3: 15 };
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5500, V80: 7000 } });
    const create = (items) =>
      req(s.base, 'POST', '/api/orders', { utoken, body: { customer: { address: 'r' }, items } });
    const editItems = (id, items) =>
      req(s.base, 'PUT', `/api/admin/orders/${id}/items`, { token: adminToken, body: { items } });
    const getOrder = async (id) => {
      const all = (await req(s.base, 'GET', '/api/admin/orders', { token: adminToken })).json;
      return all.find((o) => o.id === id);
    };

    // 1. cria O1 misto (pendente JÁ reserva) → total = 5*5500 + 3*7000
    const o1 = await create([{ productId: 'p1', qty: 5 }, { productId: 'p2', qty: 3 }]);
    assert.strictEqual(o1.status, 201);
    let snap = await assertConservation(s.base, adminToken, base, 'após O1');
    assert.strictEqual(snap.get('p1').available, 35, 'pendente reserva');
    assert.strictEqual((await getOrder(o1.json.id)).totalCents, 5 * 5500 + 3 * 7000);

    // 2. aceita O1 (mantém reservado)
    await req(s.base, 'POST', `/api/admin/orders/${o1.json.id}/accept`, { token: adminToken });
    snap = await assertConservation(s.base, adminToken, base, 'após aceitar O1');
    assert.strictEqual(snap.get('p1').available, 35);
    assert.strictEqual(snap.get('p2').available, 27);

    // 3. cria O2 (reserva) e 4. recusa O2 (devolve)
    const o2 = await create([{ productId: 'p1', qty: 10 }]);
    snap = await assertConservation(s.base, adminToken, base, 'após O2');
    assert.strictEqual(snap.get('p1').available, 25);
    await req(s.base, 'POST', `/api/admin/orders/${o2.json.id}/reject`, { token: adminToken });
    snap = await assertConservation(s.base, adminToken, base, 'após recusar O2');
    assert.strictEqual(snap.get('p1').available, 35, 'recusa devolveu');

    // 5. cria e aceita O3 = p1×4 → available 31
    const o3 = await create([{ productId: 'p1', qty: 4 }]);
    await req(s.base, 'POST', `/api/admin/orders/${o3.json.id}/accept`, { token: adminToken });

    // 6. edita +3 → ajusta estoque e recalcula total
    let e = await editItems(o3.json.id, [{ productId: 'p1', qty: 7 }]);
    assert.strictEqual(e.status, 200);
    snap = await assertConservation(s.base, adminToken, base, 'após editar +3');
    assert.strictEqual(snap.get('p1').available, 28);
    let ord = await getOrder(o3.json.id);
    assert.strictEqual(ord.items[0].priceCents, 5500, 'item mantém preço');
    assert.strictEqual(ord.totalCents, 7 * 5500, 'total recalculado');

    // 7. edita −5
    await editItems(o3.json.id, [{ productId: 'p1', qty: 2 }]);
    snap = await assertConservation(s.base, adminToken, base, 'após editar -5');
    assert.strictEqual(snap.get('p1').available, 33);
    assert.strictEqual((await getOrder(o3.json.id)).totalCents, 2 * 5500);

    // 8. remove p1, adiciona p2×1 (pedido aceito → ajusta)
    await editItems(o3.json.id, [{ productId: 'p2', qty: 1 }]);
    snap = await assertConservation(s.base, adminToken, base, 'após trocar item');
    assert.strictEqual(snap.get('p1').available, 35, 'p1 devolvido');
    assert.strictEqual(snap.get('p2').available, 26, 'p2 baixou 1 (além dos 3 do O1)');
    ord = await getOrder(o3.json.id);
    assert.strictEqual(ord.items[0].priceCents, 7000);
    assert.strictEqual(ord.totalCents, 7000);

    // 9. editar pedido recusado → 409
    const o4 = await create([{ productId: 'p1', qty: 1 }]);
    await req(s.base, 'POST', `/api/admin/orders/${o4.json.id}/reject`, { token: adminToken });
    const eRec = await editItems(o4.json.id, [{ productId: 'p1', qty: 2 }]);
    assert.strictEqual(eRec.status, 409);

    // 10. editar até zero itens → 400
    const eZero = await editItems(o3.json.id, []);
    assert.strictEqual(eZero.status, 400);
  } finally {
    s.stop();
  }
});

test('preço por cliente reflete na lista; item sem preço → total null', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5500 } });
    const list = (await req(s.base, 'GET', '/api/products', { utoken })).json;
    assert.strictEqual(list.find((p) => p.id === 'p1').price, 5500);
    assert.strictEqual(list.find((p) => p.id === 'p2').price, null, 'V80 sem preço');

    const o = await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 1 }, { productId: 'p2', qty: 1 }] },
    });
    const all = (await req(s.base, 'GET', '/api/admin/orders', { token: adminToken })).json;
    assert.strictEqual(all.find((x) => x.id === o.json.id).totalCents, null, 'misto com item sem preço → null');
  } finally {
    s.stop();
  }
});

// ---------- Concorrência ----------

test('25 pedidos paralelos em estoque 10 → nunca vende a mais', async () => {
  const s = await startServer(singleProductSeed(10));
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    const attempts = Array.from({ length: 25 }, () =>
      req(s.base, 'POST', '/api/orders', {
        utoken,
        body: { customer: { address: 'r' }, items: [{ productId: 'x1', qty: 1 }] },
      })
    );
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.status === 201).length;
    assert.strictEqual(ok, 10, 'exatamente 10 pedidos aceitos (reserva no pedido)');
    const snap = await snapshotStock(s.base, adminToken);
    assert.strictEqual(snap.get('x1').available, 0);
    assert.strictEqual(snap.get('x1').reserved, 10);
  } finally {
    s.stop();
  }
});

test('accept e reject em corrida → um 200, um 409', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    const o = await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 2 }] },
    });
    const [a, b] = await Promise.all([
      req(s.base, 'POST', `/api/admin/orders/${o.json.id}/accept`, { token: adminToken }),
      req(s.base, 'POST', `/api/admin/orders/${o.json.id}/reject`, { token: adminToken }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [200, 409]);
  } finally {
    s.stop();
  }
});

// ---------- Autenticação ----------

test('rotas admin exigem token válido', async () => {
  const s = await startServer(baseSeed());
  try {
    const routes = [
      ['GET', '/api/admin/orders'],
      ['GET', '/api/admin/products'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/products', { name: 'x', stock: 1 }],
      ['POST', '/api/admin/products/import', { items: [] }],
      ['POST', '/api/admin/brand-logo', {}],
      ['PUT', '/api/admin/users/zz', { status: 'aprovado' }],
      ['PUT', '/api/admin/products/p1', { stock: 1 }],
      ['DELETE', '/api/admin/products/p1'],
      ['DELETE', '/api/admin/users/zz'],
      ['POST', '/api/admin/orders/zz/accept'],
      ['POST', '/api/admin/orders/zz/reject'],
      ['PUT', '/api/admin/orders/zz/items', { items: [] }],
      ['POST', '/api/admin/orders/zz/finance', { revenueCents: 1, costCents: 1 }],
    ];
    for (const [method, path, body] of routes) {
      const noTok = await req(s.base, method, path, { body });
      assert.strictEqual(noTok.status, 401, `${method} ${path} sem token deveria 401`);
      const badTok = await req(s.base, method, path, { token: 'invalido', body });
      assert.strictEqual(badTok.status, 401, `${method} ${path} token errado deveria 401`);
    }
  } finally {
    s.stop();
  }
});

test('rotas de cliente exigem sessão; token de bloqueado é derrubado', async () => {
  const s = await startServer(baseSeed());
  try {
    assert.strictEqual((await req(s.base, 'GET', '/api/products')).status, 401);
    assert.strictEqual((await req(s.base, 'GET', '/api/me')).status, 401);
    assert.strictEqual((await req(s.base, 'GET', '/api/events')).status, 401, 'SSE sem token deve 401');
    assert.strictEqual(
      (await req(s.base, 'POST', '/api/orders', { body: { customer: { address: 'r' }, items: [] } })).status,
      401
    );

    const { utoken, id, adminToken } = await createApprovedUser(s.base, {});
    assert.strictEqual((await req(s.base, 'GET', '/api/me', { utoken })).status, 200);
    await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: adminToken, body: { status: 'bloqueado' } });
    assert.strictEqual((await req(s.base, 'GET', '/api/me', { utoken })).status, 401, 'token do bloqueado inválido');
  } finally {
    s.stop();
  }
});

test('rate limit: 5 senhas admin erradas bloqueiam até a correta (429)', async () => {
  const s = await startServer(baseSeed());
  try {
    for (let i = 0; i < 5; i++) {
      await req(s.base, 'POST', '/api/admin/login', { body: { username: 'krauz', password: 'errada' } });
    }
    const blocked = await req(s.base, 'POST', '/api/admin/login', { body: { username: 'krauz', password: 'test-pw' } });
    assert.strictEqual(blocked.status, 429, 'após 5 erros, até a credencial correta é barrada na janela');
  } finally {
    s.stop();
  }
});

test('rate limit: 5 logins de cliente errados → 429', async () => {
  const s = await startServer(baseSeed());
  try {
    const { username } = await createApprovedUser(s.base, {});
    for (let i = 0; i < 5; i++) {
      await req(s.base, 'POST', '/api/login', { body: { username, password: 'errada' } });
    }
    const blocked = await req(s.base, 'POST', '/api/login', { body: { username, password: '1234' } });
    assert.strictEqual(blocked.status, 429, 'força-bruta no login de cliente é barrada');
  } finally {
    s.stop();
  }
});

test('anti-flood: cadastros repetidos do mesmo IP → 429 após 8', async () => {
  const s = await startServer(baseSeed());
  try {
    let blockedAt = null;
    for (let i = 0; i < 12; i++) {
      const r = await req(s.base, 'POST', '/api/register', {
        body: { name: 'x', whatsapp: '5541999990000', username: 'flood' + i, password: '1234', partner: 'krauz' },
      });
      if (r.status === 429) { blockedAt = i; break; }
    }
    assert.ok(blockedAt !== null && blockedAt >= 8, `bloqueia após 8 cadastros (bloqueou em ${blockedAt})`);
  } finally {
    s.stop();
  }
});

test('editar pedido NÃO reprecifica itens já congelados; item novo usa preço atual', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, id, adminToken } = await createApprovedUser(s.base, { prices: { V55: 5000, 'NIK N8000': 3000 } });
    // pedido congela V55=5000 e NIK=3000
    const o = await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 5 }, { productId: 'p3', qty: 2 }] },
    });
    assert.strictEqual(o.status, 201);
    const getOrder = async () => (await req(s.base, 'GET', '/api/admin/orders', { token: adminToken })).json.find((x) => x.id === o.json.id);
    assert.strictEqual((await getOrder()).totalCents, 5 * 5000 + 2 * 3000);

    // admin muda os preços do cliente DEPOIS do pedido (para pedidos futuros)
    await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: adminToken, body: { prices: { V55: 6000, 'NIK N8000': 9000 } } });

    // edita só para remover o p3: o p1 (não tocado) mantém 5000 congelado
    let e = await req(s.base, 'PUT', `/api/admin/orders/${o.json.id}/items`, { token: adminToken, body: { items: [{ productId: 'p1', qty: 5 }] } });
    assert.strictEqual(e.status, 200);
    let ord = await getOrder();
    assert.strictEqual(ord.items[0].priceCents, 5000, 'preço congelado preservado');
    assert.strictEqual(ord.totalCents, 5 * 5000, 'total não muda com o preço novo');

    // re-adiciona o p3: agora é item NOVO → usa o preço atual 9000
    e = await req(s.base, 'PUT', `/api/admin/orders/${o.json.id}/items`, { token: adminToken, body: { items: [{ productId: 'p1', qty: 5 }, { productId: 'p3', qty: 1 }] } });
    ord = await getOrder();
    const p1 = ord.items.find((i) => i.productId === 'p1');
    const p3 = ord.items.find((i) => i.productId === 'p3');
    assert.strictEqual(p1.priceCents, 5000, 'p1 continua congelado');
    assert.strictEqual(p3.priceCents, 9000, 'p3 novo usa o preço atual');
    assert.strictEqual(ord.totalCents, 5 * 5000 + 1 * 9000);
  } finally {
    s.stop();
  }
});

test('excluir produto com pedido em aberto → 409; sem reserva exclui', async () => {
  const s = await startServer(baseSeed());
  try {
    const { utoken, adminToken } = await createApprovedUser(s.base, {});
    await req(s.base, 'POST', '/api/orders', {
      utoken,
      body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 2 }] },
    });
    const del = await req(s.base, 'DELETE', '/api/admin/products/p1', { token: adminToken });
    assert.strictEqual(del.status, 409, 'produto reservado não é excluído');
    const still = (await req(s.base, 'GET', '/api/admin/products', { token: adminToken })).json;
    assert.ok(prod(still, 'p1'), 'p1 continua existindo');
    const del3 = await req(s.base, 'DELETE', '/api/admin/products/p3', { token: adminToken });
    assert.strictEqual(del3.status, 200, 'produto sem reserva é excluído');
  } finally {
    s.stop();
  }
});

test('login: pendente e bloqueado retornam 403', async () => {
  const s = await startServer(baseSeed());
  try {
    await req(s.base, 'POST', '/api/register', {
      body: { name: 'Pend', whatsapp: '41999990000', username: 'pend01', password: '1234', partner: 'krauz' },
    });
    const pend = await req(s.base, 'POST', '/api/login', { body: { username: 'pend01', password: '1234' } });
    assert.strictEqual(pend.status, 403, 'pendente não entra');

    const token = await adminLogin(s.base);
    const users = (await req(s.base, 'GET', '/api/admin/users', { token })).json;
    const u = users.find((x) => x.username === 'pend01');
    await req(s.base, 'PUT', `/api/admin/users/${u.id}`, { token, body: { status: 'bloqueado' } });
    const blk = await req(s.base, 'POST', '/api/login', { body: { username: 'pend01', password: '1234' } });
    assert.strictEqual(blk.status, 403, 'bloqueado não entra');
  } finally {
    s.stop();
  }
});

// ---------- 2 sócios (multi-partner) ----------

test('isolamento entre sócios: cada painel só vê e só mexe nos seus dados', async () => {
  const s = await startServer(baseSeed());
  try {
    const A = await createApprovedUser(s.base, { partner: 'krauz', prices: { V55: 5000 } });
    const B = await createApprovedUser(s.base, { partner: 'boss', prices: { V55: 6000 } });
    const oa = await req(s.base, 'POST', '/api/orders', { utoken: A.utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 2 }] } });
    const ob = await req(s.base, 'POST', '/api/orders', { utoken: B.utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 3 }] } });

    // krauz vê só o seu cliente/pedido
    const usersK = (await req(s.base, 'GET', '/api/admin/users', { token: A.adminToken })).json;
    assert.ok(usersK.some((u) => u.id === A.id) && usersK.every((u) => u.id !== B.id), 'krauz não vê cliente do boss');
    const ordersK = (await req(s.base, 'GET', '/api/admin/orders', { token: A.adminToken })).json;
    assert.ok(ordersK.some((o) => o.id === oa.json.id) && ordersK.every((o) => o.id !== ob.json.id), 'krauz não vê pedido do boss');

    // krauz NÃO mexe no cliente/pedido do boss → 404
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/users/${B.id}`, { token: A.adminToken, body: { prices: { V55: 1 } } })).status, 404);
    assert.strictEqual((await req(s.base, 'DELETE', `/api/admin/users/${B.id}`, { token: A.adminToken })).status, 404);
    assert.strictEqual((await req(s.base, 'POST', `/api/admin/orders/${ob.json.id}/accept`, { token: A.adminToken })).status, 404);
    assert.strictEqual((await req(s.base, 'POST', `/api/admin/orders/${ob.json.id}/reject`, { token: A.adminToken })).status, 404);
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/orders/${ob.json.id}/items`, { token: A.adminToken, body: { items: [{ productId: 'p1', qty: 1 }] } })).status, 404);

    // boss mexe no SEU normalmente
    assert.strictEqual((await req(s.base, 'POST', `/api/admin/orders/${ob.json.id}/accept`, { token: B.adminToken })).status, 200);
    assert.strictEqual((await req(s.base, 'POST', `/api/admin/orders/${ob.json.id}/finance`, { token: B.adminToken, body: { revenueCents: 100, costCents: 50 } })).status, 200);
    // boss NÃO lança finance no pedido do krauz → 404
    assert.strictEqual((await req(s.base, 'POST', `/api/admin/orders/${oa.json.id}/finance`, { token: B.adminToken, body: { revenueCents: 1, costCents: 1 } })).status, 404);
  } finally {
    s.stop();
  }
});

test('estoque é único: pedidos dos dois sócios baixam do mesmo estoque', async () => {
  const s = await startServer(baseSeed());
  try {
    const A = await createApprovedUser(s.base, { partner: 'krauz' });
    const B = await createApprovedUser(s.base, { partner: 'boss' });
    // p1 = 40; A pede 10, B pede 5 → disponível 25 para AMBOS
    await req(s.base, 'POST', '/api/orders', { utoken: A.utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 10 }] } });
    await req(s.base, 'POST', '/api/orders', { utoken: B.utoken, body: { customer: { address: 'r' }, items: [{ productId: 'p1', qty: 5 }] } });
    const seenByA = (await req(s.base, 'GET', '/api/products', { utoken: A.utoken })).json.find((p) => p.id === 'p1').stock;
    const seenByB = (await req(s.base, 'GET', '/api/products', { utoken: B.utoken })).json.find((p) => p.id === 'p1').stock;
    assert.strictEqual(seenByA, 25);
    assert.strictEqual(seenByB, 25, 'os dois veem o MESMO estoque');
    // recusar o pedido do boss devolve ao estoque compartilhado
    const btoken = await adminLogin(s.base, 'boss');
    const orders = (await req(s.base, 'GET', '/api/admin/orders', { token: btoken })).json;
    await req(s.base, 'POST', `/api/admin/orders/${orders[0].id}/reject`, { token: btoken });
    const afterReject = (await req(s.base, 'GET', '/api/products', { utoken: A.utoken })).json.find((p) => p.id === 'p1').stock;
    assert.strictEqual(afterReject, 30, 'recusa do boss devolveu ao estoque que o krauz também vê');
  } finally {
    s.stop();
  }
});

test('cadastro exige link de sócio válido', async () => {
  const s = await startServer(baseSeed());
  try {
    assert.strictEqual((await req(s.base, 'POST', '/api/register', { body: { name: 'x', whatsapp: '41999990000', username: 'sempart', password: '1234' } })).status, 400, 'sem partner → 400');
    assert.strictEqual((await req(s.base, 'POST', '/api/register', { body: { name: 'x', whatsapp: '41999990000', username: 'badpart', password: '1234', partner: 'naoexiste' } })).status, 400, 'partner inválido → 400');
    assert.strictEqual((await req(s.base, 'POST', '/api/register', { body: { name: 'x', whatsapp: '41999990000', username: 'okpart', password: '1234', partner: 'boss' } })).status, 201, 'partner válido → 201');
  } finally {
    s.stop();
  }
});

test('GET /api/partners lista os sócios sem vazar senha/URL', async () => {
  const s = await startServer(baseSeed());
  try {
    const r = await req(s.base, 'GET', '/api/partners');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.some((p) => p.slug === 'krauz') && r.json.some((p) => p.slug === 'boss'));
    assert.ok(r.json.every((p) => !('password' in p) && !('notifyUrl' in p)), 'não vaza senha nem URL');
  } finally {
    s.stop();
  }
});

test('notificação vai só para o Pushcut do sócio dono', async () => {
  const hits = [];
  const mock = http.createServer((rq, rs) => { hits.push(rq.url); rs.end('ok'); });
  await new Promise((r) => mock.listen(0, r));
  const port = mock.address().port;
  const s = await startServer(baseSeed(), {
    P1_NOTIFY: `http://localhost:${port}/krauz`,
    P2_NOTIFY: `http://localhost:${port}/boss`,
  });
  try {
    await req(s.base, 'POST', '/api/register', { body: { name: 'B', whatsapp: '41999990000', username: 'bnotif', password: '1234', partner: 'boss' } });
    await new Promise((r) => setTimeout(r, 500)); // notificação é fire-and-forget
    assert.ok(hits.includes('/boss'), 'cadastro do boss notificou /boss');
    assert.ok(!hits.includes('/krauz'), 'não notificou o krauz');
  } finally {
    s.stop();
    mock.close();
  }
});

test('leads: admin cria cliente e edita usuário/senha (isolado por sócio)', async () => {
  const s = await startServer(baseSeed());
  try {
    const kt = await adminLogin(s.base, 'krauz');
    const bt = await adminLogin(s.base, 'boss');
    // krauz cria um cliente já aprovado
    const create = await req(s.base, 'POST', '/api/admin/users', { token: kt, body: { name: 'Lead 1', whatsapp: '5541999990000', username: 'lead1', password: 'senha1' } });
    assert.strictEqual(create.status, 201);
    assert.strictEqual(create.json.status, 'aprovado');
    const id = create.json.id;
    // já loga com as credenciais criadas
    const login = await req(s.base, 'POST', '/api/login', { body: { username: 'lead1', password: 'senha1' } });
    assert.strictEqual(login.status, 200);
    const utoken = login.json.token;
    // boss não vê nem edita o lead do krauz
    assert.ok(!(await req(s.base, 'GET', '/api/admin/users', { token: bt })).json.some((u) => u.id === id), 'boss não vê o lead do krauz');
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: bt, body: { password: 'x123' } })).status, 404);
    // krauz troca o usuário → loga com o novo
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: kt, body: { username: 'lead1novo' } })).status, 200);
    assert.strictEqual((await req(s.base, 'POST', '/api/login', { body: { username: 'lead1novo', password: 'senha1' } })).status, 200);
    // usuário duplicado → 409
    await req(s.base, 'POST', '/api/admin/users', { token: kt, body: { name: 'x', whatsapp: '5541999990000', username: 'outro', password: '1234' } });
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: kt, body: { username: 'outro' } })).status, 409);
    // redefinir senha derruba a sessão antiga e a nova senha funciona
    assert.strictEqual((await req(s.base, 'PUT', `/api/admin/users/${id}`, { token: kt, body: { password: 'novaSenha' } })).status, 200);
    assert.strictEqual((await req(s.base, 'GET', '/api/me', { utoken })).status, 401, 'token antigo derrubado');
    assert.strictEqual((await req(s.base, 'POST', '/api/login', { body: { username: 'lead1novo', password: 'novaSenha' } })).status, 200);
  } finally {
    s.stop();
  }
});

test('configurações do sócio (custos + pushcut) são isoladas por sócio', async () => {
  const s = await startServer(baseSeed());
  try {
    const kt = await adminLogin(s.base, 'krauz');
    const bt = await adminLogin(s.base, 'boss');
    const put = await req(s.base, 'PUT', '/api/admin/settings', { token: kt, body: { notifyUrl: 'https://api.pushcut.io/x/notifications/y', costs: { V55: 3000, V80: 4000 } } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.costs.V55, 3000);
    const getK = (await req(s.base, 'GET', '/api/admin/settings', { token: kt })).json;
    assert.strictEqual(getK.notifyUrl, 'https://api.pushcut.io/x/notifications/y');
    assert.strictEqual(getK.costs.V80, 4000);
    const getB = (await req(s.base, 'GET', '/api/admin/settings', { token: bt })).json;
    assert.deepStrictEqual(getB.costs, {}, 'boss não vê os custos do krauz');
    assert.strictEqual(getB.notifyUrl, '');
    const bad = await req(s.base, 'PUT', '/api/admin/settings', { token: kt, body: { notifyUrl: 'nao-e-url' } });
    assert.strictEqual(bad.status, 400, 'link de notificação inválido → 400');
  } finally {
    s.stop();
  }
});

test('migração: partnerId de sócio desconhecido é reatribuído ao sócio 1 (nada some)', async () => {
  const seed = {
    products: [{ id: 'p1', name: 'V55 – Menta', stock: 40, active: true }],
    users: [{ id: 'ug', username: 'ghost', name: 'Ghost', whatsapp: '5541999990000', status: 'aprovado', prices: {}, partnerId: 'socio_removido', createdAt: '2026-01-01T00:00:00.000Z' }],
    orders: [{ id: 'OG', userId: 'ug', partnerId: 'socio_removido', customer: { name: 'Ghost', phone: '5541', address: 'r' }, items: [{ productId: 'p1', name: 'V55 – Menta', qty: 1, priceCents: 5000 }], totalCents: 5000, status: 'aceito', createdAt: '2026-01-02T00:00:00.000Z' }],
    brandLogos: {}, models: [],
  };
  const s = await startServer(seed);
  try {
    const kt = await adminLogin(s.base, 'krauz');
    const users = (await req(s.base, 'GET', '/api/admin/users', { token: kt })).json;
    const orders = (await req(s.base, 'GET', '/api/admin/orders', { token: kt })).json;
    assert.ok(users.some((u) => u.username === 'ghost'), 'cliente órfão reatribuído ao sócio 1 (não some)');
    assert.ok(orders.some((o) => o.id === 'OG'), 'pedido órfão reatribuído ao sócio 1');
    const bt = await adminLogin(s.base, 'boss');
    assert.ok(!(await req(s.base, 'GET', '/api/admin/users', { token: bt })).json.some((u) => u.username === 'ghost'), 'boss não vê o órfão');
  } finally {
    s.stop();
  }
});
