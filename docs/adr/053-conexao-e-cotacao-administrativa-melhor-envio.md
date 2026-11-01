# ADR 053 — Conexão e cotação administrativa do Melhor Envio

Data: 01/11/2026. Status: aceita para conexão e cotação, conforme autorização
do proprietário nesta data. Complementa RFC 038 e T137/ME-0; implementação
T138, requisitos MEVC-01–08 e MEV-13 parcial.

## Contexto e decisão

A conta real está verificada, mas ainda não possui aplicativo OAuth. A
fundação de domínio e adapters existe, sem ligação com API/UI. A autorização
para seguir com a integração permite ligar a conta e consultar fretes; não
resolve as decisões comerciais, fiscais e de Expedição D1–D9 da
[RFC 038](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md).

O menu **Melhor Envio** e a API usam `COMMERCIAL_ADMIN`. A ação
`shipping.manage` fica fora das ações liberadas a qualquer Vendedor. Sessão
humana, origem e CSRF protegem comandos; o banco revalida o administrador.

OAuth solicita somente `shipping-calculate` e `shipping-companies`. O callback
volta a `/melhor-envio`; a UI remove código/estado da URL antes de enviá-los
ao comando autenticado. Estado aleatório expira em dez minutos, com hash
persistido, vínculo com usuário/sessão e uso único.

Client secret e chave de envelope própria ficam no ambiente privado da API.
Em complemento à proposta original da RFC, tokens ficam cifrados com
AES-256-GCM no PostgreSQL existente, com contexto autenticado por ambiente,
aplicativo e callback. Isso persiste a rotação sem reescrever variáveis do
EasyPanel. Réplicas serializam alterações no banco; renovação reserva seu
efeito antes da chamada remota. Falha incerta exige reconexão.

A cotação administrativa pede CEPs, peso, dimensões e valor segurado
explícitos. Não inventa peso ou embalagem padrão, não persiste cotação/CEPs e
não altera pedido ou total comercial. Respostas do provedor são projetadas e
validadas; erros livres não chegam à resposta, auditoria ou logs.

## Alternativas e consequências

Token pessoal fixo foi preterido por OAuth com rotação. Tokens em configuração
comercial foram rejeitados porque essa projeção atende consumidores de canais.
Não se adiciona serviço, banco, Redis ou dependência externa.

Compra, etiquetas, destinatário fiscal, cobrança, composição do Valor final e
Expedição permanecem nas fatias ME-1–ME-5 e decisões correspondentes. Esta ADR
não comprova homologação do Sandbox nem autoriza gastar saldo.

## Rastreabilidade

- [Contrato MEVC-01–08](../../.specs/features/melhor-envio/spec.md).
- [T138](../../.specs/features/pedidos-mvp/tasks.md).
- [RFC 038](../rfc/038-frete-e-etiqueta-pelo-melhor-envio.md).
- [Runbook](../runbooks/melhor-envio.md).
- [PR #258](https://github.com/romulosutil/crm-silmer/pull/258); sem issue
  específica prévia.
