# Olist — revisão do contrato da Fase 1

OLIST-T01 / OLIST-01–50. Revisão de 04/11/2026 sobre `977b3134`.
Responsável de integração e fechamento: Tech Lead (Codex nesta execução).
[Contrato de produto e tarefas](../../rfc/050-geracao-assistida-de-pedidos-no-olist.md),
[decisões aceitas](../../adr/057-olist-por-habilitacao-subtotal-por-tamanho-e-cancelamento.md).
Sem issue/PR específica nesta revisão; publicação na branch `codex/olist-specification`.

## Resultado da revisão

T01 concluída documentalmente. RULES, spec CRM, PRD, TDD e ARCHITECTURE já
contêm a emenda da ADR 057, distinguindo o contrato aprovado do código
publicado. Os trechos antigos sobre Olist manual, posse e total digitado são
baseline histórica nos pontos expressamente supersedidos. ADRs anteriores e
ADR 057 ficam imutáveis. Nenhuma decisão de produto nova foi tomada.

A prova de API/conta T02 é independente e permanece aberta. F1 não libera
T03 nem qualquer inclusão ERP enquanto o seu gate não estiver comprovado.
Cadastro automático permanece no escopo; ausência de prova não o converte
em cadastro manual obrigatório.

## Rastreabilidade e responsabilidades

Os donos abaixo são papéis, sem alocar pessoas externas ou habilitar contas.
Tech Lead coordena os handoffs; cada tarefa terá um único dono por arquivo.
Os papéis de Backend, Integrações, Frontend/A11y, QA e DevOps serão ativados
na sua fatia. Nesta revisão documental, Tech Lead executa sozinho.

| Requisitos OLIST | Contrato preservado                                                                                                      | Tarefas / dono da implementação                          | Evidência de fechamento                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 01–02, 33        | Humano ativo com checkbox, qualquer Pedido completo; busca exata mínima, sem Inbox/edição geral; Admin não herda geração | T19 Backend; T07 Backend; T12 Frontend/A11y              | Perfis/donos/origens, negações e replay revogado                                |
| 03–05            | Gestão Admin, sessão/CSRF/estado OAuth único, cifra/refresh com fencing e conta validada                                 | T03 Backend; T04 Integrações; T11 Frontend/A11y          | Callback inválido, reconexão em outra conta, resposta tardia                    |
| 06, 34–35        | Validador próprio por campo/revisão; confirmado não prova completude; cadastro fiscal sem invenção                       | T06 Backend; T24 Backend; T02 Integrações                | Confirmado legado, loja sem Contato/previsão, documento/IE faltantes            |
| 07–08, 36–39     | Resolver/criar comprador, pai e variações; identidade compartilhada, dados existentes preservados                        | T05/T22 Integrações; T09 Backend                         | Ambiguidade, dois Pedidos, falha em cada criação e retomada por IDs             |
| 09–10, 40–43     | Grupo distinto da linha, IDs estáveis, subtotal em centavos, total backend e unitário ERP derivado                       | T20/T21 Backend; T06 Backend; T08 Integrações            | Reordenação, M em dois grupos, desconto, overflow e revisão após quantidade     |
| 11               | Configuração central versionada; compra/vencimento explícitos; data ERP congelada sem confirmar CRM                      | T04 Integrações; T06 Backend; T15 DevOps                 | Parâmetro obsoleto, pendente sem orderDate e retry em outro dia                 |
| 12–13, 26, 32    | Allowlist mínima, referência por entidade, consultas limitadas, sem proxy/URL arbitrária                                 | T02/T05 Integrações; T09 Backend                         | Filtros exatos, páginas/quotas, ausência de link confiável mostra número        |
| 14–18, 30        | Reserva/outbox locais atômicas, efeito independente, incerteza sem retry criador e vínculo conferido                     | T03/T07/T09 Backend; T08/T22 Integrações                 | Chaves/abas/processos, resposta perdida, zero/múltiplos/divergentes sem POST    |
| 19–21, 45–47     | Sem efeito fiscal/estoque/baixa/cancelamento ERP; cancelamento local terminal e pós-envio congelado                      | T23/T10 Backend; T13 Frontend/A11y                       | Corrida com worker, universos antes de paginar, histórico financeiro preservado |
| 22–24            | UI persistida, estados por etapa, Vue/shell/tokens e teclado/foco/ARIA                                                   | T11/T12/T13 Frontend/A11y; T14 QA                        | Celular/desktop, reload, duas abas, perfil restrito e axe/teclado               |
| 25, 27–29, 48    | PII/segredos protegidos, revogação antes de cada efeito, expand/restore e piloto individual privado                      | T03/T10 Backend; T04 Integrações; T15 DevOps/Privacidade | Logs sintéticos, restore com efeitos fora do backup, flags desligadas           |
| 31               | Gate integrado não confunde código, teste local, deploy e aceite                                                         | T14 QA; T15 DevOps; T16–T18 Operação/Tech Lead/PO        | Negativos/concorrência/A11y, digest/health, aceite explícito                    |
| 44               | Legado preserva total/snapshot; loja preserva checkout/gateway/travas                                                    | T26/T24 Backend                                          | Enriquecimento humano igual ao total; divergência bloqueada, sem rateio         |
| 49–50            | Aplicação por grupo e Previsão de entrega, mesmas chaves; ficha v7 própria                                               | T25 Frontend/Impressão com QA                            | HTML/PDF v7 e amostra aprovada; v2–v6 e hashes intactos                         |

