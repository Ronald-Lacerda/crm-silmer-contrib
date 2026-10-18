# Architecture Decision Records

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
