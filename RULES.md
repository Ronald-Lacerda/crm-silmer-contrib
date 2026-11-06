# Regras do CRM Silmer

## Olist — escopo inicial de centavos exatos (05/11/2026)

A [ADR 062](docs/adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) /
[RFC 046](docs/rfc/046-olist-escopo-inicial-de-centavos-exatos.md), aprovada pelo PO,
restringe a exportação automática inicial a subtotal em centavos divisível pela
quantidade sem arredondamento. Frações permanecem válidas no CRM e bloqueiam
somente exportação; nenhuma inclusão parcial ou compensação entre linhas.
Identificador opaco em `infoAdicional`, produto e quantidade devem voltar
corretos; multiplicação exata do unitário retornado confere a linha, e ambos
os totais devem coincidir. F1 só fecha para esse subconjunto após prova API/UI;
os gates de conexão/ACL/runtime/piloto continuam separados. Sem nova infraestrutura.

## Evolução aprovada para implementação Olist e valores por tamanho

Decisão de 04/11/2026 na [ADR 057](docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md) / [RFC 050](docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md),
OLIST-01–50 e OLIST-PLAN-02. Estes pontos supersedem os trechos antigos
incompatíveis para o novo contrato; a implementação segue as fases e os
gates registrados na RFC e no plano de tarefas.

- Checkbox Habilitado Olist é ortogonal ao perfil e dono: usuário humano ativo
  habilitado opera Olist em qualquer Pedido com ficha/cadastro completos.
  Admin não herda envio; habilitação não concede Inbox, edição geral ou conexão.
- Buscar e criar cliente comprador, produto pai e variações/tamanhos ausentes,
  com dados válidos, reservas por identidade, vínculos e reconciliação por etapa.
  Não criar conta de funcionário nem sobrescrever cadastro remoto encontrado.
- Item CRM é grupo; linha de tamanho contém quantidade e subtotal informado.
  Total soma subtotais no backend, sem valor final independente digitado.
  Unitário ERP é derivado, preservando cada subtotal; inexatidão bloqueia só
  exportação, sem inventar resíduo/desconto ou preço legado.
- Cancelamento local terminal pré-exportação serve higiene/métricas/filas;
  não apaga história/pagamento/check nem estorna dinheiro. Enviado/vinculado/
  incerto não admite essa ação ou reabertura de edição; não há cancelamento ERP.
  Cancelamento conserva ACL comercial própria e não deriva do checkbox.
- Previsão de entrega substitui Entrega prometida e Aplicação substitui Técnica
  por item; chaves e templates históricos preservados, nova ficha v7 com gates.
- Loja mantém travas/gateway; adapter de completude não inventa dado faltante.
  Parâmetros ERP centralizados e piloto individual por ID privado, sem PII em diff.

As regras abaixo descrevem baseline anterior onde houver divergência expressa.
Nada neste registro habilita conta, muda produção ou substitui os gates da RFC.

## Cobranças InfinitePay — extensão aprovada (05/11/2026)

A [ADR 058](docs/adr/058-cobrancas-do-pedido-com-infinitepay.md) autoriza
cobranças de pedidos confirmados fora da loja, com entrada 0%, X% ou 100%,
Pix e cartão inclusive parcelado. Emenda a exclusão de recebimentos/saldo da
regra 16 somente para pedidos geridos pela integração. Sinal não preenche
“Pago em”; pagamento não confirma pedido. Condições e envio do link são
humanos. n8n verifica o provedor e mutações oficiais passam pela API.
APIs de datas não contornam quitação. Financeiro mantém seu check próprio;
loja e PAY-01–05 legados são preservados. Contrato
[COB-01–16](.specs/features/order-billing/spec.md), entrega COB-DEL-01 e
[runbook](docs/runbooks/order-billing.md).

## Exceção vigente — ponte Evolution/Baileys (29/10/2026)

A [ADR 050](docs/adr/050-evolution-baileys-como-ponte-do-whatsapp.md), autorizada
pelo proprietário, substitui a escolha de transporte da ADR 046 por Evolution
com Baileys. Autoriza gateway e banco exclusivo de transporte, sem Redis; o
n8n nunca acessa o banco CRM. Fluxos Meta e terceiros são preservados. Limpeza
WAHA/candidatos exige backup privado e referências verificadas. Contratos CRM,
reservas, epoch, idempotência, handoff e gates de identidade/entrega permanecem.
Não presumir liberação de conta nem menor risco de bloqueio. Estado em
[EVOL-01](.specs/features/crm-mvp/tasks.md) e no
[runbook](docs/runbooks/evolution-baileys.md). Exceções anteriores são históricas.

