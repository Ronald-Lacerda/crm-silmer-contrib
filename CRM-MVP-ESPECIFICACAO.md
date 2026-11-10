# CRM Silmer — Especificação de Produto do MVP

## Emenda Olist — centavos exatos (05/11/2026)

[ADR 062](docs/adr/062-olist-exportacao-com-unitario-exato-em-centavos.md) e
[RFC 046](docs/rfc/046-olist-escopo-inicial-de-centavos-exatos.md), aprovadas
pelo PO: exportação automática inicial somente com unitário exato em centavos,
sem arredondamento. Subtotais não divisíveis pela quantidade continuam válidos
no CRM e bloqueiam a exportação inteira antes de qualquer inclusão. Identidade
por linha e conferência exata de valores retornados/totais são obrigatórias;
F1 restrito depende da prova API e tela. Demais regras de produto preservadas.

## Evolução aprovada Olist e subtotal por tamanho em 04/11/2026

[ADR 057](docs/adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md) / [RFC 050](docs/rfc/050-geracao-assistida-de-pedidos-no-olist.md), requisitos OLIST-01–50,
tarefa documental OLIST-PLAN-02 e execução OLIST-T01–T26. Contrato aprovado,
implementação/piloto pendentes; prevalece sobre descrições históricas incompatíveis.

Cada usuário tem Habilitado Olist. Humano ativo habilitado pode gerar em
qualquer Pedido completo, sem posse/perfil implícito e sem liberar edição
geral. Buscar/criar comprador, produto e variações/tamanhos com vínculos seguros.
Item CRM continua grupo; linha de tamanho recebe quantidade/subtotal, total
calculado. Desconto de fábrica é expresso pelo subtotal, não por preço unitário
obrigatório. Legados não recebem valores inventados e loja preserva gateway.

Cancelamento CRM é higiene/métricas antes da exportação, terminal/auditado,
sem excluir dados ou cancelar/estornar ERP. Não editar após envio. Aplicação
e Previsão de entrega são os novos rótulos, inclusive na ficha v7 versionada.
Configuração comercial central e piloto individual em identidade privada.

## Evolução aprovada — cobranças InfinitePay (05/11/2026)

[ADR 058](docs/adr/058-cobrancas-do-pedido-com-infinitepay.md), após aprovação
do protótipo: responsável/admin cobra pedido confirmado com entrada 0%, X%
ou 100%. 0% não emite link; X% separa sinal e saldo; 100% cobra integral,
permitindo Pix ou cartão parcelado na InfinitePay. Sinal não é quitação.
Preço e condição são humanos, envio do link é humano e a confirmação de
pagamento é verificada no servidor. Recebimentos/saldo deixam de ser
diferidos somente nessa fronteira; loja, dois status comerciais, ficha e
check financeiro permanecem. Contrato
[COB-01–16](.specs/features/order-billing/spec.md).

## Evolução aprovada — Financeiro, Fila e detalhe (21/10/2026)

> **Tela retirada em 09/11/2026.** A [ADR 074](docs/adr/074-retirada-da-pagina-financeiro.md)
> e [FINQ-20](.specs/features/financeiro/spec.md) retiraram a página `/financeiro`
> e seu menu. Onde esta seção cita painel, filas na tela, menu ou check pela
> interface, vale a ADR 074. API, dados e histórico permanecem.

Definição do PO registrada na [ADR 040](docs/adr/040-financeiro-com-fila-e-check-manual.md)
e no [RFC 028](docs/rfc/028-financeiro-com-fila-e-check-manual.md).
Implementação autorizada em 22/10/2026, com complemento na
[ADR 042](docs/adr/042-perfis-e-requitacao-do-financeiro.md).
[FINQ-01–19](.specs/features/financeiro/spec.md) e
[FINQ-T01–T06](.specs/features/financeiro/tasks.md) detalham entrega e prontidão.

Financeiro é perfil restrito; entra em `/olist`, se tiver habilitação Olist, ou
em `/conta`, com somente esses itens no shell vigente. Até a retirada, consultava pedidos de todos os vendedores e
origens, exclusivamente confirmados, integralmente pagos e não teste, em
Aguardando/Concluídos. Sinal não qualifica; “Pago em” representa quitação
integral, com revisão dos registros legados antes da ativação. Consultava dados
do pedido e marcava “Nota criada” ao terminar sua rotina manual no Olist.
Conclusão e correção preservam autoria, horário e histórico, sem mudar
status, ficha, preço, datas ou travas da loja e sem certificar autorização Sefaz.

