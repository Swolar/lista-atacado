// Testes unitários do parser de listas (sem servidor). Asseguram o comportamento
// ALVO (pós-endurecimento B.5): aceita separador ausente, dedupe insensível a acento,
// qty 0 mantida, linhas de aviso ignoradas.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseStockList } = require('../public/parser.js');

const byName = (items, name) => items.find((i) => i.name === name);
const qtyOf = (items, name) => {
  const it = byName(items, name);
  return it ? it.qty : undefined;
};

test('P1 happy path — duas linhas viram dois produtos', () => {
  const { items, ignored } = parseStockList('-- IGNITE\n17 Menta\n5 Melancia');
  assert.strictEqual(items.length, 2);
  assert.strictEqual(qtyOf(items, 'IGNITE – Menta'), 17);
  assert.strictEqual(qtyOf(items, 'IGNITE – Melancia'), 5);
  assert.deepStrictEqual(ignored, []);
});

test('P2 dedupe insensível a acento — Menta + Ménta somam', () => {
  const { items } = parseStockList('-- IGNITE\n17 Menta\n3 Ménta');
  assert.strictEqual(items.length, 1, 'acento deveria agregar no mesmo produto');
  assert.strictEqual(items[0].qty, 20);
});

test('P3 emoji preservado no nome', () => {
  const { items } = parseStockList('-- ELF BAR\n10 Uva 🍇 Ice');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'ELF BAR – Uva 🍇 Ice');
  assert.strictEqual(items[0].qty, 10);
});

test('P4 sabor misto "a , / b" normaliza para "a / b"', () => {
  const { items } = parseStockList('8 Morango , / Kiwi');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].flavor, 'Morango / Kiwi');
  assert.strictEqual(items[0].qty, 8);
});

test('P5 headers de marca sem itens e linhas em branco → nada', () => {
  const { items, ignored } = parseStockList('-- IGNITE\n\n\n-- OXBAR\n');
  assert.deepStrictEqual(items, []);
  assert.deepStrictEqual(ignored, []);
});

test('P6 qty 0 é mantida (produto esgotado)', () => {
  const { items } = parseStockList('0 Uva');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].qty, 0);
});

test('P7 sabores duplicados na mesma marca somam', () => {
  const { items } = parseStockList('-- IGNITE\n5 Menta\n7 Menta');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].qty, 12);
});

test('P8 separador ausente/colado é aceito; número puro é ignorado', () => {
  const cases = ['17-Menta', '17—Menta', '17.Menta', '17Menta'];
  for (const line of cases) {
    const { items } = parseStockList(line);
    assert.strictEqual(items.length, 1, `"${line}" deveria virar 1 item`);
    assert.strictEqual(items[0].qty, 17, `"${line}" qty`);
    assert.match(items[0].flavor, /Menta/i, `"${line}" flavor`);
  }
  const puro = parseStockList('17999');
  assert.deepStrictEqual(puro.items, [], '"17999" (sem letra) deve ser ignorado');
  assert.deepStrictEqual(puro.ignored, ['17999']);

  const soNumero = parseStockList('17');
  assert.deepStrictEqual(soNumero.items, [], '"17" sozinho deve ser ignorado');
});

test('P9 header de marca com e sem espaço', () => {
  const a = parseStockList('--LOSTMARY\n4 Blue');
  assert.strictEqual(a.items[0].name, 'LOSTMARY – Blue');
  const b = parseStockList('-- LOST MARY\n4 Blue');
  assert.strictEqual(b.items[0].name, 'LOST MARY – Blue');
});

test('P10 linha de aviso sem quantidade → ignorada', () => {
  const { items, ignored } = parseStockList('Chegou mercadoria nova!');
  assert.deepStrictEqual(items, []);
  assert.deepStrictEqual(ignored, ['Chegou mercadoria nova!']);
});

test('P11 bloco realista completo', () => {
  const list = [
    '-- IGNITE V55',
    'Promoção da semana',
    '17 Pineaple',
    '17 Pineaple',
    '10 Uva 🍇 Ice',
    '8 Morango , / Kiwi',
    '0 Esgotado Teste',
    '5-Menta',
    '',
    '-- NIK N8000',
    '30 Sakura Grape',
    'AVISO: somente atacado',
  ].join('\n');
  const { items, ignored } = parseStockList(list);

  assert.strictEqual(qtyOf(items, 'IGNITE V55 – Pineaple'), 34, 'duplicata soma 17+17');
  assert.strictEqual(qtyOf(items, 'IGNITE V55 – Uva 🍇 Ice'), 10);
  assert.strictEqual(qtyOf(items, 'IGNITE V55 – Morango / Kiwi'), 8);
  assert.strictEqual(qtyOf(items, 'IGNITE V55 – Esgotado Teste'), 0);
  assert.strictEqual(qtyOf(items, 'IGNITE V55 – Menta'), 5, 'separador colado 5-Menta');
  assert.strictEqual(qtyOf(items, 'NIK N8000 – Sakura Grape'), 30);
  assert.deepStrictEqual(ignored, ['Promoção da semana', 'AVISO: somente atacado']);
});
