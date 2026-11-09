# RFC 047 — Enviar cobrança pela conversa

Status: backend autorizado em 06/11/2026, decidido na [ADR 066](../adr/066-intencoes-de-cobranca-e-envio-transacional.md). Frontend adiado até o redesign de outra frente. Proposta inicial de 05/11/2026.
Artefato: [protótipo e roteiro de avaliação](../prototypes/README.md), COB-CHAT-P01.
Requisitos existentes: COB-01–16, MSG-02/03, PCX-13, UX-FUNC-01.
Tarefas: COB-REV-01 e COB-CHAT-01 em
[Cobranças](../../.specs/features/order-billing/tasks.md).
Complementa a [RFC 049](049-cobrancas-do-pedido-com-infinitepay.md) e a
[ADR 058](../adr/058-cobrancas-do-pedido-com-infinitepay.md). A decisão
arquitetural está na ADR 066; não reescrever a decisão anterior nem tratar o
contrato como runtime integrado pronto. A autorização posterior de backend
substitui a avaliação visual como pré-requisito das tarefas B01–B04.

## Problema e direção solicitada

O proprietário rejeitou a ponte de copiar/colar entre Pedido e Caixa de Entrada.
Solicitou um botão para enviar cobrança no chat ou pedido, selecionar quanto e
como, gerar o pagamento e enviá-lo na própria conversa. Escolheu expressamente
“Link enviado direto no chat, com Pix e cartão” para a primeira entrega.
O pedido anterior de avaliar o protótipo antes da implementação permanece.
Dashboard está fora desta fatia; sua entrega separada deve ser preservada.
Para a integração posterior, o proprietário definiu que o saldo deve continuar
como pendência enquanto houver valor a receber, até a quitação, sem mensagens
automáticas ao cliente por esse lembrete.

## Sequência proposta

1. **Enviar cobrança**, na conversa ou no pedido vinculado. Havendo mais de um
   pedido elegível na conversa, selecionar o pedido explicitamente.
2. Escolher integral, sinal percentual ou saldo disponível. A condição 0%
   continua significando sem entrada, nunca emissão de cobrança de valor zero.
3. Revisar pedido, cliente/conversa de destino, valor da cobrança, saldo após
   pagamento e formato: link InfinitePay, Pix ou cartão inclusive parcelado.
4. **Gerar e enviar cobrança** autoriza uma intenção humana específica. O
   sistema reserva e gera o link e o enfileira como mensagem na conversa certa.
   Não exige copiar/colar nem um segundo envio no compositor.
5. Mostrar geração, fila e resultado do transporte separadamente. Só afirmar
   enviado/entregue após o respectivo feedback real. Gerar/enviar não é pagar.
6. Sinal confirmado mantém saldo. Quitação depende do recebimento verificado
   pela InfinitePay e não muda os dois status comerciais existentes.

O texto contém identificação do pedido, sinal/saldo/integral, valor exato e
link. O rascunho livre já existente na Inbox permanece separado e preservado.
Para pedido sem conversa, não inferir destinatário por nome/telefone: exigir
vínculo elegível e explícito antes de oferecer envio.

## Fronteiras técnicas a decidir na implementação

- Persistir a intenção de envio junto à emissão, com cobrança, conversa, ator,
  owner/ciclo observados e identidade determinística do comando de mensagem.
- Callback de criação salva URL cifrada e enfileira mensagem/outbox/auditoria
  atomicamente pela infraestrutura humana da Inbox. Não enviar diretamente
  pelo workflow financeiro nem invocar API pública depois de um commit parcial.
- Revalidar usuário, responsável, conversa humana ativa, ciclo, acordo, saldo
  e validade antes do enfileiramento e na reserva final do transporte. A
  transferência atual não altera epoch: comparar responsável explicitamente.
- Callback repetido, resposta perdida e retomada não duplicam mensagem nem
  cobrança. Falha conhecida no envio pode oferecer o mesmo link; resultado
  incerto exige conferência, sem reemitir cobrança ou reenviar cegamente.