Não acessa atendimento, cadastro geral de clientes, Dashboard comercial,
administração ou edição comercial. O novo perfil não herda Vendedor. A
composição aprovada é Fila e detalhe; usar design, componentes, tokens, temas,
marca e navegação responsiva existentes, sem redesign. Integração Olist fica
para fase separada. A homologação com a pessoa do Financeiro e a criação da
conta real previstas na FINQ-T06 foram canceladas pela ADR 074.

A [ADR 041](docs/adr/041-consulta-administrativa-do-financeiro.md) acrescenta
FINQ-16: Admin ativo consulta as duas filas, contagens, detalhes e histórico,
mantendo menu completo e login atual. Consulta não concede conclusão/reversão
financeira. O PO rejeitou o visual do print; FINQ-12 exige usar a aparência
das telas e componentes reais do CRM. FINQ-PLAN-02 registra o complemento;
e as evidências de implementação estão no plano da fatia. Usuários substitui
Vendedores com seleção dos três perfis. Reconfirmar outro valor exige nova
quitação e novo check; datas manuais legadas exigem declaração explícita antes
de qualificarem a fila (FINQ-17–19).

> **Versão:** v8 — 05/10/2026\
> **Baseline:** ADRs 004, 006, 008, 009, 015–020; PR 142 integrada.\
> **Status:** atendimento e Pedidos implementados; produção depende de homologação, privacidade e operação.

## 1. Visão e escopo

O CRM Silmer substitui o Datacrazy e organiza conversas, clientes, pedidos e a
ficha usada pela operação. WhatsApp oficial é o canal do primeiro lançamento;
Instagram fica em `CANAL-2`. O chat do site usa a jornada n8n da ADR 026;
a loja do site registra pedidos pagos pela InfinitePay via n8n (ADRs 027 e
028), com os gates próprios de implantação e homologação.

A Caixa de Entrada é a superfície de atendimento e handoff. Pedidos é a
superfície comercial. Kanban e Negócio foram aposentados (ADR 004).
`historico-datacrazy/` é arquivo histórico, sem autoridade sobre o produto.

## 2. Autoridade do CRM e do agente

Cada mensagem válida dispara n8n automaticamente. n8n recebe/envia WhatsApp,
chama OpenAI e solicita efeitos por API autorizada e idempotente do CRM. Nunca
acessa seu banco diretamente nem mantém fonte paralela de dados comerciais.

Cliente é `Contact` + `ContactIdentity`. Mensagens resolvem contato e conversa;
a simples chegada não confirma venda. O agente consulta contexto autorizado,
coleta dados progressivamente e projeta respostas inequívocas no briefing e
no pedido pendente. Até o cliente confirmar que quer fechar, os dados ficam
na conversa. O agente sugere internamente a criação e o vendedor responsável
ou administrador autoriza o pendente, aproveitando a pré-ficha (ADR 056).
O acompanhamento continua no atendimento humano, sem retomar o bot;
sugestões, decisões e omissões anotadas permitem avaliar o agente.

Preço, prazo garantido, condição e confirmação de pedido dependem de pessoa.
O bot nunca inventa, negocia ou altera essas decisões. OpenAI é o provedor
escolhido para produção; escolher o provedor não aprova DPA, retenção, logging
ou ZDR. Produção com PII permanece sujeita às evidências aplicáveis.

O contrato n8n v1 usa três endpoints, Basic Auth de serviço,
`Idempotency-Key`, correlação, identidade do workflow e erros padronizados.
`message.send.requested` é a reserva obrigatória antes de chamar a Meta,
validada por `automation_epoch` e revisão inbound. Resultado incerto exige
reconciliação, sem retry cego.

## 3. Atendimento e papéis

A função humana operacional é Vendedor; capacidades administrativas são
ortogonais. Atendimento aparece em evidências antigas, sem reintroduzir uma
segunda função no runtime atual.

### Vendedor

Vendedor observa conversas, responde, assume atendimento, reivindica handoff,
repassa para outro vendedor e encerra. Handoff automático tem papel-alvo
Vendedor e nasce sem responsável; somente um claim elegível vence (ADR 009).
Depois de handoff ou takeover, a conversa segue com pessoa até encerrar e não
volta ao bot (ADR 015). Esses eventos invalidam execuções antigas.

