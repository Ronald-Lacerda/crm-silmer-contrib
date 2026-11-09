# RFC 058 — Retirada da página Financeiro

Data: 09/11/2026. Status: aceita pelo PO em 09/11/2026.
Decisão: [ADR 074](../adr/074-retirada-da-pagina-financeiro.md).
Requisito [FINQ-20](../../.specs/features/financeiro/spec.md); tarefa
[FINQ-T07](../../.specs/features/financeiro/tasks.md). Sem issue específica.
Antecedentes: RFCs [028](028-financeiro-com-fila-e-check-manual.md),
[029](029-consulta-administrativa-do-financeiro.md) e
[030](030-perfis-e-requitacao-do-financeiro.md).

## Contexto

A página `/financeiro` entregou ao perfil Financeiro a composição Fila e detalhe
e o check “Nota criada”, com consulta pelo Admin (ADRs 040, 041 e 042). A
homologação com a pessoa do Financeiro (FINQ-T06) não foi concluída. O PO
descontinuou a página: a feature caiu e deu lugar à integração Olist
(ADR 057).

Em 05/11/2026, a tarefa FINQ-DEPREC-01 registrou uma intenção mais ampla:
remover também o perfil, contrair tabelas e fazer a quitação vir só da cobrança
InfinitePay. Nenhum desses itens foi executado. Esta RFC trata da decisão
menor de 09/11/2026, que retira somente a interface.

## Proposta

Sai do frontend a tela `/financeiro`, sua rota e o item de menu, tanto para o
Admin quanto para o perfil Financeiro. As dicas da ficha do pedido deixam de
citar “liberar no Financeiro”.

O perfil Financeiro continua em Usuários, sem a tela. Na prática, vira operador
restrito do Olist:

| Conta                            | Home        | Menu                    |
| -------------------------------- | ----------- | ----------------------- |
| Financeiro com habilitação Olist | `/olist`    | Olist e Conta           |
| Financeiro sem habilitação Olist | `/conta`    | Conta                   |
| Admin                            | sem mudança | o atual, sem Financeiro |
| Vendedor                         | sem mudança | sem mudança             |

Quem abrir `/financeiro` não recebe a tela e vai para a home da própria conta.

Permanecem as rotas `/api/v1/finance/*`, o domínio
`modules/orders/src/domain/finance.js`, o repositório, as permissões `finance.*`,
as migrations 0042/0043, os dados e o histórico de checks. Não há migração
destrutiva.

`paid_on`, `finance_payment_review_required`, Dashboard e cobranças InfinitePay
não mudam: a quitação é gravada pelo repositório de pedidos, não pela tela.

O check “Nota criada” deixa de ser operável pela interface. Quem precisar disso
passa a usar o fluxo do Olist, sem promessa de equivalência funcional entre os
dois: o check era uma declaração humana de rotina concluída, e o fluxo Olist
gera vendas por suas próprias regras.

## Alternativas

1. **Manter a página.** Rejeitada. Conserva tela, testes e rotina para uma
   feature que o PO encerrou, e sugere que o check segue sendo o caminho oficial.
2. **Remover também API e dados.** Rejeitada nesta decisão. É destrutiva e
   difícil de reverter, atinge histórico, auditoria e o bloqueio de exclusão de
   contas com história financeira, e não é necessária para tirar a tela. Exige
   decisão separada, com backup e plano de contração próprios.
3. **Remover o perfil.** Rejeitada nesta decisão. Exigiria migrar contas e
   constraints de identidade (ROLE-01/02). Converter essas contas em Vendedor
   ampliaria acesso. Como habilitação Olist é ortogonal ao perfil (ADR 057), o
   perfil restrito segue útil para operar só o Olist.

## Impacto

| Área            | Efeito                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| Frontend        | Saem tela, rota, itens de menu, estilos e E2E do painel; ajustes de home e guarda de rota. |
| Perfil          | Só vê Olist, se habilitado, e Conta. Sem habilitação Olist, só Conta.                      |
| Admin           | Perde a entrada de consulta; mantém o restante do menu e o destino de login.               |
| API e ACL       | Sem mudança. As rotas ficam disponíveis, sem consumidor na interface.                      |
| Dados           | Sem mudança. Pedidos seguem elegíveis no servidor, sem novas marcações pela interface.     |
| Quitação        | Sem mudança, inclusive a revisão explícita de datas legadas nas Datas do pedido.           |
| Homologação     | FINQ-T06 cancelada: não há mais tela a homologar.                                          |
| OpenAPI         | Sem mudança, porque a API permanece.                                                       |
| ADRs anteriores | ADRs 040, 041 e 042 superadas somente na tela e no menu; os corpos não são editados.       |

Reverter o PR restaura a tela sem depender de migração. Os checks não feitos
no intervalo não aparecem sozinhos: uma eventual retomada precisa tratar os
pedidos acumulados em Aguardando.

A retirada de rotas, domínio, permissões, migrations ou dados, e do próprio
perfil, depende de nova decisão.
