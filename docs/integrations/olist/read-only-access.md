# Olist — acesso temporário somente leitura para a prova F1

OLIST-T02 / OLIST-03–05, 07–13, 20, 25–27, 35–41.
Dono: Tech Lead/Integrações (Codex nesta execução). 04/11/2026.
[RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md) ·
[Consultas e caso controlado](controlled-case.md).

## Entrega e autorização

O PO aprovou instalar somente a extensão gratuita Gestão de Aplicativos.
Instalação concluída e confirmada por INSTALADO. Aplicativos está disponível
em Configurações > geral; a lista estava vazia. O formulário novo foi apenas
aberto para inspeção, sem preenchimento ou salvamento. Informa explicitamente
que as chaves são geradas depois de definir permissões e salvar.

A próxima aprovação proposta é **criar um aplicativo privado somente leitura
e conectá-lo a um coletor local temporário, executando até oito consultas**.
Isso concede acesso novo aos dados dos módulos abaixo. Nenhuma credencial,
permissão ou consulta autenticada v3 foi criada/executada nesta entrega.

## Proposta concreta para aprovação

| Campo                  | Valor proposto                                                                                                                           |
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

Permissões propostas na tela real, que separa Leitura de Incluir e editar/Excluir:

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
Não usar Marcar todos. Gatilhos tem leitura na UI, mas o snapshot público
OpenAPI 3.1 consultado não forneceu rota/operationId correspondente; não
inventar URL nem pedir escopo sem método comprovado. A evidência dos gatilhos
permanece na inspeção autenticada da UI até esclarecer o contrato dessa rota.

Esta aprovação não abrange comprador fictício/CPF gerado, novo produto,
variação ou pedido, alteração de parâmetros, envio de mensagens, fiscal,
estoque, cobrança, publicação, upgrade ou contratação.

## Coletor preparado, ainda sem conexão real

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

O uso de callback HTTP de loopback pelo provedor ainda precisa ser comprovado
na configuração/conexão real. Se o Olist rejeitar esse redirecionamento,
interromper; não publicar callback em host externo nem alterar produção por
conta própria. Não alegar prova de PKCE, refresh, escrita ou idempotência.

## Operação após aprovação, não executada com dados reais

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

Checks do coletor/documentos não certificam operação real ou completude de F1.
Não houve mudança em API/worker/UI/migrações do CRM; este utilitário de prova
fica isolado em docs/integrations/olist. Gates completos da aplicação/deploy
continuam com suas tarefas. Próximo passo requer aprovação concreta acima.
