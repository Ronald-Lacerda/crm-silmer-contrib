# Central de ações, desempenho e checkpoint

Contrato: [ACT/PERF/CHK](../../.specs/features/dashboard-actions/spec.md),
[ACT-T01/T02](../../.specs/features/dashboard-actions/tasks.md),
[ADR 059](../adr/059-central-de-acoes-e-performance-comercial.md).

## Entrega e limites

A central pessoal consulta ações reais e abre a Inbox para contato humano.
Pagamento integral e entrega são comandos separados, com versão, autorização
revalidada na transação, idempotência e auditoria. Ausência de registro aparece
como pergunta; não prova inadimplência ou ausência física de entrega.
Adiar/agendar não resolve a obrigação nem envia mensagem. Um objeto com duas
conferências conta uma vez. Listas parciais avisam o recorte e abrem as listas
completas; falha de leitura não vira zero ou estado de tranquilidade.

Desempenho usa pedidos confirmados, não teste, pela data comercial de São
Paulo. Atribuição fica congelada no primeiro fechamento; reabrir retira o
pedido do total atual, reconfirmar não duplica nem troca crédito. Pedidos
históricos sem evidência ficam sem atribuição; não há backfill pelo dono atual.
Atendeu, assumiu, encerrou e com venda têm bases explícitas no período;
não dividir essas populações para declarar conversão causal.

## Instalação compatível — ACT-T02

1. Implantar migrations expand 0056/0057 antes da imagem com as rotas novas.
   A 0056 também corrige o formato do número a partir de 100 pedidos, sem
   reescrever números existentes. Nenhuma migration altera pagamento/entrega
   históricos para inventar confirmação.
2. Conferir disponibilidade das leituras por vendedor e admin. Financeiro não
   recebe fila comercial ou relatório da equipe. Sessão humana não autoriza
   as rotas técnicas de transporte.
3. Manter `DAILY_CHECKPOINT_ENABLED=false` até conferir os dois destinatários
   em `DAILY_CHECKPOINT_RECIPIENTS_JSON`: objetos privados com `id` estável,
   `label` e `phone` E.164. Não colar valores reais em Git, screenshots de QA,
   comandos registrados ou tickets. A cifragem reutiliza a chave existente
   `IDEMPOTENCY_ENVELOPE_KEY` (32 bytes em base64); não a trocar descartando
   snapshots ainda necessários para leitura/reconciliação.
4. Gerar o workflow dedicado com
   `node ops/n8n/workflows/create-daily-checkpoint-workflow.mjs saida-privada.json bindings-privados.json`. O gerador
   aceita bindings privados de URL, instância Evolution e referências de
   credenciais; consultar a interface exportada antes de importar. O template
   inativo não contém endereços ou credenciais de produção. Nunca versionar
   o artefato privado resultante. Usar a conta remetente da Inbox existente,
   Basic técnico CRM e Header Auth Evolution já provisionados.
5. Conferir no n8n importado: cron 08h diário, timezone
   `America/Sao_Paulo`, nenhuma retenção de dados de execução nem pinData,
   sem retry de reserva ou envio. A consulta do destinatário deve confirmar
   a identidade exata; não tentar variações do telefone ou do JID.
6. Validar remetente e reconhecimento dos dois números conforme combinado
   com o proprietário. Ativar flag e publicar somente depois dessa conferência.
   Registrar evidência privada da entrega a cada destino. Resposta de aceitação
   do provedor não é evidência de entrega física no WhatsApp.

Esta entrega de código não comprova publicação do workflow nem envio real.
Não modificar os workflows comerciais existentes para instalar o checkpoint.

## Protocolo e recuperação

O n8n chama apenas as rotas POST dedicadas sob
`/api/v1/integrations/n8n/dashboard/checkpoint/`:

- `prepare`: recebe dia civil anterior, fixa uma única apuração cifrada e
  imutável por data. Replay devolve o mesmo snapshot. Recuperação aceita os
  sete dias civis anteriores, nunca hoje ou futuro.
- `reserve`: recebe checkpoint e destinatário; apenas a primeira reserva
  retorna autorização, telefone e texto para aquele destino. Replays não
  reemitem permissão de transporte. Destino alterado após snapshot gera
  conflito e exige análise, sem enviar a outro número silenciosamente.
- `complete`: registra o resultado mínimo ligado à reserva, sem payload bruto.
  Replay igual não duplica. Pode registrar a conclusão mesmo com a flag
  desligada, permitindo terminar/reconciliar efeitos já iniciados.

Falha de consulta antes do transporte é `failed`. Timeout, resposta inválida
ou efeito de transporte indefinido é `outcome_unknown`; não refazer o envio.
Reserva sem conclusão há cinco minutos aparece para o gestor como **Conferir
envio**. Consultar a execução sem expor conteúdo e o provedor/WhatsApp para
determinar se houve mensagem. Perda da resposta de reserva também exige essa
conferência: uma reserva consumida não autoriza reiniciar o transporte.

Quando houver evidência de mensagem aceita, registrar a referência do provedor
no mesmo `complete`, com `reconciled: true` para passar de desconhecido a
aceito. Nunca preencher identificador fictício para encerrar um incidente.
Não existe reset automático de reserva nem botão de reenviar no Dashboard.
Se não for possível determinar o resultado, preservar o desconhecido e a
evidência privada. O outro destinatário tem reserva e resultado independentes.

O gestor consulta status e prévia pelo GET `/api/v1/dashboard/checkpoint`.
Antes da preparação, a tela identifica a prévia como dinâmica; depois mostra
o resumo registrado. Telefone não integra a resposta humana. Configuração
desativada/incompleta não aparece como envio realizado.

## Verificação e rollback

Node 24.20.0 / npm 11.19.0. Executar `npm run validate` e `npm run test:e2e`.
Executar os testes PostgreSQL de dashboard/checkpoint e regressões de pedidos,
Financeiro e migrations com `TEST_DATABASE_URL` em bancos sintéticos dedicados.
Os testes live apagam schemas; nunca usar DSN de desenvolvimento compartilhado
ou produção. Provas de concorrência usam PostgreSQL real, não substitutos.

Para rollback, pausar o workflow dedicado e desligar a flag antes de voltar
a imagem compatível. Preservar migrations expand, snapshots e resultados.
Não restaurar banco nem apagar reservas para repetir envio. Concluir ou
reconciliar operações em andamento com a imagem que implementa o protocolo.
Qualquer ativação remota e entrega real pertence a ACT-T02 e deve ser
registrada separadamente das evidências locais.
