# Cliente, Pedido manual e assuntos — requisitos

Decisão: [RFC 019](../../../docs/rfc/019-cliente-pedido-manual-e-assuntos.md) /
[ADR 032](../../../docs/adr/032-separar-pedido-conversa-e-assunto.md).

## Pedido sem canal

- **CP-01:** Vendedor autorizado pode cadastrar Contato com nome e telefone
  obrigatórios, e-mail opcional, sem criar Conversa ou presumir identidade de
  canal confirmada; nomes iguais não são unidos. Contatos antigos sem telefone
  permanecem consultáveis para correção.
- **CP-02:** Pedidos oferece “Novo pedido” com busca paginada por nome,
  seleção por teclado e cadastro de Contato ausente.
- **CP-03:** Criar Pedido para Contato selecionado cria um `pendente` numerado,
  sem Conversa, com vendedor responsável; replay da mesma chave retorna o
  mesmo Pedido, e novo comando cria outro Pedido intencional.
- **CP-04:** Dono do Pedido manual ou administrador pode editar seções,
  arquivos, gerar, reabrir e registrar lastro; outros vendedores leem e só
  imprimem confirmados. A API aplica a regra mesmo sem a interface.
- **CP-05:** Campos comerciais da ficha são editáveis no pendente; número,
  status, cliente e totais obedecem às regras do domínio. Nome do pendente
  acompanha o Contato; o confirmado conserva o snapshot.
- **CP-06:** A lista e a busca de Pedidos incluem os manuais. A criação não
  aciona automação; Pedido da loja continua pago e travado.

## Ciclo de atendimento

- **CP-07:** Dono da Conversa ou administrador pode encerrá-la com motivo
  `concluido` ou `sem_pedido`; o CRM registra autor, hora e auditoria.
- **CP-08:** Confirmar Pedido ou tempo sem mensagem não encerram a Conversa.
  Arquivar continua independente do fechamento.
- **CP-09:** Mensagem válida posterior a ciclo encerrado abre novo ciclo para
  a mesma identidade, preservando histórico e ordens anteriores sem duplicar
  a mensagem.
- **CP-10:** Inbox apresenta estado e ação de encerramento acessíveis por
  teclado, com foco, feedback e confirmação quando houver pendente.

## Assuntos e agente

- **CP-11:** Conversa pode conter vários Assuntos; um Assunto pode apontar a
  Pedido do mesmo Contato ou ser sem Pedido.
- **CP-12:** Mensagem pode ter vínculos com mais de um Assunto e pode ficar
  sem classificação até decisão; atribuição e correção são auditadas.
- **CP-13:** Pedido pode ser retomado em outro ciclo da mesma identidade ou
  de outra identidade do Contato após correlação verificável.
- **CP-14:** A Inbox lista todos os Pedidos e Assuntos da Conversa, com
  indicação do alvo atual; seleção humana tem prioridade sobre sugestão do
  agente.
- **CP-15:** Briefing do agente é isolado por Assunto. Projeção exige
  `subject_id` e `order_id` válidos e inequívocos; nunca escolhe “último
  pendente”.
- **CP-16:** Se a mensagem for ambígua, o agente pergunta a qual Pedido ela
  se refere ou transfere, sem mutar ficha ou condição comercial.
- **CP-17:** Assunto e Pedido alvo são validados com Contato, autorização,
  epoch, revisão, idempotência e auditoria; replays não criam Assunto, Pedido
  ou mensagem duplicados.
- **CP-18:** Até o workflow adotar esse contrato, a via legada mantém um
  pendente por Conversa. A ampliação depende de implantação CRM antes do n8n.

## Identificação por telefone

- **CP-19:** A busca e o roteamento de Contatos priorizam o telefone
  normalizado, incluindo números já associados a identidades de canal. O nome
  é o identificador legível na interface e o e-mail é opcional. Duplicatas de
  telefone exigem escolha humana; nenhuma identidade de canal é confirmada só
  porque alguém digitou um número.
- **CP-20:** A criação de Pedido manual exige telefone no Contato. Um Contato
  legado sem telefone continua visível e editável, mas precisa ser corrigido
  antes de receber um Pedido novo. O fluxo de Pedidos permite cadastrar o
  Contato e criar o Pedido em uma sequência contínua, com estados e erros
  acessíveis.
- **CP-21:** No chat direto do site, nome e telefone são coletados antes da
  primeira mensagem e guardados como informação declarada, separada de
  identidade WhatsApp confirmada. O CRM consulta possíveis coincidências de
  telefone somente para roteamento interno; o chat não recebe identificadores,
  histórico ou detalhes de Contatos encontrados. Duplicatas são ambíguas.
