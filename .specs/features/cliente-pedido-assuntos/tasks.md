# Cliente, Pedido manual e assuntos — tarefas

## CP-T01 — Pedido manual sem canal

**Requisitos:** CP-01..06. Expandir Contato/Pedido, API autorizada e
idempotente, busca paginada, formulário acessível em Pedidos, edição existente
e testes positivos, negativos, concorrentes e de loja. Commit e push
atômicos; não alterar o workflow n8n.

## CP-T02 — Encerramento neutro

**Requisitos:** CP-07..10. Migration de ciclo terminal, comando e auditoria,
Inbox e testes de nova mensagem, pedido pendente, arquivo e takeover. Commit
e push atômicos.

## CP-T03 — Assuntos no CRM

**Requisitos:** CP-11..14, CP-17. Persistência, atribuição humana, vínculo
explícito Pedido/Contato, leitura da Inbox e teste de mensagens com dois
assuntos e retomada em novo ciclo. Commit e push atômicos.

Entrega de CP-T01–T03: [PR #170](https://github.com/romulosutil/crm-silmer/pull/170).

## CP-T04 — Contrato do agente

**Requisitos:** CP-15..18. Expandir API n8n, migrar briefing por Assunto,
adaptar workflow, gates de epoch/revisão e UAT com ambiguidades, replay e
handoff. Implantar CRM antes do workflow. A checklist operacional final deve
separar código do CRM, workflow n8n, privacidade e homologação do canal.

## CP-T05 — Telefone como chave de busca e cadastro de Pedido

**Requisitos:** CP-01..03, CP-19..20. Tornar telefone obrigatório em novos
Contatos e Pedidos manuais, manter legados para correção, buscar por telefone
sem unir identidades por inferência, apresentar duplicatas para escolha humana
e simplificar o cadastro de Contato dentro do fluxo de Pedido. E-mail permanece
opcional. Testar número já conhecido, duplicata e legado sem telefone.

## CP-T06 — Ingresso do chat do site e repasse ao site

**Requisitos:** CP-21..22 e CP-15..18. Receber nome e telefone declarados
somente da sessão sintética do chat, cifrar a declaração e permitir busca
interna com origem não confirmada. Retornar ao agente apenas a classificação
necessária; abrir Pedido novo no Contato da sessão sem anexar histórico de
outro canal. Adaptar o workflow depois do CRM, preparar estilo Silmer e
fornecer implementação dirigida ao repositório do site, com botão na home e
em `/instagram`, formulário e testes de teclado, celular, replay e duplicata.
O repasse humano por texto usa a caixa de entrada do CRM e a consulta de
mensagens da mesma sessão pelo widget; áudio do vendedor fica indisponível
nesse canal até existir entrega de mídia no chat.
Publicação e homologação do chat são gates separados.

## CP-T07 — Continuar cliente conhecido pelo WhatsApp

**Requisitos:** CP-23..24 e CP-19..22. Após aprovação operacional da Meta e
de um modelo de mensagem, coletar no site consentimento específico para a
Silmer chamar o visitante no WhatsApp. Para uma coincidência única de telefone,
reservar uma abertura idempotente e encaminhar o atendimento à Inbox; somente
após a reserva autorizada o chat anuncia “Vou te chamar no WhatsApp”. A resposta
WhatsApp confirma o número e permite vincular, com auditoria, as identidades
ao mesmo Contato, preservando Conversas separadas e a propriedade dos Pedidos.
Tratar duplicatas, ausência de consentimento, indisponibilidade, falha ou
resultado incerto de envio, replay e resposta de outro número. O piloto CP-T06
continua atendendo pelo chat do site até esses gates estarem homologados.

## CP-T08 — Cadastro completo do cliente

**Status:** concluída em 28/10/2026.

**Requisitos:** CP-25..28. Migration expand com envelope cifrado próprio e
estado completo/incompleto, comando autorizado, versionado e idempotente,
leitura no detalhe e estado na lista, consulta de CEP pela API com falha
tratada, seção “Cadastro” acessível na ficha do Contato e testes positivos,
negativos, de replay, de concorrência e de teclado. Commit e push atômicos.

## CP-T09 — Assunto da mensagem só na dúvida do agente

**Requisitos:** CP-12, CP-14, CP-16 e CP-29..31. Migração `0045` com
revisões por mensagem, vínculo do agente nas entradas do turno, leitura com
origem do vínculo e mensagens pendentes, pergunta na Inbox só na dúvida e
testes de serviço, Postgres real, contrato do workflow e e2e com teclado e
axe. Sem alteração do workflow n8n; ajustes de fala e gatilho do agente ficam
na [RFC 036](../../../docs/rfc/036-assunto-da-mensagem-so-na-duvida-do-agente.md)
até decisão do PO. Evidência de UX:
[estudo de 28/10/2026](../../../docs/product/pesquisa-ux-assuntos-2026-10-28.md).
