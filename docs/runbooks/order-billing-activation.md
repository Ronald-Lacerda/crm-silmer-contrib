# Ativação coordenada de cobranças InfinitePay

BREL-07/04/05, COB-OPS-01, tarefa T6. Preparado em09/11/2026.
**Este roteiro não foi executado.** A autorização atual cobre publicar a
proteção humana e preparar a ativação, mantendo envios desligados. Checkout,
pagamento e mensagem reais exigem aviso prévio e autorização específica.

## Ponto de partida verificado

- API/worker/edge da release87cbc435; expand até0075,71/71checksums conferidos.
- Atendimento k7tI6T4RhQPyJkn9 publicado em9157724a-1493-4d85-91f7-582af4d73a1c com preflight, preservando141nós originais. Versão anterior7b78d0b9-80e0-41b5-a5ae-e4ff52cd96b3 disponível no histórico.
- Emissão/aviso YI75ZEo33RsVbW4r e conferência t5wxOAz2c8OUl9Hf inativos. Credenciais vinculadas por referência; autenticidade/conta perante o provedor ainda sem ensaio.
- ORDER_BILLING_ENABLED=false, ORDER_BILLING_RECEIVE_ENABLED=false e ORDER_BILLING_CHAT_SEND_ENABLED=false nos processos API/worker.
- Live/ready/edge200; heartbeat8s; seis tabelas billing e outbox billing vazias na última conferência.

Prova: [proteção publicada](../qa/order-billing-human-guard-2026-11-09.md).
O estado precisa ser relido no início da janela: a observação acima não é um
lock sobre o ambiente. Não executar migrações antigas, importar exports
desatualizados ou reiniciar toda a instância n8n para essa ativação.

## Antes da janela

1. Combinar com o proprietário pedido de teste, operador, valor máximo, número de cobranças/pagamentos, meio e destino do link. Usar comprador controlado pelo proprietário; não acionar cliente real sem autorização específica.
2. Avisar que a primeira etapa testa checkout/pagamento com envio do CRM ainda desligado. Pagamento é feito pessoalmente pelo proprietário; não solicitar chave, senha ou dados de cartão no chat.
3. Reexportar os três workflows e comparar com as versões revisadas; recusar drift, especialmente credenciais, URLs, marcador billing, execução reservada e saídas de erro. Não publicar sobre alterações concorrentes de outra pessoa.
4. Confirmar a conta/InfiniteTag silmer2025 e a credencial InfinitePay pela interface privada. O vínculo da chave não comprova que ela pertença à conta correta ou seja válida no provedor. As Basic DEV são nomes existentes; conferir identidade/capacidades e autenticação, sem expor valores.
5. Confirmar URLs create/check/paid do workflow CRM, separadas das da loja, e settings sem retenção de payloads nos dois workflows financeiros. Preservar os fluxos da loja e suas credenciais.
6. Conferir backup recente, versão recuperável,71expand/checksums, health e heartbeat. Não restaurar banco nem mudar schema como parte do teste.
7. Ler contagens/estados de cobranças, intents, checks e jobs billing. Se houver pendências, resultado incerto ou execução antiga de cobrança, revisar antes de habilitar consumidores. Não limpar filas, reabrir intents ou repetir checkout/envio automaticamente. Em modo receive-only, jobs de criação podem ser encerrados BILLING_DISABLED sem efeito remoto; não usar a troca de flags como limpeza silenciosa.
8. Revalidar ACL do operador e pedido confirmado/não cancelado. O produto não possui piloto financeiro por ID neste roteiro: ativar flags pode oferecer a rotina a outros operadores autorizados. Combinar a janela e limitar operacionalmente o uso; não afirmar isolamento técnico inexistente.

## Ordem de ativação futura

Todas as linhas abaixo são **planejadas**. Os valores de API/worker devem
ser conferidos no processo depois de cada deploy, não apenas salvos no
editor. Não alterar outras variáveis ou credenciais.

| Etapa | RECEIVE_ENABLED | ENABLED | CHAT_SEND_ENABLED | Gate antes de seguir |
| --- | --- | --- | --- | --- |
| Estado atual | false | false | false | Já conferido; nenhum efeito financeiro |
| Preparar webhooks | false | false | false | Publicar individualmente os dois workflows financeiros revisados; validar versão/path/credenciais e ausência de conflitos, sem Execute ou chamada ao provedor |
| Receber e conferir | true | false | false | Atualizar API e worker; health/heartbeat, autenticação técnica e rotas de consulta/callback verificadas sem criar checkout |
| Emitir para homologação autorizada | true | true | false | API e worker atualizados; pedido/valor/destino revisados; autorizar uma emissão controlada pelo CRM, sem retry manual em resultado incerto |
| Enviar pela conversa | true | true | true | Somente após homologação e autorização separada de envio real; guarda humana publicada, ACL/reserva/destinatário revistos e filas sem pendência incerta |

