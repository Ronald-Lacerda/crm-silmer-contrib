# Architecture Decision Records

## Decisão de 09/11/2026

- [073 — Comprador no vínculo histórico com telefone divergente](073-comprador-no-vinculo-historico-com-telefone-divergente.md), RFC 057; exceção exclusiva de T16, sem referência reutilizável.

- [072 — Envio em aberto sem duplicar cadastros do ERP](072-envio-em-aberto-sem-duplicar-cadastros-do-erp.md),
  RFC 056; simplifica a rotina da ADR 071 por decisão do proprietário.

- [071 — Vencimento explícito e vínculo histórico isolado no Olist](071-vencimento-explicito-e-vinculo-historico-isolado-no-olist.md),
  proposta na RFC 055, OLIST-T15–T17.

- [074 — Retirada da página Financeiro](074-retirada-da-pagina-financeiro.md),
  RFC 058 / FINQ-T07, FINQ-20: sai a tela `/financeiro` e o menu, o perfil vira
  operador restrito do Olist e API e dados ficam; supersede as ADRs 040, 041 e
  042 somente na tela e no menu.
- [070 — Olist: quota com espera de leitura e folga](070-olist-quota-com-espera-de-leitura-e-folga.md),
  RFC 050 / OLIST-T28, OLIST-52: só leitura espera quota, escrita nunca espera e
  só começa com folga para a leitura pós-venda; `verifyAccount` espera 15 s.
- [069 — Olist: invalidação administrativa de export](069-olist-invalidacao-administrativa-de-export.md),
  RFC 050 / OLIST-T27, OLIST-51: Admin arquiva a geração antes de qualquer venda
  (comando local, nova geração é nova linha, uma operação ativa por Pedido),
  com retry pré-efeito; D1, D2 e D5 a confirmar pelo proprietário.

## Decisão de 08/11/2026

- [066 — Responder por mensagem mais recente](066-responder-por-mensagem-mais-recente.md),
  RFC 053 / INBOX-VEZ-08: recência da última mensagem, sem fixar falhas no topo,
  com cursor próprio e preservação do relógio de espera.
- [065 — Caixa por vez de responder](065-caixa-de-entrada-por-vez-de-responder.md),
  RFC 052 / INBOX-VEZ-01: quatro abas derivadas em leitura, Todos como padrão,
  72 h corridas, lembrete por pessoa e p95 real como critério para migration.

## Decisão de 06/11/2026

- [068 — Cancelamento local terminal pré-exportação](068-cancelamento-local-terminal-pre-exportacao.md),
  RFC 050 / OLIST-T23: marcador separado dos dois status comerciais, motivo
  cifrado, ACL comercial, disputa com reserva de venda e histórico financeiro preservado.
- [063 — Triagem prioritária do Vendedor](063-triagem-prioritaria-do-vendedor.md),
  RFC 051 / VND-L05: dúvidas comerciais e alternativas sem regra inferida,
  urgência antes da ficha completa e perguntas só de campos faltantes.

## Decisão de 05/11/2026

- [067 — Fontes comerciais suplementares](067-fontes-comerciais-suplementares-sem-reescrever-ficha.md), RFC 054 / T26/T24, preservando ficha, total e pagamentos.
- [061 — Métricas de expediente, perda declarada e presença](061-metricas-de-expediente-perda-e-presenca.md),
  RFC 048 / ACT-T04: minutos de expediente por função SQL versionada, lead
  perdido em desfecho próprio e presença sob flag; supersede a ADR 059 só nas 48h.
- [059 — Central de ações e performance comercial](059-central-de-acoes-e-performance-comercial.md),
  RFC 044 / ACT-T01: fila pessoal, conferências independentes, crédito congelado
  e checkpoint diário com snapshot e reserva por destinatário; ativação ACT-T02.
- [058 — Cobranças do pedido com InfinitePay](058-cobrancas-do-pedido-com-infinitepay.md),
  RFC 049 / COB-DEL-01: 0%, X% e 100%, sinal/saldo, Pix/cartão e quitação
  verificada de pedidos existentes, após aprovação do protótipo.

