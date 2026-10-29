/** EVOL-01: prepare only explicitly selected, inactive transport candidates.
 * The caller exports a private backup and verifies the round trip separately.
 * Archived workflows retain credential references; this never deletes credentials.
 * @param {any[]} workflows @param {string[]} selectedIds @returns {any[]}
 */
export function planLegacyTransportArchive(workflows, selectedIds) {
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length)
    throw new Error('CLEANUP_SELECTION_INVALID');
  const selected = new Set(selectedIds);
  for (const workflow of workflows.filter((item) => !selected.has(item.id))) {
    const content = JSON.stringify({
      nodes: workflow.nodes,
      settings: workflow.settings,
    });
    if (selectedIds.some((id) => content.includes(id)))
      throw new Error('CLEANUP_REFERENCED_WORKFLOW');
  }
  return selectedIds.map((id) => {
    const workflow = workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('CLEANUP_WORKFLOW_MISSING');
    if (workflow.active || workflow.activeVersionId)
      throw new Error('CLEANUP_ACTIVE_WORKFLOW');
    const nodes = JSON.stringify(workflow.nodes);
    if (
      workflow.nodes.some(
        (/** @type {any} */ node) =>
          node.type === 'n8n-nodes-base.whatsAppTrigger',
      ) ||
      /graph\.facebook\.com/.test(nodes)
    )
      throw new Error('CLEANUP_META_WORKFLOW_PROTECTED');
    if (!/WAHA|WPPConnect|silmer-waha|silmer-wppconnect/.test(nodes))
      throw new Error('CLEANUP_NOT_LEGACY_TRANSPORT');
    return { ...structuredClone(workflow), isArchived: true };
  });
}