## Exceção atualizada — nova linha na Inbox por WAHA/WEBJS (28/10/2026)

A [ADR 046](docs/adr/046-retomar-waha-para-atendimento-da-nova-linha.md)
supersede a escolha de transporte da ADR 045 para a nova linha: WPPConnect
fica parado, sem pareamento ou `--no-sandbox`, e WAHA/WEBJS é retomado com
volumes novos. O destino é a Inbox real, sem atendimento de teste paralelo.
A conta anterior bloqueada não é reativada; seus volumes ficam preservados.
Mantêm-se n8n, API do CRM, autenticação, reservas e idempotência. A identidade
da nova conta foi confirmada em `WORKING` e o transporte publicado no workflow
principal preservado. Texto real de entrada, transferência, takeover e
resposta humana foram verificados; os gates restantes continuam em WAHA-01D.
Exibição de QR e resposta HTTP no-op não comprovam atendimento ponta a ponta.
Não repetir comandos antigos nem inferir menor risco de bloqueio.

## Exceção autorizada — piloto WAHA/WEBJS (27/10/2026)

A [ADR 043](docs/adr/043-piloto-whatsapp-waha-webjs.md) autoriza WAHA com WEBJS
somente para a linha temporária do piloto. Nessa fronteira, substitui a
exigência de API oficial da regra técnica 4; as reservas da regra 11 valem antes
de qualquer envio pelo transporte ativo. Mantêm-se n8n obrigatório, API do CRM,
autorização, idempotência, handoff definitivo e os demais gates. A escolha não
comprova pareamento, entrega real ou ausência de bloqueio.

## Financeiro — implementação autorizada em 22/10/2026

A [ADR 040](docs/adr/040-financeiro-com-fila-e-check-manual.md) aprova
o perfil restrito Financeiro e os [requisitos FINQ-01–15](.specs/features/financeiro/spec.md).
Somente pedidos confirmados, integralmente pagos e
não teste entram no universo financeiro; “Pago em” significa quitação integral,
com revisão do uso legado antes de ativar. “Nota criada” é conclusão humana
da rotina, separada do status comercial, com autoria, horário e reversão auditada.
Não altera a ficha ou as travas da loja, não implementa recebimentos/saldo e
não integra Olist/Sefaz. O Financeiro não herda permissões de Vendedor.
As regras de edição comercial e handoff abaixo continuam válidas.

O design existente é obrigatório: Fila e detalhe descreve composição e
interação, sem autorizar novo shell, tema, marca, tipografia ou componentes
paralelos. Usar [design.md](design.md), ADRs 035/036 e tokens do CRM.
Implementação e evidências em [FINQ-T01–T05](.specs/features/financeiro/tasks.md).
Homologação e conta real permanecem em FINQ-T06.

Complemento [ADR 041](docs/adr/041-consulta-administrativa-do-financeiro.md):
FINQ-16 autoriza consulta do Admin ativo às filas, contagens, detalhes e
histórico, preservando menu completo, login e permissões anteriores. Essa
consulta não concede concluir/desfazer a rotina financeira. O visual do print
foi rejeitado pelo PO e não é referência de aparência; usar o design real do
CRM. [ADR 042](docs/adr/042-perfis-e-requitacao-do-financeiro.md) complementa:
Usuários oferece Vendedor/Financeiro/Administrador; trocar perfil revoga
sessões. Reconfirmar outro valor exige nova quitação e novo check, preservando
histórico. Pagamento manual legado só qualifica após declaração explícita de
recebimento integral; salvar entrega não o libera (FINQ-17–19).

## Regras de produto

