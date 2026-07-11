// Seeds com ids estáveis para os testes de API. Nomes escolhidos para que
// modelOf/brandOf do server se comportem de forma previsível:
//   'V55 – Menta'     → modelo V55  → marca IGNITE (preço por modelo 'V55')
//   'V80 – Melancia'  → modelo V80  → marca IGNITE
//   'NIK N8000 – Uva' → modelo 'NIK N8000' → marca NIK
function baseSeed() {
  return {
    products: [
      { id: 'p1', name: 'V55 – Menta', stock: 40, active: true },
      { id: 'p2', name: 'V80 – Melancia', stock: 30, active: true },
      { id: 'p3', name: 'NIK N8000 – Uva', stock: 15, active: true },
    ],
    orders: [],
    users: [],
    brandLogos: {},
  };
}

function singleProductSeed(stock) {
  return {
    products: [{ id: 'x1', name: 'V55 – Unico', stock, active: true }],
    orders: [],
    users: [],
    brandLogos: {},
  };
}

module.exports = { baseSeed, singleProductSeed };
