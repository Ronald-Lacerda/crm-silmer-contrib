# ADR 074 — Retirada da página Financeiro

Data: 09/11/2026. Status: aceita pelo PO em 09/11/2026, tanto a retirada da
página quanto a preservação de perfil, API e dados.
Proposta: [RFC 058](../rfc/058-retirada-da-pagina-financeiro.md).
Requisito [FINQ-20](../../.specs/features/financeiro/spec.md); tarefa
[FINQ-T07](../../.specs/features/financeiro/tasks.md). Sem issue específica.
Supersede as ADRs [040](040-financeiro-com-fila-e-check-manual.md),
[041](041-consulta-administrativa-do-financeiro.md) e
[042](042-perfis-e-requitacao-do-financeiro.md) **somente** no que diz respeito à
tela e ao menu. Não supersede a [ADR 057](057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md)
nem a [ADR 058](058-cobrancas-do-pedido-com-infinitepay.md).

## Contexto

A página `/financeiro` (Fila e detalhe, com o check “Nota criada”) foi
descontinuada pelo PO: a feature caiu e deu lugar à integração Olist. A
homologação FINQ-T06 não foi concluída. A retirada é só da interface e deve
continuar reversível.

## Decisão

1. **Interface.** Sair do frontend a tela `/financeiro`, sua rota e o item de
   menu do Admin e do perfil Financeiro. As dicas da ficha do pedido deixam de
   citar “liberar no Financeiro”.
2. **Perfil.** O perfil Financeiro continua existindo em Usuários. Sua home é
   `/olist` se a conta tiver a habilitação Olist; senão, `/conta`. Seu menu é
   Olist, se habilitado, e Conta. Uma conta Financeiro sem habilitação Olist só
   vê Conta. Na prática, é um operador restrito do Olist.
3. **Backend e dados preservados.** Permanecem as rotas `/api/v1/finance/*`, o
   domínio `modules/orders/src/domain/finance.js`, o repositório, as permissões
   `finance.*`, as migrations 0042/0043, os dados e o histórico de checks, sem
   migração destrutiva. Retirar backend ou dados exige decisão separada.
4. **Quitação inalterada.** `paid_on`, `finance_payment_review_required`,
   Dashboard e cobranças InfinitePay continuam iguais. A quitação é gravada pelo
   repositório de pedidos, não pela tela.
5. **“Nota criada”.** O check deixa de ser operável pela interface. Quem precisar
   disso passa a usar o fluxo do Olist, sem promessa de equivalência funcional
   entre os dois.

## O que muda nas decisões anteriores

| ADR | Deixa de valer                                                                                  | Continua valendo                                                                                             |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 040 | Composição Fila e detalhe, login no painel e shell com Financeiro/Minha conta (item 3); item 5. | Perfil próprio sem herdar Vendedor, universo no servidor e controle separado com auditoria (itens 1, 2 e 4). |
| 041 | Entrada no menu, consulta pela tela e regras visuais da tela.                                   | Leitura pela API para Admin ativo e negação dos comandos a essa capacidade.                                  |
| 042 | Implementação de Fila e detalhe no design atual e menu completo com a tela.                     | Usuários com três perfis, revogação de sessões, nova quitação e novo check, revisão de legado e histórico.   |

Os corpos dessas ADRs e de suas RFCs não são editados.

## Consequências

- A home e a guarda de rota do perfil Financeiro passam a depender da habilitação
  Olist. FINQ-20 define o contrato; FINQ-02 e os requisitos de tela ficam suspensos.
- As rotas financeiras ficam sem consumidor na interface, mas seguem sob sessão,
  ACL, CSRF, idempotência e auditoria. Um comando direto na API ainda funciona
  para quem tem a permissão.
- Os pedidos elegíveis deixam de receber marcações pela interface. Reativar
  a página exige tratar os pedidos acumulados em Aguardando; nada é inferido.
- O trecho da ADR 058 sobre o check humano de nota continua verdadeiro para
  dados e API, mas sem operação pela interface.
- FINQ-T06 é cancelada, inclusive a revisão de pagamentos reais prevista ali.
  A revisão explícita pelas Datas do pedido continua disponível caso a caso.
- A intenção de 05/11/2026 em FINQ-DEPREC-01 é mais ampla que esta decisão.
  Remover o perfil, contrair tabelas e fazer a quitação vir só da cobrança
  InfinitePay **não** estão autorizados aqui.
- Reverter o PR restaura a tela sem migração.