## Confirmação nas fontes atuais

O grafo do checkout principal é de 04/10/2026, commit `c237200a`, anterior à
baseline. Foi consultado somente como mapa. O worktree da RFC não possui
`graphify-out/`; os achados foram confirmados com `rg` e leitura das fontes:

| Fronteira atual                                                                   | Achado confirmado                                                                                                                               | Consequência para a implementação                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Cadastro](../../../modules/contacts/src/domain/contact-registration.js)          | Cadastro é opcional; completude local exige IE para PJ, mas não comprova exigências da conta ERP; telefone/e-mail estão no envelope de detalhes | T06 compõe fontes/versionamento e aplica exigência fiscal comprovada; não reutilizar booleano como aceite ERP |
| [Pedido](../../../modules/orders/src/domain/order.js)                             | `missingForConfirmation` retorna vazio para confirmado; confirmação recebe `amountCents` independente                                           | T06 usa validador independente de status; T20/T21 substituem entrada de total sem retrocalcular legado        |
| [Autorização](../../../modules/identity-access/src/authorization.js)              | Ações/perfis atuais não têm capacidade Olist                                                                                                    | T19 adiciona política ortogonal sem elevar Financeiro a Vendedor/Admin                                        |
| [Loja](../../../modules/orders/src/domain/store-order.js)                         | Snapshot de origem próprio e Pedido já confirmado                                                                                               | T24 adiciona completude autorizada; não inventar Contato/data nem destravar checkout                          |
| [Financeiro](../../../modules/orders/src/adapters/postgres-finance-repository.js) | Universo confirmado/pago próprio                                                                                                                | T23 filtra cancelados antes de contagem/paginação, preserva histórico                                         |
| [Impressão](../../../modules/orders/src/print/ficha-canonical-v6.js)              | v6 é versão histórica selecionada                                                                                                               | T25 cria versão nova; esta fase não troca seletor ou artefatos                                                |

## Gaps técnicos abertos

| ID     | Limitação / tratamento exigido                                                                                                                                                           | Dono / gate                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| F1-G01 | `number/float` não informa escala unitária/arredondamento; resposta de item não declara subtotal próprio. Provar representação e leitura por linha, inclusive repetição do mesmo produto | Integrações T02; bloqueia F1 e T06/T08                                          |
| F1-G02 | Produto tipo V descreve grade e variações obrigatórias na criação. Provar pai vazio ou planejar criação inicial composta; não enviar pai inválido nem repetir lote após timeout          | Integrações T02/T22; bloqueia F1/T03 para essa fronteira                        |
| F1-G03 | Documento, IE/isento, NCM/origem/unidade e outros mínimos fiscais variam por exigência efetiva; schema permissivo não comprova regra fiscal                                              | Integrações T02; valores centrais reais em T15; nenhum default fiscal inventado |
| F1-G04 | Filtros de código/documento/referência existem, sem garantia de unicidade/idempotência. Provar roundtrip/limites e igualdade; zero após incerteza continua bloqueado                     | Integrações T02; Backend T03/T09                                                |
| F1-G05 | Conta de testes dedicada preferida pelo PO em 04/11; disponibilidade, acesso, permissões e gatilhos ainda não comprovados                                                                | Integrações T02 + PO/Operação; nenhuma escrita até ambiente/caso definidos      |
| F1-G06 | Escopos concretos, identidade da conta, quotas compartilhadas, OAuth/PKCE e links são capacidades a verificar                                                                            | Integrações T02/T04/T05; não inferir pelo schema                                |
| F1-G07 | DDL/locks/estados, representação de cancelamento, legado/loja e rollback ainda precisam desenho verificável                                                                              | Backend T03/T20/T23/T24/T26; ADR técnico quando decisão durável for tomada      |
| F1-G08 | Retenção, amostra/período, suporte, parâmetros operacionais e gatilhos reais são gates posteriores explícitos                                                                            | DevOps/Privacidade T15 + PO; não bloqueiam a revisão T01 nem autorizam piloto   |