- **CP-22:** O chat do site atende e pode abrir Pedido novo na sessão própria
  mesmo sem WhatsApp ativo. Acesso ao histórico ou alteração de Pedido anterior
  exige futura confirmação do número pelo WhatsApp e correlação auditada. O
  atendimento direto por WhatsApp não pede novamente nome e telefone em um
  formulário do site. Quando o agente transfere, o vendedor responde por texto
  na caixa de entrada do CRM e o visitante recebe a resposta na mesma sessão
  do chat. O identificador aleatório da sessão permite consultar apenas as
  mensagens daquela conversa, sem usar o telefone declarado para essa leitura.
- **CP-23:** Depois de a Meta liberar o envio iniciado pela Silmer, um visitante
  do chat do site com telefone correspondente a um único cliente existente
  pode optar expressamente por continuar no WhatsApp. O CRM só anuncia
  “Vou te chamar no WhatsApp” quando a abertura da conversa estiver autorizada
  e reservada de modo idempotente. O primeiro envio usa um modelo aprovado;
  falha, indisponibilidade ou coincidência ambígua mantém o atendimento no
  chat do site e encaminha à equipe, sem promessa de envio.
- **CP-24:** A resposta recebida no WhatsApp ao contato iniciado confirma o
  controle do número. Só então uma correlação auditada pode vincular a
  identidade do chat ao mesmo Contato da identidade WhatsApp. As Conversas
  continuam separadas por canal, mas o histórico e os Pedidos passam a
  pertencer ao cliente correto no CRM. Antes dessa confirmação, o número
  digitado no site não libera histórico nem altera Pedido anterior.

## Cadastro completo do cliente

Decidido em 28/10/2026 a pedido do cliente Silmer
([RFC 035](../../../docs/rfc/035-cadastro-completo-do-cliente.md),
[ADR 047](../../../docs/adr/047-cadastro-completo-do-cliente.md)).

- **CP-25:** A ficha do Contato permite registrar tipo de pessoa (física ou
  jurídica), CPF ou CNPJ, nome completo ou razão social, @ do Instagram,
  inscrição estadual, CEP, cidade, UF, endereço, bairro, número, complemento,
  celular e e-mail. Cada campo é validado quando preenchido: CPF e CNPJ por
  dígito verificador (CNPJ numérico ou alfanumérico), CEP com 8 dígitos, UF
  entre as 27 unidades, número aceita “S/N” e inscrição estadual aceita
  “ISENTO”. Celular e e-mail continuam sendo os dados de contato já existentes.
- **CP-26:** O cadastro é opcional e não bloqueia Contato, Conversa ou Pedido.
  A ficha e a lista mostram “Cadastro completo” somente quando tipo de pessoa,
  documento, nome ou razão social, CEP, cidade, UF, endereço, bairro, número,
  celular e e-mail estão preenchidos; pessoa jurídica também exige inscrição
  estadual ou “ISENTO”. Complemento e Instagram são sempre opcionais.
- **CP-27:** O cadastro é dado pessoal: fica cifrado em repouso, só aparece no
  detalhe do Contato para quem tem `contact.read`, só é alterado por quem pode
  editar o Contato, usa versão esperada e chave de idempotência e gera
  auditoria e evento sem valores pessoais. A lista expõe apenas o estado
  completo/incompleto, nunca documento ou endereço.
- **CP-28:** Ao informar o CEP, a API consulta o ViaCEP e sugere endereço,
  bairro, cidade e UF, que continuam editáveis. Somente o CEP sai do CRM;
  a consulta é feita pela API, com tempo limite curto e limite de taxa. Falha,
  CEP inexistente ou indisponibilidade mantêm o preenchimento manual com
  mensagem acessível.

## Assunto da mensagem na dúvida do agente

Decisão: [ADR 048](../../../docs/adr/048-assunto-da-mensagem-so-na-duvida-do-agente.md).

- **CP-29:** Quando o CRM aceita um evento do agente com Assunto alvo
  explícito e válido, as mensagens de entrada daquele turno ficam ligadas ao
  mesmo Assunto como vínculo do agente. Vínculo existente ou decisão humana
  (inclusive “nenhum pedido”) nunca é sobrescrito; evento rejeitado não grava
  vínculo e replay só completa a abertura de Pedido que falhou, sem duplicar.
  Turno transferido por baixa confiança não recebe vínculo do agente.
- **CP-30:** Quando o agente transfere sem alvo por não saber a qual Assunto
  a mensagem se refere, as mensagens do turno ficam marcadas para revisão,
  sem mudar Pedido, ficha ou briefing. A Inbox pergunta “A qual pedido esta
  mensagem se refere?” só nessas mensagens e só para quem pode gerir os
  Assuntos; a faixa de assumir diz que o agente parou para não misturar
  pedidos.
- **CP-31:** A resposta do vendedor resolve a revisão e é auditada como
  atribuição humana; não encerra o handoff nem devolve a conversa ao agente.
  Separar a mensagem em novo Assunto não muda o Assunto que o agente usa.
  Sem revisão aberta não há controle por mensagem; com dois ou mais Assuntos
  a mensagem vinculada mostra o pedido, quem ligou e a opção de corrigir.
