/**
 * test-vendor-filter.js
 * Testes simulados da lógica de filtro de vendedor do GWeb Tools
 * Executa com: node test-vendor-filter.js
 */

'use strict';

// ─── Cores para output ───────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

let passed = 0;
let failed = 0;
const failures = [];

function assert(description, condition, detail = '') {
  if (condition) {
    console.log(`  ${C.green}✔${C.reset} ${description}`);
    passed++;
  } else {
    console.log(`  ${C.red}✘${C.reset} ${C.red}${description}${C.reset}`);
    if (detail) console.log(`    ${C.dim}→ ${detail}${C.reset}`);
    failed++;
    failures.push({ description, detail });
  }
}

function section(title) {
  console.log(`\n${C.bold}${C.cyan}▶ ${title}${C.reset}`);
}

// ─── Funções copiadas/simuladas do comissao-content.js ──────────────────────

// Estado global simulado
let appState = {
  dateFrom: '',
  dateTo: '',
  vendorFilter: '',
};

function parseDate(str) {
  if (!str) return null;
  const m = str.trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
}

function isDataConclusaoNoPeriodo(dataConclusaoStr) {
  if (!dataConclusaoStr) return false;
  const dc = parseDate(dataConclusaoStr);
  if (!dc) return false;
  if (appState.dateFrom) {
    const from = new Date(appState.dateFrom + 'T00:00:00');
    if (dc < from) return false;
  }
  if (appState.dateTo) {
    const to = new Date(appState.dateTo + 'T23:59:59');
    if (dc > to) return false;
  }
  return true;
}

function matchesVendorFilter(vendedor) {
  if (!appState.vendorFilter) return true;
  if (!vendedor) return false;
  function normalize(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }
  return normalize(vendedor).indexOf(normalize(appState.vendorFilter)) !== -1;
}

// Simula a decisão final sobre um pedido (combina data + vendedor)
function shouldIncludeOrder(order) {
  if (!isDataConclusaoNoPeriodo(order.dataConclusao)) return { include: false, reason: 'FORA_PERIODO' };
  if (!matchesVendorFilter(order.vendedor))            return { include: false, reason: 'FILTRADO_VENDEDOR' };
  return { include: true, reason: 'INCLUIDO' };
}

// Simula o envio do START do popup para o content script
function simulatePopupStart({ dateFrom, dateTo, vendorInput }) {
  const msg = {
    action: 'START',
    dateFrom,
    dateTo,
    vendorFilter: (vendorInput || '').trim(),
  };
  // Simula o que o content script faz ao receber START:
  appState.dateFrom    = msg.dateFrom;
  appState.dateTo      = msg.dateTo;
  appState.vendorFilter = msg.vendorFilter;
  return msg;
}

// ─── Dataset de pedidos simulados ────────────────────────────────────────────
const PEDIDOS = [
  { numeroPedido: '1.001', dataConclusao: '15/06/2026', vendedor: 'João Silva',    valorTotal: 1500 },
  { numeroPedido: '1.002', dataConclusao: '20/06/2026', vendedor: 'Maria Souza',   valorTotal: 800  },
  { numeroPedido: '1.003', dataConclusao: '25/06/2026', vendedor: 'João Silva',    valorTotal: 2200 },
  { numeroPedido: '1.004', dataConclusao: '01/06/2026', vendedor: 'Carlos Lima',   valorTotal: 500  },
  { numeroPedido: '1.005', dataConclusao: '10/06/2026', vendedor: 'joao silva',    valorTotal: 300  }, // nome em minúsculo
  { numeroPedido: '1.006', dataConclusao: '31/05/2026', vendedor: 'João Silva',    valorTotal: 900  }, // fora do período
  { numeroPedido: '1.007', dataConclusao: '30/06/2026', vendedor: '',              valorTotal: 400  }, // sem vendedor
  { numeroPedido: '1.008', dataConclusao: '',           vendedor: 'Maria Souza',   valorTotal: 1200 }, // sem data
  { numeroPedido: '1.009', dataConclusao: '18/06/2026', vendedor: 'João Silveira', valorTotal: 600  }, // nome parecido
  { numeroPedido: '1.010', dataConclusao: '22/06/2026', vendedor: 'CARLOS LIMA',  valorTotal: 700  }, // uppercase
];

// ─── SUITE DE TESTES ─────────────────────────────────────────────────────────

// ── SUITE 1: matchesVendorFilter ─────────────────────────────────────────────
section('SUITE 1 — matchesVendorFilter (comparação case-insensitive e parcial)');