Dono da conversa ou administrador cria, edita, gera e reabre pedido. Outro
vendedor pode consultar e imprimir pedido confirmado, mas não editar pela
interface ou API. Mudança de dono passa pela ação oficial do atendimento.

A função Vendedor, isoladamente, não aprova concessão de capacidades administrativas ou atos reservados ao administrador; estes exigem a role adicional `Admin` (capacidade COMMERCIAL_ADMIN). Gerar Pedido da própria conversa é a confirmação operacional autorizada pela ADR 006, sem conceder privilégios administrativos.

### Vendedor Silmer

O agente coleta dados e completa o Pedido pendente dentro de sua capacidade técnica; preço, condição e confirmação de Pedido permanecem humanos. Handoff suspende definitivamente a automação desse atendimento.

## 4. Pedido e ficha

Pedido tem apenas `pendente` e `confirmado` (ADR 006). Pode nascer do agente ou
de ação humana; uma conversa admite vários pedidos e no máximo um pendente.
O número é reservado na criação, desde `01-CRM`. A data do pedido e o nome
confirmado do cliente são fixados na confirmação humana (ADR 018).

A pessoa completa seções em qualquer ordem. Salvar rascunho incompleto é
permitido; gerar exige:

- ao menos um item com Modelo (`item.tipo`, FPI-05), Cor, Quantidade calculada pela grade,
  Técnica, Tecido, Tamanhos e Gola;
- origem da arte do pedido;
- entrega prometida, valor final e condição de pagamento.

Técnica é por item (`tipo_servico`). Arte é do pedido: cliente envia, Silmer
cria ou sem estampa; as duas primeiras podem coexistir e a última é exclusiva.
O bot só projeta técnica e origem inequívocas ainda não preenchidas. Estampa
do item é referência opcional; técnica geral antiga continua guardada, sem
edição ou impressão (ADR 020, TEC-01..08).

Gerar registra autor, horário, valor e condição, muda para confirmado e libera
impressão. Reabrir preserva número, registra autor e bloqueia impressão.
Depois da confirmação, “Gerar PDF” baixa a ficha aprovada no celular ou no
computador; onde houver compartilhamento nativo de arquivos, “Compartilhar PDF”
permite escolher o WhatsApp manualmente (ADR 037). A entrega automática à
operação continua sujeita a homologação separada.
Pagamento e entrega não mudam status automaticamente. No Pedido manual sem
conversa, Primeiro contato recebe a criação do pedido e só “Pago em” é
digitável nesse contrato (ADR 039). A central do Dashboard pergunta se o
pedido de atendimento confirmado foi pago integralmente e se o cliente já o
recebeu, com ou sem conversa. A quitação exige declaração explícita e data
válida; a entrega registra o dia de São Paulo no servidor. São decisões
independentes, autorizadas, versionadas e auditadas, que preservam o status,
o snapshot e a outra data. Pedidos de teste e da loja ficam fora desses
comandos. A ampliação da entrega supersede a restrição a manuais da ADR 039
([ADR 059](docs/adr/059-central-de-acoes-e-performance-comercial.md), ACT-04);
os contratos de datas do detalhe do pedido permanecem vigentes.

A fila pessoal reúne conversas a responder, handoffs disponíveis, pedidos a
completar e conferências de pagamento/entrega. Adiar só altera o lembrete;
sugestão após 48h sem resposta à última saída humana enviada não inventa
compromisso. Retorno agendado depende de decisão humana. A Inbox real continua
sendo o local de responder e assumir, sem envio pela central ou retorno ao bot.
Desempenho distingue valor vendido, pedidos, atendimentos, tomadas,
encerramentos e conversas com venda. O responsável recebe o crédito capturado
na confirmação, mesmo quando o administrador executa a ação; histórico sem
prova permanece sem atribuição, e pagamento/entrega não criam nova venda.

O checkpoint dos sócios é agendado no n8n às 08h todos os dias, no horário de
São Paulo, com o total e os valores por vendedor do dia civil anterior, mais
loja e sem atribuição. Usa a mesma apuração oficial, snapshot cifrado imutável
e reserva por destino privado, sem retry cego após resultado desconhecido.
Configuração e entrega real são homologadas separadamente; a implementação
começa desativada. Requisitos e fronteiras em
[ACT-01–12, PERF-01–08 e CHK-01–08](.specs/features/dashboard-actions/spec.md),
tarefa ACT-T01 e gate operacional ACT-T02.
Receber arquivo não confirma pagamento.

