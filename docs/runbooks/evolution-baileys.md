# Evolution/Baileys — ponte da Inbox Silmer

Atualização: 29/10/2026, America/Sao_Paulo.
Decisão: [ADR 050](../adr/050-evolution-baileys-como-ponte-do-whatsapp.md),
[RFC 039](../rfc/039-evolution-baileys-como-ponte-do-whatsapp.md).
Rastreabilidade: EVOL-01, OPS-1, INT-1/2, ORC-01..08, INB-01, MSG-01..04.

## Preparação

O proprietário autorizou preparar Evolution/Baileys no EasyPanel, integrá-la ao
n8n e à Inbox e limpar WAHA/candidatos obsoletos. O fluxo Meta deve ser preservado.
Dois bloqueios foram relatados; sua causa não foi confirmada. API oficial em
aprovação e disponibilidade do número são gates externos distintos.

- `schedule/silmer-evolution`: gateway privado na porta interna 8080, volume
  exclusivo de instâncias, sem domínio nem porta publicada; 1 CPU/1024 MiB.
- `schedule/silmer-evolution-db`: PostgreSQL exclusivo, banco/usuário
  `silmer_evolution`, sem porta pública; 0,5 CPU/512 MiB. Não reutiliza o banco CRM.
- [Perfil e fonte fixada](../../ops/evolution/README.md): Evolution 2.3.7,
  Node 24.22.1, cache local, sem Redis, logs/telemetria restritos e expurgo horário.
- Webhook previsto: `/webhook/silmer/evolution-events` no HTTPS existente do n8n,
  somente `MESSAGES_UPSERT` e `MESSAGES_UPDATE`, header exclusivo, sem base64
  no webhook e sem chave API no corpo. `TZ=UTC` preserva timestamps do provider.

Telefone, QR, tokens, credenciais e conteúdo de cliente nunca entram no Git,
logs, notas públicas ou evidências sanitizadas.

## Proteção do fluxo atual

Antes de mutações, exportar workflows e credenciais criptografadas para volume
privado com acesso restrito. Capturar fingerprints de nós, conexões, settings,
versões/publicação e IDs dos fluxos preservados. Não exportar execuções.

O inventário de 29/10 encontrou `k7tI6T4RhQPyJkn9` ativo, com 110 nós e
transporte WAHA, e `lwjMll33Beg2HQyU` como cópia Meta inativa de 86 nós.
Essa observação não autoriza confundir a cópia Meta com o transporte ativo.
O proprietário esclareceu que todos os fluxos prontos para a API oficial devem
ser preservados. Sete workflows Meta foram identificados e mantidos inalterados.
O atendimento principal foi convertido no mesmo ID, sem publicar antes de
parear/homologar a conta. Nunca publicar dois consumidores no mesmo método/path
de webhook. Checkout e DEV são fluxos independentes preservados.

## Evidência de preparação em 29/10/2026

- Evolution `2.3.7` em execução com imagem local
  `sha256:9a4226fa0d342e7fcac39b8f63233f9488edd3c69aa1c4f41978e6bcde8a1226`.
  O build exige Node `24.22.1`, Alpine 3.23 e imports de Baileys/Sharp/Prisma.
  O usuário da imagem é `node`; não há domínio nem porta pública.
- A consulta privada autenticada de instâncias retornou `200`, e sem chave
  retornou `401`. A instância `silmer` foi criada com `201`, sem solicitar QR;
  estado `close`, sem conta. O webhook foi explicitamente desabilitado e
  conferido com `enabled=false`, `byEvents=false`, `base64=false`, eventos vazios
  e destino exato. O create upstream habilitou o webhook apesar de `enabled=false`;
  por isso o `POST /webhook/set/silmer` separado é obrigatório na preparação.
- `EvolutionSilmerPilot01` foi importado inativo a partir do principal atual
  de 110 nós, usando somente a fronteira Meta da cópia de 86 nós. Todos os
  workflows existentes permaneceram inalterados nessa etapa.
- Após o esclarecimento do proprietário, `k7tI6T4RhQPyJkn9` passou a
  **Silmer | Atendimento WhatsApp IA (Evolution Baileys)**, ainda com 110 nós,
  versão `6fc447d1-7cf4-4f41-9208-b23a0b5d98c7`, sem publicação. Não há nós WAHA,
  referências às chaves dos gateways antigos ou mudança dos paths usados pelo
  CRM. Sete fingerprints Meta e os outros fluxos preservados ficaram iguais.
- O workflow manual **Silmer | Conectar Evolution (QR privado)**,
  `EvolutionPairSilmer01`, está preparado, com credencial própria e imagem
  binária do QR; execução manual/sucesso/erro não salvam payloads. Ele não foi
  executado. Só gerar QR quando o proprietário tiver uma conta disponível.
- Seis candidatos/QR antigos WAHA/WPPConnect foram arquivados, após checar
  publicação, ausência de dependentes e proteção Meta. O candidato Evolution
  duplicado também foi arquivado após converter o principal. Arquivar é
  recuperável; não é exclusão definitiva. Credenciais referenciadas pelos
  arquivados permanecem protegidas e não são declaradas órfãs.
- O WAHA foi confirmado em `SCAN_QR_CODE`, sem identidade/pareamento, e então
  suspenso pelo conector EasyPanel. A revisão automática inicialmente recusou
  a parada por risco de interrupção; a prova de ausência de conta permitiu a
  operação. Volumes e backups antigos foram preservados.
