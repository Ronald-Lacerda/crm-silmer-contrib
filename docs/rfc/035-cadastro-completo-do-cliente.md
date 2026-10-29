# RFC 035 — Cadastro completo do cliente

Status: decidida em 28/10/2026 na
[ADR 047](../adr/047-cadastro-completo-do-cliente.md).
Responsável: Tech Lead. Pedido do cliente Silmer: registrar os dados
cadastrais completos de pessoas físicas e jurídicas.
Requisitos: [CP-25..28](../../.specs/features/cliente-pedido-assuntos/spec.md).
Tarefa: [CP-T08](../../.specs/features/cliente-pedido-assuntos/tasks.md).
Issue/PR específica: não criada nesta etapa.

## Contexto

O Contato guarda nome, celular e e-mail (ADR 033). O cliente pediu tipo de
pessoa, CPF/CNPJ, nome ou razão social, @ do Instagram, inscrição estadual e
endereço completo (CEP, cidade, UF, endereço, bairro, número, complemento).
São dados pessoais e fiscais que o atendimento pelo WhatsApp normalmente não
tem no primeiro contato.

## Alternativas

1. **Cadastro obrigatório antes do Pedido.** Garante dados, mas trava o
   atendimento rápido e contraria o fluxo da ADR 033. Rejeitada pelo
   proprietário.
2. **Cadastro obrigatório na criação do Contato.** Mesmo problema, e o
   Contato também nasce de canais sem esses dados. Rejeitada.
3. **Cadastro opcional com estado completo/incompleto.** A ficha mostra o que
   falta sem bloquear. Escolhida.

Para o endereço, avaliou-se digitação manual e consulta ao ViaCEP. A consulta
envia só o CEP, feita pela API para não expor o navegador a terceiros, e
reduz erro de digitação; a falha cai no preenchimento manual. Escolhida a
consulta, com o manual sempre disponível.

## Proposta

- Envelope AES-256-GCM próprio no Contato, com AAD distinto do envelope de
  celular/e-mail, e uma coluna não sensível de estado (`complete` ou
  `incomplete`) para a lista.
- Comando `PUT /api/v1/contacts/{id}/registration` com versão esperada,
  `Idempotency-Key`, auditoria `contact.registration.updated` e evento de
  domínio sem PII. Celular e e-mail seguem no comando existente de detalhes.
- `POST /api/v1/postal-codes/lookup` autenticado, com o CEP no corpo para não
  ficar em URL nem log de proxy, limite de taxa e tempo limite, devolvendo
  sugestão de endereço.
- A resposta guardada para idempotência traz só id, versão e estado, porque a
  tabela é imutável e não deve reter cópias do cadastro.
- CPF e CNPJ validados por dígito verificador, incluindo o CNPJ alfanumérico
  em vigor desde julho de 2026. Sem unicidade por documento: duas pessoas da
  mesma empresa podem ter o mesmo CNPJ.
