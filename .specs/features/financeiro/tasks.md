# Financeiro — Plano de entrega

**Requisitos:** [FINQ-01–FINQ-19](spec.md).
**Decisão:** [ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md)
e [RFC 028](../../../docs/rfc/028-financeiro-com-fila-e-check-manual.md).
**Complemento:** [ADR 041](../../../docs/adr/041-consulta-administrativa-do-financeiro.md)
e [RFC 029](../../../docs/rfc/029-consulta-administrativa-do-financeiro.md).
**Atualização:** 22/10/2026. Implementação autorizada pelo PO, incluindo
seletor de três perfis em Usuários e nova quitação/check após mudança do valor.
Complemento: [ADR 042](../../../docs/adr/042-perfis-e-requitacao-do-financeiro.md).

## FINQ-PLAN-01 — Registrar o escopo aprovado

- [x] Registrar Fila e detalhe, confirmação + quitação integral, check manual,
      perfil restrito, design existente e integração Olist diferida.
- [x] Vincular requisitos, plano macro, gestão de usuários e fontes canônicas,
      distinguindo decisão aprovada de runtime ainda não implementado.
- Evidência: estes documentos e a decisão do PO nesta conversa em 21/10/2026.
  Checks e commit/push constam do fechamento da entrega documental.

## Complemento documental aprovado

### FINQ-PLAN-02 — Consulta administrativa e design preservado

- [x] Registrar FINQ-16: Admin consulta o painel com menu completo e login
      preservados, sem herdar os comandos de conclusão/correção do Financeiro.
- [x] Registrar a rejeição explícita do visual do print. Somente a organização
      Fila e detalhe permanece; a aparência deve seguir as telas e componentes do CRM.
- Evidência: complemento do PO nesta conversa em 21/10/2026. Entrega somente
  documental; as tarefas FINQ-T01–T06 abaixo continuam abertas.

## Implementação autorizada

### FINQ-T01 — Perfil Financeiro e acesso mínimo

- [x] Implementar a função humana Financeiro no schema e na política central,
      sem herdar Vendedor; adaptar criação/edição/listagem de contas pelo Admin.
- [x] Preservar handoff exclusivo de Vendedor, login dos papéis existentes,
      capacidades administrativas e bloqueio de conta desativada. Histórico
      financeiro deve impedir exclusão destrutiva da conta.
- [x] Autorizar leitura de Financeiro para Admin ativo (`COMMERCIAL_ADMIN`),
      sem trocar o perfil e sem conceder os comandos de concluir/desfazer por
      essa capacidade. Cobrir autorização da tela, contagens, detalhes e histórico.
- [x] Renomear a tela para Usuários e permitir Vendedor, Financeiro e
      Administrador; auditar troca, revogar sessões e bloquear autoalteração de perfil.
- Requisitos: FINQ-01–03, FINQ-11, FINQ-16/17; emenda de ROLE-01/02/04 e USR-02.
- Fronteira futura: identity-access, migrations, identity API, contrato OpenAPI,
  gestão de usuários e testes de autorização/schema. Não editar dados reais.
- Verificação: testes positivos/negativos por papel e URL/API direta;
  `validate:phase0-decisions`, `test:phase0-decisions`, suítes de identidade
  afetadas e live com banco dedicado e sintético.

### FINQ-T02 — Elegibilidade, persistência e comandos financeiros

- [x] Mapear “Pago em” como quitação integral; migration marca datas manuais
      legadas para revisão explícita, sem presumir sinal como quitação. O
      saneamento dos registros reais permanece no gate operacional FINQ-T06.
- [x] Registrar decisão do PO: reconfirmar outro valor exige nova quitação e
      novo check, preservando histórico; FINQ-18/19 e ADR 042.
- [x] Implementar consulta e contagens filtradas no servidor, conclusão e
      reversão com estado próprio, autoria, relógio, versão e histórico auditável.
- [x] Garantir transação, CSRF, idempotência, concorrência e revalidação de
      elegibilidade; preservar snapshot e travas da loja. Documentar API,
      migration compatível, rollback sem perda de histórico e resposta incerta.
- Requisitos: FINQ-04–11, FINQ-14–15. Depende de FINQ-T01.
- Fronteira futura: orders, repositórios, API, migrations, auditoria e OpenAPI;
  sem canal, n8n ou cliente Olist.
- Verificação: domínio, serviço, rotas, persistência live e cenários concorrentes
  com dados sintéticos; três origens e matriz completa de elegibilidade.

### FINQ-T03 — Entrada e composição Fila e detalhe no design vigente

- [x] Abrir Financeiro no login desse perfil e restringir o shell existente
      a Financeiro/Minha conta; preservar os destinos dos demais papéis.
- [x] Acrescentar Financeiro ao menu completo do Admin, mantendo seu login
      atual e todas as áreas existentes; exibir somente consulta nesse contexto.
- [x] Montar Aguardando e Concluídos, seleção de pedido e consulta lateral no
      desktop; adaptar navegação entre fila e detalhe no celular conforme os
      componentes e shell já usados pelo CRM.
- [x] Reutilizar tokens, marca configurável, seleção neutra, Poppins, temas,
      espaçamento e padrões de jornada vigentes. Não copiar CSS do mockup,
      mudar identidade, redesenhar outras telas ou introduzir framework/store.
- [x] Usar as telas reais, componentes e tokens atuais como referência e aceite
      visual. O print da conversa foi rejeitado e não deve ser reproduzido.
- Requisitos: FINQ-02–03, FINQ-06–07, FINQ-12–14, FINQ-16. Depende de FINQ-T01/T02.
- Fronteira futura: router, shell, views/componentes locais e camada cliente.
- Verificação: build, `check:design-tokens`, lint e E2E responsivo em temas
  claro/escuro, desktop e 390×844, usando as regras de design atuais.