appState.vendorFilter = '';
assert('Sem filtro → aceita qualquer vendedor',  matchesVendorFilter('João Silva'));
assert('Sem filtro → aceita string vazia',       matchesVendorFilter(''));
assert('Sem filtro → aceita undefined',          matchesVendorFilter(undefined));

appState.vendorFilter = 'João';
assert('Filtro "João" → aceita "João Silva"',    matchesVendorFilter('João Silva'));
assert('Filtro "João" → aceita "joão silva" (case-insensitive)', matchesVendorFilter('joão silva'));
assert('Filtro "João" → aceita "João Silveira"', matchesVendorFilter('João Silveira'));
assert('Filtro "João" → rejeita "Maria Souza"',  !matchesVendorFilter('Maria Souza'));
assert('Filtro "João" → rejeita "" (sem vendedor)', !matchesVendorFilter(''));
assert('Filtro "João" → rejeita null',           !matchesVendorFilter(null));

appState.vendorFilter = 'JOÃO';
assert('Filtro "JOÃO" maiúsculo → aceita "João Silva"', matchesVendorFilter('João Silva'));
assert('Filtro "JOÃO" maiúsculo → aceita "joao silva" parcial', matchesVendorFilter('joao silva'));

appState.vendorFilter = 'silva';
assert('Filtro "silva" minúsculo → aceita "João Silva"',    matchesVendorFilter('João Silva'));
assert('Filtro "silva" minúsculo → REJEITA "João Silveira" ("silveira" não contém "silva")',
  !matchesVendorFilter('João Silveira'),
  '"silva" não é substring de "silveira" — correto rejeitar'
);
assert('Filtro "silv" minúsculo → aceita "João Silveira" (match parcial correto)', (() => {
  appState.vendorFilter = 'silv';
  const r = matchesVendorFilter('João Silveira');
  appState.vendorFilter = 'silva';
  return r;
})());
assert('Filtro "silva" minúsculo → rejeita "Carlos Lima"',  !matchesVendorFilter('Carlos Lima'));

appState.vendorFilter = 'carlos';
assert('Filtro "carlos" → aceita "Carlos Lima"',  matchesVendorFilter('Carlos Lima'));
assert('Filtro "carlos" → aceita "CARLOS LIMA"',  matchesVendorFilter('CARLOS LIMA'));
assert('Filtro "carlos" → rejeita "João Silva"',  !matchesVendorFilter('João Silva'));

// ── SUITE 2: isDataConclusaoNoPeriodo ────────────────────────────────────────
section('SUITE 2 — isDataConclusaoNoPeriodo (filtro por data)');

appState.vendorFilter = '';
appState.dateFrom = '2026-06-01';
appState.dateTo   = '2026-06-30';

assert('01/06/2026 → DENTRO do período',  isDataConclusaoNoPeriodo('01/06/2026'));
assert('30/06/2026 → DENTRO do período',  isDataConclusaoNoPeriodo('30/06/2026'));
assert('15/06/2026 → DENTRO do período',  isDataConclusaoNoPeriodo('15/06/2026'));
assert('31/05/2026 → FORA do período',    !isDataConclusaoNoPeriodo('31/05/2026'));
assert('01/07/2026 → FORA do período',    !isDataConclusaoNoPeriodo('01/07/2026'));
assert('string vazia → FORA',            !isDataConclusaoNoPeriodo(''));
assert('null → FORA',                    !isDataConclusaoNoPeriodo(null));

// ── SUITE 3: Integração — shouldIncludeOrder ──────────────────────────────────
section('SUITE 3 — Integração (data + vendedor combinados)');

// Sem filtro de vendedor
appState.dateFrom     = '2026-06-01';
appState.dateTo       = '2026-06-30';
appState.vendorFilter = '';

{
  const r = shouldIncludeOrder(PEDIDOS[0]); // João Silva, 15/06
  assert('Pedido 1.001 (João, 15/06, sem filtro) → INCLUIDO', r.include && r.reason === 'INCLUIDO');
}
{
  const r = shouldIncludeOrder(PEDIDOS[5]); // João Silva, 31/05 (fora)
  assert('Pedido 1.006 (João, 31/05, sem filtro) → FORA_PERIODO', !r.include && r.reason === 'FORA_PERIODO');
}
{
  const r = shouldIncludeOrder(PEDIDOS[7]); // sem data
  assert('Pedido 1.008 (sem data, sem filtro) → FORA_PERIODO',  !r.include && r.reason === 'FORA_PERIODO');
}

