// Leitor de listas de estoque no formato:
//   -- MARCA DO POD
//   17 SABOR DO POD
// Linhas sem quantidade no início (avisos, títulos) são ignoradas e mostradas na conferência.
(function (global) {
  function cleanFlavor(raw) {
    let s = String(raw).replace(/\s*[,.]?\s*\/\s*/g, ' / '); // normaliza sabores mistos "a ,/ b" → "a / b"
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[.,]+$/, '').trim();
    s = s.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (m, p1, p2) => p1 + p2.toUpperCase());
    return s;
  }

  function parseStockList(text) {
    const rawItems = [];
    const ignored = [];
    let brand = '';

    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('--')) {
        brand = line.replace(/^-+\s*/, '').replace(/\s+/g, ' ').trim().toUpperCase();
        continue;
      }

      // aceita separador colado ou ausente ("17-Menta", "17Menta"); exige ao menos
      // uma letra no sabor para não confundir número puro ("17999") com produto.
      const m = line.match(/^(\d+)\s*[-–—.]?\s*(.+)$/);
      if (m) {
        const qty = parseInt(m[1], 10);
        const flavor = cleanFlavor(m[2]);
        if (flavor && /\p{L}/u.test(flavor)) {
          rawItems.push({ brand, flavor, qty });
          continue;
        }
      }

      ignored.push(line);
    }

    // agrega duplicados (mesma marca + mesmo sabor somam quantidades);
    // a chave ignora acentos para "Menta" e "Ménta" caírem no mesmo produto.
    const map = new Map();
    for (const it of rawItems) {
      const name = it.brand ? `${it.brand} – ${it.flavor}` : it.flavor;
      const key = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      if (map.has(key)) {
        map.get(key).qty += it.qty;
      } else {
        map.set(key, { name, brand: it.brand || 'SEM MARCA', flavor: it.flavor, qty: it.qty });
      }
    }

    return { items: [...map.values()], ignored };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseStockList };
  } else {
    global.parseStockList = parseStockList;
  }
})(typeof window !== 'undefined' ? window : globalThis);
