/**
 * report-page.js - Logica do relatorio (CSP-compliant)
 * Carrega dados via chrome.storage.local e monta a pagina
 */

(function () {
  'use strict';

  var PREFIX = '[GDOORScraper]';

  var loadingState = document.getElementById('loadingState');
  var emptyState = document.getElementById('emptyState');
  var reportRoot = document.getElementById('reportRoot');

  async function init() {
    console.log(PREFIX, 'Report-page: carregando dados...');

    try {
      var result = await chrome.storage.local.get([
        'reportData',
        'reportDateFrom',
        'reportDateTo',
        'reportGeneratedAt',
        'reportStats',
        'reportAudit',
        'reportDiscarded',
        'reportAlerts'
      ]);

      var data = result.reportData;
      var dateFrom = result.reportDateFrom || '';
      var dateTo = result.reportDateTo || '';
      var generatedAt = result.reportGeneratedAt || new Date().toISOString();
      var stats = result.reportStats || {};
      var audit = result.reportAudit || [];
      var discarded = result.reportDiscarded || [];
      var alerts = result.reportAlerts || [];

      // Limpa os dados do storage apos carregar
      await chrome.storage.local.remove([
        'reportData',
        'reportDateFrom',
        'reportDateTo',
        'reportGeneratedAt',
        'reportStats',
        'reportAudit',
        'reportDiscarded',
        'reportAlerts'
      ]);

      if (!data || data.length === 0) {
        loadingState.style.display = 'none';
        emptyState.style.display = 'block';
        return;
      }

      console.log(PREFIX, 'Report-page: ' + data.length + ' pedidos carregados');

      // Gera o HTML do relatorio usando report.js
      var extras = {
        stats: stats,
        audit: audit,
        discarded: discarded,
        alerts: alerts
      };
      var reportHtml = ReportGenerator.generate(data, dateFrom, dateTo, generatedAt, extras);

      loadingState.style.display = 'none';
      reportRoot.style.display = 'block';
      reportRoot.innerHTML = reportHtml;

      // Conecta eventos apos renderizar
      setupEventListeners(data, dateFrom, dateTo, extras);

    } catch (e) {
      console.error(PREFIX, 'Erro ao carregar relatorio:', e);
      loadingState.innerHTML = '<p style="color:#c73650">Erro ao carregar dados do relat\u00f3rio.</p>';
    }
  }

  // Retorna os pedidos respeitando os filtros de data + vendedor selecionados
  function getFilteredData(data) {
    var fd = document.getElementById('filterGlobal');
    var fv = document.getElementById('filterVendedor');
    var dateFilter = fd ? fd.value : 'all';
    var vendFilter = fv ? fv.value : 'all';
    return data.filter(function (o) {
      var dKey = o.dataConclusao || 'Sem data';
      var vKey = o.vendedor || 'Sem vendedor';
      var dateOk = (dateFilter === 'all') || (dKey === dateFilter);
      var vendOk = (vendFilter === 'all') || (vKey === vendFilter);
      return dateOk && vendOk;
    });
  }

  function setupEventListeners(data, dateFrom, dateTo, extras) {
    // Botao Copiar Tudo \u2014 usa apenas os pedidos filtrados
    var btnCopy = document.getElementById('btnCopyAll');
    if (btnCopy) {
      btnCopy.addEventListener('click', function () {
        var text = ReportGenerator.generatePlainText(getFilteredData(data), extras);
        navigator.clipboard.writeText(text).then(function () {
          btnCopy.textContent = '\u2713 Copiado!';
          setTimeout(function () { btnCopy.textContent = '\ud83d\udccb Copiar Tudo'; }, 2000);
        });
      });
    }

    // Botao Imprimir
    var btnPrint = document.getElementById('btnPrint');
    if (btnPrint) {
      btnPrint.addEventListener('click', function () {
        window.print();
      });
    }

    // Botao CSV
    var btnCsv = document.getElementById('btnCsv');
    if (btnCsv) {
      btnCsv.addEventListener('click', function () {
        var filtered = getFilteredData(data);
        var csv = ReportGenerator.generateCSV(filtered);
        var BOM = '\uFEFF';
        var blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        // Inclui o vendedor no nome do arquivo quando filtrado
        var fv = document.getElementById('filterVendedor');
        var vendTag = (fv && fv.value !== 'all') ? '_' + fv.value.replace(/[^\w]+/g, '-') : '';
        var fileName = 'pedidos_gdoor_' + dateFrom + '_' + dateTo + vendTag + '.csv';
        link.download = fileName.replace(/\//g, '-');
        link.click();
        URL.revokeObjectURL(url);
      });
    }

    // Filtros: data + vendedor (aplicados juntos)
    var filterDate = document.getElementById('filterGlobal');
    var filterVend = document.getElementById('filterVendedor');
    function runFilters() {
      applyFilter(
        filterDate ? filterDate.value : 'all',
        filterVend ? filterVend.value : 'all'
      );
    }
    if (filterDate) filterDate.addEventListener('change', runFilters);
    if (filterVend) filterVend.addEventListener('change', runFilters);

    // Botoes expandir itens, pedidos por vendedor e grupos de data
    document.querySelectorAll('.expand-btn').forEach(function (btn) {
      var targetId = btn.dataset.target;
      var target = document.getElementById(targetId);
      if (!target) return;

      var isVendorTable = target.dataset.type === 'vendor-orders';
      var isDateGroup = btn.classList.contains('date-toggle');

      if (isDateGroup) {
        // Grupo de data: oculto por padrao, botao expande
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var hidden = target.style.display === 'none';
          var num = btn.dataset.count || '';
          if (hidden) {
            target.style.display = 'block';
            btn.textContent = '\u25b2 Fechar';
          } else {
            target.style.display = 'none';
            btn.textContent = '\u25bc Abrir (' + num + ')';
          }
        });
        // Tambem permite clicar no header inteiro para expandir
        var header = btn.closest('.date-group-header');
        if (header) {
          header.addEventListener('click', function () {
            btn.click();
          });
        }
      } else if (isVendorTable) {
        // Tabela de vendor: oculta por padrao, botao expande
        btn.addEventListener('click', function () {
          var hidden = target.style.display === 'none';
          var num = btn.dataset.count || '';
          if (hidden) {
            target.style.display = 'block';
            btn.textContent = '\u25b2 Fechar';
          } else {
            target.style.display = 'none';
            btn.textContent = '\u25bc Pedidos (' + num + ')';
          }
        });
      } else {
        // Items-row de pedido: oculto por padrao, botao expande
        btn.addEventListener('click', function () {
          target.classList.toggle('visible');
          var num = btn.textContent.match(/\d+/)?.[0] || '';
          btn.textContent = target.classList.contains('visible') ? '\u25b2 Fechar' : '\u25bc Itens (' + num + ')';
        });
      }
    });
  }

  // Formata BRL (mesmo padrao do report.js)
  function fmtBRL(num) {
    return 'R$ ' + (parseFloat(num) || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  // Aplica filtro de data + vendedor juntos
  function applyFilter(dateFilter, vendFilter) {
    dateFilter = dateFilter || 'all';
    vendFilter = vendFilter || 'all';

    var groups = document.querySelectorAll('.date-group');
    groups.forEach(function (group) {
      // 1) Filtro de data — esconde grupo de data inteiro
      var dateMatch = (dateFilter === 'all') || (group.dataset.date === dateFilter);
      if (!dateMatch) { group.style.display = 'none'; return; }

      // 2) Filtro de vendedor — esconde linhas de outros vendedores e recalcula totais
      var rows = group.querySelectorAll('.order-row');
      var visOrders = 0, visItems = 0, visTotal = 0, visComissao = 0;
      rows.forEach(function (row) {
        var match = (vendFilter === 'all') || (row.dataset.vendedor === vendFilter);
        row.style.display = match ? '' : 'none';
        // items-row logo apos a linha do pedido segue a mesma visibilidade
        var itemsRow = row.nextElementSibling;
        if (itemsRow && itemsRow.classList.contains('items-row')
            && itemsRow.dataset.vendedor === row.dataset.vendedor) {
          // mantem escondida se a linha sumiu; senao respeita o toggle .visible
          if (!match) itemsRow.style.display = 'none';
          else itemsRow.style.display = '';
        }
        if (match) {
          visOrders += 1;
          visItems += parseInt(row.dataset.itens, 10) || 0;
          visTotal += parseFloat(row.dataset.total) || 0;
          visComissao += parseFloat(row.dataset.comissao) || 0;
        }
      });

      // Esconde grupo de data sem nenhum pedido do vendedor selecionado
      group.style.display = (visOrders > 0) ? 'block' : 'none';

      // Atualiza o texto de estatisticas do cabecalho do grupo
      var statsTxt = group.querySelector('.group-stats-text');
      if (statsTxt) {
        var t = visOrders + ' pedidos · ' + visItems + ' itens · ' + fmtBRL(visTotal);
        if (visComissao > 0) t += ' · Comissão: ' + fmtBRL(visComissao);
        statsTxt.textContent = t;
      }
    });

    // 3) Resumo por Vendedor — mostra so o card do vendedor selecionado
    document.querySelectorAll('.vendor-card').forEach(function (card) {
      var match = (vendFilter === 'all') || (card.dataset.vendedor === vendFilter);
      card.style.display = match ? '' : 'none';
    });
  }

  init();
})();