## Verificação desta entrega

Revisão cruzada de RULES, spec CRM, PRD, TDD, ARCHITECTURE, ADR 057 e RFC 050;
cobertura dos 50 IDs; links locais e Markdown alterado; `git diff --check`.
Sem alteração de runtime, migração, conta, cadastro, impressão ou infraestrutura.
T02 registra separadamente schema/hash, fixtures, resultados e plano de prova
na [matriz de capacidades](capabilities.md).

## Atualização de ambiente após a revisão

Em 04/11/2026 o PO escolheu a conta operacional atual para consultas e preparo
de caso controlado, com aprovação antes de qualquer criação. Essa orientação
atualiza F1-G05: conta dedicada não é mais o bloqueio; acesso v3, gatilhos e
payload/efeitos conferidos continuam necessários. [Inspeção e caso](controlled-case.md).
Demais decisões/ADRs e gates permanecem; esta atualização não aprova POSTs.

## Resultado das experiências T02 em 05/11/2026

[Relatório atual](phase1-report.md): cliente/pai/M/G/GG e C01–C04 criados com
aprovações específicas. G02 tem inclusão composta e reconciliação de filhos
comprovadas na amostra, sem garantia de atomicidade. G04 tem roundtrip de
origem/referência nos três pedidos novos, sem garantia de unicidade remota.
G03 tem um conjunto fiscal real aceito; validações universais não foram inferidas.
G05 foi resolvido pela escolha expressa da conta operacional e casos controlados.
G06 tem OAuth e permissões concretas comprovados; refresh/PKCE/concorrência
continuam nas tarefas posteriores. G07/G08 mantêm os gates próprios.

**G01 continua bloqueante:** subtotais corretos e comprováveis na UI, porém a
API perde precisão dos unitários e diverge nos totais em C03/C04. Não há leitor
monetário automático fiel comprovado. T02/F1 e a liberação de T03 permanecem
abertos até prova técnica ou decisão explícita de alteração do contrato.

Atualização de 05/11 após [comparação remota v2 × v3](evidence/monetary-readback-live-result.json):
sete tentativas, seis resultados válidos, zero escrita. O fallback v2 reproduziu
as divergências por linha/total v3 e não resolve G01. As credenciais Olist
foram renovadas pelo PO. A próxima dependência é rota e contrato de precisão
suportados, seguidos de prova consistente; pergunta técnica preparada e não
enviada. A autorização de concluir F1 não muda os critérios da ADR 057.

## Fechamento no escopo reduzido em 05/11

A [ADR 062](../../adr/062-olist-exportacao-com-unitario-exato-em-centavos.md)
/[RFC 046](../../rfc/046-olist-escopo-inicial-de-centavos-exatos.md) alterou
explicitamente o critério monetário inicial. [C05–C07](evidence/exact-cent-proof-result.json)
passaram por API e tela: F1-G01/T02 fechados somente para unitários exatos em
centavos, com identidade inequívoca e conferência exata de cada linha/totais.
Os checkpoints anteriores de G01 permanecem históricos; o problema fracionário
não foi corrigido. T03 pode iniciar. G07/G08 e os demais gates posteriores
continuam próprios; nenhuma habilitação, deploy ou piloto foi liberado.