## Decisão de 04/11/2026

- [057 — Olist por habilitação e subtotal por tamanho](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md),
  RFC 050 / OLIST-PLAN-02: checkbox por usuário, qualquer Pedido completo,
  criação de cadastros/variações, subtotal por tamanho, cancelamento CRM
  pré-exportação, rótulos Aplicação/Previsão de entrega e piloto individual.

## Decisão de 03/11/2026

- [056 — Abertura de pedido com confirmação humana](056-abertura-de-pedido-com-confirmacao-humana.md),
  RFC 043 / OA-T01: sugestões internas durante bot/humano, criação humana,
  evidência, decisões e avaliação de omissões, supersedendo a abertura da ADR 014.

## Decisão de 02/11/2026

- [055 — Central de erros restrita à conta operadora](055-central-de-erros-restrita-a-conta-operadora.md),
  OPS-ERR-T01: Saúde e erros com acesso por conta e capacidade, agrupamento
  de falhas e triagem auditada, preservando os gates de monitor externo.

- [054 — Cotação na conversa vinculada ao pedido](054-cotacao-na-conversa-vinculada-ao-pedido.md),
  T139: vendedor responsável/admin consulta e guarda estimativa com alvos
  explícitos; resposta sugerida para envio humano e valor comercial preservado.

## Decisão de 01/11/2026

- [053 — Conexão e cotação administrativa do Melhor Envio](053-conexao-e-cotacao-administrativa-melhor-envio.md),
  continuidade T137/ME-0: OAuth mínimo, tokens cifrados no PostgreSQL e menu
  administrativo; decisões comerciais/compra da RFC 038 continuam separadas.

## Decisão de 30/10/2026

- [052 — Vendedor mensurável e com mais contexto](052-vendedor-mensuravel-e-com-mais-contexto.md),
  decidida na RFC 041; falha do bot vira handoff `automation_failure`,
  telemetria por turno sem PII, handoff resolvido ao encerrar, vendedor pedido
  pelo nome, transcrição do áudio no CRM, histórico com Assuntos, contexto do
  cliente recorrente e código de falha do bot. A ADR 050 (Evolution) entra por
  outro PR.

## Decisão de 29/10/2026

- [051 — Vendedor aprende com os atendentes humanos](051-vendedor-aprende-com-os-atendentes-humanos.md),
  preço adiado na primeira pergunta, arte e tecido perguntados, imagem sem
  falha, rajada agrupada, urgência pelo prazo, parceria e revenda, tom e aviso
  perto do fechamento; supersede a ADR 009 (item 4) e a ADR 024 (item 3) em
  parte.
- [050 — Evolution/Baileys como ponte do WhatsApp](050-evolution-baileys-como-ponte-do-whatsapp.md),
  gateway e banco privados sem Redis, jornada preservada, limpeza WAHA por
  referências e integração Meta protegida; homologação real em EVOL-01.

## Decisão de 28/10/2026

- [049 — Aprendizados do Vendedor na Inbox real](049-aprendizados-do-vendedor-na-inbox-real.md),
  pergunta do cliente primeiro, modelo livre, bandeira com tamanho, datas
  relativas, empresa, aviso fora do horário e quantidade do item único.
- [048 — Assunto da mensagem só na dúvida do agente](048-assunto-da-mensagem-so-na-duvida-do-agente.md),
  o agente liga as mensagens do turno ao Assunto e a Inbox só pergunta nas
  mensagens que ele não soube atribuir; complementa a ADR 032.
- [047 — Cadastro completo do cliente](047-cadastro-completo-do-cliente.md),
  cadastro opcional cifrado, estado completo/incompleto e CEP pelo ViaCEP.
- [046 — Retomar WAHA para atendimento da nova linha](046-retomar-waha-para-atendimento-da-nova-linha.md),
  pausa WPPConnect sem pareamento e retoma WAHA/WEBJS para a Inbox real,
  com volumes novos e sem reutilizar a conta bloqueada; identidade confirmada,
  principal publicado com WAHA e texto real de ida e volta verificado;
  gates restantes de canal continuam abertos.