1. Toda mensagem válida entra na Caixa de Entrada e dispara automaticamente o n8n; a UI não inicia a automação.
2. Cliente é `Contact` com zero ou mais `ContactIdentity`: o cadastro humano pode preceder o canal. A chegada resolve contato e conversa, mas não confirma venda. Identidades só são ligadas por correlação verificável.
3. Kanban e Negócio estão aposentados (ADR 004); novas capacidades não reutilizam tabelas ou módulos históricos desse domínio.
4. Pedido possui somente `pendente` e `confirmado` (ADR 006). O preenchimento é progressivo e não linear.
5. O agente coleta na conversa e sugere internamente a abertura somente quando o cliente confirma que quer fechar. O responsável humano ou administrador cria o pedido pendente (ADR 056); a automação não o cria, inclusive por contratos antigos. O agente nunca confirma pedido nem altera preço, pagamento ou escolha humana já registrada. O acompanhamento durante atendimento humano não retoma o bot nem envia mensagens.
6. Preço, prazo garantido e regra comercial nunca são inventados pelo agente. Uma pessoa autorizada decide as condições.
7. Automação limita-se às capacidades de `AUTOMATION_EXECUTOR`, ao `automation_epoch` e aos gates; há desligamento por conversa e global.
8. Retries e duplicidades não criam contatos, conversas, pedidos ou envios duplicados. Efeitos oficiais são auditáveis.
9. Um cliente pode ter vários pedidos pendentes. O contrato legado do agente mantém no máximo um pendente por conversa até haver Assunto/Pedido alvo explícito (ADR 032). Confirmação e reabertura são humanas; reabrir preserva número e bloqueia impressão e PDF.
10. Pedido confirmado registra autor, horário, valor e condição. Só pedido confirmado pode ser impresso ou ter a ficha gerada em PDF.
11. A numeração começa em `01-CRM`, é reservada na criação e não depende da sequência legada.
12. Rose é a destinatária operacional da ficha. O compartilhamento manual do PDF pelo recurso nativo do aparelho é permitido (ADR 037); o encaminhamento operacional a Rose e eventual aviso automático ainda exigem homologação própria. O telefone, quando usado pela automação, vem de `secret://crm/order-recipient-phone` e nunca é versionado.
13. Gerar exige os pontos principais de cada item: Tipo de roupa, Cor, Quantidade calculada, Técnica, Tecido, Tamanhos e Gola; também exige origem da arte, entrega prometida, valor final e condição (ADR 020).
14. Rascunho pode ser salvo incompleto. Pendências bloqueiam gerar, sem impor colunas ou avanço linear. Adicionais e nome do pedido não bloqueiam.
15. Arte pertence ao pedido: cliente envia, Silmer cria ou sem estampa. “Sem estampa” exclui as duas outras opções. O bot só projeta resposta inequívoca e não substitui escolha humana.
16. Vendas e valor vendido contam apenas pedidos confirmados; recebimentos e saldo a receber ficam fora do MVP. As datas de pagamento e entrega não mudam status. Na central, a quitação exige declaração explícita de recebimento integral e data válida; a entrega grava o dia de São Paulo no servidor, sem alterar pagamento, status ou snapshot. São comandos humanos independentes para pedidos de atendimento confirmados, não teste, com ou sem conversa, do responsável ou administrador (ADR 059, ACT-04), supersedendo a restrição a manuais da ADR 039. Os demais contratos de datas do detalhe do pedido permanecem vigentes.
17. Rômulo Sutil Corrêa é o Responsável de Privacidade; a política do piloto foi aprovada após consulta jurídica. Aprovações externas de IA e recovery permanecem gates independentes.
18. A nova mídia enviada pelo vendedor no chat é preservada no RustFS até nova decisão de retenção, sem expurgo por sete dias ou fim da jornada (ADR 029; implementação existente, homologação e ativação em INBOX-MEDIA-1). Cleanup automático alcança somente rascunhos sem vínculo com mais de 24h, sob guardas de writer e remoção confirmada antes de liberar quota. O runtime legado de mídia de canal não promovida continua transitório até sua migração: remover bytes no fim da jornada ou em sete dias, o que ocorrer primeiro. Pedido, ficha, documentos comerciais válidos e auditoria seguem retenção própria.
19. Handoff e tomada humana são definitivos para o atendimento: a conversa segue com pessoa até encerrar e não volta ao bot (ADR 015).
20. Handoff nasce sem responsável e tem papel-alvo Vendedor (ADR 009). A reivindicação é atômica e exige pessoa ativa e elegível; editar, gerar ou reabrir pedido exige dono da conversa ou administrador, ou, para Pedido manual sem conversa, seu vendedor responsável ou administrador (ADR 032).
21. Pedido da loja do site (ADRs 027 e 028) é a única exceção às regras 5, 9, 10 e 16 quanto à confirmação humana e ao dia do pagamento digitado: nasce `confirmado`, sem conversa nem Contato, registrado pelo n8n (`AUTOMATION_EXECUTOR`, ação `store.order.record`) só depois de a InfinitePay confirmar o Pix, em nome da `system:loja-do-site`, ao preço do catálogo do CRM e com o dia do pagamento confirmado pelo gateway; fica travado (sem edição, reabertura, lastro ou arquivos) e conta como venda, salvo pedido de teste. A primeira impressão HTML ou geração bem-sucedida do PDF da ficha registra quem e quando e tira o pedido do aviso do Dashboard, sem mudar o status (ADRs 031 e 037).