- A única execução marcada em andamento era `86995`, do QR WAHA já arquivado,
  iniciado em 29/10 às 12:33 UTC, com três chamadas HTTP de timeout 15 s e sem
  referência ao principal. O principal não tinha execução em andamento. A
  revisão automática inicialmente recusou a conversão; a verificação de
  independência permitiu converter sem encerrar esse utilitário naquela etapa.
- Somente `N8N_SSRF_ALLOWED_HOSTNAMES` mudou no ambiente do n8n, para
  `schedule_silmer-evolution`; proteção SSRF e as outras variáveis foram mantidas.
  O redeploy foi aplicado mantendo a imagem/fluxos existentes.
- Gate `npm run validate`: 1.424 testes, 1.419 aprovados, cinco ignorados, nenhuma
  falha, com build. O sandbox Windows recusou hardlinks dos testes de áudio;
  a execução autorizada fora do sandbox passou. Perfil/adapter/guard de limpeza:
  28 testes focados aprovados. E2E/axe: 335 aprovados e sete ignorados.
  `npm audit --audit-level=high` passou, com três avisos low/moderate existentes.

Os quatro exports privados anteriores/posteriores, incluindo credenciais
criptografadas, foram baixados para `var/evolution/backups/`, ignorado pelo Git,
e conferidos por tamanho/SHA-256. O auxiliar `schedule/silmer-evolution-ops` e
seu domínio temporário foram removidos depois dessa conferência. A verificação
final retornou n8n `healthz=200`, Evolution autenticada `200`/sem chave `401`,
sete fingerprints Meta intactos e instância `close`, sem conta. Nunca publicar
os bytes dos backups ou os dados de execução.

## Verificações e gates

### Pareamento e texto operacional em 29/10/2026

O proprietário forneceu uma nova conta em canal privado e leu o QR exibido
no utilitário manual autenticado do n8n, sem persistência da execução.
A Evolution confirmou `open` e identidade exatamente igual à configuração
privada. No principal de 110 nós, somente os dois campos `ownNumber` da
fronteira Evolution e o destino `wa.me` do nó de encaminhamento do site foram
ajustados. Variáveis e workflows da Meta não foram alterados.

O principal foi publicado pela interface n8n com a versão
`48c1bc53-a57c-4d08-8550-04df116a49dd`, nome
**EVOL-01D · Conta Evolution pareada**. A exportação final confirmou versão
atual publicada e todos os outros workflows inalterados, incluindo os sete
Meta protegidos. Não havia colisão de webhooks ativos.

Antes da publicação, uma consulta agregada, transacional e somente leitura
verificou o backlog antigo: nenhum comando elegível para entrega automática
ou em processamento. Os 12 comandos com resultado incerto permaneceram
preservados, sem retry. Essa consulta foi feita por auxiliar separado no
projeto CRM; o n8n não acessou seu banco.

O callback recusou requisição sem o header exclusivo com `403`. Depois foi
habilitado somente para `MESSAGES_UPSERT` e `MESSAGES_UPDATE`, no destino
exato, com `byEvents=false` e `base64=false`.

Uma mensagem de texto enviada da outra conta já aberta no WhatsApp Web gerou
uma única entrada na Inbox e o aviso de transferência para vendedor. Após
**Assumir atendimento**, uma única resposta humana foi enviada pela Inbox e
observada na conversa do WhatsApp Web. A conferência agregada registrou uma
entrada `received`, um aviso automático `sent` e uma resposta humana `sent`,
cada mensagem com um único ID do provider. O comando humano ficou `sent`,
com um único ID e sem retry autorizado. A tomada humana manteve a conversa
em estado `human`, com atribuição, epoch 1 e revisão de entrada 1.

Essa observação comprova texto bidirecional e recebimento visual no teste.
Os recibos do provider ainda constavam como `sent`: `delivered`/`read`, mídia,
replay, reconexão e recuperação continuam sem homologação nesta etapa.

Os exports privados anterior/posterior ao pareamento foram baixados para
`var/evolution/pairing/backups/` e verificados por tamanho e SHA-256. Os
auxiliares `schedule/silmer-evolution-pair-ops` e
`espectro-mvp/silmer-evolution-cutover-check`, incluindo seus domínios
temporários, foram removidos após guardar as evidências privadas. Evolution,
seu banco e o n8n permanecem operacionais.

### Checklist acumulado

- [x] Serviços dedicados criados pelo conector EasyPanel.
- [x] Backup privado e inventário de workflows obtidos por CLI da mesma versão
      do n8n, sem iniciar outro servidor, worker ou consumidor de eventos.
- [x] Adapter e perfil revisados, com testes de eventos negativos, reservas,
      resultado incerto, identidade/LID, mídia, logs e retenção.
- [x] Imagem/build, perfil não root, HTTP autenticado e recusa sem chave confirmados.
- [x] Candidato e principal preparados, rotas/referências verificadas; limpeza
      recuperável dos candidatos e gateways antigos suspensos.
- [x] Identidade da conta pareada corresponde à configuração privada.
- [x] Entrada real na Inbox, handoff, tomada humana e resposta recebida uma vez
      no WhatsApp Web.
- [ ] Mídia, recibos `delivered`/`read`, replay, reconexão e recuperação homologados.

Não promover um `200` de health ou evento ignorado a prova de entrega real.

## Suspensão e recuperação

Interromper somente o gateway e o transporte da ponte. Preservar volumes,
backups, mensagens persistidas e resultados incertos; reconciliar antes de
reenviar. Não reativar WAHA nem restaurar a baseline Meta automaticamente.
O rollback de workflow preserva suas credenciais e webhooks comerciais; não
restaura o banco CRM como consequência de falha do canal.
