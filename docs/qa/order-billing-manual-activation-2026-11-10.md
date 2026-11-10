# Ativação completa para teste manual posterior, 10/11/2026

BREL-10/04, T9. O proprietário autorizou ligar todas as funções e realizar seu
teste manual depois. Emissão, envio pelo chat, recebimento e conferência estão
ativos; nenhuma cobrança, mensagem ou pagamento de teste foi executado pelo agente.
Essa autorização substitui a sequência proposta de homologar antes de ligar envio.
Não constitui homologação financeira nem isolamento por usuário.

## Conferência anterior

- Worktree atualizado a partir de origin/masterd8200857, preservando as demais
  entregas. Nenhuma alteração de código, schema, credencial ou workflow nesta etapa.
- Workflows ativos e integrais aos baselines revisados: atendimento144nós,
  versão9157724a; emissão/recebimento19nós,71a6a9d3; conferência11nós,d774f29e.
  IDs, versões, nós, conexões, settings e referências de credenciais comparados
  independentemente. Retenção none; guarda de preflight humano preservada.
- Transação read-only:71expand/checksums exatos, última0075; seis tabelas
  financeiras com contagem0 e outbox billing vazia; heartbeat global9s.
- Clientes de checkout e conferência inicializados com a Basic existente sem
  executar transporte. URL/timeout e validação de credenciais mantidos.
- Na API, N8N_INTEGRATION_ENABLED=true e três envelope keys com comprimento
  decodificado32bytes, conferidos somente como booleanos. A composição exige
  banco, autorização operacional e outbox; esses guards não foram alterados.
  Chaves exclusivas da API não são pré-condições do cliente HTTP do worker.

## Alterações e resultado

Apenas ORDER_BILLING_ENABLED e ORDER_BILLING_CHAT_SEND_ENABLED passaram de false
para true no worker e na API. ORDER_BILLING_RECEIVE_ENABLED=true foi preservada.
Worker atualizado e conferido antes de abrir admissão na API. Nenhuma outra
variável foi alterada. A habilitação vale para todos os operadores com as
capacidades existentes; não há piloto financeiro isolado por ID neste contrato.

| Serviço | Container | Papel/PID | ENABLED | RECEIVE | CHAT_SEND |
| --- | --- | --- | --- | --- | --- |
| Worker | r60d7vmshnrux2e9lzdaipvfp | worker/9 | true | true | true |
| API | u2ex6472of57elrzwdar6s9v4 | api/6 | true | true | true |

Flags lidas de `/proc` dos processos Node corretos. Quatro hashes de runtime
coincidiram com a fonte revisada em ambos os containers; scanner presente no
worker. Live200, ready200 e edge health200. Não se afirma uma prova nova de
image IDs completos nesta janela; a verificação de fonte é limitada aos quatro
arquivos observados, além dos checksums das migrações.

Após a ativação:71expand/checksums exatos, seis tabelas financeiras ainda0,
fila billing vazia e heartbeat global5s. Nenhuma fila foi limpa ou registro
financeiro fabricado. Heartbeat global não comprova execução de um job billing.
Não houve POST financeiro, chamada ao provedor, checkout, envio ou pagamento.
A validade externa da chave/conta, a entrega do link e o crédito financeiro
permanecem para o teste manual do proprietário.

## Evidências e recuperação

Seis capturas privadas em `var/billing-manual-activation/`: database-before.jpg,
worker-before-config.jpg, api-before-config.jpg, worker-all-enabled.jpg,
api-all-enabled-health.jpg e database-after.jpg. Exports JSON e review no mesmo
diretório. Evidências contêm somente referências, metadados, flags e contagens;
valores de credenciais não foram exibidos ou versionados nesta etapa.
Revisão independente: [validation-manual-activation.md](../../.specs/features/order-billing-release/validation-manual-activation.md).

Em falha, desligar CHAT_SEND na API primeiro e depois ENABLED na API/worker.
Conservar RECEIVE=true e workflows de aviso/conferência se houver links ou
pagamentos possíveis. Não repetir operações incertas, apagar histórico ou
reverter migrações. Desligar flags não cancela um link existente na InfinitePay.