// Com filtro de vendedor "João"
appState.vendorFilter = 'João';
{
  const r = shouldIncludeOrder(PEDIDOS[0]); // João Silva, 15/06
  assert('Pedido 1.001 (João Silva, 15/06, filtro="João") → INCLUIDO', r.include);
}
{
  const r = shouldIncludeOrder(PEDIDOS[1]); // Maria Souza, 20/06
  assert('Pedido 1.002 (Maria Souza, 20/06, filtro="João") → FILTRADO_VENDEDOR', !r.include && r.reason === 'FILTRADO_VENDEDOR');
}
{
  const r = shouldIncludeOrder(PEDIDOS[4]); // "joao silva" minúsculo, 10/06
  assert('Pedido 1.005 (joao silva lower, filtro="João") → INCLUIDO (case-insensitive)', r.include);
}
{
  const r = shouldIncludeOrder(PEDIDOS[5]); // João Silva, 31/05 (fora do período)
  assert('Pedido 1.006 (João, 31/05, filtro="João") → FORA_PERIODO (data tem prioridade)', !r.include && r.reason === 'FORA_PERIODO');
}
{
  const r = shouldIncludeOrder(PEDIDOS[6]); // sem vendedor, 30/06
  assert('Pedido 1.007 (sem vendedor, filtro="João") → FILTRADO_VENDEDOR', !r.include && r.reason === 'FILTRADO_VENDEDOR');
}
{
  const r = shouldIncludeOrder(PEDIDOS[8]); // João Silveira, 18/06
  assert('Pedido 1.009 (João Silveira, filtro="João") → INCLUIDO (match parcial)', r.include);
}

// ── SUITE 4: Simulação completa do pipeline ───────────────────────────────────
section('SUITE 4 — Pipeline completo (simula START popup → content script → resultado)');

function runPipeline(dateFrom, dateTo, vendorInput, pedidos) {
  simulatePopupStart({ dateFrom, dateTo, vendorInput });
  const included   = [];
  const filtered   = [];
  const outOfRange = [];
  const noDate     = [];

  pedidos.forEach(p => {
    if (!p.dataConclusao) { noDate.push(p); return; }
    const r = shouldIncludeOrder(p);
    if      (r.reason === 'INCLUIDO')          included.push(p);
    else if (r.reason === 'FILTRADO_VENDEDOR') filtered.push(p);
    else                                        outOfRange.push(p);
  });

  return { included, filtered, outOfRange, noDate };
}

// Cenário A: sem filtro de vendedor
{
  const result = runPipeline('2026-06-01', '2026-06-30', '', PEDIDOS);
  // Dataset: 10 pedidos. Fora do período: 1.006 (31/05). Sem data: 1.008.
  // Dentro do período: 1.001,1.002,1.003,1.004,1.005,1.007,1.009,1.010 = 8
  assert('Cenário A (sem filtro): 8 pedidos incluídos no período',
    result.included.length === 8,
    `Encontrou: ${result.included.length} → [${result.included.map(p=>p.numeroPedido).join(', ')}]`
  );
  assert('Cenário A (sem filtro): 1 pedido fora do período (31/05)',
    result.outOfRange.length === 1,
    `Fora: [${result.outOfRange.map(p=>p.numeroPedido).join(', ')}]`
  );
  assert('Cenário A (sem filtro): 1 pedido sem data',
    result.noDate.length === 1,
    `Sem data: [${result.noDate.map(p=>p.numeroPedido).join(', ')}]`
  );
  assert('Cenário A (sem filtro): 0 filtrados por vendedor',
    result.filtered.length === 0
  );
}

// Cenário B: filtro = "João"
{
  const result = runPipeline('2026-06-01', '2026-06-30', 'João', PEDIDOS);
  const includedNums = result.included.map(p => p.numeroPedido).sort();
  // João Silva (1.001, 1.003), joao silva lower (1.005), João Silveira (1.009) = 4
  assert('Cenário B (filtro="João"): 4 pedidos incluídos (1.001, 1.003, 1.005, 1.009)',
    result.included.length === 4,
    `Encontrou: ${result.included.length} → [${includedNums.join(', ')}]`
  );
  assert('Cenário B (filtro="João"): 1.001 incluído (João Silva)',
    result.included.some(p => p.numeroPedido === '1.001')
  );
  assert('Cenário B (filtro="João"): 1.003 incluído (João Silva, 25/06)',
    result.included.some(p => p.numeroPedido === '1.003')
  );
  assert('Cenário B (filtro="João"): 1.005 incluído (joao silva lower)',
    result.included.some(p => p.numeroPedido === '1.005')
  );
  assert('Cenário B (filtro="João"): 1.009 incluído (João Silveira)',
    result.included.some(p => p.numeroPedido === '1.009')
  );
  assert('Cenário B (filtro="João"): 1.002 (Maria) filtrado por vendedor',
    result.filtered.some(p => p.numeroPedido === '1.002')
  );
  assert('Cenário B (filtro="João"): 1.004 (Carlos) filtrado por vendedor',
    result.filtered.some(p => p.numeroPedido === '1.004')
  );
  assert('Cenário B (filtro="João"): 1.007 (sem vendedor) filtrado por vendedor',
    result.filtered.some(p => p.numeroPedido === '1.007')
  );
  assert('Cenário B (filtro="João"): 1.006 (João, 31/05) fora do período — não filtrado por vendedor',
    result.outOfRange.some(p => p.numeroPedido === '1.006')
  );
}

