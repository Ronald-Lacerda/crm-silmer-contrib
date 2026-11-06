# Request for Comments

## Decisão de 06/11/2026

- [051 — Triagem prioritária sem inferir regras comerciais](051-triagem-prioritaria-sem-inferir-regras-comerciais.md),
  aprovada na solicitação do proprietário, decidida na ADR 063 / VND-L05.

## Decisão de 05/11/2026

- [048 — Métricas de expediente, perda declarada e presença](048-metricas-de-expediente-perda-e-presenca.md),
  aceita pelo PO e registrada na ADR 061 / ACT-T04: expediente versionado,
  tempos de atendimento, retomada em 72h, lead perdido com motivo e presença.
- [044 — Performance comercial, checkpoint e central de ações](044-performance-comercial-e-central-de-acoes.md),
  protótipo refinado aprovado e recorte registrado na ADR 059 / ACT-T01.
## Decisão de 04/11/2026

- [050 — Geração assistida de pedidos de venda no Olist](050-geracao-assistida-de-pedidos-no-olist.md),
  revisão 2 decidida na ADR 057 / OLIST-PLAN-02. OLIST-01–50, seis fases,
  T01–T26: habilitação, cadastros, subtotais, cancelamento CRM e rótulos.
  Validações técnicas, implementação e piloto continuam pendentes.

## Decisão de 03/11/2026

- [043 — Abertura assistida de pedidos](043-abertura-assistida-de-pedidos.md),
  aprovada pelo proprietário e registrada na ADR 056 / OA-T01.

## Decisão de 02/11/2026

- [042 — Central de saúde e erros](042-central-de-saude-e-erros.md),
  decidida na ADR 055: menu exclusivo da conta operadora, ocorrências
  técnicas sem payloads e triagem auditada, sem reenvio de efeitos.

## Em revisão

- [047 — Enviar cobrança pela conversa](047-enviar-cobranca-pela-conversa.md),
  aberta em 05/11/2026 após revisão da jornada: gerar e enviar o link de Pix/cartão
  na conversa certa, por comando humano, sem copiar/colar; novo protótipo em avaliação.

- [038 — Frete e etiqueta pelo Melhor Envio](038-frete-e-etiqueta-pelo-melhor-envio.md),
  aberta em 29/10/2026. Tem retirada na loja ou Melhor Envio, etiqueta
  pronta ao embalar e menu próprio. As decisões D1–D9 estão em aberto.

## Decisão de 05/11/2026

- [049 — Cobranças do pedido com InfinitePay](049-cobrancas-do-pedido-com-infinitepay.md),
  aprovada após avaliação do protótipo. ADR 058 / COB-DEL-01: condições
  0%, X% e 100%, Pix/cartão, sinal/saldo e confirmação no servidor.

## Decisão de 30/10/2026

- [041 — Vendedor mensurável e com mais contexto](041-vendedor-mensuravel-e-com-mais-contexto.md),
  decidida na ADR 052; revisão do Vendedor publicado, falha silenciosa,
  telemetria sem PII e mais contexto para o agente. Catálogo e agente com
  ferramentas ficaram adiados.

## Decisão de 29/10/2026

- [040 — Vendedor aprende com os atendentes humanos](040-vendedor-aprende-com-os-atendentes-humanos.md),
  decidida na ADR 051; nove conversas reais de 29/10 e o que a vendedora
  perguntou e respondeu.
- [039 — Evolution/Baileys como ponte do WhatsApp](039-evolution-baileys-como-ponte-do-whatsapp.md),
  decidida na ADR 050 para a ponte temporária, limpeza do n8n e preservação Meta.

## Decisão de 28/10/2026

- [037 — Aprendizados do Vendedor na Inbox real](037-aprendizados-do-vendedor-na-inbox-real.md),
  decidida na ADR 049; cinco conversas reais de 28/10 e correções aprovadas.
- [036 — Assunto da mensagem só na dúvida do agente](036-assunto-da-mensagem-so-na-duvida-do-agente.md),
  decidida na ADR 048 quanto ao CRM; ajustes do workflow n8n aguardam o PO.
- [035 — Cadastro completo do cliente](035-cadastro-completo-do-cliente.md),
  decidida na ADR 047.
- [034 — Retomar WAHA para atendimento da nova linha](034-retomar-waha-para-atendimento-da-nova-linha.md),
  decidida na ADR 046; WPPConnect parado e pareamento WAHA da nova linha
  destinado à Inbox real; identidade confirmada e principal publicado,
  com texto real de ida e volta verificado e gates restantes abertos.
- [033 — Pareamento privado com WPPConnect](033-pareamento-privado-com-wppconnect.md),
  decidida na ADR 045; preparação preservada e transporte revisto na RFC 034/ADR 046.

## Decisão de 27/10/2026

- [031 — Piloto WhatsApp com WAHA e WEBJS](031-piloto-whatsapp-waha-webjs.md),
  aprovada pelo proprietário e decidida na ADR 043.

