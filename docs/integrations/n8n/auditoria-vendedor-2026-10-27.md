# Auditoria do Vendedor — 27/10/2026

Requisito/tarefa: CHAN-WA-01; AGT-01..08, ORC-01..08.
Decisão: [ADR 044](../../adr/044-atendimento-comercial-concentrado-no-whatsapp.md).

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
- Na primeira etapa a sessão do navegador perdeu conexão depois do export.
  O proprietário reativou o acesso; a publicação e o modelo real foram
  verificados na continuação descrita abaixo. Perfil/Direct Instagram
  continuam sem evidência de configuração nesta entrega.

## Continuação — modelo real, organização e publicação

O proprietário pediu também organizar o fluxo como especialista em n8n.
O organizador `organize-vendedor-workflow.mjs` gera cinco áreas: site para
WhatsApp, atendimento WhatsApp, operação humana, falhas/reconciliação e
compatibilidade histórica. A direção é da esquerda para a direita, com
espaçamento previsível, modelo/parser próximos do agente e notas de operação.
O layout não muda parâmetros executáveis, credenciais, webhooks ou conexões;
testes cobrem determinismo, idempotência, corpos sem sobreposição e colisões
de nomes reservados. A inspeção visual foi realizada no editor real.

Foram executadas duas rodadas de 12 cenários sintéticos usando o modelo
OpenAI configurado no n8n, em workflow manual privado sem nós de HTTP, CRM
ou envio WhatsApp. As saídas reais revelaram duas lacunas adicionais:

- O agente podia pular o modelo da camiseta ou repetir a cor já informada.
  Agora o próximo campo segue o ritmo do workflow; uma pergunta declarada
  pelo modelo que diverge desse campo é substituída pela pergunta correta,
  incluindo quando o modelo pergunta um campo já respondido.
- Diante de desistência, dizia que encerraria o atendimento, embora não
  executasse encerramento. A nova guarda interrompe a coleta, transfere e
  avisa a equipe, sem patch, novo rascunho ou alegação de cancelamento.
  Correções como “não quero mais de 30” e “desisti do azul” não cancelam.

A regra final de normalização foi reaplicada às 12 saídas reais da segunda
rodada, sem gerar novas respostas ou efeitos comerciais. Os dois casos
acima passaram, assim como saudação, correção, duas Marias isoladas,
negociação, indecisão, injection, duas intenções, categoria removida e
conclusão da pré-ficha. A [evidência sintética](evidence/vendedor-modelo-2026-10-27.json)
guarda somente respostas e decisões mínimas, sem prompt/credenciais.
Isso não homologa transações de encerramento ou entrega WhatsApp real.

O original `k7tI6T4RhQPyJkn9` foi publicado com o nome de versão
“CHAN-WA-01 · WhatsApp, guardas e canvas organizado”. A UI confirmou
`Published`. O candidato WAHA continua sem cutover por esta entrega.
O canvas tem 87 nós executáveis/legados e cinco notas, sem nomes duplicados.
Webhooks, credenciais, configurações e conexões foram conferidos por export;
a UI n8n regenera os IDs internos dos nós ao importar, preservando os IDs
dos webhooks e os nomes usados nas referências. Backup anterior preservado.

Smoke remoto no endereço antigo do chat, com sessão sintética inválida para
o fluxo legado e texto pedindo orçamento/instrução adversarial: HTTP 200,
somente `output` estático com “Nosso atendimento acontece pelo WhatsApp” e
link `wa.me`. O caminho de entrada tem apenas trigger e resposta fixa,
sem CRM/IA. A produção do site permanece na PR separada; não se declara
publicação do site ou configuração do Direct com base nesse smoke.

Gate final após os ajustes: `npm run validate` aprovou 1.161 testes, com
três ignorados e nenhuma falha, seguido de build. A auditoria npm anterior
continua com o finding de Vite; nenhuma dependência foi alterada.

## Publicação do site e configuração da conta Meta

