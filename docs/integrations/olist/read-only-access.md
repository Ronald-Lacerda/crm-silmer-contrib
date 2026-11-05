# Olist — acesso temporário somente leitura para a prova F1

OLIST-T02 / OLIST-03–05, 07–13, 20, 25–27, 35–41.
Dono: Tech Lead/Integrações (Codex nesta execução). 04/11/2026.
[RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md) ·
[Consultas e caso controlado](controlled-case.md).

## Entrega e autorização

O PO aprovou instalar a extensão gratuita Gestão de Aplicativos e, depois,
autorizou explicitamente: **“Autorizo criar e conectar esse aplicativo de
leitura”**. O aplicativo foi salvo com os sete módulos e somente Leitura,
conectado pelo OAuth oficial e executou os oito GET definidos abaixo. Todos
retornaram HTTP 200, após /info confirmar a conta esperada em memória.

[Evidência sanitizada real](evidence/read-only-live-result.json), capturada em
04/11/2026 às 22:52:36 UTC. O callback HTTP de loopback foi aceito. Os headers
informaram limite de leitura de **30/minuto**, com saldo de 29 a 22 durante
a sequência; isso não certifica quota de escrita nem concorrência da conta.
As duas listas de pagamento retornaram dez itens da primeira página, não uma
contagem total da conta.

O coletor foi encerrado após a prova. Tokens não foram persistidos; o envelope
cifrado de entrada foi consumido/apagado e as chaves ficaram somente em memória
durante a execução. O aplicativo e suas credenciais continuam cadastrados no
ERP, **somente leitura**; não foram revogados, rotacionados ou ampliados.
O Client Secret foi ocultado novamente na interface. Capturas sem segredo
ficam em var/olist-phase1/ no checkout principal, fora do Git.

Nenhum cliente, produto, variação ou pedido foi criado. A autorização cobre
somente esse acesso de leitura, sem ampliar permissões ou liberar o caso
controlado de escrita. T02 e o gate F1 permanecem abertos.

## Configuração aprovada e executada

| Campo                  | Valor aprovado                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Nome                   | CRM Silmer - prova F1 - somente leitura                                                                                                  |
| Conta                  | A conta operacional atual, conferida pelo documento da empresa em memória antes de consultar outros módulos                              |
| Redirecionamento OAuth | `http://127.0.0.1:8765/olist/callback`                                                                                                   |
| Execução               | Coletor temporário nesta máquina, ligado apenas ao loopback 127.0.0.1; duração máxima de 30 minutos                                      |
| Credenciais            | Client ID/secret gerados pelo Olist somente após aprovação e salvamento; transferência local cifrada, sem texto puro em arquivo/chat/log |
| Autorização            | Fluxo oficial de código OAuth; uma troca de código no endpoint de tokens do Olist; sem refresh automático                                |
| Tokens                 | Apenas memória durante a execução; sem persistência de access/refresh token                                                              |
| Consultas              | Até oito GET fixos, uma página de até dez itens por lista paginada, sem repetição automática                                             |
| Resultado público      | Status HTTP, contagem de itens, limites de uso e conta coincidente; sem CPF/CNPJ, nomes, IDs, payload ou token                           |
| Escritas ERP           | Nenhuma; incluir/editar/excluir desmarcados em todos os módulos                                                                          |

Permissões conferidas na tela real, que separa Leitura de Incluir e editar/Excluir:

| Módulo               | Leitura | Incluir/editar | Excluir      | Necessidade                                                                       |
| -------------------- | ------- | -------------- | ------------ | --------------------------------------------------------------------------------- |
| Contatos             | Sim     | Não            | Não          | Buscar comprador de teste e consultar vendedores, sem criar funcionário/comprador |
| Produtos             | Sim     | Não            | Não          | Buscar produto de teste e grade                                                   |
| Pedidos              | Sim     | Não            | Não          | Consultar ausência da referência do caso, sem nova venda                          |
| Informações da Conta | Sim     | Indisponível   | Indisponível | Confirmar empresa antes de outras consultas                                       |
| Forma de Pagamento   | Sim     | Indisponível   | Indisponível | Conferir configuração comercial disponível                                        |
| Forma de Recebimento | Sim     | Indisponível   | Indisponível | Conferir configuração comercial disponível                                        |
| Depósitos            | Sim     | Indisponível   | Indisponível | Consultar depósitos existentes, sem movimentar estoque                            |

Todos os demais módulos ficam desmarcados, incluindo Notas Fiscais, Estoque,
Expedição, Contas Receber/Pagar, Caixa, Extrato bancário, Usuários e Anúncios.
Não usar Marcar todos. Gatilhos tem leitura na UI, mas o snapshot público da API 3.1
(OpenAPI 3.0.0) consultado não forneceu rota/operationId correspondente; não
inventar URL nem pedir escopo sem método comprovado. A evidência dos gatilhos
permanece na inspeção autenticada da UI até esclarecer o contrato dessa rota.

Esta aprovação não abrange comprador fictício/CPF gerado, novo produto,
variação ou pedido, alteração de parâmetros, envio de mensagens, fiscal,
estoque, cobrança, publicação, upgrade ou contratação.

## Coletor e consultas executadas

[read-only-probe.mjs](read-only-probe.mjs) usa somente módulos nativos Node,
sem nova dependência, serviço de produção ou mudança no runtime do CRM.
O transporte e o método são allowlist exata; não há proxy ou payload ERP
arbitrário. O único POST permitido é a troca OAuth, para o host oficial fixo.

