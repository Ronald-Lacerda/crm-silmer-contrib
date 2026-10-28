import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Layout only: preserve executable parameters, identities and all edges.
 * @param {any} source
 */
export function organizeVendedorWorkflow(source) {
  const result = structuredClone(source);
  const guides = new Set([
    'GUIA 01 — Site para WhatsApp',
    'GUIA 02 — Atendimento WhatsApp',
    'GUIA 03 — Operação humana',
    'GUIA 04 — Falhas e reconciliação',
    'GUIA 05 — Compatibilidade histórica',
  ]);
  if (
    result.nodes.some(
      (/** @type {any} */ n) =>
        guides.has(n.name) && n.type !== 'n8n-nodes-base.stickyNote',
    )
  ) {
    throw new Error('LAYOUT_GUIDE_NAME_COLLISION');
  }
  result.nodes = result.nodes.filter(
    (/** @type {any} */ n) => !guides.has(n.name),
  );
  const nodes = new Map(
    result.nodes.map((/** @type {any} */ n) => [n.name, n]),
  );
  const adjacent = (/** @type {string} */ name) =>
    (result.connections[name]?.main ?? [])
      .flat()
      .map((/** @type {any} */ e) => e.node);
  const visited = new Set();
  let top = 0;
  const sections = [
    [
      'Site - Receber mensagem do chat (MVP)',
      'GUIA 01 — Site para WhatsApp',
      '01 · SITE → WHATSAPP',
      'Resposta fixa. Sem IA, coleta, CRM ou pedido. O visitante precisa enviar a mensagem no WhatsApp.',
      5,
    ],
    [
      'WhatsApp - Receber eventos (MVP)',
      'GUIA 02 — Atendimento WhatsApp',
      '02 · ATENDIMENTO WHATSAPP',
      'Entrada → CRM → mídia → contexto → IA → decisão → reserva → envio. Ramos de baixo: handoff e recuperação. Nunca confirmar preço, prazo ou pedido. Dois pedidos separados e categorias removidas seguem para humano.',
      6,
    ],
    [
      'Painel - Receber comando (MVP)',
      'GUIA 03 — Operação humana',
      '03 · OPERAÇÃO HUMANA',
      'Comandos autenticados do CRM. Reserva antes de enviar; mídia validada, hash e preflight. Resultado incerto exige reconciliação, sem repetir o envio.',
      4,
    ],
    [
      'Capturar falha do workflow (MVP)',
      'GUIA 04 — Falhas e reconciliação',
      '04 · FALHAS E RECONCILIAÇÃO',
      'Registrar a falha no CRM. Nunca expor mensagens, segredos ou conteúdo pessoal nos logs. HTTP 200 não comprova entrega.',
      3,
    ],
  ];
  for (const [root, guide, title, text, color] of sections) {
    const members = [];
    const queue = [String(root)];
    while (queue.length) {
      const name = queue.shift();
      if (!name || visited.has(name) || !nodes.has(name)) continue;
      visited.add(name);
      members.push(name);
      queue.push(...adjacent(name));
    }
    if (!members.length) continue;
    // Longest path in each acyclic stream; stable sibling rows make routing legible.
    const ranks = new Map(members.map((name) => [name, 0]));
    for (let iteration = 0; iteration < members.length; iteration += 1) {
      let changed = false;
      for (const name of members) {
        for (const next of adjacent(name)) {
          if (!ranks.has(next)) continue;
          const rank = (ranks.get(name) ?? 0) + 1;
          if (rank > (ranks.get(next) ?? 0)) {
            ranks.set(next, rank);
            changed = true;
          }
        }
      }
      if (!changed) break;
      if (iteration === members.length - 1)
        throw new Error('LAYOUT_CYCLE_REQUIRES_REVIEW');
    }
    const rows = new Map();
    for (const name of members) {
      const rank = ranks.get(name) ?? 0;
      const row = rows.get(rank) ?? 0;
      rows.set(rank, row + 1);
      nodes.get(name).position = [rank * 280, top + 240 + row * 240];
    }
    // Model and parser remain visually attached to their agent, below the main path.
    const agent = nodes.get('Atendente virtual Silmer (MVP)');
    if (members.includes('Atendente virtual Silmer (MVP)') && agent) {
      for (const [offset, name] of [
        'OpenAI - Modelo do MVP',
        'Validar saída do MVP',
      ].entries()) {
        if (!nodes.has(name)) continue;
        nodes.get(name).position = [
          agent.position[0] - 80 + offset * 180,
          agent.position[1] + 160,
        ];
        visited.add(name);
      }
    }
    const height = Math.max(...rows.values()) * 240 + 440;
    const width = Math.max(1100, Math.max(...ranks.values()) * 280 + 400);
    result.nodes.unshift(
      sticky(
        String(guide),
        String(title),
        String(text),
        Number(color),
        top,
        width,
        height,
      ),
    );
    top += height + 240;
  }
  const legacy = [...nodes.keys()].filter((name) => !visited.has(name));
  if (legacy.length) {
    legacy.forEach((name, index) => {
      nodes.get(name).position = [index * 280, top + 220];
    });
    result.nodes.unshift(
      sticky(
        'GUIA 05 — Compatibilidade histórica',
        '05 · COMPATIBILIDADE HISTÓRICA',
        'Nós preservados sem entrada pública. Não reconectar o antigo chat à coleta comercial. Dados e contratos anteriores permanecem disponíveis.',
        7,
        top,
        Math.max(1100, legacy.length * 280 + 100),
        480,
      ),
    );
  }
  return result;
}

/** @param {string} name @param {string} title @param {string} text @param {number} color @param {number} top @param {number} width @param {number} height */
function sticky(name, title, text, color, top, width, height) {
  return {
    id: createHash('sha256').update(name).digest('hex').slice(0, 32),
    name,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-80, top],
    parameters: { content: `## ${title}\n\n${text}`, color, width, height },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === output)
    throw new Error('Distinct input/output paths required');
  const source = JSON.parse(await readFile(input, 'utf8'));
  await writeFile(
    output,
    JSON.stringify(organizeVendedorWorkflow(source), null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    'Layout prepared; no execution or publication performed.\n',
  );
}
