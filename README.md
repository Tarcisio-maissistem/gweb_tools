# GWeb Comissões - Extensão Chrome

Extensão Chrome (MV3) para extração automática de pedidos de venda do **GDOOR Web**, com cálculo de comissão baseado na **data de conclusão** do pedido.

## Funcionalidades

- **Raspagem via API direta** — captura tokens de autenticação da sessão ativa do GDOOR Web
- **Pipeline paralelo** — até 20 requisições simultâneas para máxima velocidade
- **Cache inteligente** — pedidos concluídos/cancelados são cacheados por 7 dias no localStorage
- **Persistência de estado** — retoma de onde parou em caso de interrupção (chrome.storage.session)
- **Filtro por data de conclusão** — comissão calculada pela data em que o pedido foi finalizado
- **Relatório HTML completo** com:
  - Agrupamento por data (recolhível)
  - Agrupamento por vendedor (recolhível)
  - Detalhamento de itens por pedido
  - Resumo com totais, ticket médio e comissões
  - Exportação CSV (separador `;`, decimais com `,`, UTF-8 BOM)
  - Exportação texto plano
  - Impressão otimizada (tema claro)
- **Teste de conexão API** integrado

## Instalação

1. Baixe ou clone este repositório
2. Abra o Chrome e acesse `chrome://extensions/`
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação**
5. Selecione a pasta do projeto

## Uso

1. Faça login no [GDOOR Web](https://app.gdoorweb.com.br)
2. Navegue até a página de **Pedidos de Venda**
3. Clique no ícone da extensão na barra do Chrome
4. Defina o **período de datas** (data de conclusão)
5. Clique em **Iniciar Raspagem**
6. Ao finalizar, o relatório abre automaticamente em nova aba

## Estrutura do Projeto

```
manifest.json          # Configuração da extensão Chrome MV3
popup.html / popup.js  # Interface do popup da extensão
report.html            # Página do relatório
src/
  background.js        # Service worker — hub de estado e persistência
  content.js           # Content script — lógica de raspagem e extração
  interceptor.js       # MAIN world — captura headers de autenticação
  report.js            # Gerador do HTML do relatório
  report-page.js       # Lógica interativa da página de relatório
icons/                 # Ícones da extensão (16/48/128px)
```

## Requisitos

- Google Chrome 116+ (suporte a MV3 e chrome.storage.session)
- Conta ativa no GDOOR Web (https://app.gdoorweb.com.br)

## Permissões

- `activeTab` — acesso à aba ativa do GDOOR
- `storage` — persistência de estado e cache
- `host_permissions` — acesso às URLs do GDOOR Web e API

## Versão

3.4.0