| Ordem | GET fixo                                                               | Limite                                                                                                          |
| ----- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1     | `/info`                                                                | Documento retornado precisa coincidir com a identidade esperada da conta; divergência para antes dos demais GET |
| 2     | `/contatos?nome=teste&limit=10&offset=0`                               | Uma página; nomes/documentos não entram no resumo                                                               |
| 3     | `/produtos?nome=teste&limit=10&offset=0`                               | Uma página; sem alteração de catálogo/estoque                                                                   |
| 4     | `/pedidos?numeroPedidoEcommerce=CRM-F1-20261104-C01&limit=10&offset=0` | Consulta da referência proposta, sem criar venda                                                                |
| 5     | `/vendedores?limit=10&offset=0`                                        | Uma página; IDs/nome apenas em memória                                                                          |
| 6     | `/depositos`                                                           | Lista sem paginação no schema; corpo limitado a 128 KiB, sem lançar saldo                                       |
| 7     | `/formas-pagamento?limit=10&offset=0`                                  | Uma página                                                                                                      |
| 8     | `/formas-recebimento?limit=10&offset=0`                                | Uma página                                                                                                      |

A base única é `https://api.tiny.com.br/public-api/v3`. A troca de código usa
`https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token`.
Não ler cookies do Chrome nem reutilizar token legado de outra integração.
Não usar gerador de CPF para preencher a identidade esperada: ela precisa ser
a empresa real da conta, conferida privadamente. Essa comparação é de conta,
não prova de cadastro fiscal de comprador.

Estado OAuth tem 32 bytes aleatórios e consumo único. Callback exige host,
porta e caminho exatos e rejeita parâmetros duplicados/replay; remove code/state
da URL por redirect local antes das consultas. Respostas têm no-store,
no-referrer e CSP restritiva. HTTP externo não segue redirects, tem timeout
de 15s e limites de corpo. Erro, quota baixa ou expiração interrompem a prova,
sem retry; rotas de criação ERP são recusadas antes da rede.

O provedor aceitou o callback HTTP de loopback nesta execução. Não foi
necessário publicar callback externo ou alterar produção. Esta prova não
comprova PKCE, refresh, escrita ou idempotência.

## Procedimento utilizado e repetição futura

1. Iniciar o coletor com Node 24.20.0, em diretório privado ignorado pelo Git:

   ```powershell
   fnm exec --using 24.20.0 -- node docs/integrations/olist/read-only-probe.mjs
   ```

   A porta é fixa 8765; se ocupada, o processo recusa iniciar sem trocar a URL.
   O processo cria `var/olist-phase1/session-.../public-key.pem` e informa o
   caminho esperado de `credentials.enc`. A chave RSA privada nunca sai da
   memória. A parte pública e o envelope cifrado não contêm segredo em claro.

2. Salvar no ERP somente a configuração aprovada, observando novamente os
   checkboxes de Leitura e negando incluir/editar/excluir antes do clique.
   Se aparecer cobrança ou permissões diferentes, interromper para revisão.
3. Conferir a identidade da empresa no próprio ERP. Ler as chaves somente pela
   UI autorizada, sem emitir seus valores na ferramenta. Cifrar localmente um
   JSON com clientId, clientSecret e expectedDocument usando a chave pública
   da sessão, RSA-OAEP/SHA-256, e gravar apenas os bytes cifrados no envelope.
   Se o conteúdo exceder o limite RSA, parar; não usar arquivo em texto puro.
4. O coletor importa o envelope uma vez, apaga apenas esse artefato temporário
   e mantém as credenciais na memória. Abrir `http://127.0.0.1:8765/` e seguir
   Conectar Olist para consultas. Se houver login/verificação, o PO completa
   autenticação diretamente no navegador; não enviar senha/código pelo chat.
5. Conferir o consentimento da conta/módulos aprovados, aguardar o resumo e
   registrar somente os campos sanitizados. O coletor não publica IDs ou corpos;
   os registros selecionados para o caso serão conferidos privadamente depois.
6. Encerrar o processo após o resumo. Expira em até 30 minutos e não renova
   tokens. O cadastro do aplicativo permanece no Olist até decisão sobre uso
   posterior/revogação; não apagar ou ampliar permissões automaticamente.

## Validação

[Testes](read-only-probe.test.mjs): 17 cenários de segurança/contrato, incluindo
ensaio completo em loopback com todos os retornos remotos **simulados**:
importação cifrada, callback/redirect, oito GET e resumo sem dados privados.
Teste não usa CPF/CNPJ real nem rede externa. Resultado/versionamento/hashes
em [evidência offline do coletor](evidence/read-only-probe-result.json).

```powershell
fnm exec --using 24.20.0 -- node --test docs/integrations/olist/read-only-probe.test.mjs
```

Os 17 testes simulados certificam o coletor; a evidência real acima certifica
somente as oito leituras e a conexão descrita. Não certificam escrita ou
completude de F1. Não houve mudança em API/worker/UI/migrações do CRM; este
utilitário fica isolado em docs/integrations/olist. A próxima etapa exige caso
controlado revisável e autorização específica antes de ampliar acesso/criar
registros. Não repetir automaticamente as consultas por este documento.

## Consultas posteriores do caso C01

Após o PO confirmar o cadastro SILMER encontrado, o mesmo aplicativo foi
reutilizado no transporte C01 somente para preparação. Foram dezesseis GET
em quatro rodadas (três diagnósticos de dois e a preparação final de dez),
sem POST ERP ou ampliação de acesso. Comprador, pai e M/G foram conferidos.
[Evidência C01](evidence/controlled-sale-preflight.json) ·
[caso e próxima aprovação específica](controlled-case.md).
O coletor original continua restrito aos oito GET; o transporte C01 tem
modo de preparação separado e padrão sem escrita. As sessões foram encerradas.
