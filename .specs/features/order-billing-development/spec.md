# Cobranças: ambiente de desenvolvimento verificável

Autorização de 08/11/2026: revisar tudo que falta e executar as frentes
independentes em paralelo. Complementa COB-01–16 e BAPI-01–10, sem alterar
as decisões das ADRs 058/066. Plano completo na RFC 047.

## Problem Statement

O backend está integrado, mas os testes do workflow financeiro executam
expressões em fixtures. Falta comprovar a execução no n8n real contra a API
e o PostgreSQL locais. O checkout publicado da loja cria pedidos após o
pagamento; não substitui cobranças de pedidos existentes do CRM.

## User Stories

- Como desenvolvedor, quero executar o workflow financeiro no n8n real sem
  criar links ou enviar mensagens reais.
- Como operador, quero repetir pagamentos e falhas e verificar o saldo
  persistido, sem depender de uma conta financeira.
- Como integrador do frontend, quero um contrato atual que permita conectar
  chat e pedido após o redesign, sem reimplementar o domínio.

## Assumptions & Open Questions

| Assumption                | Chosen default                                        | Rationale                                                              |
| ------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Isolamento                | Containers e rede locais exclusivos, dados sintéticos | Docker local autorizado e nenhuma mudança de produção necessária       |
| Paridade                  | Um gerador compartilhado, perfil DEV explícito        | Evita duas implementações financeiras divergentes                      |
| URLs do checkout fictício | Formato HTTPS já autorizado pelo CRM, nunca navegadas | Preserva a validação de produção; esta fatia não cria checkout visual  |
| Autenticação              | Credenciais sintéticas e atores de fixture            | Prova a fronteira financeira; não substitui teste de login/sessão real |
| Redesign                  | Frontend definitivo continua dependente dessa entrega | Preserva o trabalho de outra pessoa e a decisão do proprietário        |

Open questions: none for this delivery. Credenciais/conta e pagamentos reais
são gates operacionais posteriores, não perguntas resolvidas por fixtures.

## Requisitos e critérios de aceite

- BDEV-01: WHEN o perfil de produção é gerado, THE generator SHALL preservar
  endpoints, autenticação, grafo e validações existentes; o perfil DEV é uma
  entrada explícita, exportada inativa, com nome, paths e credenciais próprios.
- BDEV-02: WHEN uma configuração DEV contém destino remoto, userinfo,
  expressão ou endpoint diferente dos destinos locais autorizados, THE
  generator SHALL rejeitá-la antes da execução; nenhuma configuração DEV
  relaxa a allowlist de URLs do domínio financeiro de produção.
- BDEV-03: WHEN o perfil DEV é executado, THE workflow SHALL usar o mesmo
  percurso de reserva, criação, validação e callback, substituindo somente
  destinos externos por simulador HTTP local com respostas sintéticas.
- BDEV-04: WHEN o ensaio local inicia, THE runner SHALL usar n8n real,
  PostgreSQL dedicado e runtime/rotas reais de cobranças, com rede sem saída
  externa, portas publicadas apenas em loopback e recursos próprios limpos
  ao encerrar, sem tocar outros containers ou bancos.
- BDEV-05: WHEN sinal de 3000 centavos é pago em pedido de 10000, THE CRM
  SHALL registrar recebido de 3000, saldo de 7000 e nenhuma quitação integral;
  WHEN os 7000 restantes são pagos por cartão em 3 parcelas, THE CRM SHALL
  registrar recebido de 10000, saldo zero e quitação integral, preservando
  os dois pagamentos e sem transformar parcelas em parcelas comerciais.
- BDEV-06: WHEN criação ou aviso de pagamento é repetido, THE flow SHALL
  produzir um link por reserva e um recebimento por transação; pagamento
  não confirmado ou abaixo do valor SHALL ser recusado; falha ao persistir
  callback SHALL impedir ACK de sucesso e permitir reentrega sem duplicar
  crédito. Uma falha após efeito externo SHALL impedir recriação automática.
- BDEV-07: WHEN a documentação é consultada, THE project SHALL distinguir
  teste do gerador, execução financeira no n8n, transporte simulado, login/UI
  e homologação real; publicar comandos reproduzíveis e registrar evidência
  e limites, mantendo frontend/redesign e ativação real como pendências.

## Requirement Traceability

| ID      | Task   | Relação                                               |
| ------- | ------ | ----------------------------------------------------- |
| BDEV-01 | T1     | COB-04/05/13/14; perfil de teste do mesmo workflow    |
| BDEV-02 | T1     | COB-13; isolamento de destinos e credenciais          |
| BDEV-03 | T1, T2 | COB-06/07; simulador substitui só a fronteira externa |
| BDEV-04 | T2     | COB-08/14; execução local e banco transacional reais  |
| BDEV-05 | T2     | COB-03/09; sinal, saldo e cartão parcelado            |
| BDEV-06 | T2     | COB-05/06/07/14; duplicidade e recuperação            |
| BDEV-07 | T3     | BAPI-01–10; integração futura e limites operacionais  |

## Out of Scope

Não executar pagamento, criar link InfinitePay real, enviar WhatsApp, acessar
segredos remotos, publicar workflow remoto, aplicar migração em produção ou
habilitar flags reais. Não implementar o redesign nem criar outro framework,
store global ou infraestrutura de produção. O simulador não comprova o
comportamento da InfinitePay nem oferece um checkout visual navegável.
Dashboard e divergência Pix/cartão da loja continuam em COB-DASH-01 e
COB-STORE-01. A suíte local não declara a feature inteira pronta para produção.