// Cenário C: filtro = "carlos" (minúsculo)
{
  const result = runPipeline('2026-06-01', '2026-06-30', 'carlos', PEDIDOS);
  assert('Cenário C (filtro="carlos"): 1.004 (Carlos Lima) incluído',
    result.included.some(p => p.numeroPedido === '1.004')
  );
  assert('Cenário C (filtro="carlos"): 1.010 (CARLOS LIMA upper) incluído',
    result.included.some(p => p.numeroPedido === '1.010')
  );
  assert('Cenário C (filtro="carlos"): 1.001 (João) filtrado',
    result.filtered.some(p => p.numeroPedido === '1.001')
  );
}

// Cenário D: filtro sem resultado nenhum
{
  const result = runPipeline('2026-06-01', '2026-06-30', 'Vendedor Inexistente', PEDIDOS);
  assert('Cenário D (filtro inexistente): 0 pedidos incluídos', result.included.length === 0);
  // Dos 8 no período: todos têm vendedor que não bate (inclusive 1.007 que não tem vendedor) = 8
  assert('Cenário D (filtro inexistente): todos os 8 do período são filtrados por vendedor',
    result.filtered.length === 8,
    `Filtrados: ${result.filtered.length}`
  );
}

// Cenário E: popup salva e restaura o vendorFilter
section('SUITE 5 — Comunicação popup → content (mensagem START)');
{
  const msg = simulatePopupStart({ dateFrom: '2026-06-01', dateTo: '2026-06-30', vendorInput: '  João Silva  ' });
  assert('Trim no vendorFilter: espaços removidos',
    msg.vendorFilter === 'João Silva',
    `Recebido: "${msg.vendorFilter}"`
  );
  assert('appState.vendorFilter atualizado corretamente',
    appState.vendorFilter === 'João Silva'
  );
}
{
  const msg = simulatePopupStart({ dateFrom: '2026-06-01', dateTo: '2026-06-30', vendorInput: '' });
  assert('vendorFilter vazio quando campo não preenchido',
    msg.vendorFilter === '' && appState.vendorFilter === ''
  );
}
{
  const msg = simulatePopupStart({ dateFrom: '2026-06-01', dateTo: '2026-06-30', vendorInput: undefined });
  assert('vendorFilter vazio quando campo undefined',
    msg.vendorFilter === '' && appState.vendorFilter === ''
  );
}

// ── SUITE 6: Deduplicação e ordenação ─────────────────────────────────────────
section('SUITE 6 — Deduplicação e ordenação de vendedores');

function deduplicateAndSort(names) {
  var seen = {};
  var unique = [];
  names.forEach(function (n) {
    var key = n.toLowerCase();
    if (!seen[key]) { seen[key] = true; unique.push(n); }
  });
  return unique.sort(function (a, b) { return a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }); });
}

{
  const rawList = ['João Silva', 'joão silva', 'Maria Souza', 'Carlos Lima', 'carlos lima'];
  const processed = deduplicateAndSort(rawList);
  assert('Remove duplicatas case-insensitive', processed.length === 3);
  assert('Ordena alfabeticamente (pt-BR)', 
    processed[0] === 'Carlos Lima' && 
    processed[1] === 'João Silva' && 
    processed[2] === 'Maria Souza',
    `Resultado real: [${processed.join(', ')}]`
  );
}

// ─── RESULTADO FINAL ──────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(55));
const total = passed + failed;
if (failed === 0) {
  console.log(`${C.bold}${C.green}✔ TODOS OS TESTES PASSARAM (${passed}/${total})${C.reset}`);
} else {
  console.log(`${C.bold}${C.red}✘ ${failed} FALHA(S) de ${total} testes${C.reset}`);
  console.log(`\n${C.red}Falhas:${C.reset}`);
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.description}`);
    if (f.detail) console.log(`     ${C.dim}${f.detail}${C.reset}`);
  });
}
console.log('─'.repeat(55));
process.exit(failed > 0 ? 1 : 0);
