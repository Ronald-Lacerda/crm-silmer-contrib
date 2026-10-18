# ADR 038 — Correção administrativa de quantidade da loja

- Data: 18/10/2026
- Estado: aceita por autorização emergencial do PO.
- Proposta: [RFC 026](../rfc/026-correcao-administrativa-quantidade-loja.md).
- Rastreabilidade: LOJ-39–LOJ-41, T135; commit da entrega T135.
- Emenda pontualmente ADRs 027, 028 e 031 quanto ao bloqueio de quantidade.

## Decisão

Oferecer correção administrativa dedicada de quantidade para produtos
unitários da loja, pela API autenticada e autorizada do CRM. O administrador
confirma a quantidade com o cliente; o preço continua vindo do catálogo e
precisa ser coberto pelo Pix existente. Não há nova cobrança ou envio de
mensagem neste comando.

Somente grade, peças, valor das peças, versão e atualização são corrigidos.
Pagamento, número, confirmação e primeira impressão são preservados.
Auditoria e evento são transacionais. O fingerprint do checkout original
permanece imutável, e seu replay não desfaz a correção. Repetições do comando
humano não geram outro efeito.

## Consequências

O bloqueio das demais operações da loja permanece. A ação aparece somente
para administrador e exige autenticação, CSRF, origem, idempotência e
versão na API. A capacidade é revalidada ao gravar. A ficha corrigida deve
ser gerada novamente; arquivos já baixados não são substituídos. A operação
confere frete separadamente, pois o registro inicial do checkout é mantido.
