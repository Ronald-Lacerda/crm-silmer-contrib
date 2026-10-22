# Operação do Financeiro

Rastreabilidade: [FINQ-01–19](../../.specs/features/financeiro/spec.md),
[FINQ-T06](../../.specs/features/financeiro/tasks.md),
[ADR 042](../adr/042-perfis-e-requitacao-do-financeiro.md).

## Ativação

Aplicar migrations 0042/0043 pelo migrador normal, após backup e gates do
projeto. Não criar perfis ou pagamentos por SQL operacional. Em Usuários, o
Admin cria/edita a conta e seleciona Financeiro. Credenciais são entregues
pelo fluxo existente e não entram em logs, issues ou documentação.

Antes de criar a conta real, homologar com pedidos sintéticos: login restrito,
fila e detalhe, marcação, reversão, acesso por teclado e consulta do Admin com
menu completo. A entrega técnica não constitui essa homologação.

Datas manuais existentes na implantação permanecem visíveis com revisão
pendente e fora do Financeiro. Vendedor responsável/Admin abre Datas do
pedido, confere o recebimento integral, marca “Confirmo que o valor integral
foi recebido” e salva. A data pode ser a mesma. Alterar entrega sem essa
declaração mantém a revisão pendente. Não liberar sinal/parcela como quitação.
Registros da loja usam o pagamento confirmado pelo gateway.

## Rotina

Financeiro vê confirmados, integralmente pagos e não teste de todos os
responsáveis. Aguardando começa pelo pagamento mais antigo; Concluídos pela
conclusão mais recente. Após terminar a rotina externa, “Marcar nota criada”
registra autoria e horário do servidor (exibido em São Paulo). A ação declara
rotina concluída; não atesta autorização Sefaz. “Desfazer”/“Voltar para
aguardando” preservam o evento anterior e registram a correção.

Reabrir comercialmente retira o pedido das listas. Reconfirmar com outro
valor limpa o pagamento manual e invalida o check: registrar quitação de novo
e depois conferir no Financeiro. Reconfirmar o mesmo valor preserva os
registros anteriores. Correção de valor na loja preserva o pagamento gateway
que cobre o preço e invalida o check. Nenhum desses eventos apaga histórico.

Admin consulta o painel e histórico, sem concluir/desfazer. Para mudança de
perfil, usar Usuários; sessões da conta são revogadas. O próprio Admin não
pode mudar seu perfil nessa tela. Vínculos comerciais existentes são mantidos;
redistribuir pelo fluxo administrativo quando necessário. Desativar bloqueia
acesso; histórico financeiro impede exclusão da conta.

## Falha, recuperação e rollback

Falha de consulta não é fila vazia. Usar Tentar novamente; em conflito ou
resultado incerto, reler o pedido antes de nova ação. Repetições do mesmo
comando usam a mesma chave de idempotência e não duplicam eventos. Não
contornar erro com chaves novas sem reconciliação. Para investigação, usar
IDs técnicos e correlação, sem exportar ficha, cliente ou dados bancários.

Em rollback, desativar contas Financeiro e retornar a imagem anterior sem
reverter migrations, apagar eventos ou reconstruir pagamentos. A aplicação
antiga desconhece a marca de revisão: antes de reativar a versão nova, conferir
novamente os pagamentos manuais modificados durante esse período. Não usar
rollback destrutivo de tabelas; preservar backup e trilha de auditoria.

Olist é operado manualmente. Não há token, webhook, sincronização ou emissão
de nota pelo CRM nesta entrega.