- [045 — Piloto WhatsApp com WPPConnect](045-piloto-whatsapp-wppconnect.md),
  preparação por QR com atendimento preservado; escolha de transporte
  posteriormente supersedida pela ADR 046, sem reescrever o registro.

## Decisão de 27/10/2026

- [043 — Piloto WhatsApp com WAHA e WEBJS](043-piloto-whatsapp-waha-webjs.md),
  exceção autorizada para a linha temporária, preservando n8n e contratos CRM.

- [041 — Consulta administrativa do Financeiro](041-consulta-administrativa-do-financeiro.md),
  complemento documental à ADR 040: Admin consulta com menu completo; print
  descartado como referência visual e design real do CRM preservado.

- [040 — Financeiro com fila e check manual](040-financeiro-com-fila-e-check-manual.md),
  aceita em 21/10/2026; requisitos e tarefas registrados, implementação futura,
  composição Fila e detalhe no design vigente e integração Olist diferida.

Esta pasta contém as decisões arquiteturais já tomadas no CRM Silmer.

## Convenção

- Nomeie os arquivos como `NNN-titulo-em-kebab-case.md`.
- Use numeração sequencial com três dígitos, começando em `001`.
- Escreva o ADR em português, salvo quando houver motivo técnico para manter
  um termo em inglês.
- Inclua data, status, decisores, contexto, decisão, consequências e links
  para RFCs, requisitos, issues e PRs relacionados.
- ADR é registro histórico: não reescreva uma decisão aceita. Quando ela
  mudar, crie um novo ADR e marque o anterior como superseded.

## Quando usar

Crie um ADR depois que a decisão arquitetural estiver tomada ou em fase final
de formalização. Para uma proposta que ainda precisa de avaliação e aprovação,
use [`../rfc/`](../rfc/) primeiro.

O ADR não substitui `ARCHITECTURE.md`, `TECHNICAL-DESIGN.md` nem os requisitos
canônicos; ele registra o contexto e o motivo da escolha.

## Índice

- [001 — Adotar Vue 3 no frontend do CRM](001-adotar-vue-no-frontend.md)
- [002 — Adotar adaptador de integração n8n](002-adotar-adaptador-de-integracao-n8n.md)
- [003 — Adotar integração n8n simples para o MVP](003-adotar-integracao-n8n-mvp-simples.md)
- [004 — Aposentar Kanban e Negócio](004-aposentar-kanban-e-negocio.md)
- [005 — Excluir contas sem histórico](005-excluir-contas-sem-historico.md)
- [006 — Pedido com dois status e confirmação humana](006-pedido-dois-status.md)
- 007 — reservado para a ficha por produto (branch `feat/ficha-por-produto`), não aceita e superada pela 017
- [008 — Lastro de datas do pedido](008-lastro-de-datas-do-pedido.md)
- [009 — Regras de transferência e teto do bot no n8n](009-regras-de-transferencia-e-teto-do-bot.md)
- [010 — Intenção de pedido sem pergunta e tom do bot](010-intencao-de-pedido-sem-pergunta-e-tom-do-bot.md)
- [011 — Pergunta ignorada transfere e toda mensagem alimenta a ficha](011-pergunta-ignorada-e-ficha-por-mensagem.md)
- [012 — Ficha de sete pontos e ritmo fixo do bot](012-ficha-de-sete-pontos-e-ritmo-fixo.md)
- [013 — Só pedido do zero no bot e meta de meia ficha](013-pedido-do-zero-e-meta-de-meia-ficha.md)
- [014 — Pedido abre no primeiro ponto da ficha](014-pedido-abre-no-primeiro-ponto-da-ficha.md)
- [015 — A conversa não volta para o bot](015-conversa-nao-volta-para-o-bot.md)
- [016 — Itens com os sete pontos da ficha](016-itens-com-os-sete-pontos-da-ficha.md)
- [017 — Ficha impressa com os sete pontos](017-ficha-impressa-com-os-sete-pontos.md)
- [018 — O cliente do pedido acompanha o contato](018-cliente-do-pedido-acompanha-o-contato.md)
- [019 — Ficha espelhada e sinais operacionais](019-ficha-espelhada-e-sinais-operacionais.md)
- [020 — Técnica por item e arte do pedido](020-tecnica-por-item-e-arte-do-pedido.md)
- [021 — Adotar OpenAI no MVP](021-adotar-openai-no-mvp.md)
- [022 — Manter deploy automático GitHub → EasyPanel](022-manter-deploy-automatico-github-easypanel.md)
- [023 — Arquivos da arte do pedido no RustFS](023-arquivos-da-arte-no-rustfs.md)
- [024 — O atendimento começa pelo produto](024-atendimento-comeca-pelo-produto.md)
- [025 — Itens por público no pedido](025-itens-por-publico.md)
- [026 — Imagem, áudio e chat do site no bot](026-midia-e-chat-do-site-no-bot.md)
- [027 — Venda da loja do site no CRM](027-venda-da-loja-do-site.md)
- [028 — Pedido pago da loja confirmado pela InfinitePay e registrado pelo n8n](028-pedido-pago-da-loja-pelo-n8n.md)

