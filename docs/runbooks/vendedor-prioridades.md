# VND-L05 — Triagem prioritária do Vendedor

Contrato: AGT-01–05/08, ORC-03/05/07;
[ADR 063](../adr/063-triagem-prioritaria-do-vendedor.md) e
[RFC 051](../rfc/051-triagem-prioritaria-sem-inferir-regras-comerciais.md).

## Comportamento e limites

`mvp-simple-23` encaminha perguntas explícitas de mínimo/viabilidade e opções
de quantidade para o vendedor, sem inferir regras de uma conversa. Mantém
dados inequívocos; alternativas não sobrescrevem quantidade. Prazo desejado
hoje/amanhã transfere antes da ficha completa, com pendências no resumo.
Enviar arte/pagar hoje não representa prazo de entrega. Perguntas de campos
já preenchidos seguem para o próximo ponto. Preço e condições continuam humanos.

Não há catálogo novo ou mínimo fixo. Nome de produto isolado não provoca
rejeição; a pessoa confirma viabilidade. As redes textuais não cobrem toda
paráfrase, e a revisão humana da ficha continua necessária. O percentual
preenchido é completude de dados, não aprovação comercial.

## Verificação local

Usar Node 24.20.0/npm 11.19.0 e dados exclusivamente sintéticos:

```powershell
node --test test/n8n-vendedor-prioridades.test.js test/n8n-vendedor-aprendizados.test.js test/n8n-vendedor-aprendizados-l02.test.js test/n8n-vendedor-l03.test.js test/n8n-adversarial-conversations.test.js test/n8n-order-assistance.test.js
npm run validate
npm run test:e2e
npm audit --audit-level=high
git diff --check
```

Os testes executam os Code nodes reais em VM; não comprovam extração do
modelo, entrega no WhatsApp nem comportamento da versão publicada.
Snapshots DEV/local simulam transporte. Conservar IDs, posições, settings e
conexões do principal ao atualizar código gerado pelo renderer; o renderer
legado não reproduz esses metadados operacionais integralmente.

## Publicação e rollback

1. Exportar o principal vivo para backup privado e registrar versão/hashes,
   sem conteúdo, credenciais ou parâmetros privados em logs/PR.
2. Comparar a implementação com os corpos vivos, incluindo overlays de turnos,
   guardrail e política de abertura humana. A versão `evolution-baileys-1-turns-1`
   não comprova que L03/L04 foram publicadas integralmente.
3. Preparar delta revisado apenas do normalizador/prompt usando
   `ops/n8n/patch-vendedor-prioridades.mjs`. O script recebe cinco caminhos:
   export vivo, canônico anterior, canônico posterior, manifesto revisado e
   candidato novo. O manifesto contém os SHA256 exatos dos campos vivos
   `Normalizar decisão da IA (MVP).jsCode` e
   `Atendente virtual Silmer (MVP).systemMessage`, após revisão humana dos
   corpos. Nunca aprovar automaticamente hashes extraídos do export. O script
   recusa drift, trechos ausentes/ambíguos, dados fixados e sintaxe inválida;
   não executa código nem publica. Cabeçalhos operacionais são preservados e
   sua identificação de release deve ser revisada separadamente. Não importar
   o snapshot Meta, substituir contexto, remover wrappers nem aplicar hunks que
   não correspondam exatamente ao export revisado.
4. Conferir igualdade de IDs, credenciais, URLs, nós, conexões, settings,
   retenção, mídia, abertura humana, epoch/revisão e reservas. Publicar somente
   o candidato verificado e conferir o export posterior.
5. Validar sem replay/envio a clientes; eventual canário deve ser sintético e
   isolado. Observar os primeiros turnos reais antes de declarar ganho.

Drift ou ausência de trecho exige revisar o delta sobre o export atual;
nunca substituir a versão viva pela baseline para fazer o patch passar.
Reverter pelos nós/cabeçalhos do backup anterior efetivamente publicado,
preservando a barreira humana da ADR 056. Não restaurar o banco, recriar
pedidos ou reenviar mensagens.

Estado desta entrega: implementação preparada; publicação e observação no
workflow Evolution devem ser registradas separadamente com evidência real.

## Evidência de 06/11/2026

Sobre a master atual, com Node 24.20.0/npm 11.19.0: `npm run validate`
aprovado, com 1.806 testes aprovados e 19 ignorados; inclui tipos, lint,
fronteiras, contratos e build reproduzível. E2E/axe: 505 aprovados, sete
ignorados, sem falhas ou retries consumidos na rodada final.
Os 39 cenários de triagem e patch offline passaram; diff check limpo. Os
snapshots preservam metadata, IDs, conexões e settings; o principal altera
somente prompt, normalizador e cabeçalhos da versão canônica.

A composição com SIL-36 conserva integralmente a referência publicada de
141 nós e seus fingerprints operacionais. Só os quatro fingerprints dos
candidatos SDK/principal/DEV/local evoluem, com hashes anteriores/posteriores
e estado `prepared_not_published` nos manifests; as 12 pendências externas
existentes permanecem intactas. Os cinco testes de referência continuam ativos.

A auditoria local foi recusada pela revisão automática por envolver envio de
metadados de dependências ao registro externo. O gate remoto posterior
[Scan production dependencies](https://github.com/romulosutil/crm-silmer/actions/runs/42161194711)
foi aprovado no CI da revisão `3c1fa421`, sem alteração de dependências.
O CI da nova revisão de integração repetirá o gate normal; a evidência remota
não é uma execução local. Não há evidência de publicação ou ganho de
atendimento real nesta entrega.


## Revisão de integração — 06/11/2026

A identificação da triagem usa ADR 063/RFC 051; ADR 062 de centavos exatos e
RFC 049 de cobrança permanecem intactas. O rebase preserva Olist, cobrança,
Saúde e erros e a referência publicada. A data urgente passa a vir da cláusula
de entrega: “receber hoje; amanhã envio a arte” conserva hoje, e uma data
posterior para arte/pagamento não anula a urgência explícita da entrega.
Regressões sintéticas também preservam negações e datas ambíguas/futuras.

Node 24.20.0/npm 11.19.0: 192 testes focados aprovados, incluindo os cinco da
referência publicada; `npm run validate` completo aprovado. Links locais,
sintaxe do patch e `git diff --check` aprovados. Os três candidatos mantêm
metadata e demais nós; os quatro fingerprints candidatos foram atualizados.
Nenhuma migration, dependência, API, flag ou workflow publicado foi alterado.
O CI da revisão integrada executará novamente seus gates de PostgreSQL,
E2E/axe, auditoria e imagens antes do merge.
