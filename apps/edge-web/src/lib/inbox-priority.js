import { brand } from '../brand/index.js';
import { conversationLabel } from './format.js';
import { handoffReasonLabel } from './order-format.js';

const TERMINAL_STATES = new Set([
  'convertida_em_lead',
  'sem_lead',
  'encerrada',
]);

/** @param {Record<string, any>} conversation */
export function conversationIsClosed(conversation) {
  return (
    Boolean(conversation.terminalAt) || TERMINAL_STATES.has(conversation.state)
  );
}

/** An API flag is evidence; a completed briefing or a missing flag is not. @param {Record<string, any>} conversation */
export function orderReadyToReview(conversation) {
  const order = conversation.reviewOrder ?? conversation.order;
  return (
    !conversationIsClosed(conversation) &&
    order?.status === 'pendente' &&
    order?.readyForConfirmation === true
  );
}

/** @param {Record<string, any>} conversation */
export function conversationWaitingSince(conversation) {
  if (conversationIsClosed(conversation) || conversation.archivedAt)
    return null;
  const value =
    conversation.handoff?.status === 'pending'
      ? conversation.handoff.createdAt
      : conversation.waitingSince;
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

/** @param {Record<string, any>} conversation @param {string} actorId @param {string} [ownerName] */
export function conversationNextAction(conversation, actorId, ownerName = '') {
  if (conversationIsClosed(conversation))
    return { label: conversationLabel(conversation), tone: '' };
  if (conversation.archivedAt) return { label: 'Conversa arquivada', tone: '' };
  const otherOwner =
    conversation.assignedUser && conversation.assignedUser.id !== actorId;
  const owner =
    ownerName || conversation.assignedUser?.name || 'outro vendedor';
  const delivery =
    conversation.deliveryIssue?.status ??
    conversation.lastMessage?.deliveryStatus ??
    conversation.lastMessage?.status;
  if (delivery === 'failed')
    return {
      label: otherOwner
        ? `Envio falhou · Com ${owner}`
        : 'Envio falhou — revisar',
      tone: 'error',
    };
  if (delivery === 'outcome_unknown')
    return {
      label: otherOwner
        ? `Envio incerto · Com ${owner}`
        : 'Envio incerto — verificar',
      tone: 'error',
    };
  if (otherOwner) return { label: `Com ${owner}`, tone: '' };
  if (conversation.handoff?.status === 'pending')
    return {
      label: orderReadyToReview(conversation)
        ? 'Assumir e revisar pedido'
        : 'Assumir atendimento',
      tone: 'warning',
    };
  if (conversation.automationState === 'assistant')
    return { label: `Com ${brand.assistant.reference}`, tone: '' };
  if (!conversation.assignedUser)
    return { label: 'Sem responsável', tone: 'warning' };
  if (orderReadyToReview(conversation))
    return { label: 'Revisar pedido', tone: 'ready' };
  if (
    conversationWaitingSince(conversation) ||
    conversation.lastMessage?.direction === 'inbound'
  )
    return { label: 'Responder cliente', tone: 'warning' };
  return { label: 'Aguardando cliente', tone: '' };
}

/** Keep the original reason in the disclosure, without diagnosing a generic code. @param {Record<string, any>} conversation */
export function conversationHandoffTitle(conversation) {
  return conversation.handoff?.reasonCode === 'unsupported'
    ? 'Agente não continuou'
    : handoffReasonLabel(conversation.handoff?.reasonCode);
}