Após autorização explícita do proprietário, o encaminhamento do site foi
isolado da branch de loja e publicado pela
[PR #37](https://github.com/romulosutil/silmer-web/pull/37), em `main`
`e1e411f73c72a277cf66d5d99f97e57742f09c28`. O
[deploy Vercel](https://vercel.com/romulodesigns/silmer-web/DTWq6icmVg94FR1YqNHVeKp5Wek7)
concluiu com sucesso. Somente os 13 arquivos do encaminhamento foram
integrados; catálogo, checkout e configuração comercial permaneceram
idênticos ao `main` anterior. Os commits de inventário/acessos e de correção
anterior da loja não integraram essa publicação.

Na base de produção passaram build, check sem erros/avisos, 160 unitários
e 12 jornadas. Smoke em `https://silmer.com.br`, `/chat` e `/instagram`,
em celular e desktop: seis cenários aprovados, HTTP 200, um CTA flutuante
“Falar no WhatsApp”, destino comercial correto, ausência do formulário
antigo e zero requests n8n/CRM. Teclado, foco e alvo de toque foram
conferidos. `/chat` também passou sem JavaScript. Nenhuma mensagem foi enviada.

Na conta `@silmeroficial`, a bio publicada passou a orientar
“Atendimento pelo WhatsApp no link”. Os links existentes para o site foram
preservados e chegam às páginas publicadas. O Instagram web informa que
alterar links exige o aplicativo; o botão nativo de contato e um link direto
`wa.me` no perfil não foram configurados por esta entrega.

O proprietário autorizou expressamente atualizar também o Messenger,
pois as duas automações existentes compartilham o texto com o Instagram.
A resposta automática e a mensagem de ausência foram salvas e reabertas
para conferir persistência, com ambos os canais selecionados. Texto inicialmente
publicado (destino corrigido na seção seguinte):

> Oi! Nosso atendimento acontece pelo WhatsApp. Para conversar com a Silmer,
> toque no link: https://wa.me/5527996337374?text=Ol%C3%A1%21%20Vim%20pelas%20redes%20sociais.

Os sete modelos de resposta salvos foram atualizados para esse mesmo texto,
sem nomes de pessoas, variável de telefone quebrada, número antigo,
horários divergentes ou promessa de retorno pelo Direct. Atalhos distintos:
Atendimento, Continuar, Máscaras, Orçamento, Máscara, Uniforme e Solicitação,
todos com o sufixo “WhatsApp”. A biblioteca foi conferida: sete destinos
corretos e nenhuma promessa de espera. O compositor terminou vazio.

Três legendas públicas foram corrigidas pontualmente e verificadas após
publicação: `DeMkPF8Fn8X` e `DdoiP8DOsLT` passaram de convite ao Direct
para WhatsApp pelo link da bio; `DewoNuekQd_` passou a indicar o link da bio
e deixou de prometer resposta “rapidinho”. O conteúdo editorial restante
dessas legendas foi preservado. Isso não representa revisão de todo o
histórico de posts/Stories.

Limites de verificação: a resposta automática nativa informa responder à
primeira mensagem, enquanto a ausência depende do status/horários da Meta.
Esses gatilhos foram preservados; não se declara resposta a cada DM.
Modelos salvos são manuais. Foram verificadas configuração e prévia, sem
enviar DM a clientes nem alegar teste real de entrega externa. O inventário
anexo foi usado como evidência, sem ser publicado ou alterar acessos,
credenciais, recuperação, permissões ou integrações.

## Correção do destino — WhatsApp do CRM

O proprietário esclareceu que o atendimento deve chegar ao número
`27936180599`, do CRM. O número usado inicialmente era o da loja e foi um
erro de roteamento desta entrega. O destino de atendimento correto é
`https://wa.me/5527936180599`.

No n8n publicado, somente o código do nó “Site - Direcionar para WhatsApp
(MVP)” mudou de destino. A versão “CHAN-WA-01 · Destino WhatsApp do CRM”
ficou `Published`; smoke remoto no webhook antigo, com sessão sintética e
texto adversarial, retornou HTTP 200 e somente a resposta fixa com o número
correto. Nenhum envio WhatsApp foi acionado. SDK e snapshot canônico foram
atualizados, e o teste existente passou a exigir o número do CRM e rejeitar
o número da loja. Os 47 testes de contrato, mídia/chat e layout passaram.

Na Meta, resposta automática e ausência foram corrigidas e reabertas para
conferir persistência. Os sete modelos salvos foram corrigidos e conferidos:
todos com o número do CRM, sem número anterior e sem texto duplicado.
O compositor terminou vazio. Texto vigente nos dois canais:

> Oi! Nosso atendimento acontece pelo WhatsApp. Para conversar com a Silmer,
> toque no link: https://wa.me/5527936180599

O link simples evita mostrar parâmetros codificados na mensagem do Direct.
A bio não contém telefone e continua indicando o link. O link direto e o
botão nativo do perfil permanecem para configuração pelo proprietário no
aplicativo Instagram, usando o número do CRM. Não houve alteração de
registro de linha, autenticação ou transporte WhatsApp.

Site corrigido em produção pelas PRs
[#38](https://github.com/romulosutil/silmer-web/pull/38) e
[#39](https://github.com/romulosutil/silmer-web/pull/39), `main`
`a8d71b2844a94e6bccceb1ef40a49cae1fdf6a1a`, com deploy Vercel concluído.
Uma configuração própria de atendimento e helper sem fallback separam o
número do CRM dos contatos da loja. Todas as entradas genéricas, inclusive
“Dúvidas” do cabeçalho/vitrine e “Tirar dúvida” do produto, chegam ao CRM.
Telefone institucional informativo, vendedores explicitamente nomeados e
pós-pagamento mantêm seus destinos próprios; catálogo/checkout não mudaram.
Build, check, 163 unitários e 219 links passaram. Smoke final em produção:
dez cenários (início, chat, Instagram, loja e produto, em celular/desktop),
mais chat sem JavaScript, aprovados, sem requests n8n/CRM e sem envio WhatsApp.
