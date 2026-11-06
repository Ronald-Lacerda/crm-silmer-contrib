# Revisão da jornada de cobrança — Inbox e Pedido

Data: 05/11/2026. Fonte inicial: commit `9c729681`. Tarefa COB-REV-01;
contrato COB-01–16, MSG-02/03, PCX-13 e UX-FUNC-01. Revisão independente
de produto/design e de evidências/detector, sem compartilhar os resultados
antes de concluir a avaliação de design. Grafo consultado de 04/10, commit
`c237200a`; achados confirmados nas fontes atuais, sem atualizar o grafo.

## Resultado da inspeção

Domínio, API e workflow separam confirmação comercial, emissão, recebimento
e quitação. Os cenários 0% → integral, X% → sinal → saldo e 100% com cartão
parcelado estão cobertos localmente. O caminho inicialmente entregue exige
copiar o link/texto, abrir a conversa e enviar manualmente. Não existe ainda
envio automático vinculado à geração da cobrança.

Após avaliar essa continuidade, o proprietário solicitou o fluxo da
[RFC 047](../rfc/047-enviar-cobranca-pela-conversa.md): um comando humano
**Gerar e enviar cobrança**, no chat ou pedido, para o link chegar à conversa
sem copiar/colar. Primeiro formato: link com Pix e cartão. Protótipo novo
precede implementação dessa orquestração. A entrega em curso da dashboard
foi identificada no worktree `dashboard-central-actions` e preservada;
o proprietário retirou dashboard do foco inicial desta revisão.

## Falhas reproduzidas e correções

| Prioridade | Reprodução                                                                                                                              | Correção nesta fatia                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1         | Em 390 px com toque, Enviar muda de posição após blur; pointerup atinge ícone, click termina em DIV, sem submit/POST. Desktop funciona. | As regras móveis usam `:focus-within` do compositor, estabilizando navegação e alvo durante o toque.                                                                                                                                  |
| P1         | Texto na Inbox → Abrir pedido → Abrir conversa retorna campo vazio.                                                                     | Rascunhos temporários por conversa no shell autenticado; limpar ao trocar/sair de sessão e no reload. Sem armazenamento persistente no navegador. Callback antigo nunca limpa a sessão seguinte.                                      |
| P1         | Acordo alterado/revisão e link vencido ainda oferecem Copiar link e Preparar mensagem.                                                  | Ações normais exigem pedido confirmado, cobrança aguardando pagamento, prazo válido e ausência de revisão/incerteza. Estado vencido é explícito; link anterior fica só no acesso de conferência. Revalidar também no momento da ação. |
| P2         | Valor específico do sinal só aparece no histórico abaixo do link.                                                                       | Tipo, valor da cobrança e validade passam a ficar junto ao link.                                                                                                                                                                      |

O recebimento continua passando pelo servidor; a UI não cancela links no
gateway nem promete cancelamento ao ocultar um link antigo. Emissão incerta
continua sem retry cego. Conferência/devolução preservam histórico.

## Provas locais e limites

- Baseline da avaliação: 20/20 E2E de cobrança, afazeres e próximo passo.
- Reprodução somente sintética confirmou copiar link → conversa correta →
  colar → envio desktop: um POST com texto correto e chave de idempotência.
  Aceitação pela API mock não comprova entrega ao WhatsApp.
- Guardas de assistente, conversa encerrada e outro responsável verificadas.
- Após corrigir toque: 6/6 novos E2E e reprodução instrumental com um POST,
  click no ícone, submit no formulário e rascunho limpo.
- Integração das correções: 29/29 E2E de cobrança, rascunhos e toque, incluindo
  reabertura, revisão, validade vencida, resultado incerto, troca de conta,
  falha/retry e isolamento entre conversas.
- Detector inicial sem achados; inspeção visual real de Pedido/Inbox. Browser
  nativo não alcançou localhost e IAB indisponível; fallback Playwright,
  sem overlay. Screenshots e logs sintéticos no diretório de evidências do chat.
- Nenhum envio externo ou pagamento real. Previews de diagnóstico encerrados.

Gate integrado final: `npm run validate` com 1.760 aprovados e 13 skips;
E2E completo com 534 aprovados e sete skips. A primeira rodada expôs uma
asserção de mídia que exigia altura idêntica após remover anexo; o foco agora
conserva a navegação recolhida e dá mais espaço ao histórico. O teste passou
a exigir recuperação de pelo menos o espaço original, mantendo as demais
verificações de visibilidade, teclado e geometria; a suíte completa repetida
passou. Após o refinamento de privacidade dos links, typecheck/lint e os 16
cenários do Pedido foram repetidos. Detector dos alvos finais sem achados,
revisão independente sem pendências. Sem mudança de backend/migração nesta fatia.

O novo protótipo da RFC 047 usa somente dados/efeitos simulados. Nove
verificações passaram, sem erros JavaScript: sinal/saldo, 0% sem link de zero,
100%, reenvio do mesmo link após falha conhecida, 320/390 px, tema escuro e
Escape com retorno de foco. Isso não comprova envio real integrado.

Na consulta operacional, API/worker não tinham flags/URL de cobrança; os
serviços apontavam para `master`, antes da integração de cobranças. Outra
publicação da dashboard estava em curso. Essa leitura não comprova estado
posterior nem ativação. Migração, workflow, conta/credenciais e homologação
real permanecem em COB-OPS-01; não foram modificados nesta revisão.

## Comparação com o site

Checkout e retorno do `silmer-web` foram lidos sem alterar o repositório.
100/100 testes das bibliotecas checkout/pedido passaram; 17/17 testes CRM de
domínio/rotas/export também. Fonte do site envia versão 3 com entrega/frete;
usar a extensão documentada em `docs/frete-loja.md`, não só o contrato antigo
que ainda exemplifica versão 2. Export integral atual da loja não está no repo.

Risco separado: loja aceita somente `pix` no domínio CRM, mas seu contrato de
checkout admite retorno `credit_card`, reproduzido como 422 no CRM. O Checkout
InfinitePay mantém cartão habilitado segundo sua documentação oficial. Isso
precisa de correção de contrato própria; não alterar silenciosamente a loja
nesta revisão. Cobranças novas do atendimento reconhecem Pix e cartão.

Fonte primária: [InfinitePay — Checkout](https://www.infinitepay.io/checkout-documentacao).

## Preparação da branch de PR

A entrega foi isolada sobre `origin/master` em `72702f0a`, preservando a central
de ações e suas migrations 0056/0057. Mudanças anteriores de busca, Clarity e
suas dependências não fazem parte deste PR. Os conflitos de composição da API,
inventário de flags, CI e documentação foram resolvidos conservando ambos os
módulos; os gates PostgreSQL da dashboard continuam no CI junto ao de cobranças.

Nesta combinação: `npm run validate` com 1.766 aprovados, 15 skips e zero falhas;
37 E2E de cobrança, rascunhos, toque, ações e desempenho da dashboard aprovados.
`git diff --check` e instalação offline pelo lockfile aprovados. Evidência de
PostgreSQL e E2E completos da implementação original permanece acima; o CI do
PR executa a matriz integrada. Nenhuma ativação operacional acompanha o PR.
