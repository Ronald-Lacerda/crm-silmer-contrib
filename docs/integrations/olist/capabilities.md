# Olist — prova de capacidades da Fase 1

OLIST-T02 / OLIST-03–17, 20, 26, 35–41. Responsável: Integrações,
coordenado pelo Tech Lead (Codex nesta execução). Consulta em 04/11/2026.
[Revisão T01](contract-review.md) · [RFC 044](../../rfc/044-geracao-assistida-de-pedidos-no-olist.md)
· [ADR 057](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).

**Situação: prova documental/offline entregue; T02 e gate F1 abertos.**
O PO autorizou consultas na conta operacional atual e a preparação de caso
controlado, com aprovação anterior a qualquer criação. Inspeção autenticada
pela UI já realizada; zero chamadas autenticadas à API v3, inclusões, criação
de credenciais ou alterações de parâmetros. Gatilhos e pendências no
[caso controlado](controlled-case.md). T02/F1 continuam abertos.

## Schema e reprodução

Fonte pública oficial:
[swagger-mintlify.json](https://erp.olist.com/public-api/v3/swagger/swagger-mintlify.json),
referenciada pela página [Criar pedido](https://api-docs.erp.olist.com/api-reference/pedidos/criar-pedido).
OpenAPI `3.0.0`, API `info.version = 3.1` (rota continua `/v3`).
Last-Modified recebido: `Thu, 29 Oct 2026 16:58:38 GMT`.
SHA-256 dos 844559 bytes da fonte:
`107f8d039de20401097443038efb1459c9c2ff01599830fe1274cfa0d9f47216`.

O [manifesto](evidence/schema-manifest.json) registra instante UTC, URL,
versão, hash original e hash da [projeção](evidence/openapi-v3.projection.json).
A projeção preserva sem alterar os 11 pares método/path selecionados e seus
componentes transitivos; somente serialização/ordem de chaves são normalizadas.
Não contém resposta de conta, segredo ou dado de cliente real. O arquivo
original completo não é versionado. Não é o OpenAPI das futuras rotas CRM.

Prova isolada em Python 3.14 / `jsonschema 4.26.0`; não adiciona dependência,
serviço ou runner ao runtime Node. `jsonschema` (licença MIT) é usado somente
para validação local do schema; versão fixada para reprodução. Risco/impacto:
instalação em venv de desenvolvimento, sem PII, execução no servidor ou mudança
no lockfile da aplicação. Em outro ambiente, instalar a dependência
em venv local ignorado pelo Git, se necessário:

```powershell
python -m venv .tmp/olist-proof
.tmp/olist-proof/Scripts/python -m pip install -r docs/integrations/olist/requirements-proof.txt
.tmp/olist-proof/Scripts/python docs/integrations/olist/verify_contract.py
```

Nesta máquina, a biblioteca já existe; comando executado:

```powershell
python docs/integrations/olist/verify_contract.py
```

[Resultado registrado](evidence/offline-result.json): **11 testes passaram**, incluindo seis hipóteses monetárias e
integridade de 24 casos planejados de falha. A adaptação de `nullable` permite
checar tipos/enum/required/allOf/refs do recorte com JSON Schema Draft 4.
Não valida CPF/IE/NCM, restrições em texto livre, autorização, efeitos remotos
ou o worker ainda não implementado. As rejeições observadas são do validador
local, não respostas 4xx do Olist. Fixtures estão marcadas `sendable: false`;
o documento fiscal é intencionalmente inválido para provar a permissividade.

Recaptura opcional (faz somente GET público, sobrescreve evidências locais;
revisar o diff/hash e executar a prova após qualquer mudança):

```powershell
python docs/integrations/olist/capture_schema.py
```

## Matriz de capacidades

“Documentado” significa propriedade/operação no schema ou texto oficial;
“aberto” exige observação na conta. Nenhum item abaixo é certificado live.

| Capacidade                    | Evidência pública e observação offline                                                                                                                                                                                              | Situação / prova restante                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cliente comprador             | [Criar contato](https://api-docs.erp.olist.com/api-reference/contatos/criar-contato): `POST /contatos`; `tipoPessoa` F/J e `cpfCnpj`, `codigo`, endereço/IE. Busca `GET /contatos` por `cpfCnpj`/`codigo`, leitura por ID           | Documentado; provar identidade exata, duplicatas, obrigatórios e retorno pesquisável                                         |
| Cliente sem acesso ao sistema | `ContatoModel.situacao`: B ativo, A ativo com acesso. Fixture usa B; nenhuma operação de criação de funcionário                                                                                                                     | Provar que cadastro só cria comprador e não concede acesso; não usar A                                                       |
| Produto pai                   | [Criar produto](https://api-docs.erp.olist.com/api-reference/produtos/criar-produto): sku/descricao/tipo obrigatórios estruturais. Tipo V descreve grade e variações iniciais obrigatórias, mas required não codifica essa condição | Pai vazio não está comprovado. Provar criação composta e IDs/readback de todas as variações; não assumir atomicidade do lote |
| Tamanhos/variações            | [Criar variação](https://api-docs.erp.olist.com/api-reference/produtos/criar-varia%C3%A7%C3%A3o-do-produto): `POST /produtos/{idProduto}/variacoes`, sku e grade com chave/valor; chaves devem coincidir com pai                    | Provar adição a pai existente, limite de grade/tamanho/SKU, não agregação indevida; validar retorno e leitura do pai         |
| Identidade de produto         | `GET /produtos?codigo=` e `GET /produtos/{idProduto}`; leitura retorna sku, produtoPai e variacoes com IDs/grade                                                                                                                    | Provar filtro de codigo recuperando sku exato, igualdade normalizada e paginação completa; nome não é identidade             |
| Fiscal de produto             | Schema expõe ncm, origem, unidade e tributacao, sem fixar preenchimento suficiente por conta/categoria                                                                                                                              | Exigir política explícita e dados válidos; nenhum NCM/origem/unidade/preço de catálogo inventado                             |
| Venda e referência            | [Criar pedido](https://api-docs.erp.olist.com/api-reference/pedidos/criar-pedido): itens com produto.id, quantidade e valorUnitario; ecommerce.numeroPedidoEcommerce; retorno id/numeroPedido                                       | Provar referência sem ecommerce.id, ou ID central requerido; nunca reutilizar numeroOrdemCompra                              |
| Reconciliação da venda        | [Listar pedidos](https://api-docs.erp.olist.com/api-reference/pedidos/listar-pedidos): filtro numeroPedidoEcommerce e limit/offset; detalhe por ID                                                                                  | Provar roundtrip/filtro/limites e duplicatas; não há promessa de unicidade ou idempotência na prova                          |
| Dinheiro por linha            | Item request/response usa number/float sem multipleOf/escala. Resposta tem produto/quantidade/valorUnitario/infoAdicional; totais só no pedido                                                                                      | Escala, arredondamento, subtotal independente e agregação de produto repetido abertos; total igual não basta                 |
| Conta e OAuth                 | [Autenticação](https://api-docs.erp.olist.com/documentacao/comecando/autenticacao) documenta código/refresh; `/info` permite conferir empresa. Prazo documental 4h/1d não substitui expires retornado                               | Confirmar identidade protegida, reconexão, permissões/PKCE e rotação; sem persistir token nesta prova                        |
| Permissões                    | [Aplicativo](https://api-docs.erp.olist.com/documentacao/comecando/criando-um-aplicativo): mínimo por módulo e permissões do usuário ERP; mudança pode exigir nova autorização                                                      | Testar leituras/criações de Contatos/Produtos/Pedidos/Info; sem escopos fiscais/estoque/baixa/exclusão                       |
| Quotas                        | [Limites](https://api-docs.erp.olist.com/documentacao/comecando/limites-de-consulta): leitura/escrita por conta compartilhadas, headers X-RateLimit-*                                                                               | Valores efetivos e concorrência por conta abertos; números de exemplo não são quota da Silmer                                |
| Gatilhos/efeitos              | [Gestão de aplicativos](https://ajuda.olist.com/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao) lista API de Gatilhos e permissões por módulo                                                             | Inspecionar configuração efetiva e conferir ausência de nota, estoque, contas, cobrança e mensagens automáticas              |
| Link de venda                 | Resposta de criação tem id/numeroPedido, sem link de impressão garantido nesse recorte                                                                                                                                              | Mostrar número; não gerar doc.view, URL compartilhável ou adivinhar hash                                                     |

## Campos centrais e completude

Mapeamento candidato, sujeito à prova de campos obrigatórios da conta:

| Fonte CRM / configuração                                             | Campo ERP                                                    | Guarda                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| registration.personType individual/company                           | tipoPessoa F/J                                               | Somente os tipos existentes; estrangeiro exige decisão de escopo se surgir                 |
| registration.document/legalName                                      | cpfCnpj/nome                                                 | Documento validado no domínio CRM, busca exata e HMAC local; ausência/ambiguidade bloqueia |
| registration.stateRegistration                                       | inscricaoEstadual                                            | Não converter vazio em ISENTO; regra fiscal explícita ainda pendente                       |
| registration.street/number/district/city/state/postalCode/complement | endereco.endereco/numero/bairro/municipio/uf/cep/complemento | Usar cadastro versionado; pais somente de fonte/default central aprovado                   |
| Contato celular/e-mail                                               | celular/email                                                | Exportar somente o mínimo exigido, sem notas/Instagram/contexto de atendimento             |
| Assinatura comercial aprovada do grupo                               | sku/descricao + atributos verificáveis                       | Não usar posição de array, nome sozinho ou preço negociado como identidade                 |
| Tamanho da linha                                                     | variacoes[].grade com chave/valor                            | Pai inclui definição de grade; mesma letra em dois grupos não une produtos                 |
| Linha CRM subtotal/quantidade                                        | itens[].valorUnitario/quantidade                             | Derivação exata sob precisão comprovada; comparar cada linha após criar                    |
| summary.data_entrega_confirmada                                      | dataPrevista (candidato)                                     | Confirmar semântica de previsão; não usar deliveredOn ou inferir data                      |
| orderDate ou dia de São Paulo congelado no comando                   | data                                                         | Não muda confirmação/data CRM; retry preserva valor                                        |
| Conta: vendedor/natureza/depósito/situação/pagamento                 | Objetos/IDs homônimos e parcelas                             | IDs/códigos reais a validar; não inferir do dono CRM ou de Pix                             |
| Referência local da exportação                                       | ecommerce.numeroPedidoEcommerce                              | Comprimento/pesquisabilidade e ecommerce.id a provar; ordem de compra fica própria         |

O schema aceita estruturalmente `{}` para contato/venda/variação e aceita
CPF inválido. Isso não reduz OLIST-34/35 nem dispensa o validador próprio da
prévia. O documento técnico não estabelece regime/IE/NCM por conta própria.

## Casos de dinheiro e leitura

[Fixtures sintéticas](fixtures.json), OLIST-09/10/40/41/42. Os testes usam
inteiros/Fraction e a **hipótese** de arredondamento half-up ao centavo por
linha; nenhuma escala ou regra foi atribuída ao Olist.

| Quantidade | Subtotal CRM | Escala hipotética | Resultado local                                                    |
| ---------- | ------------ | ----------------- | ------------------------------------------------------------------ |
| 10         | R$ 180,00    | 2                 | Unitário R$ 18,00 representa                                       |
| 20         | R$ 320,00    | 2                 | Unitário R$ 16,00 representa, desconto por quantidade preservado   |
| 3          | R$ 1,00      | 2                 | Não há representação por essa hipótese                             |
| 3          | R$ 1,00      | 4                 | 0,3333 pode representar sob a hipótese, exige confirmação remota   |
| 1000       | R$ 0,01      | 4                 | Não há representação por essa hipótese                             |
| 1000       | R$ 0,01      | 6                 | 0,000010 pode representar sob a hipótese, exige confirmação remota |

Testar os limites de escala aceitos, empate de arredondamento, quantidade alta,
dois grupos com tamanho M e duas linhas com o mesmo produto, incluindo valores
diferentes. Ler resposta JSON preservando lexemas decimais; conferir também a
visualização do ERP quando não houver subtotal independente na API. Documentar
como obter prova suficiente por linha. Se o ERP unir linhas ou não permitir
comprová-las, F1 permanece aberto; não declarar sucesso pela soma global.

O cenário 100+100 centavos esperado versus 99+101 remoto soma o mesmo total e
é divergente. Aritmética offline não comprova armazenamento/arredondamento do
provedor. Inexatidão bloqueia só exportação conforme decisão já aprovada; não
precisa de nova decisão para manter o Pedido comercial válido no CRM.

## Recuperação planejada por entidade

A matriz em fixtures contém quatro efeitos × seis falhas: timeout/crash após
reserva, 5xx, JSON inválido, sucesso sem ID e falha de commit local. Resultado
esperado em todos: incerto, sem repetir inclusão ou iniciar dependentes.
A prova offline checa cobertura/coerência da matriz, não execução de falhas.
Injeção de falhas/concorrência de runtime será evidência de T03/T08/T22/T14.

| Etapa                      | Consulta de recuperação                                            | Persistência / limite                                                                                                     |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Cliente                    | Documento/código, paginação e GET por ID conhecido                 | Guardar ID confirmado antes de produto; zero após incerteza não libera POST                                               |
| Pai com variações iniciais | Código do pai e GET pai com variações/IDs/grade                    | Tratar conjunto criado no mesmo HTTP como possivelmente afetado; reconciliar cada SKU/filho antes de reservar complemento |
| Variação adicional         | GET pai e filtro/código de produto; conferir vínculo/grade         | Guardar ID/tamanho confirmado; ausência/ambiguidade não autoriza repetir                                                  |
| Venda                      | Referência e GET por ID; conta/comprador/grade/cada subtotal/total | Divergência preserva ID e exige análise; sem segundo POST                                                                 |

Se inclusão inicial composta for obrigatória, T03/T22 precisam representar
pai e filhos como recursos com dependências, reservar todos antes do HTTP e
reconciliar resultados parciais. Ainda não foi decidido que o provedor fornece
atomicidade do conjunto. Isso é gap de contrato, não permissão de retry de lote.
Revogação antes do próximo efeito bloqueia avanço; efeito iniciado continua
exigindo registro/reconciliação. Sem DELETE, atualização de catálogo ou
cancelamento de venda como compensação técnica.

## Ambiente e plano de prova real

A documentação pública consultada da API ERP v3 não comprovou sandbox nem
conta de testes já disponível. Não concluir que o fornecedor não oferece:
a disponibilidade precisa ser confirmada com a conta/suporte. A documentação
sobre [staging de e-commerce](https://ajuda.olist.com/desenvolvedores-e-api/api-da-plataforma-de-ecommerce-da-olist)
trata de outro produto/API. [Homologação fiscal](https://ajuda.olist.com/primeiros-passos-para-emitir-notas-fiscais/ambientes-da-nota-fiscal)
isola validade de notas, sem comprovar isolamento de cadastros/pedidos/contas.

A preferência inicial por conta dedicada foi revista pelo PO em 04/11/2026:
**usar a conta operacional atual para consultas e preparar o caso controlado
para aprovação antes de qualquer criação**. Não foi autorizada criação real,
credencial/aplicativo ou alteração de parâmetros nesta etapa. A conta de testes
não foi criada. O plano abaixo é a matriz original; o escopo atual menor,
gatilhos observados e pendências estão no [caso controlado](controlled-case.md).

Preparação mínima do alvo, sem segredo/documento real no repositório:

1. Conferir identidade da conta operacional autorizada, acesso existente à
   API v3/Gestão de Aplicativos e gatilhos sem salvar configurações. Consulta
   não autoriza criar credencial, contratar serviço ou executar POST de prova.
2. Guardar identidade esperada da empresa/conta e credenciais em canal privado;
   registrar publicamente apenas referência opaca da evidência. Preparar
   aplicativo privado, callback e permissões mínimas; autenticação real depende
   desse acesso (conector de produção será T04).
3. Integrações confere `/info`, permissões, parâmetros comerciais/fiscais,
   quotas e gatilhos. Conta isolada não elimina efeitos externos: bloquear
   notificações, fiscal, estoque, financeiro/cobrança e integrações downstream
   incompatíveis antes de qualquer escrita. Ler configurações se não houver API.
4. Preparar dados aceitos pelo ambiente e plano concreto: um comprador, um pai
   com M/G iniciais, uma variação GG adicional e vendas/casos monetários abaixo.
   Os placeholders de fixtures não são payload fiscal pronto. Cada efeito tem
   referência própria e orçamento máximo; revisar antes de autorizar as inclusões.
5. Executar primeiro somente buscas/leituras; depois as inclusões autorizadas,
   uma vez por identidade e com registro privado dos IDs. Não apagar recursos
   para resetar testes, não reproduzir timeout destrutivo contra provedor.
6. Ler por identidade/ID e comparar pai/filhos, comprador, cada linha e total,
   precisão/SKU/referência, IDs do retorno e gatilhos. Caso duplicado preexistente
   é negativo de consulta; não criar duplicatas de propósito em conta operacional.
7. Registrar versão/hash usados, código seguro de rejeições, campos/limites
   comprovados, evidências privadas por entidade, responsáveis e resultado.
   Só então reavaliar T02/F1 e a autorização para T03.

Matriz inicial de chamadas a concretizar após o alvo:

| Caso                           | Leituras/efeitos previstos                                      | Critério / limite                                                                                 |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Conta e busca                  | GET info, listas/detalhes por documento/código/referência       | Sem escrita; teto inicial 30 GET, limit até 100, páginas limitadas e sem extrapolar quota efetiva |
| Cadastros                      | Até 1 POST contato + 1 POST pai com M/G + 1 POST variação GG    | Um recurso por identidade; reconciliar qualquer incerteza e parar                                 |
| Venda exata                    | Até 1 POST pedido com M 10/R$180 e G 20/R$320                   | Duas linhas preservadas e R$500; não alterar catálogo, contas ou estoque                          |
| Precisão e identidade de linha | Até 3 POST pedido, cada caso previamente escolhido              | Terço/escala, empate e produto repetido; cada linha confere, sem compensação                      |
| Rejeições/limites              | Somente os payloads negativos revisados/autorizados para o alvo | Rejeição esperada pode criar efeito se schema aceitar; sem execução automática                    |

Esse orçamento é teto de planejamento, não autorização de execução. Revalidar
quota e ambiente por caso; nenhum script desta entrega executa POST/autenticação.
Se faltar campo central/fiscal, parar antes da inclusão e informar pendência.
Na conta operacional, a referência de teste não suprime efeitos ou métricas.
Apresentar o caso final com identidades validadas e efeitos/custos antes de
solicitar aprovação. Nenhum orçamento da matriz original autoriza execução.

## Handoff e próximo passo

- T01: concluída e publicada no commit `bb453651`.
- T02: captura/schema, fixtures e 11 testes offline concluídos; inspeção UI
  da conta operacional e caso mínimo proposto em documento próprio. API v3,
  gatilhos restantes, fiscal, precisão/linhas e efeitos reais pendentes. F1 aberto.
- Sessão expirou durante a inspeção da loja de extensões; novo login solicitado
  para terminar as consultas. Não solicitar senha/token pelo chat ou publicar
  IDs reais. Caso controlado depende de conclusão das consultas e aprovação.
- Sem migração, runtime, deploy, habilitação de operadora ou piloto. Próximo
  desbloqueio: prova real T02; T03 depende do gate F1.