A [ADR 059](docs/adr/059-central-de-acoes-e-performance-comercial.md) rege a
central de ações ([ACT-01–12, PERF-01–08 e CHK-01–08](.specs/features/dashboard-actions/spec.md),
ACT-T01). Lembretes são pessoais, versionados e auditados; adiar não resolve
pendência, sugestão não comprova promessa e nenhuma ação envia mensagem ou
retoma o bot. O crédito comercial é capturado para o responsável na confirmação,
separado do executor, e não é reconstruído com a posse atual. O checkpoint
diário das 08h usa o dia anterior em São Paulo e a apuração oficial; destinos
privados, snapshot cifrado imutável e reserva única por destinatário impedem
reenvio cego. Ativação e entrega real exigem o gate operacional ACT-T02.

## Regras técnicas já impostas

Exceção restrita à regra de produto 21 (ADR 038, LOJ-39–LOJ-41): administrador
humano ativo pode corrigir somente quantidade e valor das peças de produto
unitário da loja, após confirmação com o cliente, pelo comando dedicado da
API com sessão, CSRF, origem, idempotência e versão. O catálogo determina o
valor e o pagamento existente deve cobri-lo. O registro original do checkout,
pagamento, número, confirmação e primeira impressão são preservados; evento
e auditoria acompanham a correção na mesma transação. As demais operações
da loja continuam bloqueadas.

1. Frontend em Vue 3, Vue Router e Vite (ADR 001); nova biblioteca de estado ou framework exige autorização explícita.
2. Não manter estado de domínio em `window`; usar módulos isolados.
3. Toda interface opera por teclado, gerencia foco e anuncia mudanças com ARIA quando aplicável.
4. WhatsApp usa API oficial e é o canal obrigatório do primeiro lançamento. Instagram pertence a `CANAL-2` e não bloqueia o piloto WhatsApp.
5. Na futura migração entre canais, associar identidades ao mesmo Contato somente após correlação verificável e auditável; nunca por nome ou inferência da IA.
6. n8n é obrigatório para canais, OpenAI e orquestração. Falha de n8n é visível, sem fallback silencioso.
7. Toda mutação oficial passa por contrato autenticado, autorizado, idempotente e auditável do CRM; n8n nunca acessa diretamente o banco do CRM.
8. Dados pessoais seguem minimização, acesso por capacidade, auditoria e política de retenção aprovada. Controles de acesso devem refletir a implementação e as evidências atuais.
9. Mídia transitória legada usa volume privado sem backup; arquivos válidos são anexados ao pedido no RustFS interno (ADR 023). A nova mídia enviada do chat usa buckets privados próprios no RustFS existente, com acesso autorizado pelo CRM e recuperação sujeita a evidência de backup externo. Só a API fala com o RustFS dos arquivos do pedido; o pipeline de mídia do chat também usa worker e referências privadas autorizadas por conversa. Não há URL pública, link pré-assinado ou promoção automática a partir do canal. Recuperação externa permanece um gate próprio.
10. n8n v1 usa Basic Auth com `AUTOMATION_EXECUTOR`, idempotência, correlação, identidade de workflow e `application/problem+json`; sem HMAC/timestamp nesse contrato.
11. `message.send.requested` é reserva obrigatória de uso único antes da chamada à Meta. Timeout posterior vira resultado desconhecido e reconciliação; retry cego é proibido.
12. A reserva valida modo, `automation_epoch` e `source_revision` atuais; cada revisão inbound só pode ser consumida uma vez. Não há claim, lease ou token de rodada.
13. OpenAI é o provedor escolhido para produção. Produção com PII exige evidências aplicáveis de DPA, retenção, logging e ZDR; escolha do provedor não satisfaz esse gate. DPA e ZDR foram informados como entregues pelo responsável em 30/10/2026; retenção e logging seguem no [checklist OpenAI](docs/integrations/openai/README.md).
14. `PRINT_TEMPLATE` seleciona `ficha-canonical-v6` (ADR 025), com aprovação provisória do PO. Rose e Operação devem assinar a amostra física antes da produção; templates v2–v5 e hashes permanecem imutáveis.
15. Manter o deploy automático GitHub → EasyPanel existente; verificar imagem/digest, migrations, health, segredos, isolamento, rollback e recovery no ambiente alvo antes de declarar prontidão operacional.

## CHAN-WA-01 — Atendimento concentrado no WhatsApp (27/10/2026)

A ADR 044 supersede o atendimento ativo do site: site e Instagram encaminham
para WhatsApp sem coleta comercial, IA ou abertura de pedido. A loja mantém
seu checkout. O agente não oferece/coleta mochilas, bolsas e similares;
encaminha pedidos dessas categorias ao humano sem projetar rascunho.
Identidades e histórico não são unidos pelo clique.