A ficha impressa usa `ficha-canonical-v6` (ADR 025, público por item e Modelo de malha), paginação com cabeçalho e campos
posteriores de produção vazios. Valor e condição não saem no papel. Aprovação
provisória do PO permite desenvolvimento; Rose e Operação devem assinar a
amostra física antes da produção. Templates v2–v5 e hashes permanecem intactos.

O inventário da planilha está em `CAMPOS-FICHA-E-JORNADA-P0-1.md`; as
exigências atuais do runtime são refinadas em
`.specs/features/pedidos-mvp/spec.md`, sem restaurar gates lineares antigos.

## 5. Gestão e sinais operacionais

Dashboard contabiliza somente pedidos confirmados: vendas, valor vendido e
peças. Reabertura retira o pedido do total de confirmados, preservando histórico.
Recebimentos, saldo e conciliação financeira estão fora do MVP.

Cliente sem resposta considera última saída efetivamente enviada e sem inbound
posterior por pelo menos 48 horas; pedido sem movimentação considera
`updatedAt`. Nenhum desses sinais mede chance de venda (REV-06..09).

As páginas observam eventos do CRM; edição preserva rascunho e conflito exige
revisão. Operação normal não depende de botão de atualização; erro real oferece
nova tentativa. Teclado, foco previsível e ARIA fazem parte do aceite.

## 6. Canal, arquivos e recuperação

Toda mensagem conhecida está processada ou em pendência visível. Não prometer
recuperação de mensagens ou bytes não observados. Mídia não promovida dura até
o encerramento ou sete dias, o que ocorrer primeiro, em volume privado.
Essa regra é do runtime legado: a mídia enviada pelo vendedor no chat fica
preservada no RustFS até nova decisão de retenção (INBOX-MEDIA-1), com
cleanup apenas de rascunhos sem vínculo após 24h. Validação e scan precedem
o envio; falha temporária não autoriza envio inseguro.

Arquivos comerciais válidos seguem retenção própria: o vendedor os envia e
baixa pela página do pedido, e eles ficam no RustFS interno (ADR 023), com o
bucket no backup off-host. Upload automático a partir do canal continua
desativado. Rose é a destinatária operacional da ficha; eventual
envio ou aviso automático exige fluxo próprio e homologação. Quando usado, o
telefone vem de `secret://crm/order-recipient-phone`, nunca do repositório.

Manter o deploy automático GitHub → EasyPanel hoje existente. A prontidão exige
checagens reais de domínio/HTTPS, isolamento, segredos, health, digest,
migrations, rollback, backups externos e recovery. Documentos e mocks não
substituem evidência do ambiente.

## 7. Privacidade e lançamento

A política do piloto foi aprovada após consulta jurídica; Rômulo Sutil Corrêa
é o responsável. Minimização, acesso por capacidade, criptografia, auditoria,
retenção, direitos do titular e tombstones seguem as regras aprovadas do P0.6.
A exceção solo interna não prova segregação nem permite inventar aceite externo.

O gate de lançamento combina WhatsApp real, n8n saudável, fluxo de pedido por
teclado, ACL negativa, replay e takeover seguros, ficha assinada, privacidade
OpenAI e operação recuperável. Rastreabilidade: ORC/INB/AGT/ORD/MSG/FIN/PRV,
CRM-1..4, OPS-1 e INT-1..4. A lista de tarefas é o plano de prontidão, e não
uma declaração de produção aprovada.

## 8. Fora do escopo e evolução

Estoque, ERP/fiscal, produção completa, app nativo, disparos em massa e
pós-venda automatizado. Instagram entra depois em `CANAL-2`, com identidades
correlacionadas explicitamente. Cobrança PIX, comprovante estruturado,
boas-vindas automáticas e automação do envio da ficha permanecem evolução
rastreada, sem bloquear confirmação humana do Pedido vigente.

## CHAN-WA-01 — Atualização aprovada em 27/10/2026

O proprietário concentrou o atendimento comercial no WhatsApp (ADR 044).
Site e Instagram encaminham por CTA explícito, sem qualificação/coleta.
Mochilas e bolsas saem da abordagem automática e são encaminhadas à pessoa.
Loja/checkout e históricos permanecem conforme seus contratos anteriores.