- Conversa encerrada/transferida ou acordo alterado bloqueia a intenção antiga;
  não migrar silenciosamente o envio para outro responsável ou novo atendimento.
- Autorização de administrador precisa ser explícita no serviço de mensagem;
  não simular função Vendedor para contornar a validação atual.
- Usar nova migration expand com numeração coordenada com as entregas em curso;
  não alterar 0055 nem colidir com migrations da central de ações.

## InfinitePay e limites

A [documentação oficial](https://www.infinitepay.io/checkout-documentacao)
informa que QR Pix/copia e cola aparecem no checkout do comprador e não são
devolvidos pela API. Não criar QR de URL e apresentá-lo como QR Pix. Cartão
permanece habilitado no checkout; não oferecer seleção “somente Pix”.
Uso único e validade exigem API Key privada para `options`; a conta da chave
e a InfiniteTag devem coincidir. O site existente usar checkout por handle
não comprova que essa credencial privada está configurada no n8n.

## Prova necessária

Revisão do protótipo; teste transacional de callback duplicado/concorrente e
rollback; transferência/fechamento/desativação/expiração/mudança de preço antes
do link e da reserva final; pagamento antes do envio; falhas conhecidas e
incertas sem duplicação; Admin/Vendedor/outro responsável; pedido sem conversa;
teclado e toque 320/390 px; preservação do rascunho. Homologação remota e
pagamento real autorizado continuam gates separados em COB-OPS-01.

## Revisão do plano — 05/11/2026

Revisão documental COB-PLAN-01, vinculada a COB-CHAT-01 e COB-01/04/05/12–15.
Base: [PR 298](https://github.com/romulosutil/crm-silmer/pull/298), commit
`19b9361817ad4a89cffc526a014da031949a9bbc`. Os três checks desse commit
estavam aprovados na consulta desta revisão. Isso valida a entrega existente,
não o envio integrado ainda pendente. O handoff global trata de mídia e não
substitui o estado específico em `order-billing/tasks.md`.

### Parecer e alternativas

Recomenda-se manter a intenção persistida no CRM, a emissão pelo workflow
financeiro e o envio pelo transporte humano existente. O vendedor revisa
uma vez; o processamento assíncrono continua sem depender da aba aberta.

| Alternativa                                             | Avaliação                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Frontend gera, aguarda o link e chama o envio           | Menos trabalho inicial, mas fechar a aba ou perder a resposta deixa a sequência incompleta. Não atende recuperação durável. |
| Workflow financeiro envia ao WhatsApp                   | Mistura efeitos financeiros e de mensagem, duplicando autorização, reserva e recuperação já existentes na Inbox.            |
| CRM persiste intenção e compõe as duas filas existentes | Recomendada: mantém fronteiras, autoria e recuperação no PostgreSQL atual, sem infraestrutura adicional.                    |

### Ajustes necessários antes de implementar

1. **Valor e forma de pagamento.** O diálogo escolhe integral, sinal ou saldo
   conforme o acordo permitido pelo domínio. Não permite percentual avulso que
   contorne `BILLING_CONDITION_LOCKED`. O formato é um link; Pix/cartão e
   parcelamento são escolhas do comprador no checkout. 0% salva sem entrada;
   cobrar o integral depois exige ação humana explícita. Uma cobrança vigente
   elegível oferece envio do mesmo link, sem emitir outra. Pedido sem conversa
   elegível não ganha envio por inferência nem um novo fluxo de vinculação
   nesta fatia; conserva geração e compartilhamento manual.
2. **Dois efeitos com estados independentes.** Cobrança conserva seus estados
   financeiros. Intenção registra espera pelo link, mensagem enfileirada,
   bloqueio, falha conhecida e resultado incerto, referenciando o comando e a
   mensagem existentes. Enviado/entregue vêm do transporte; quitação vem do
   recebimento verificado. Callback não cria nova intenção humana.
3. **Link preservado quando envio fica inelegível.** Em uma transação,
   `created` salva a URL cifrada e resolve a intenção: enfileira uma mensagem
   única se elegível ou persiste bloqueio e motivo técnico mínimo se houve
   transferência, fechamento, desativação, pagamento ou mudança do acordo.
   Esse bloqueio de negócio não descarta a URL nem pede nova emissão. Falha
   técnica de persistência/auditoria causa rollback e reentrega do mesmo
   callback. Repetição idêntica retorna o resultado durável; URL divergente
   conflita. Falhar a mensagem não desfaz a cobrança externa.
4. **Composição transacional interna.** Extrair/reutilizar uma operação da
   Inbox que aceite o cliente transacional atual para mensagem, outbox e
   auditoria. O método público atual abre sua própria transação, exige função
   Vendedor e o envio atribui a conversa ao autor. Não chamá-lo como segunda
   transação nem forjar função. A operação de cobrança revalida a capacidade
   administrativa real, preserva o responsável observado e mantém autoria
   humana explícita. Definir ordem consistente de locks entre conversa,
   usuário, pedido, plano, cobrança e comando, inclusive na reserva final.
5. **Autorização até a reserva do efeito.** Persistir ator, conversa/ciclo,
   responsável, epoch e acordo financeiro observados; usar identidade única
   para a intenção e cada tentativa autorizada. Conferir vínculo explícito
   Assunto/Pedido quando aplicável. Revalidar conta ativa/capacidade,
   responsável, ciclo humano aberto, acordo, saldo e validade no comando,
   callback e reserva do transporte. Transferência não muda epoch, portanto
   epoch sozinho não basta. Usar a revisão inbound atual ao enfileirar e
   preservar o fence vigente na reserva; mensagem inbound posterior pode
   bloquear a tentativa e exigir nova revisão humana. Não invalidar o acordo
   financeiro por mera edição de observação. Depois de iniciado o efeito
   externo, não prometer cancelamento nem garantia de ausência de corrida;
   resultado incerto exige reconciliação.
6. **Recuperação explícita.** Cobrança incerta não autoriza novo link. Mensagem
   incerta não autoriza reenvio. Após falha comprovadamente anterior ao envio,
   nova confirmação humana pode reservar outra tentativa do mesmo link ainda
   válido, sem reutilizar uma reserva consumida. Retomar após bloqueio exige
   rever destino e valor, mantendo o histórico. Pagamento antes da reserva
   impede o envio; pagamento posterior preserva o resultado do transporte.
7. **Desativação própria do envio.** Propor uma flag independente para novas
   intenções e reservas de envio de cobrança, inicialmente desligada.
   Desligá-la bloqueia mensagens ainda não autorizadas, conserva URLs,
   callbacks financeiros, recebimentos e conciliação. Não desliga o envio
   comum da Inbox nem interrompe a confirmação de links já emitidos.

### Sequência revisada de execução

As etapas abaixo refinam COB-CHAT-01; permanecem propostas até a avaliação do
protótipo e a decisão do contrato. Cada tarefa futura terá gate e entrega
atômicos. Não marcar a implementação como concluída por esta revisão.

| Ordem | Entrega                                                                                                             | Evidência de aceite                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Rever protótipo e formalizar critérios específicos de COB-CHAT-01; registrar novo ADR após a decisão                | Destino/pedido explícitos, mesmo link existente, 0%/sinal/saldo/integral, falha conhecida/incerta, teclado e retorno de foco; preservar rascunho.                                                         |
| 2     | Migration expand, intenção durável e operação transacional interna de mensagem, com emissão de mensagens desativada | PostgreSQL sintético: ACL Admin/Vendedor/outro responsável, idempotência, concorrência, rollback, unicidade e preservação do responsável.                                                                 |
| 3     | Integrar callback e guardas da reserva final, recuperação e flag de envio                                           | Callback duplicado/concorrente, resposta perdida, transferência/fechamento/desativação, mudança de preço, vencimento e pagamento em cada fronteira; uma cobrança e uma mensagem por tentativa autorizada. |
| 4     | Compor o diálogo reutilizado na Inbox e no Pedido e exibir estados reais                                            | E2E/axe em 320/390 px e desktop; toque, Escape, foco, rascunhos, múltiplos pedidos, reload e falhas; nenhum sucesso baseado só no HTTP do n8n.                                                            |
| 5     | Revisão independente integrada e documentação operacional                                                           | Gates completos, matriz PostgreSQL/navegador, runbook e rollback; homologação real continua em COB-OPS-01.                                                                                                |

A migração 0055 e as 0056/0057 da dashboard são imutáveis. A frente local
de saúde operacional já propõe 0058: reservar o próximo número livre após
reconciliar master e frentes em curso, sem fixá-lo antecipadamente. Aplicar
o mesmo cuidado à numeração do novo ADR. Dashboard/saldo e divergência de
cartão da loja continuam em COB-DASH-01/COB-STORE-01.

### Fontes conferidas e validação desta revisão

- `apps/api/src/order-billing-runtime.js`: `issue`, `created`, versões,
  idempotência e transações atuais.
- `modules/inbox-channels/src/application/inbox-service.js` e
  `adapters/postgres-inbox-repository.js` do mesmo módulo: validação humana,
  atribuição do autor no envio, transação e transferência sem mudar epoch.
- `modules/n8n-integration/src/postgres-command-outbox.js` e
  `postgres-repository.js`: outbox no mesmo cliente e fence final de mensagem.
- Documentação oficial InfinitePay consultada novamente: link com Pix/cartão,
  options privadas para validade/uso único, ausência de QR Pix na resposta e
  impossibilidade de cancelar link pela API. Não há sandbox financeiro;
  nenhuma chamada de criação ou pagamento foi realizada nesta revisão.
- Grafo histórico consultado somente para descoberta e confirmado nas fontes;
  nenhum build/update ou arquivo de grafo alterado.

Esta entrega modifica somente a proposta e sua rastreabilidade. Validação:
links locais dos documentos alterados e `git diff --check`. Não executa nem
declara novos testes de runtime; os checks do PR acima são evidência da base.

## Plano de conclusão revisado em 08/11/2026

O backend B01–B05 e os protótipos atualizados da Inbox/Pedido estão concluídos
localmente. O frontend integrado continua dependente do redesign. O
proprietário autorizou iniciar as frentes independentes em paralelo, incluindo
estrutura de testes no ambiente de desenvolvimento antes de produção.

Foi inspecionado, sem executar ou alterar, o workflow publicado
`Silmer | Loja | Checkout InfinitePay` (`Lu5dpTCA25Fe2Xfh`). Ele cria checkout,
confere pagamento e registra pedido pago por `store-orders`. Isso confirma uma
base existente na instância n8n, não a homologação das cobranças do CRM. A
nota do workflow descreve Pix; opções/credenciais e comportamento do provedor
para o novo fluxo ainda exigem conferência própria. Reaproveitar instância e
conta não significa cobrar pedido existente pelo endpoint de criação da loja.

### Entregas e dependências

| Ordem / tarefa    | Trabalho restante                                                                            | Dependência                                                | Critério de fechamento                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COB-DEV-01 / T1   | Perfil DEV do gerador financeiro compartilhado, inativo e isolado                            | Nenhuma                                                    | Grafo e regras comuns; paths/credenciais DEV; destinos externos recusados; produção preservada                                                                 |
| COB-DEV-02 / T2   | Simulador HTTP e ensaio no n8n real, API/runtime e PostgreSQL dedicados                      | Interface de T1; simulador pode ser preparado em paralelo  | Sinal/saldo Pix/cartão, replay, recusa de pagamento e recuperação verificados sem efeito real                                                                  |
| COB-READY-01 / T3 | Corrigir documentação obsoleta e preparar mapa de integração frontend                        | Independente; incorporar evidências T1/T2 ao finalizar     | Rotas, comandos, erros, histórico, permissões e limites conferidos no código                                                                                   |
| COB-DEV-03        | Completar ensaio da cadeia de transporte pelo n8n DEV e testes de jornada                    | T1/T2; transporte humano DEV existente                     | Outbox, reserva, preflight, envio simulado e callbacks reais de transporte; cinco comandos, correção expirada e callback tardio; flag off preserva recebimento |
| COB-API-READY     | Expor relação histórica de correção/retry se o redesign usar o rótulo explícito do protótipo | Antes da UI final                                          | Projeção autenticada retorna IDs de origem já persistidos; schema/OpenAPI e teste de reload, sem inferência por ordem/valor                                    |
| COB-CHAT-UI       | Integrar botão na Inbox e seção do Pedido ao contrato real                                   | Redesign disponível, COB-READY-01 e eventual COB-API-READY | Seleção explícita de pedido, revisão destino/valor, cinco comandos, estados financeiros/transporte separados, histórico e comprovantes reais                   |
| COB-CHAT-QA       | Validar jornada final e revisar independentemente                                            | COB-CHAT-UI e ensaios DEV                                  | API/PostgreSQL/n8n/navegador; ACL/CSRF, concorrência, falhas, celular, teclado/foco/axe e rascunhos; sensor de regressão                                       |
| COB-OPS-01        | Preparar candidato, publicar e homologar com liberação operacional                           | Gates anteriores                                           | Imagem/digest/migrações/credenciais/conta conferidos, workflow financeiro dedicado e preflight humano, teste real autorizado e rollback mantendo callbacks     |

T1/T2/T3 têm critérios BDEV-01–07 e tarefas em
[order-billing-development](../../.specs/features/order-billing-development/spec.md).
Essa primeira fatia comprova a fronteira financeira no motor n8n e prepara a
UI. Não declarar transporte completo apenas porque uma mensagem foi gravada
na outbox. Não declarar sessão/login real a partir do ator de fixture.

COB-DEV-03 também precisa conectar esses adaptadores ao desenvolvimento
interativo da API/worker/frontend. O ensaio de T2 sobe e descarta seus próprios
recursos; não substitui um ambiente permanente para avaliar a futura UI.
Preparar essa composição preservando o n8n DEV de atendimento existente,
com simuladores e configuração próprios, antes da integração visual final.

### Decisões de execução e isolamento

- Containers de teste novos, rede Docker interna sem saída e portas somente
  em loopback. Nenhum banco/container existente é reaproveitado para resets.
- Mesmo gerador para produção e DEV. O simulador substitui somente as chamadas
  InfinitePay; o CRM conserva domínio, autorização, filas e transações reais.
- Links fictícios mantêm o formato autorizado pelo domínio, mas não devem ser
  abertos. Esta fatia é um ensaio técnico, não um checkout visual local.
- A correção não cancela o link anterior no provedor. Exige vencimento e
  conferência; callbacks tardios conservam recebimentos e pedem revisão.
- Preparar e revisar configuração não autoriza ativar flags, migrar banco
  remoto, publicar workflow nem fazer pagamento ou enviar WhatsApp real.

### Fora do caminho crítico

COB-DASH-01 e COB-STORE-01 permanecem separados. Não alterar a central nem o
domínio Pix da loja para concluir cobranças pelo chat. Aprovação do protótipo
e disponibilidade do redesign não são inferidas de testes automatizados.

### Primeira fatia implementada

COB-DEV-01/02, COB-READY-01 e COB-API-READY foram implementados nesta worktree.
Há perfil DEV do mesmo gerador, ensaio financeiro no n8n real e projeção dos
vínculos de correção/retry persistidos. O ensaio aprovou nove cenários locais;
o gate integrado aprovou 2.002 testes, com 24 skips condicionais existentes
e build concluído. A matriz PostgreSQL financeira aprovou 46 cenários.
Evidências e revisão final ficam nas tarefas/validação de
`order-billing-development`. Os demais itens da tabela continuam pendentes.