- [029 — Mídia do chat no RustFS](029-midia-do-chat-no-rustfs.md); supersede a numeração colidente da decisão original, preservada no histórico.
- [030 — Antivírus persistente no worker](030-antivirus-persistente-no-worker.md), motor clamd no worker existente com socket Unix privado.
- [031 — Aviso de pedido novo do site até a primeira impressão da ficha](031-aviso-de-pedido-novo-do-site.md); supersede em parte a ADR 028 (item 9).
- [032 — Separar Pedido, Conversa e Assunto](032-separar-pedido-conversa-e-assunto.md); Pedido manual sem canal, encerramento neutro e assuntos de atendimento.
- [033 — Telefone no cadastro e roteamento](033-telefone-no-cadastro-e-roteamento.md); novo cadastro e Pedido manual exigem telefone, com legados consultáveis.
- [034 — Chat do site com telefone declarado](034-chat-do-site-com-telefone-declarado.md); sessão isolada, busca interna e Pedido novo antes do WhatsApp.
- [035 — Fundação visual whitelabel e mobile-first](035-fundacao-visual-whitelabel-mobile-first.md); tokens de marca em três camadas, logotipo por configuração e barra inferior no celular.
- [036 — Padrões de jornada: próximo passo único, filtros em folha e progresso real](036-padroes-de-jornada.md); decidido no RFC 024, com o valor final no diálogo de gerar e o destino do login por papel adiado.
- [037 — Gerar PDF da ficha para uso no celular](037-gerar-pdf-da-ficha-para-uso-mobile.md); renderiza o template vigente em PDF privado e permite compartilhamento manual no aparelho.
- [038 — Correção administrativa de quantidade da loja](038-correcao-administrativa-quantidade-loja.md); exceção restrita por administrador, com pagamento e checkout original preservados.

- [039 — Datas e afazeres do Pedido manual](039-datas-e-afazeres-do-pedido-manual.md); primeiro contato automático e entrega confirmada pelo responsável no Dashboard.
- [040 — Financeiro com fila e check manual](040-financeiro-com-fila-e-check-manual.md).
- [041 — Consulta administrativa do Financeiro](041-consulta-administrativa-do-financeiro.md).
- [042 — Perfis e nova quitação no Financeiro](042-perfis-e-requitacao-do-financeiro.md); Usuários e invalidação do check quando o valor muda.

- [044 — Atendimento comercial concentrado no WhatsApp](044-atendimento-comercial-concentrado-no-whatsapp.md), decisão na RFC 032; supersede atendimento ativo do site e retira mochilas/bolsas da coleta.

- [062 — Olist com unitário exato em centavos](062-olist-exportacao-com-unitario-exato-em-centavos.md); escopo inicial menor aprovado pelo PO, sem arredondamento de negociação.
