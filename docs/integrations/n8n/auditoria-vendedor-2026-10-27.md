# Auditoria do Vendedor — 27/10/2026

Requisito/tarefa: CHAN-WA-01; AGT-01..08, ORC-01..08.
Decisão: [ADR 043](../../adr/043-atendimento-comercial-concentrado-no-whatsapp.md).

## Fonte realmente observada

A UI n8n mostrou `Silmer | Atendimento WhatsApp IA` como `Published`.
A exportação desse workflow (`k7tI6T4RhQPyJkn9`) informa `active: true`,
versão `186e4282-e96f-4b5f-814d-f28d827ef6e8`, 86 nós e modelo
`gpt-5.6-luna`. O candidato WAHA não foi promovido por esta auditoria.
O export privado anterior fica em diretório ignorado, sem credenciais exportadas.
Não se publica o JSON operacional com referências privadas.

O prompt do publicado coincide com o repositório anterior: pré-coleta,
15 mensagens, condições/confirmar com humano, mochilas/bolsas e chat do site.
Contexto e normalização têm um guard adicional `silmer-guardrail-1`, ausente
da fonte local anterior: injection, segredo, link e algumas promessas
comerciais. Ele foi incorporado e preservado no candidato.

## Comparação executada

A mesma suíte executa os Code nodes do export anterior e do candidato,
com extrações sintéticas explícitas do modelo. São 35 casos: homônimas,
correções, ataques, orçamento, promessas indevidas, pedidos intercalados,
duas intenções no bootstrap, alvo ambíguo, abandono/retomada, ciclo novo,
indecisão, pré-ficha pronta, teto, takeover, desligamento e replay.

- Publicado anterior: 25 passam e 10 falham sob os critérios atuais.
- Quatro gaps: entrega certa amanhã, desconto aprovado, parcelas sem juros
  e dois pedidos separados no primeiro inbound.
- Seis diferenças da solicitação nova: cinco categorias removidas e retomada
  de uma coleta antiga de mochila.
- Candidato: 35 passam, incluindo bloqueios novos e preservação do guard.

O publicado já bloqueava o exemplo com R$ 1; o probe inicial contra o snapshot
local não descrevia integralmente sua proteção. Os testes não são diálogos
reais com OpenAI, não provam transações PostgreSQL de encerramento e não
homologam identidade, pareamento ou entrega WhatsApp real. Não houve envio
para clientes. Não declarar qualidade do modelo real com esses números.

## UX de encaminhamento

O site publicado oferecia nome/celular e “Começar conversa”, com WhatsApp como
alternativa secundária. O patch do projeto `silmer-web` substitui isso por
“Falar no WhatsApp”, preserva `/chat` como ponte e retira a opção de chat do
linktree `/instagram`. O webhook legado tem resposta estática sem CRM/IA.

Copy: “Oi! Nosso atendimento acontece pelo WhatsApp. Toque abaixo para
conversar com a Silmer.” O texto pré-preenchido é só “Olá! Vim pelo site.”
ou “Olá! Vim pelo Instagram.” Não prometer pessoa ou resposta imediata.

“Fale comigo” foi substituído por um rótulo que explicita destino e ação,
conforme revisão documental; não houve teste com participantes.

- [WhatsApp click-to-chat](https://faq.whatsapp.com/5913398998672934).
- [Conexão Instagram/WhatsApp](https://faq.whatsapp.com/1164217254479464/).
- [GOV.UK botões](https://design-system.service.gov.uk/components/button/).
- [WCAG finalidade do link](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html).
- [WCAG alvo mínimo](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- [WCAG foco visível](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).

## Publicação e recuperação

O candidato deve ser aplicado sobre o export observado, alterando só os nós
de contexto, decisão, prompt e entrada do site. Conservar IDs, credenciais,
paths, URLs privadas e configuração de retenção. Não publicar WAHA junto com
o original nem reaproveitar o telefone operacional da ficha.

Para rollback, restaurar somente os nós/conexões alterados a partir do backup
anterior e publicar conscientemente. Não restaurar banco ou repetir envios
incertos. Publicação e smoke do modelo real permanecem sem evidência até
verificação explícita no ambiente alvo.

## Evidência de integração e limites dos gates

- Gate completo local `npm run validate`: 1.152 testes, 1.149 aprovados,
  três ignorados e zero falhas, seguido de build aprovado. Executado fora
  do sandbox após EPERM/EACCES de arquivos/portas locais no sandbox.
- Matriz de conversa: 35 casos; mais quatro testes do merge operacional
  (39 no arquivo adversarial), todos aprovados.
- E2E CRM: 299 aprovados, sete ignorados e três timeouts na primeira rodada;
  somente os três casos falhos foram reexecutados com um worker e passaram.
- Site: 160 unitários, 12 jornadas de encaminhamento, check e build aprovados.
  [PR draft #36](https://github.com/romulosutil/silmer-web/pull/36), SHA `1f235be`,
  Vercel preview concluído; produção não foi alterada. Cinco falhas adicionais
  da loja foram reproduzidas na baseline anterior do site.
- Auditoria npm encontrou quatro vulnerabilidades no lockfile intocado
  (uma alta em Vite, duas moderadas e uma baixa). O gate de auditoria não
  passou; atualização de dependências não integra este patch.
- A sessão do navegador perdeu conexão depois do export (`Debugger unattached`).
  Nenhuma publicação n8n foi realizada. O helper `prepare-vendedor-update.mjs`
  prepara candidato privado preservando a configuração do export; importar e
  publicar exige recuperar acesso. Modelo real e perfil/Direct Instagram
  continuam sem evidência de teste/configuração nesta entrega.
