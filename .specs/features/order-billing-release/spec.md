# Implantação de cobranças com emissão desligada

## Problem Statement

O proprietário autorizou implantar a feature e suas migrações em09/11/2026.
A master avançou com Olist/cancelamento/retirada do Financeiro; a implantação
precisa compor essas mudanças e preservar os contratos já publicados.

## User Stories

Como operador, quero o código e banco compatíveis em produção, com recuperação
disponível e envios desligados, para realizar depois um ensaio autorizado.

## Requirements

- BREL-01: WHEN a branch de cobrança for integrada à master vigente, THE SYSTEM SHALL preservar migrações/checksums publicados, jobs Olist, cancelamento terminal e retirada da página Financeiro, com histórico financeiro acessível e novos comandos cancelados recusados.
- BREL-02: WHEN a release for publicada, THE SYSTEM SHALL usar histórico linear, checks aprovados e integração pelo mantenedor autorizado, identificando fonte e versão recuperável sem contornar gates.
- BREL-03: WHEN as migrações forem aplicadas, THE SYSTEM SHALL conferir backup e capacidade antes, executar somente expand da release compatível e comparar versões/checksums e saúde após, sem apagar dados ou editar migrações aplicadas.
- BREL-04: WHILE emissão e envio não forem explicitamente autorizados, THE SYSTEM SHALL mantê-los desligados; WHILE um ensaio financeiro específico não for autorizado ao agente, THE SYSTEM SHALL não executar pagamento, checkout ou mensagem reais, inclusive depois da ativação das flags.
- BREL-05: WHEN a chave InfinitePay for cadastrada, THE SYSTEM SHALL mantê-la exclusivamente na credencial privada do n8n, com entrada e salvamento pessoais pelo proprietário, sem segredo em chat, repositório, logs ou export.
- BREL-06: WHEN a proteção do workflow humano for publicada, THE SYSTEM SHALL preservar integralmente os nós originais e encaminhar cobranças reservadas somente após preflight positivo do CRM, bloqueando envio em falha, timeout ou resposta inválida.
- BREL-07: WHILE a ativação coordenada e o ensaio real estiverem apenas preparados, THE SYSTEM SHALL manter as três flags financeiras false e os workflows financeiros inativos, registrando ordem de ativação, recuperação e aviso prévio ao proprietário antes de qualquer teste real.
- BREL-08: WHEN recebimento e conferência forem explicitamente autorizados, THE SYSTEM SHALL publicar os workflows financeiros revisados e habilitar somente RECEIVE na API e no worker, conferindo backlog, flags efetivas, autenticação técnica e saúde sem criar checkout, pagamento ou mensagem de teste.
- BREL-09: WHEN os clientes financeiros usarem a credencial Basic existente do CRM para n8n, THE SYSTEM SHALL aceitar a senha legada sintética de13caracteres e preservar seu conteúdo no header, aplicando os limites do cliente existente (usuário até256, senha até1024, ambos não vazios após trim, sem CR/LF e usuário sem dois-pontos), sem alterar a credencial, exigir32caracteres ou relaxar HTTPS, autenticação e bloqueios de emissão/envio.
- BREL-10: WHEN o proprietário autorizar ligar todas as funções para seu teste manual posterior, THE SYSTEM SHALL habilitar RECEIVE, ENABLED e CHAT_SEND na API e no worker após conferir backlog e workflows protegidos, verificar processos e saúde e manter autenticação, ACL, reserva, preflight e idempotência, sem executar ensaio financeiro pelo agente nem declarar homologação real.

## Out of Scope

Pagamento/envio reais, alterações funcionais no Olist, restauração destrutiva,
rotação das Basic, infraestrutura nova e aprovação implícita de go-live.

## Assumptions & Open Questions

O GitHub conectado está autenticado como mantenedor romulosutil; o CLI local
como contribuidor Ronald-Lacerda. São respeitados fork/PR/checks/merge linear.
O proprietário informou possuir a API Key; o formulário privado foi aberto
para entrada pessoal enquanto a integração continua.

Open questions: nenhuma decisão de produto pendente; etapas externas dependem
de checks, saúde, backup e cadastro seguro, com status explícito em tasks.md.

## Acceptance Criteria

- Atualização para master0ed44bd3 ou posterior, sem regressão de Olist/cancelamento; migrações inéditas de billing0073–0075 e ADR/RFC com índices livres.
- Gates locais/CI, PostgreSQL de upgrade/concorrência/cancelamento e E2E afetados aprovados; revisão independente das mudanças de integração.
- Fonte implantada identificada, backup conferido e todas expand aplicadas com checksums correspondentes; health e leitura autorizada compatíveis.
- Flags de emissão/envio false ou ausentes verificadas nos processos remotos; nenhum efeito financeiro ou WhatsApp real usado como probe.
- Campo secreto preenchido pelo usuário; só referência da credencial é vinculada aos workflows, sem expor o valor.

## Requirement Traceability

| Requirement | Task  | Source                                           |
| ----------- | ----- | ------------------------------------------------ |
| BREL-01     | T1    | COB/BAPI/BFIN/BFUI e invariantes Olist da master |
| BREL-02     | T2    | CONTRIBUTING e ADR022                            |
| BREL-03     | T3    | COB-OPS-01 e runbook de migração/recovery        |
| BREL-04     | T1–T4 | autorização limitada do proprietário             |
| BREL-05     | T4    | política de credenciais e runbook InfinitePay    |
| BREL-06     | T5    | BAPI-07/09/10 e autorização de09/11 para proteção humana |
| BREL-07     | T6    | autorização de09/11 para preparar ativação sem envios |
| BREL-08     | T7    | autorização de09/11 para publicar e habilitar somente recebimento/conferência |
| BREL-09     | T8    | autorização de10/11 para compatibilidade com a senha Basic atual |
| BREL-10     | T9    | autorização de10/11 para ativação completa e teste manual posterior pelo proprietário |