O prefixo de todas as flags é `ORDER_BILLING_`. Na API, envio exige emissão
habilitada e infraestrutura de autorização/outbox disponível; combinação
inválida impede startup. O bloqueio final de envio é aplicado pelo CRM no
preflight do comando reservado. Manter configuração consistente nos dois
serviços; não ligar CHAT_SEND como consequência automática do teste de pagamento.

Publicar workflows financeiros registra novos endpoints de produção, inclusive
o aviso de pagamento público. Esse aviso não é prova de pagamento: o workflow
deve consultar a cobrança conhecida, verificar a InfinitePay e persistir o
resultado autenticado no CRM antes do ACK. Não aceitar um callback fabricado
ou o retorno visual do navegador como confirmação financeira.

## Roteiro do ensaio real, ainda não autorizado

1. Registrar as versões, flags efetivas, operador/pedido e o limite aprovado, mantendo os dados sensíveis fora de logs/relatórios públicos.
2. Gerar a cobrança no CRM e esperar link persistido. HTTP200 do n8n não comprova persistência nem entrega. Se o resultado for incerto, conferir o estado existente; não emitir outro link por tentativa.
3. Com CHAT_SENDfalse, apresentar o link somente ao destinatário controlado autorizado. O proprietário paga pessoalmente. Conferir valor/meio/parcelas esperados e um único crédito no histórico de chat e pedido.
4. Aguardar confirmação persistida e ACK; confirmar idempotência sem duplicar crédito. Se o webhook não chegar, usar Conferir pagamento para verificar a mesma cobrança no provedor. Essa ação não deve criar novo link nem simular recibo.
5. Verificar histórico, saldo e ausência de quitação comercial indevida. Cenários de correção, saldo, cancelamento, replay e pagamento externo permanecem cobertos em DEV; qualquer efeito real adicional exige autorização própria. Recebimento externo em produção só representa dinheiro efetivamente recebido fora da integração, com método/data/autoria verdadeiros.
6. Só depois, e com autorização específica para mensagem, habilitar CHAT_SEND e ensaiar uma cobrança no chat para o destino autorizado. Revisar destinatário/valor antes do comando. Falha no preflight deve produzir zero envio, sem retry automático do efeito.
7. Registrar resultado e decisão de manter/desligar. Não declarar homologação apenas porque há um link, um status visual ou uma execução n8n verde.

## Interrupção e recuperação

- Diante de problema, desligar CHAT_SEND na API primeiro e conferir o novo processo; manter os demais operadores informados da janela. Desligar emissão na API/worker em seguida. Não repetir comandos incertos nem reenviar uma mensagem que pode já ter saído.
- Se já houver link emitido, pagamento possível ou confirmação pendente, conservar RECEIVE_ENABLEDtrue e workflows de aviso/conferência compatíveis para conciliar. Se não houve nenhum efeito financeiro, pode voltar ao estado todofalse após conferir filas e registros.
- Se o atendimento comum regredir, desabilitar envio financeiro antes de restaurar a versão humana anterior7b78d0b9 pelo histórico do n8n. Confirmar versão publicada e integridade dos nós; não desativar os outros workflows nem a instância inteira.
- A versão antiga não contém o novo preflight. Não reabilitar envio financeiro enquanto ela estiver publicada. Publicação também não modifica execuções já iniciadas; considerar pendências da versão anterior na conferência da janela.
- Desligar flags ou corrigir cobrança não cancela automaticamente um link já emitido na InfinitePay. Preservar link, recebimentos e trilha de auditoria; conferir pagamento antes de cobrar outro valor/saldo.
- Não apagar dados nem reverter migrações expand. Restore de backup é decisão de recuperação própria, fora deste roteiro, e não foi ensaiado nesta etapa.

## Critério de encerramento

Agora: guarda publicada, workflows financeiros inativos e três flagsfalse;
ensaio real pendente. Depois de execução autorizada: registrar estado de
cada fase, crédito/saldo único, ausência de envio indevido e decisão explícita
sobre operação. Não promover um resultado DEV a evidência financeira de produção.
