#!/usr/bin/env bash
# Suíte de regressão completa do Lista de Pods.
# Roda contra schemas isolados (podtest_*) no Postgres — nunca toca no schema public.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "=== Limpando schemas de teste antigos ==="
node scripts/clean-test-schemas.js || true

echo "=== Testes de Parser (node:test) ==="
node --test tests/parser.test.js
parser_status=$?

echo ""
echo "=== Testes de API (node:test) ==="
node --test tests/api.test.js
api_status=$?

echo ""
echo "=== Cenários extremos/hostis (node:test) ==="
node --test tests/scenarios.test.js
scen_status=$?

echo ""
echo "=== Teste de XSS (Playwright) ==="
node tests/xss.playwright.js
xss_status=$?

echo ""
echo "=== Teste de UI ponta-a-ponta (Playwright) ==="
node tests/ui.playwright.js
ui_status=$?

echo ""
if [ $parser_status -eq 0 ] && [ $api_status -eq 0 ] && [ $scen_status -eq 0 ] && [ $xss_status -eq 0 ] && [ $ui_status -eq 0 ]; then
  echo "✔ SUÍTE COMPLETA VERDE"
  exit 0
else
  echo "✖ FALHAS: parser=$parser_status api=$api_status cenarios=$scen_status xss=$xss_status ui=$ui_status"
  exit 1
fi
