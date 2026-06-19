/**
 * report.js - Funcoes de geracao do HTML do relatorio
 * GWeb Comissoes
 *
 * Metricas:
 *   - Agrupamento por data de conclusao
 *   - Agrupamento por vendedor
 *   - Total vendido, total comissionado, ticket medio
 *   - Alertas de validacao
 *   - Trilha de auditoria
 *
 * Expoe o objeto global ReportGenerator
 */

var ReportGenerator = (function () {
  'use strict';

  // --- Helpers ---

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBRL(value) {
    var num = parseFloat(value) || 0;
    return 'R$\u00a0' + num.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatDate(str) {
    if (!str) return '\u2014';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str;
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      var d = new Date(str + 'T00:00:00');
      return d.toLocaleDateString('pt-BR');
    }
    return str;
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
  }

  function statusClass(status) {
    if (!status) return '';
    var s = status.toLowerCase();
    if (s.indexOf('conclu') !== -1 || s.indexOf('finaliz') !== -1) return 'concluido';
    if (s.indexOf('cancel') !== -1) return 'cancelado';
    return 'pendente';
  }

  function parseDate2(str) {
    if (!str) return null;
    var m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return new Date(str);
  }

  /** Agrupa pedidos por data de conclusao */
  function groupByDate(data) {
    var groups = {};
    data.forEach(function (order) {
      var key = order.dataConclusao || 'Sem data';
      if (!groups[key]) groups[key] = [];
      groups[key].push(order);
    });

    var sorted = Object.keys(groups).sort(function (a, b) {
      if (a === 'Sem data') return 1;
      if (b === 'Sem data') return -1;
      var da = parseDate2(a);
      var db = parseDate2(b);
      if (!da || !db) return 0;
      return da - db;
    });

    return sorted.map(function (key) { return { date: key, orders: groups[key] }; });
  }

  /** Agrupa pedidos por vendedor */
  function groupByVendedor(data) {
    var groups = {};
    data.forEach(function (order) {
      var key = order.vendedor || 'Sem vendedor';
      if (!groups[key]) groups[key] = [];
      groups[key].push(order);
    });

    return Object.keys(groups).sort().map(function (key) {
      return { vendedor: key, orders: groups[key] };
    });
  }

  // =====================================================================
  // GERACAO DO HTML DO RELATORIO
  // =====================================================================

  function generate(data, dateFrom, dateTo, generatedAt, extras) {
    extras = extras || {};
    // Remove cancelados antes de qualquer calculo
    data = data.filter(function (o) {
      return !(o.status && o.status.toLowerCase().indexOf('cancel') !== -1);
    });
    var stats = extras.stats || {};
    var audit = extras.audit || [];
    var discarded = extras.discarded || [];
    var reportAlerts = extras.alerts || [];

    var totalOrders = data.length;
    var totalItems = data.reduce(function (s, o) { return s + (o.itens ? o.itens.length : 0); }, 0);
    var totalValue = data.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
    var totalDiscount = data.reduce(function (s, o) { return s + (parseFloat(o.valorDesconto) || 0); }, 0);
    var totalFreight = data.reduce(function (s, o) { return s + (parseFloat(o.valorFrete) || 0); }, 0);
    var totalComissao = data.reduce(function (s, o) { return s + (parseFloat(o.comissao) || 0); }, 0);
    var ticketMedio = totalOrders > 0 ? totalValue / totalOrders : 0;

    var dateGroups = groupByDate(data);
    var vendedorGroups = groupByVendedor(data);
    var uniqueDates = dateGroups.map(function (g) { return g.date; });
    var uniqueVendedores = vendedorGroups.map(function (g) { return g.vendedor; });

    var html = '';

    // ========================= HEADER =========================
    html += '<div class="report-header">';
    html += '<h1>GWeb Comiss\u00f5es</h1>';
    html += '<p>Relat\u00f3rio de Pedidos \u2014 Comiss\u00e3o por data de conclus\u00e3o</p>';
    html += '<div class="meta">';
    html += '<span>Per\u00edodo: ' + escapeHtml(formatDate(dateFrom)) + ' a ' + escapeHtml(formatDate(dateTo)) + '</span>';
    html += '<span>Gerado em: ' + escapeHtml(formatDateTime(generatedAt)) + '</span>';
    html += '<span>' + totalOrders + ' pedidos</span>';
    if (stats.totalRowsSeen) {
      html += '<span>' + stats.totalRowsSeen + ' linhas analisadas</span>';
    }
    html += '</div></div>';

    // ========================= ACTIONS BAR =========================
    html += '<div class="actions-bar">';
    html += '<button class="act-btn" id="btnCopyAll">\ud83d\udccb Copiar Tudo</button>';
    html += '<button class="act-btn" id="btnPrint">\ud83d\udda8\ufe0f Imprimir</button>';
    html += '<button class="act-btn primary" id="btnCsv">\ud83d\udce5 Exportar CSV</button>';
    html += '<select class="filter-select" id="filterGlobal">';
    html += '<option value="all">Todas as datas</option>';
    uniqueDates.forEach(function (d) {
      html += '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>';
    });
    html += '</select></div>';

    // ========================= SUMMARY CARDS =========================
    html += '<div class="summary-cards">';

    html += cardHtml('Total de Pedidos', totalOrders, 'info');
    html += cardHtml('Total de Itens', totalItems, '');
    html += cardHtml('Valor Total', formatBRL(totalValue), 'money');
    html += cardHtml('Ticket M\u00e9dio', formatBRL(ticketMedio), 'money');

    if (reportAlerts.length > 0) {
      html += cardHtml('Alertas', reportAlerts.length, 'alert');
    }

    html += '</div>';

    // ========================= CONTENT =========================
    html += '<div class="report-content">';

    // --- ALERTAS DE VALIDACAO ---
    if (reportAlerts.length > 0) {
      html += '<div class="alerts-section" style="margin-top:24px">';
      html += '<h2 style="font-size:18px;margin-bottom:12px;color:#c73650">\u26a0\ufe0f Alertas de Valida\u00e7\u00e3o (' + reportAlerts.length + ')</h2>';
      html += '<div style="background:#fff5f5;border:1px solid #fecaca;border-radius:8px;padding:16px">';
      reportAlerts.forEach(function (a) {
        var icon = a.level === 'warn' ? '\u26a0\ufe0f' : '\u274c';
        html += '<div style="padding:4px 0;font-size:13px;color:#991b1b">' + icon + ' ' + escapeHtml(a.text || a.msg || a) + '</div>';
      });
      html += '</div></div>';
    }

    // --- AGRUPAMENTO POR DATA DE CONCLUSAO ---
    html += '<h2 style="font-size:20px;margin-top:32px;margin-bottom:4px">Pedidos por Data de Conclus\u00e3o</h2>';
    html += '<p style="color:#888;font-size:13px;margin-bottom:16px">Somente pedidos CONCLU\u00cdDOS com data de conclus\u00e3o no per\u00edodo</p>';

    dateGroups.forEach(function (group, gi) {
      var groupTotal = group.orders.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
      var groupItems = group.orders.reduce(function (s, o) { return s + (o.itens ? o.itens.length : 0); }, 0);
      var groupComissao = group.orders.reduce(function (s, o) { return s + (parseFloat(o.comissao) || 0); }, 0);

      var dgId = 'dategroup_' + gi;
      html += '<div class="date-group" data-date="' + escapeHtml(group.date) + '">';
      html += '<div class="date-group-header" style="cursor:pointer">';
      html += '<span>\ud83d\udcc5 ' + escapeHtml(group.date) + '</span>';
      html += '<span class="group-stats">' + group.orders.length + ' pedidos \u00b7 ' + groupItems + ' itens \u00b7 ' + formatBRL(groupTotal);
      if (groupComissao > 0) html += ' \u00b7 Comiss\u00e3o: ' + formatBRL(groupComissao);
      html += ' <button class="expand-btn date-toggle" data-target="' + dgId + '" data-count="' + group.orders.length + '">\u25bc Abrir (' + group.orders.length + ')</button>';
      html += '</span></div>';
      html += '<div class="date-group-body" id="' + dgId + '" style="display:none">';

      html += '<table class="order-table"><thead><tr>';
      html += '<th>N\u00ba Pedido</th><th>Data Emiss\u00e3o</th><th>Data Conclus\u00e3o</th>';
      html += '<th>Vendedor</th><th>Finalizado por</th><th>Cliente</th>';
      html += '<th style="text-align:right">Total</th><th>Forma Pagamento</th>';
      html += '<th>Status</th><th>Fonte</th><th>Itens</th>';
      html += '</tr></thead><tbody>';

      group.orders.forEach(function (order, oi) {
        var itemsId = 'items_' + gi + '_' + oi;
        var hasItems = order.itens && order.itens.length > 0;
        var hasAlerts = order._alerts && order._alerts.length > 0;
        var sourceLabel = order._source === 'cache' ? '\ud83d\udce6 Cache' : '\ud83c\udf10 P\u00e1gina';

        html += '<tr' + (hasAlerts ? ' style="background:#fff5f5"' : '') + '>';
        html += '<td><strong>' + escapeHtml(order.numeroPedido || order._idLista || order.id) + '</strong>';
        if (hasAlerts) html += ' <span style="color:#c73650" title="Este pedido tem alertas">\u26a0\ufe0f</span>';
        html += '</td>';
        html += '<td>' + escapeHtml(formatDate(order.dataEmissao)) + '</td>';
        html += '<td>' + escapeHtml(formatDate(order.dataConclusao)) + '</td>';
        html += '<td>' + escapeHtml(order.vendedor || '\u2014') + '</td>';
        html += '<td>' + escapeHtml(order.alteradoPor || '\u2014') + '</td>';
        html += '<td>' + escapeHtml(order.cliente);
        if (order.clienteCpfCnpj) html += '<br><small style="color:#888">' + escapeHtml(order.clienteCpfCnpj) + '</small>';
        html += '</td>';
        html += '<td class="money"><strong>' + formatBRL(order.valorTotal) + '</strong></td>';
        html += '<td>' + escapeHtml(order.formaPagamento || '\u2014') + '</td>';
        html += '<td><span class="status-badge ' + statusClass(order.status) + '">' + escapeHtml(order.status) + '</span></td>';
        html += '<td style="font-size:11px;color:#888">' + sourceLabel + '</td>';
        html += '<td>' + (hasItems ? '<button class="expand-btn" data-target="' + itemsId + '">\u25bc Itens (' + order.itens.length + ')</button>' : '\u2014') + '</td>';
        html += '</tr>';

        if (hasItems) {
          html += '<tr class="items-row" id="' + itemsId + '"><td colspan="11" style="padding:0 14px 14px">';
          html += '<table class="items-subtable"><thead><tr>';
          html += '<th>C\u00f3digo</th><th>Descri\u00e7\u00e3o</th><th style="text-align:right">Qtd</th>';
          html += '<th>Un.</th><th style="text-align:right">Vlr Unit.</th>';
          html += '<th style="text-align:right">Desconto</th><th style="text-align:right">Total</th>';
          html += '</tr></thead><tbody>';

          order.itens.forEach(function (item) {
            html += '<tr>';
            html += '<td>' + escapeHtml(item.codigo) + '</td>';
            html += '<td>' + escapeHtml(item.descricao) + '</td>';
            html += '<td style="text-align:right;font-family:IBM Plex Mono,monospace">' + String(item.quantidade || 0).replace('.', ',') + '</td>';
            html += '<td>' + escapeHtml(item.unidade) + '</td>';
            html += '<td class="money">' + formatBRL(item.valorUnitario) + '</td>';
            html += '<td class="money">' + formatBRL(item.desconto) + '</td>';
            html += '<td class="money"><strong>' + formatBRL(item.valorTotal) + '</strong></td>';
            html += '</tr>';
          });

          html += '</tbody></table></td></tr>';
        }
      });

      html += '</tbody></table></div></div>';
    });

    // --- RESUMO POR VENDEDOR (comissao) ---
    html += generateVendedorSummary(data, vendedorGroups);

    // --- RESUMO POR DATA ---
    html += generateDateSummary(data, dateGroups);

    // --- TRILHA DE AUDITORIA ---
    if (audit.length > 0) {
      html += generateAuditTrail(audit);
    }

    html += '</div>'; // .report-content
    return html;
  }

  function cardHtml(label, value, cls) {
    return '<div class="scard"><div class="scard-label">' + escapeHtml(label) + '</div>' +
      '<div class="scard-value' + (cls ? ' ' + cls : '') + '">' + escapeHtml(String(value)) + '</div></div>';
  }

  // ========================= RESUMO POR VENDEDOR =========================

  function generateVendedorSummary(data, groups) {
    var html = '<div class="global-summary" style="margin-top:40px">';
    html += '<h2 style="font-size:18px;margin-bottom:20px">\ud83d\udc64 Resumo por Vendedor</h2>';

    var grandTotal = 0;
    var grandOrders = 0;

    groups.forEach(function (group, gi) {
      var qty = group.orders.length;
      var total = group.orders.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
      var ticket = qty > 0 ? total / qty : 0;
      var vendorId = 'vendor_orders_' + gi;

      grandTotal += total;
      grandOrders += qty;

      html += '<div class="vendor-card">';
      html += '<div class="vendor-card-header">';
      html += '<div class="vendor-card-name">\ud83d\udc64 ' + escapeHtml(group.vendedor) + '</div>';
      html += '<div class="vendor-card-stats">';
      html += '<span>' + qty + ' pedido' + (qty !== 1 ? 's' : '') + '</span>';
      html += '<span>Ticket m\u00e9dio: <strong>' + formatBRL(ticket) + '</strong></span>';
      html += '<span class="vendor-card-total">Total: ' + formatBRL(total) + '</span>';
      html += '<button class="expand-btn" data-target="' + vendorId + '" data-count="' + qty + '">\u25bc Pedidos (' + qty + ')</button>';
      html += '</div></div>';

      html += '<div id="' + vendorId + '" data-type="vendor-orders" class="vendor-orders-table" style="display:none">';
      html += '<table><thead><tr>';
      html += '<th>N\u00ba Pedido</th><th class="col-date">Data Emiss\u00e3o</th>';
      html += '<th class="col-date">Data Conclus\u00e3o</th><th>Finalizado por</th><th>Cliente</th>';
      html += '<th>Forma Pgto</th><th class="col-total">Total</th>';
      html += '</tr></thead><tbody>';

      var sortedOrders = group.orders.slice().sort(function (a, b) {
        var da = parseDate2(a.dataConclusao);
        var db = parseDate2(b.dataConclusao);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
      });

      sortedOrders.forEach(function (order, oi) {
        html += '<tr class="' + (oi % 2 === 0 ? 'row-even' : 'row-odd') + '">';
        html += '<td><strong>' + escapeHtml(order.numeroPedido || order._idLista || order.id || '\u2014') + '</strong></td>';
        html += '<td class="col-date">' + escapeHtml(formatDate(order.dataEmissao)) + '</td>';
        html += '<td class="col-date">' + escapeHtml(formatDate(order.dataConclusao)) + '</td>';
        html += '<td>' + escapeHtml(order.alteradoPor || '\u2014') + '</td>';
        html += '<td>' + escapeHtml(order.cliente || '\u2014');
        if (order.clienteCpfCnpj) html += '<br><small style="color:#9ca3af">' + escapeHtml(order.clienteCpfCnpj) + '</small>';
        html += '</td>';
        html += '<td class="col-payment">' + escapeHtml(order.formaPagamento || '\u2014') + '</td>';
        html += '<td class="col-total">' + formatBRL(order.valorTotal) + '</td>';
        html += '</tr>';
      });

      html += '<tr class="row-subtotal"><td colspan="6">Total ' + escapeHtml(group.vendedor) + '</td>';
      html += '<td class="col-total">' + formatBRL(total) + '</td></tr>';
      html += '</tbody></table></div></div>';
    });

    var grandTicket = grandOrders > 0 ? grandTotal / grandOrders : 0;
    html += '<div class="vendor-grand-total">';
    html += '<strong>TOTAL GERAL</strong>';
    html += '<div class="vendor-grand-total-stats">';
    html += '<span>' + grandOrders + ' pedidos</span>';
    html += '<span>Ticket m\u00e9dio: ' + formatBRL(grandTicket) + '</span>';
    html += '<span class="vendor-grand-total-value">' + formatBRL(grandTotal) + '</span>';
    html += '</div></div>';

    html += '</div>';
    return html;
  }

  // ========================= RESUMO POR DATA =========================

  function generateDateSummary(data, groups) {
    var html = '<div class="global-summary" style="margin-top:24px">';
    html += '<h2 style="font-size:18px;margin-bottom:16px">\ud83d\udcc5 Resumo por Data de Conclus\u00e3o</h2>';
    html += '<table><thead><tr>';
    html += '<th>Data</th><th style="text-align:right">Pedidos</th><th style="text-align:right">Itens</th>';
    html += '<th style="text-align:right">Subtotal</th><th style="text-align:right">Descontos</th>';
    html += '<th style="text-align:right">Ticket M\u00e9dio</th><th style="text-align:right">Total</th>';
    html += '</tr></thead><tbody>';

    var grandTotal = 0, grandItems = 0, grandSubtotal = 0, grandDiscount = 0;

    groups.forEach(function (group) {
      var qty = group.orders.length;
      var items = group.orders.reduce(function (s, o) { return s + (o.itens ? o.itens.length : 0); }, 0);
      var subtotal = group.orders.reduce(function (s, o) { return s + (parseFloat(o.valorSubtotal) || 0); }, 0);
      var discount = group.orders.reduce(function (s, o) { return s + (parseFloat(o.valorDesconto) || 0); }, 0);
      var total = group.orders.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
      var ticket = qty > 0 ? total / qty : 0;

      grandTotal += total;
      grandItems += items;
      grandSubtotal += subtotal;
      grandDiscount += discount;

      html += '<tr>';
      html += '<td>' + escapeHtml(group.date) + '</td>';
      html += '<td style="text-align:right">' + qty + '</td>';
      html += '<td style="text-align:right">' + items + '</td>';
      html += '<td class="money">' + formatBRL(subtotal) + '</td>';
      html += '<td class="money">' + formatBRL(discount) + '</td>';
      html += '<td class="money">' + formatBRL(ticket) + '</td>';
      html += '<td class="money"><strong>' + formatBRL(total) + '</strong></td>';
      html += '</tr>';
    });

    var grandTicket = data.length > 0 ? grandTotal / data.length : 0;

    html += '<tr style="font-weight:700;border-top:2px solid #333">';
    html += '<td>TOTAL GERAL</td>';
    html += '<td style="text-align:right">' + data.length + '</td>';
    html += '<td style="text-align:right">' + grandItems + '</td>';
    html += '<td class="money">' + formatBRL(grandSubtotal) + '</td>';
    html += '<td class="money">' + formatBRL(grandDiscount) + '</td>';
    html += '<td class="money">' + formatBRL(grandTicket) + '</td>';
    html += '<td class="money" style="color:var(--green)">' + formatBRL(grandTotal) + '</td>';
    html += '</tr></tbody></table></div>';

    return html;
  }

  // ========================= TRILHA DE AUDITORIA =========================

  function generateAuditTrail(audit) {
    var html = '<div class="global-summary" style="margin-top:24px">';
    html += '<h2 style="font-size:18px;margin-bottom:16px">\ud83d\udcdd Trilha de Auditoria</h2>';
    html += '<p style="color:#888;font-size:12px;margin-bottom:12px">Registro de por que cada pedido foi inclu\u00eddo ou descartado</p>';
    html += '<table style="font-size:12px"><thead><tr>';
    html += '<th>Pedido</th><th>Decis\u00e3o</th><th>Motivo</th>';
    html += '</tr></thead><tbody>';

    var decisionColors = {
      'INCLUIDO': '#059669',
      'DESCARTADO_STATUS': '#6b7280',
      'DESCARTADO_DATA': '#d97706',
      'DESCARTADO_DUPLICATA': '#6b7280',
      'ERRO': '#dc2626',
      'ALERTA': '#d97706'
    };

    // Mostra apenas INCLUIDOS, DESCARTADOS_DATA e ERROS (os mais relevantes)
    var relevant = audit.filter(function (a) {
      return a.decision === 'INCLUIDO' || a.decision === 'DESCARTADO_DATA' || a.decision === 'ERRO' || a.decision === 'ALERTA';
    });

    relevant.forEach(function (entry) {
      var color = decisionColors[entry.decision] || '#333';
      html += '<tr>';
      html += '<td><strong>' + escapeHtml(entry.pedidoId) + '</strong></td>';
      html += '<td><span style="color:' + color + ';font-weight:600">' + escapeHtml(entry.decision) + '</span></td>';
      html += '<td>' + escapeHtml(entry.reason) + '</td>';
      html += '</tr>';
    });

    if (relevant.length === 0) {
      html += '<tr><td colspan="3" style="text-align:center;color:#888">Nenhum registro relevante</td></tr>';
    }

    html += '</tbody></table></div>';
    return html;
  }

  // =====================================================================
  // EXPORTACAO - TEXTO PLANO
  // =====================================================================

  function generatePlainText(data, extras) {
    extras = extras || {};
    var text = 'GWEB COMISSOES - RELATORIO DE PEDIDOS DE VENDA\n';
    text += 'Regra: Comissao = data de conclusao, NAO emissao\n';
    text += '='.repeat(60) + '\n\n';

    // Resumo por vendedor
    var vendedorGroups = groupByVendedor(data);
    text += 'RESUMO POR VENDEDOR:\n';
    text += '-'.repeat(40) + '\n';
    vendedorGroups.forEach(function (g) {
      var total = g.orders.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
      var comissao = g.orders.reduce(function (s, o) { return s + (parseFloat(o.comissao) || 0); }, 0);
      var ticket = g.orders.length > 0 ? total / g.orders.length : 0;
      text += '  ' + g.vendedor + ': ' + g.orders.length + ' pedidos | ' + formatBRL(total) + ' | Ticket: ' + formatBRL(ticket) + ' | Comissao: ' + formatBRL(comissao) + '\n';
    });

    // Detalhes por data
    var dateGroups = groupByDate(data);
    dateGroups.forEach(function (group) {
      text += '\n\nDATA DE CONCLUSAO: ' + group.date + '\n';
      text += '-'.repeat(50) + '\n';

      group.orders.forEach(function (order) {
        text += '\nPedido: ' + (order.numeroPedido || order._idLista || order.id) + '\n';
        text += '  Cliente: ' + (order.cliente || '') + '\n';
        text += '  Vendedor: ' + (order.vendedor || '-') + '\n';
        text += '  Finalizado por: ' + (order.alteradoPor || '-') + '\n';
    // Also add Emissao and Pagamento to plain text
        text += '  Data Emissao: ' + (order.dataEmissao || '') + '\n';
        text += '  Data Conclusao: ' + (order.dataConclusao || '') + '\n';
        text += '  Status: ' + (order.status || '') + '\n';
        text += '  Valor Total: ' + formatBRL(order.valorTotal) + '\n';
        text += '  Forma Pagamento: ' + (order.formaPagamento || '-') + '\n';
        text += '  Comissao: ' + formatBRL(order.comissao) + '\n';

        if (order.itens && order.itens.length > 0) {
          text += '  Itens:\n';
          order.itens.forEach(function (item) {
            text += '    - ' + (item.descricao || '') + ' | Qtd: ' + String(item.quantidade || 0).replace('.', ',') + ' | ' + formatBRL(item.valorTotal) + '\n';
          });
        }
      });
    });

    var totalValue = data.reduce(function (s, o) { return s + (parseFloat(o.valorTotal) || 0); }, 0);
    var totalComissao = data.reduce(function (s, o) { return s + (parseFloat(o.comissao) || 0); }, 0);
    text += '\n' + '='.repeat(60) + '\n';
    text += 'TOTAL GERAL: ' + data.length + ' pedidos - ' + formatBRL(totalValue) + '\n';
    text += 'COMISSAO TOTAL: ' + formatBRL(totalComissao) + '\n';

    return text;
  }

  // =====================================================================
  // EXPORTACAO - CSV (separador ;, UTF-8 BOM, decimais com virgula)
  // =====================================================================

  function generateCSV(data) {
    var sep = ';';
    var lines = [];

    lines.push([
      'No Pedido', 'Data Emissao', 'Data Conclusao',
      'Cliente', 'CPF/CNPJ', 'Vendedor', 'Finalizado por', 'Status', 'Observacao',
      'Cod. Item', 'Descricao Item', 'Quantidade', 'Unidade',
      'Vlr Unitario', 'Desconto Item', 'Vlr Total Item',
      'Subtotal Pedido', 'Desconto Pedido', 'Frete',
      'Forma Pagamento', 'Comissao', 'Valor Total Pedido'
    ].join(sep));

    data.forEach(function (order) {
      var base = [
        csvSafe(order.numeroPedido || order._idLista || order.id),
        csvSafe(order.dataEmissao),
        csvSafe(order.dataConclusao),
        csvSafe(order.cliente),
        csvSafe(order.clienteCpfCnpj),
        csvSafe(order.vendedor),
        csvSafe(order.alteradoPor),
        csvSafe(order.status),
        csvSafe(order.observacao)
      ];

      if (order.itens && order.itens.length > 0) {
        order.itens.forEach(function (item) {
          lines.push(base.concat([
            csvSafe(item.codigo),
            csvSafe(item.descricao),
            csvDecimal(item.quantidade),
            csvSafe(item.unidade),
            csvDecimal(item.valorUnitario),
            csvDecimal(item.desconto),
            csvDecimal(item.valorTotal),
            csvDecimal(order.valorSubtotal),
            csvDecimal(order.valorDesconto),
            csvDecimal(order.valorFrete),
            csvSafe(order.formaPagamento),
            csvDecimal(order.comissao),
            csvDecimal(order.valorTotal)
          ]).join(sep));
        });
      } else {
        lines.push(base.concat([
          '', '', '', '', '', '', '',
          csvDecimal(order.valorSubtotal),
          csvDecimal(order.valorDesconto),
          csvDecimal(order.valorFrete),
          csvSafe(order.formaPagamento),
          csvDecimal(order.comissao),
          csvDecimal(order.valorTotal)
        ]).join(sep));
      }
    });

    return lines.join('\n');
  }

  function csvSafe(val) {
    if (val === null || val === undefined) return '';
    var str = String(val);
    if (str.indexOf(';') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function csvDecimal(val) {
    var num = parseFloat(val) || 0;
    return num.toFixed(2).replace('.', ',');
  }

  // =====================================================================
  // PUBLIC API
  // =====================================================================

  return {
    generate: generate,
    generatePlainText: generatePlainText,
    generateCSV: generateCSV
  };

})();
