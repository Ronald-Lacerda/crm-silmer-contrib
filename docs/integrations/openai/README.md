# OpenAI — baseline e prontidão do MVP

OpenAI é o provedor escolhido para o lançamento em 05/10/2026
([ADR 021](../../adr/021-adotar-openai-no-mvp.md), OPS-AI-01).
A escolha está concluída; a liberação de dados pessoais ainda depende das
evidências abaixo. Em 30/10/2026 o responsável informou que o DPA e o ZDR da
OpenAI foram entregues; os documentos ficam fora do repositório. Não houve
chamada ao provedor nem publicação de workflow nesta atualização documental.

## Configuração observada no código

Fonte: `ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js`.

- Nó `OpenAI - Modelo do MVP`, tipo `lmChatOpenAi`, versão 1.3.
- Modelo `gpt-5.6-luna`, Responses API habilitada, sem built-in tools.
- Limite de 1500 tokens, reasoning `low`, timeout 30 segundos e um retry da
  geração (`maxRetries: 1` no `mvp-simple-20`, ainda não publicado; ADR 052).
  Isso não autoriza repetir envio WhatsApp.
- Parser estruturado do workflow e validação de comandos pelo CRM.
- `promptCacheKey` definido; a política real de caching deve ser conferida.
- A fonte não explicita `store: false`. Não se afirma que o request efetivo
  ou a organização já tenha retenção desabilitada.

`AI_PROVIDER` e `AI_MODEL_PRIMARY` do spike Gemini não selecionam o nó OpenAI.
A fonte da configuração de IA desta jornada é a versão do workflow n8n.

## Checagens antes de produção com dados pessoais

| Checagem             | Evidência necessária                                                                               | Estado nesta entrega                                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modelo e endpoint    | Versão realmente implantada e request sintético sanitizado                                         | Pendente                                                                                                                                                                                                                                                                                               |
| Projeto e billing    | Referência opaca ao projeto, billing e limites/cota                                                | Pendente                                                                                                                                                                                                                                                                                               |
| Credencial           | Key privada, escopo mínimo e rotação, sem expor valor                                              | Pendente                                                                                                                                                                                                                                                                                               |
| Privacidade          | DPA, subprocessadores, região e retenção efetiva aprovados                                         | DPA entregue: informado pelo responsável em 30/10/2026; documento mantido fora do repositório. Subprocessadores, região e retenção efetiva não estão registrados aqui                                                                                                                                  |
| ZDR                  | Confirmação do provedor para organização/projeto e endpoint/modelo usados                          | Entregue: informado pelo responsável em 30/10/2026; documento mantido fora do repositório                                                                                                                                                                                                              |
| Persistência         | Request com `store: false`, sem background/conversation state, comportamento real do nó verificado | Pendente                                                                                                                                                                                                                                                                                               |
| Cache e data sharing | Opções reais compatíveis com a política aprovada, sem opt-in de compartilhamento                   | Pendente                                                                                                                                                                                                                                                                                               |
| n8n                  | Retenção de execuções e logs sem PII; credenciais e chave recuperáveis                             | Parcial: o workflow principal não salva execuções (`saveDataSuccessExecution` e `saveDataErrorExecution` em `none`, `saveManualExecutions` e `saveExecutionProgress` em `false`), conferido no snapshot e na publicação de 29/10/2026. Logs sem PII, credenciais e chave recuperáveis seguem pendentes |
| Smoke sintético      | Schema, recusa/timeout, handoff, epoch e fence, sem efeito Meta repetido                           | Pendente                                                                                                                                                                                                                                                                                               |

O controle `store: false` trata persistência de estado da Responses API;
não elimina por si só retenção para monitoramento de abuso. ZDR depende de
aprovação do provedor e tem limitações de endpoint/modelo/cache. Conferência
oficial em 05/10/2026:
[controles de dados](https://developers.openai.com/api/docs/guides/your-data).

A saída do modelo é validada mesmo com parser. Não se declara que o nó atual
envia `strict: true`/JSON Schema à API sem verificar o request efetivo.
Referência: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Histórico e fechamento

`docs/phase0/external-effects.json`, fixtures e smoke Gemini preservam a
evidência de T00.4 anterior à ADR 021. Não são gates de homologação do
provedor ativo. A issue #5 registra essa escolha histórica; sua aprovação
condicional não vale para OpenAI. O responsável informou em 30/10/2026 a
entrega do DPA e do ZDR da OpenAI, mantidos fora do repositório. As demais
linhas da tabela continuam abertas antes de liberar o tráfego com PII.

Não usar prompts de clientes no smoke. Registrar somente IDs de correlação,
versões, resultado dos checks e referências de evidência, sem key, prompt ou
resposta completa.
