# Ficha impressa por item — tarefas

Requisitos: [spec.md](spec.md). Decisão:
[ADR 078](../../../docs/adr/078-ficha-impressa-por-item.md) e
[RFC 061](../../../docs/rfc/061-ficha-impressa-por-item.md).

### FPI-T01: implementação e pacote de revisão

- [ ] Criar `ficha-canonical-v8` com a folha por item, a folha extra e o conteúdo
      de fábrica (FPI-01 a FPI-04, FPI-06 a FPI-08 e FPI-10).
- [ ] Entregar a Poppins na ficha impressa sem serviço externo de fontes,
      dentro da política de segurança da rota (FPI-08).
- [ ] Aplicar o rótulo "Modelo" no formulário do item, nos dados do atendimento,
      na lista de itens com valores, nas pendências e no resumo da Caixa de
      Entrada, com os testes correspondentes (FPI-05).
- [ ] Gerar as amostras sintéticas v8, o relatório de revisão e o registro de
      aprovação pendente em `docs/phase0/`, com a nova contagem de campos.
- Depends on: none.
- Done when: FPI-01 a FPI-08 e FPI-10 têm evidência nas amostras; templates v2 a
  v7 e seus hashes intactos; `PRINT_TEMPLATE` em v6 (FPI-09).
- Gate: checks do projeto e `git diff --check`, sem PII nas amostras.

### FPI-T02: aprovação das amostras e troca de `PRINT_TEMPLATE`

- [ ] Registrar a aprovação provisória do PO vinculada ao hash das amostras v8.
- [ ] Trocar `PRINT_TEMPLATE` para `ficha-canonical-v8` em commit próprio.
- Depends on: FPI-T01.
- Done when: a validação aceita a v8 com o registro e o recusa sem ele (FPI-09).

### FPI-T03: assinatura física e produção

- [ ] Imprimir as amostras na impressora laser da fábrica e escrever à caneta nas
      linhas pautadas, na linha "Conferido" e nas caixas.
- [ ] Conferir a legibilidade do visual do design system nessa impressora e se a
      margem esquerda serve para arquivar em pasta.
- [ ] Confirmar com Rose e Operação se as cores da arte precisam de outro registro.
      Se precisarem, abrir nova decisão.
- [ ] Colher a assinatura física de Rose e Operação e registrar a evidência sem PII.
- [ ] Liberar a v8 em produção.
- Depends on: FPI-T02.
- Done when: papel assinado registrado conforme o gate de produção (FPI-09).

### FPI-T04: conferir "tipo de roupa" nas mensagens do bot

- [ ] Verificar nos workflows publicados do n8n se o bot usa "tipo de roupa" nas
      mensagens ao cliente.
- [ ] Registrar o resultado aqui. Se o texto existir, levar a mudança ao PO antes
      de alterar o workflow: FPI-05 não altera o contrato do bot.
- Depends on: none.
- Done when: resultado registrado, com o ID e a versão dos workflows conferidos.