### FINQ-T04 — Check, correção, teclado e recuperação

- [x] Ligar “Marcar nota criada”, feedback, Desfazer e “Voltar para aguardando”
      ao contrato; mostrar autoria, horário e histórico somente no contexto autorizado.
- [x] Implementar carregamento, vazio, erro, conflito e salvamento com foco
      previsível, anúncios acessíveis e prevenção de conclusão fictícia.
- Requisitos: FINQ-08–14. Depende de FINQ-T02/T03.
- Fronteira futura: componentes do Financeiro e testes de interação.
- Verificação: E2E por teclado e axe, remoção da última linha, reversão,
  falha/resultado incerto, duplo clique, versão obsoleta e foco após atualização.

### FINQ-T05 — Revisão de QA, segurança e regressão

- [x] Executar a matriz de aceite da spec; procurar vazamento em respostas,
      contagens, logs, atalhos de pedido/conversa e rotas não autorizadas.
- [x] Comprovar que o Financeiro não muda pedido, pagamento ou dados da loja,
      não recebe handoffs e não chama o Olist. Validar regressão de vendedores,
      Admin, login, pedidos, impressão e loja.
- [x] Validar consulta administrativa às duas filas, contagens, detalhes e
      histórico, menu completo e login preservados; provar ausência das ações
      financeiras na UI e negação dos comandos pela API para Admin sem esse perfil.
- [x] Conferir aderência às telas reais e ao design vigente do CRM, sem usar
      a aparência do print rejeitado como referência ou resultado esperado.
- Requisitos: FINQ-01–19. Depende de FINQ-T01–T04.
- Evidência: testes e achados priorizados; não converter simulação em aceite real.
- Gates: `git diff --check`, `npm run validate`, `npm run test:e2e`,
  `npm audit --audit-level=high` e suites live afetadas, proporcionais à implementação.

### FINQ-T06 — Homologação e ativação do perfil

- [ ] Validar com a pessoa do Financeiro a fila, os dados de consulta, o
      significado do check e a correção, usando pedidos sintéticos.
- [x] Documentar operação, criação/desativação, revisão de pagamentos legados,
      ativação, recuperação e rollback no [runbook](../../../docs/runbooks/financeiro.md).
- [ ] Homologar e revisar pagamentos reais; só então criar a conta real pelo
      fluxo administrativo, sem credenciais em documentação ou commits.
- [x] Atualizar evidências técnicas da entrega; commit/push atômicos na branch
      `codex/financeiro-painel`, com fechamento na PR de implementação.
- Requisitos: FINQ-01, FINQ-04, FINQ-08–15. Depende de FINQ-T05.
- A integração Olist não pertence a esta tarefa nem é gate desta fase.

## Evolução separada — Olist

O PO informou que a operação usa o ERP Olist, antigo Tiny, plano Crescer e
redigitação manual. A pesquisa documental mostrou possibilidade de API,
mas não houve acesso à conta nem homologação. Não há tarefa de integração
autorizada neste plano. Uma fase futura deve definir cadastros/produtos,
preços por item, dados fiscais, permissões, credenciais, vínculo entre pedidos
e notas e tratamento de duplicidade antes de qualquer implementação.

## Evidências técnicas — 22/10/2026

- Node 24.20.0/npm 11.19.0: `npm run validate` (formatação, tipos, lint,
  fronteiras, tokens, validadores, 1111 testes aprovados e build; 5 skips de
  suítes que exigem configuração externa no comando unitário).
- PostgreSQL 17 local descartável, somente dados sintéticos:
  `test:identity:live` 13/13, `test:commercial:live` 38/38 e
  `test:finance:live` 10/10, sem skips. Casos Financeiro incluem projeção
  mínima, paginação, papéis, replay, concorrência, transação única via xmin,
  rollback de auditoria, legado, novo valor, loja e histórico imutável.
- `npm run test:e2e -- --workers=4`: 324 aprovados, 7 cenários históricos
  já desativados; inclui 24 cenários de Financeiro/Usuários/revisão de pagamento,
  teclado, foco, axe claro/escuro e celular 390×844. Execução isolada do build
  de validação para evitar alteração de assets durante a navegação.
- `npm audit --audit-level=high`: zero vulnerabilidades. `git diff --check`
  sem erros. Revisão especializada sem findings bloqueantes após corrigir
  o salvamento de entrega que liberava pagamento legado sem declaração.
- Capturas são da interface compilada com dados sintéticos e design do CRM;
  não constituem homologação operacional. FINQ-T06 continua aberta: conferir
  pagamentos reais e homologar com a pessoa do Financeiro antes de criar conta real.

## FINQ-DEPREC-01 — Descontinuar o módulo Financeiro (05/11/2026)

Decisão do PO em 05/11/2026. A cobrança InfinitePay ainda está em
implementação (commit `9c729681`, fora do master); nada abaixo começa antes
de a quitação conciliada estar disponível.

- [ ] Registrar a decisão: novo ADR que supersede 040/041/042 e emenda o
      058 e COB-01/09/10.
- [ ] Remover a rota `/financeiro`, o perfil Financeiro e o item de menu.
- [ ] Migração contract das tabelas `crm.order_finance` e
      `crm.order_finance_events`, da coluna
      `crm.orders.finance_payment_review_required` e do trigger
      `invalidate_finance_amount` (expand 0043), somente após verificação.
- [ ] Remover testes, CSS e runbook do Financeiro.
- [ ] Quitação passa a vir só da cobrança InfinitePay conciliada.
