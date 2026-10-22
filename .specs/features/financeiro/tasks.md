# Financeiro — Plano de entrega

**Requisitos:** [FINQ-01–FINQ-15](spec.md).
**Decisão:** [ADR 040](../../../docs/adr/040-financeiro-com-fila-e-check-manual.md)
e [RFC 028](../../../docs/rfc/028-financeiro-com-fila-e-check-manual.md).
**Atualização:** 21/10/2026. Somente planejamento autorizado nesta etapa;
não executar as tarefas de implementação abaixo por este registro.

## FINQ-PLAN-01 — Registrar o escopo aprovado

- [x] Registrar Fila e detalhe, confirmação + quitação integral, check manual,
      perfil restrito, design existente e integração Olist diferida.
- [x] Vincular requisitos, plano macro, gestão de usuários e fontes canônicas,
      distinguindo decisão aprovada de runtime ainda não implementado.
- Evidência: estes documentos e a decisão do PO nesta conversa em 21/10/2026.
  Checks e commit/push constam do fechamento da entrega documental.

## Implementação futura — todas as tarefas permanecem abertas

### FINQ-T01 — Perfil Financeiro e acesso mínimo

- [ ] Implementar a função humana Financeiro no schema e na política central,
      sem herdar Vendedor; adaptar criação/edição/listagem de contas pelo Admin.
- [ ] Preservar handoff exclusivo de Vendedor, login dos papéis existentes,
      capacidades administrativas e bloqueio de conta desativada. Histórico
      financeiro deve impedir exclusão destrutiva da conta.
- Requisitos: FINQ-01–03, FINQ-11; emenda planejada de ROLE-01/02/04 e USR-02.
- Fronteira futura: identity-access, migrations, identity API, contrato OpenAPI,
  gestão de usuários e testes de autorização/schema. Não editar dados reais.
- Verificação: testes positivos/negativos por papel e URL/API direta;
  `validate:phase0-decisions`, `test:phase0-decisions`, suítes de identidade
  afetadas e live com banco dedicado e sintético.

### FINQ-T02 — Elegibilidade, persistência e comandos financeiros

- [ ] Mapear “Pago em” como quitação integral; revisar uso legado e registrar
      evidência de saneamento antes de ativar, sem presumir sinal como quitação.
- [ ] Definir com Produto, antes de implementar os comandos, o tratamento de
      pagamento/check anteriores após reabertura, reconfirmação ou mudança de
      valor. Não presumir quitação ou conclusão válida para uma nova revisão;
      a política de reconferência/retorno à fila permanece pendente na spec.
- [ ] Implementar consulta e contagens filtradas no servidor, conclusão e
      reversão com estado próprio, autoria, relógio, versão e histórico auditável.
- [ ] Garantir transação, CSRF, idempotência, concorrência e revalidação de
      elegibilidade; preservar snapshot e travas da loja. Documentar API,
      migration compatível, rollback sem perda de histórico e resposta incerta.
- Requisitos: FINQ-04–11, FINQ-14–15. Depende de FINQ-T01.
- Fronteira futura: orders, repositórios, API, migrations, auditoria e OpenAPI;
  sem canal, n8n ou cliente Olist.
- Verificação: domínio, serviço, rotas, persistência live e cenários concorrentes
  com dados sintéticos; três origens e matriz completa de elegibilidade.

### FINQ-T03 — Entrada e composição Fila e detalhe no design vigente

- [ ] Abrir Financeiro no login desse perfil e restringir o shell existente
      a Financeiro/Minha conta; preservar os destinos dos demais papéis.
- [ ] Montar Aguardando e Concluídos, seleção de pedido e consulta lateral no
      desktop; adaptar navegação entre fila e detalhe no celular conforme os
      componentes e shell já usados pelo CRM.
- [ ] Reutilizar tokens, marca configurável, seleção neutra, Poppins, temas,
      espaçamento e padrões de jornada vigentes. Não copiar CSS do mockup,
      mudar identidade, redesenhar outras telas ou introduzir framework/store.
- Requisitos: FINQ-02–03, FINQ-06–07, FINQ-12–14. Depende de FINQ-T01/T02.
- Fronteira futura: router, shell, views/componentes locais e camada cliente.
- Verificação: build, `check:design-tokens`, lint e E2E responsivo em temas
  claro/escuro, desktop e 390×844, usando as regras de design atuais.

### FINQ-T04 — Check, correção, teclado e recuperação

- [ ] Ligar “Marcar nota criada”, feedback, Desfazer e “Voltar para aguardando”
      ao contrato; mostrar autoria, horário e histórico somente no contexto autorizado.
- [ ] Implementar carregamento, vazio, erro, conflito e salvamento com foco
      previsível, anúncios acessíveis e prevenção de conclusão fictícia.
- Requisitos: FINQ-08–14. Depende de FINQ-T02/T03.
- Fronteira futura: componentes do Financeiro e testes de interação.
- Verificação: E2E por teclado e axe, remoção da última linha, reversão,
  falha/resultado incerto, duplo clique, versão obsoleta e foco após atualização.

### FINQ-T05 — Revisão de QA, segurança e regressão

- [ ] Executar a matriz de aceite da spec; procurar vazamento em respostas,
      contagens, logs, atalhos de pedido/conversa e rotas não autorizadas.
- [ ] Comprovar que o Financeiro não muda pedido, pagamento ou dados da loja,
      não recebe handoffs e não chama o Olist. Validar regressão de vendedores,
      Admin, login, pedidos, impressão e loja.
- Requisitos: FINQ-01–15. Depende de FINQ-T01–T04.
- Evidência: testes e achados priorizados; não converter simulação em aceite real.
- Gates: `git diff --check`, `npm run validate`, `npm run test:e2e`,
  `npm audit --audit-level=high` e suites live afetadas, proporcionais à implementação.

### FINQ-T06 — Homologação e ativação do perfil

- [ ] Validar com a pessoa do Financeiro a fila, os dados de consulta, o
      significado do check e a correção, usando pedidos sintéticos.
- [ ] Documentar operação, criação/desativação da conta, revisão dos pagamentos
      legados, ativação, recuperação e rollback; só então criar a conta real pelo
      fluxo administrativo autorizado, sem credenciais em documentação ou commits.
- [ ] Atualizar evidências de entrega e concluir cada fatia com commit/push.
- Requisitos: FINQ-01, FINQ-04, FINQ-08–15. Depende de FINQ-T05.
- A integração Olist não pertence a esta tarefa nem é gate desta fase.

## Evolução separada — Olist

O PO informou que a operação usa o ERP Olist, antigo Tiny, plano Crescer e
redigitação manual. A pesquisa documental mostrou possibilidade de API,
mas não houve acesso à conta nem homologação. Não há tarefa de integração
autorizada neste plano. Uma fase futura deve definir cadastros/produtos,
preços por item, dados fiscais, permissões, credenciais, vínculo entre pedidos
e notas e tratamento de duplicidade antes de qualquer implementação.