- [029 — Consulta administrativa do Financeiro](029-consulta-administrativa-do-financeiro.md),
  decidida na ADR 041: consulta do Admin com menu completo e rejeição do print
  como referência visual, sem implementação.

- [028 — Financeiro com fila e check manual](028-financeiro-com-fila-e-check-manual.md),
  decidida em 21/10/2026 na ADR 040; somente planejamento, sem implementação
  ou alteração do design do CRM.

Esta pasta contém propostas de mudanças significativas que ainda precisam de
avaliação e decisão.

## Convenção

- Nomeie os arquivos como `NNN-titulo-em-kebab-case.md`.
- Use numeração sequencial com três dígitos, começando em `001`.
- Escreva o RFC em português, salvo quando houver motivo técnico para manter
  um termo em inglês.
- Inclua contexto, responsável pela proposta, aprovadores, impacto,
  premissas, critérios de decisão, opções, recomendação, ações e resultado.
- Mantenha o RFC editável durante a revisão e registre a decisão final no
  próprio documento; depois, crie o ADR correspondente quando houver uma
  decisão arquitetural durável.

## Quando usar

Use um RFC antes de comprometer arquitetura, processo, produto ou ferramenta
em uma mudança relevante. Depois da decisão, atualize o status do RFC e, se a
decisão for arquitetural, crie um ADR em [`../adr/`](../adr/) com o vínculo
entre os documentos.

## Decisões operacionais de 05/10/2026

- [009 — OpenAI no MVP](009-openai-no-mvp.md), decidida na ADR 021.
- [010 — Deploy automático GitHub → EasyPanel](010-deploy-automatico-github-easypanel.md), decidida na ADR 022.
- [011 — Arquivos da arte do pedido no RustFS](011-arquivos-da-arte-no-rustfs.md), decidida na ADR 023.

## Decisões de 07/10/2026

- [014 — Imagem, áudio e chat do site no bot](014-midia-e-chat-do-site-no-bot.md), decidida na ADR 026.
- [015 — Venda da loja do site no CRM](015-venda-da-loja-do-site.md), decidida na ADR 027.

## Decisões de 09/10/2026

- [016 — Pedido pago da loja confirmado pelo gateway, via n8n](016-pedido-pago-da-loja-pelo-n8n.md), decidida na ADR 028.

## Integração de 10/10/2026

- [017 — Mídia do chat no RustFS](017-midia-do-chat-no-rustfs.md), decisão de 05/10/2026 reafirmada na ADR 029 após corrigir a colisão de numeração.
- [018 — Antivírus persistente no worker](018-antivirus-persistente-no-worker.md), decidida na ADR 030.
- [019 — Aviso de pedido novo do site no Dashboard](019-aviso-de-pedido-novo-do-site.md), decidida na ADR 031.

## Decisão de 14/10/2026

- [020 — Telefone no cadastro e roteamento](020-telefone-no-cadastro-e-roteamento.md), decidida na ADR 033.
- [021 — Chat do site com telefone declarado](021-chat-do-site-com-telefone-declarado.md), decidida na ADR 034.

## Decisão de 15/10/2026

- [022 — Fundação visual whitelabel do CRM](022-fundacao-visual-whitelabel.md), decidida na ADR 035.
- [024 — Jornadas com menos botões](024-jornadas-com-menos-botoes.md), aprovada pelo PO e decidida na ADR 036; o destino do login por papel (D3) ficou adiado.
- [025 — Ficha em PDF para uso no celular](025-ficha-em-pdf-para-uso-mobile.md), decidida na ADR 037.
- [026 — Correção administrativa de quantidade da loja](026-correcao-administrativa-quantidade-loja.md), decidida na ADR 038; LOJ-39–LOJ-41 e T135.

## Decisão de 21/10/2026

- [027 — Datas e afazeres do Pedido manual](027-datas-e-afazeres-do-pedido-manual.md), decidida na ADR 039.
- [028 — Financeiro com fila e check manual](028-financeiro-com-fila-e-check-manual.md), decidida na ADR 040.
- [029 — Consulta administrativa do Financeiro](029-consulta-administrativa-do-financeiro.md), decidida na ADR 041.
- [030 — Perfis e nova quitação no Financeiro](030-perfis-e-requitacao-do-financeiro.md), decidida na ADR 042.

## Proposta de 14/10/2026

- [023 — Backup externo e recuperação do CRM e do n8n](023-backup-externo-e-recuperacao-do-crm-e-n8n.md), pendente de destino externo, execução e drill.

- [032 — Atendimento comercial concentrado no WhatsApp](032-atendimento-comercial-concentrado-no-whatsapp.md), decidida na ADR 044.

- [046 — Escopo inicial Olist de centavos exatos](046-olist-escopo-inicial-de-centavos-exatos.md), aceita na ADR 062; prova restrita e bloqueio fracionário.
