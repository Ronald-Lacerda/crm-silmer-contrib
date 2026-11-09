import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import {
  encryptJson,
  lockBillingSend,
  billingSendBlockReason,
  blockBillingSend,
} from '@crm-silmer/n8n-integration';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  billingSplit,
  decryptOrderPrivateJson,
  billingUrl,
} from '@crm-silmer/orders';
import {
  billingChatError as error,
  billingChatIdentifier as identifier,
  readBillingSendCommand,
} from './order-billing-chat-contract.js';

/** @param {any} value */
function uuid(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value,
    )
  )
    throw error();
  return value.toLowerCase();
}
/** @param {any} value */
function cents(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw error('BILLING_INVALID_AMOUNT', 422);
  return n;
}
/** @param {any} value */
const iso = (value) => new Date(value).toISOString();
/** @param {any} row */
function present(row) {
  return {
    id: row.id,
    version: Number(row.version),
    action: row.action,
    chargeId: row.charge_id,
    conversationId: row.conversation_id,
    state: row.state,
    blockedReason: row.blocked_reason,
    messageId: row.message_id,
    commandId: row.command_id,
    amountCents: cents(row.amount_cents),
    canRetry: row.state === 'failed' && row.failure_stage === 'before_send',
    supersedesChargeId: row.supersedes_charge_id ?? null,
    retryOfIntentId: row.retry_of_intent_id ?? null,
  };
}

/** Transactional billing intent and human message composition; no network I/O.
 * @param {any} database
 * @param {{access:any,outboundMessageOutbox?:any,environment?:Record<string,string|undefined>,clock?:()=>Date,idFactory?:()=>string}} options
 */
export function createOrderBillingChatRuntime(database, options) {
  const env = options.environment ?? process.env;
  const financialEnabled = env.ORDER_BILLING_ENABLED === 'true';
  const enabled =
    financialEnabled && env.ORDER_BILLING_CHAT_SEND_ENABLED === 'true';
  const receiving =
    financialEnabled || env.ORDER_BILLING_RECEIVE_ENABLED === 'true';
  const envelopeKey = Buffer.from(
    env.N8N_INTEGRATION_ENVELOPE_KEY ?? '',
    'base64',
  );
  const idempotencyKey = Buffer.from(
    env.IDEMPOTENCY_ENVELOPE_KEY ?? '',
    'base64',
  );
  if (envelopeKey.length !== 32 || idempotencyKey.length !== 32)
    throw new Error('Billing envelope keys must decode to 32 bytes');
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  /** Caller holds the shared billing locks before entering message/outbox writes.
   * @param {any} client @param {any} intent @param {string} correlationId */
  async function compose(client, intent, correlationId) {
    if (intent.state !== 'waiting_link') return intent;
    const now = clock();
    const reason = await billingSendBlockReason(client, intent, {
      enabled,
      now,
    });
    if (reason) {
      await blockBillingSend(client, intent.id, reason, now);
      return (
        await client.query(
          'SELECT * FROM crm.order_billing_send_intents WHERE id=$1',
          [intent.id],
        )
      ).rows[0];
    }
    const charge = (
      await client.query(
        'SELECT * FROM crm.order_billing_charges WHERE id=$1',
        [intent.charge_id],
      )
    ).rows[0];
    if (charge.status !== 'waiting' || !charge.checkout_envelope) return intent;
    const url = billingUrl(
      decryptOrderPrivateJson(
        charge.checkout_envelope,
        `billing-checkout:${charge.id}`,
        envelopeKey,
      ).url,
    );
    const messageKey = Buffer.from(
      env.INBOX_MESSAGE_ENVELOPE_KEY ?? '',
      'base64',
    );
    if (
      messageKey.length !== 32 ||
      typeof options.outboundMessageOutbox?.enqueueChannelMessage !== 'function'
    )
      throw new Error(
        'Billing message composition requires the Inbox envelope key and transactional outbox',
      );
    const conversation = (
      await client.query('SELECT * FROM crm.conversations WHERE id=$1', [
        intent.conversation_id,
      ])
    ).rows[0];
    const messageId = `billing-message:${intent.id}`;
    const commandId = `billing-send:${intent.id}`;
    const amount = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(cents(intent.amount_cents) / 100);
    const order = (
      await client.query('SELECT number FROM crm.orders WHERE id=$1', [
        intent.order_id,
      ])
    ).rows[0];
    const kind =
      charge.kind === 'signal'
        ? 'sinal'
        : charge.kind === 'balance'
          ? 'saldo'
          : 'pagamento integral';
    const text = `Pedido ${order.number} — ${kind} de ${amount}. Link para pagamento: ${url}`;
    await client.query(
      `INSERT INTO crm.messages
      (id,conversation_id,provider,provider_account_id,command_id,direction,author_kind,author_id,message_type,content_envelope,key_version,status,occurred_at,created_at,automation_epoch)
      VALUES($1,$2,$3,$4,$5,'outbound','human',$6,'text',$7::jsonb,1,'queued',$8,$8,$9)`,
      [
        messageId,
        intent.conversation_id,
        conversation.provider,
        conversation.provider_account_id,
        commandId,
        intent.actor_id,
        JSON.stringify(
          encryptJson({ text }, `message:${messageId}`, messageKey),
        ),
        now,
        conversation.automation_epoch,
      ],
    );
    await options.outboundMessageOutbox.enqueueChannelMessage(
      {
        id: `billing-send-job:${intent.id}`,
        idempotencyKey: commandId,
        messageId,
        availableAt: now,
        billingSend: true,
      },
      { transaction: client },
    );
    // Match Inbox read-model invalidation without taking over the conversation.
    await client.query(
      `UPDATE crm.conversations SET version=version+1,
         last_message_at=GREATEST(last_message_at,$2) WHERE id=$1`,
      [intent.conversation_id, now],
    );
    await client.query(
      `INSERT INTO crm.domain_events
         (id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,correlation_id,occurred_at)
       SELECT $1,'conversation',$2,
         COALESCE((SELECT max(aggregate_version) FROM crm.domain_events
           WHERE aggregate_type='conversation' AND aggregate_id=$2
             AND event_type='conversation.message_queued'),0)+1,
         'conversation.message_queued',$3::jsonb,$4,$5`,
      [
        `billing-message-event:${intent.id}`,
        intent.conversation_id,
        JSON.stringify({ conversationId: intent.conversation_id }),
        correlationId,
        now,
      ],
    );
    const queued = (
      await client.query(
        `UPDATE crm.order_billing_send_intents SET state='queued',message_id=$2,command_id=$3,queued_source_revision=$4,version=version+1,updated_at=$5 WHERE id=$1 AND state='waiting_link' RETURNING *`,
        [intent.id, messageId, commandId, conversation.inbound_revision, now],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO crm.order_billing_send_events(id,intent_id,state,occurred_at) VALUES($1,$2,'queued',$3)",
      [uuid(idFactory()), intent.id, now],
    );
    await new PostgresAuditTrail(client, { clock }).append({
      actor: intent.actor_id,
      action: 'billing.send.queued',
      target: { type: 'billing-intent', id: intent.id },
      version: Number(queued.version),
      reason: 'BILLING_SEND_QUEUED',
      correlationId,
    });
    return queued;
  }

  /** Same order as financial writers: live actor, conversations, subjects, order, plan, charges.
   * @param {any} client @param {any} input @param {string|null} targetId @param {boolean} write */
  async function context(client, input, targetId, write) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('billing-send-order:'||$1,0))",
      [identifier(input.orderId)],
    );
    if (input.actor?.kind !== 'human') throw error('FORBIDDEN', 403);
    const user = (
      await client.query(
        `SELECT u.id,f.function_name FROM crm.users u
      JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
        [input.actor.id],
      )
    ).rows[0];
    if (!user) throw error('FORBIDDEN', 403);
    const grants = (
      await client.query(
        'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
        [user.id],
      )
    ).rows;
    const actor = {
      id: user.id,
      kind: /** @type {const} */ ('human'),
      functionName: user.function_name,
      capabilities: grants.map((/** @type {any} */ g) => g.capability),
    };
    authorize(actor, write ? 'billing.manage' : 'billing.read');
    const before = (
      await client.query(
        'SELECT conversation_id,contact_id FROM crm.orders WHERE id=$1',
        [identifier(input.orderId)],
      )
    ).rows[0];
    if (!before) throw error('ORDER_NOT_FOUND', 404);
    const ids = [
      ...new Set([before.conversation_id, targetId].filter(Boolean)),
    ].sort();
    const conversations = (
      await client.query(
        'SELECT * FROM crm.conversations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [ids],
      )
    ).rows;
    const primary = conversations.find(
      (/** @type {any} */ c) => c.id === before.conversation_id,
    );
    const target = conversations.find(
      (/** @type {any} */ c) => c.id === targetId,
    );
    const identity = target
      ? (
          await client.query(
            'SELECT id,current_contact_id FROM crm.contact_identities WHERE id=$1 FOR SHARE',
            [target.contact_identity_id],
          )
        ).rows[0]
      : null;
    const identityLinks = identity
      ? (
          await client.query(
            // Merge/unmerge must lock the identity already held above. Do not
            // lock links here: unmerge locks link -> identity in the old writer.
            "SELECT source_contact_id,target_contact_id FROM crm.identity_links WHERE contact_identity_id=$1 AND status='active'",
            [identity.id],
          )
        ).rows
      : [];
    const linked =
      targetId && targetId !== before.conversation_id
        ? (
            await client.query(
              'SELECT id FROM crm.conversation_subjects WHERE conversation_id=$1 AND order_id=$2 AND contact_id=$3 FOR SHARE',
              [targetId, input.orderId, before.contact_id],
            )
          ).rows.length > 0
        : true;
    const order = (
      await client.query('SELECT * FROM crm.orders WHERE id=$1 FOR UPDATE', [
        input.orderId,
      ])
    ).rows[0];
    if (
      !order ||
      order.conversation_id !== before.conversation_id ||
      order.contact_id !== before.contact_id
    )
      throw error('VERSION_CONFLICT', 409);
    const owner = order.conversation_id
      ? primary?.assigned_user_id
      : order.manual_owner_id;
    const admin = actor.capabilities.includes('COMMERCIAL_ADMIN');
    if (
      !admin &&
      (owner !== actor.id ||
        (targetId && target?.assigned_user_id !== actor.id))
    )
      throw error('FORBIDDEN', 403);
    if (targetId && (!target || !linked))
      throw error('BILLING_TARGET_CONFLICT', 409);
    if (
      targetId &&
      identity?.current_contact_id !== order.contact_id &&
      !identityLinks.some(
        (/** @type {any} */ link) =>
          link.source_contact_id === order.contact_id &&
          link.target_contact_id === identity.current_contact_id,
      )
    )
      throw error('BILLING_TARGET_CONFLICT', 409);
    const plan = (
      await client.query(
        'SELECT * FROM crm.order_billing_plans WHERE order_id=$1 FOR UPDATE',
        [order.id],
      )
    ).rows[0];
    return { actor, order, plan, target, owner };
  }
  /** @param {any} client @param {string} orderId */
  async function financials(client, orderId) {
    const charges = (
      await client.query(
        'SELECT * FROM crm.order_billing_charges WHERE order_id=$1 ORDER BY created_sequence FOR UPDATE',
        [orderId],
      )
    ).rows;
    const payments = (
      await client.query(
        `SELECT p.* FROM crm.order_billing_receipt_ledger p WHERE p.order_id=$1 ORDER BY p.id`,
        [orderId],
      )
    ).rows;
    const net = payments
      .filter((/** @type {any} */ p) => p.application_valid)
      .reduce(
        (/** @type {bigint} */ sum, /** @type {any} */ p) =>
          sum +
          (BigInt(p.applied_amount_cents) > BigInt(p.refunded_amount_cents)
            ? BigInt(p.applied_amount_cents) - BigInt(p.refunded_amount_cents)
            : 0n),
        0n,
      );
    return { charges, payments, paid: cents(net) };
  }
  /** @param {any} order @param {any} charge */
  function matches(order, charge) {
    return (
      iso(order.confirmed_at) === iso(charge.confirmed_at) &&
      cents(order.final_amount_cents) ===
        cents(charge.order_amount_cents ?? charge.final_amount_cents) &&
      order.payment_condition === charge.payment_condition
    );
  }
  /** @param {any} c @param {any} input @param {any} f */
  function eligible(c, input, f) {
    if (
      Number(c.order.version) !== input.expectedVersion ||
      Number(c.plan?.version ?? 0) !== input.expectedBillingVersion ||
      Number(c.target.version) !== input.expectedConversationVersion
    )
      throw error('VERSION_CONFLICT', 409);
    if (c.order.origin !== 'atendimento')
      throw error('BILLING_TARGET_CONFLICT', 409);
    if (c.order.status !== 'confirmado')
      throw error('ORDER_NOT_CONFIRMED', 409);
    if (c.target.automation_state !== 'human' || c.target.terminal_at)
      throw error('BILLING_TARGET_CONFLICT', 409);
    if (
      c.plan?.review_required ||
      (c.plan && !matches(c.order, c.plan)) ||
      f.charges.some((/** @type {any} */ r) => r.status === 'review') ||
      (!c.plan && (c.order.paid_on || c.order.finance_payment_review_required))
    )
      throw error('BILLING_REVIEW_REQUIRED', 409);
    if (cents(c.order.final_amount_cents) < 100)
      throw error('BILLING_INVALID_AMOUNT', 422);
    if (f.paid > cents(c.order.final_amount_cents))
      throw error('BILLING_REVIEW_REQUIRED', 409);
    if (f.paid === cents(c.order.final_amount_cents))
      throw error('BILLING_ALREADY_PAID', 409);
  }
  /** @param {any} client @param {any} c @param {number} percent */
  async function savePlan(client, c, percent) {
    return (
      await client.query(
        `INSERT INTO crm.order_billing_plans(order_id,percent,confirmed_at,final_amount_cents,payment_condition,created_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(order_id) DO UPDATE SET version=crm.order_billing_plans.version+1,percent=EXCLUDED.percent,updated_at=EXCLUDED.updated_at RETURNING *`,
        [
          c.order.id,
          percent,
          c.order.confirmed_at,
          c.order.final_amount_cents,
          c.order.payment_condition,
          c.actor.id,
          clock(),
        ],
      )
    ).rows[0];
  }
  /** @param {any} client @param {any} c @param {any} command @param {any} f @param {string} correlationId */
  async function reserve(client, c, command, f, correlationId) {
    const total = cents(c.order.final_amount_cents),
      balance = total - f.paid;
    /** @type {any} */ let charge;
    /** @type {any} */ let prior = null;
    /** @type {any} */ let corrected = null;
    if (command.action === 'retry') {
      prior = (
        await client.query(
          'SELECT * FROM crm.order_billing_send_intents WHERE id=$1 AND order_id=$2 FOR UPDATE',
          [uuid(command.intentId), c.order.id],
        )
      ).rows[0];
      if (!prior) throw error('BILLING_NOT_FOUND', 404);
      if (Number(prior.version) !== command.expectedIntentVersion)
        throw error('VERSION_CONFLICT', 409);
      if (
        prior.conversation_id !== c.target.id ||
        prior.state !== 'failed' ||
        prior.failure_stage !== 'before_send' ||
        (
          await client.query(
            'SELECT 1 FROM crm.order_billing_send_intents WHERE retry_of_intent_id=$1',
            [prior.id],
          )
        ).rows.length
      )
        throw error('BILLING_RETRY_UNSAFE', 409);
      charge = f.charges.find(
        (/** @type {any} */ r) => r.id === prior.charge_id,
      );
    } else if (command.action === 'send_existing') {
      charge = f.charges.find(
        (/** @type {any} */ r) => r.id === uuid(command.chargeId),
      );
      if (!charge) throw error('BILLING_NOT_FOUND', 404);
      if (
        (
          await client.query(
            'SELECT 1 FROM crm.order_billing_send_intents WHERE charge_id=$1',
            [charge.id],
          )
        ).rows.length
      )
        throw error('BILLING_ACTIVE_CHARGE', 409);
    }
    if (charge || prior) {
      if (
        !charge ||
        charge.status !== 'waiting' ||
        !charge.checkout_envelope ||
        new Date(charge.valid_until) <= clock() ||
        !matches(c.order, charge) ||
        cents(charge.amount_cents) > balance
      )
        throw error('BILLING_REVIEW_REQUIRED', 409);
      billingUrl(
        decryptOrderPrivateJson(
          charge.checkout_envelope,
          `billing-checkout:${charge.id}`,
          envelopeKey,
        ).url,
      );
    } else {
      if (
        f.charges.some((/** @type {any} */ r) =>
          ['queued', 'creating', 'waiting', 'unknown'].includes(r.status),
        )
      )
        throw error('BILLING_ACTIVE_CHARGE', 409);
      let amount,
        percent = c.plan?.percent ?? 100;
      if (command.action === 'correct') {
        corrected = f.charges.find(
          (/** @type {any} */ r) => r.id === uuid(command.chargeId),
        );
        if (!corrected) throw error('BILLING_NOT_FOUND', 404);
        if (new Date(corrected.valid_until) > clock())
          throw error('BILLING_LINK_STILL_VALID', 409);
        if (
          corrected.status !== 'closed' ||
          f.payments.some(
            (/** @type {any} */ p) => p.charge_id === corrected.id,
          ) ||
          !matches(c.order, corrected) ||
          (
            await client.query(
              'SELECT 1 FROM crm.order_billing_send_intents WHERE supersedes_charge_id=$1',
              [corrected.id],
            )
          ).rows.length
        )
          throw error('BILLING_REVIEW_REQUIRED', 409);
        amount = command.amountCents;
      } else if (command.action === 'balance') {
        if (f.paid <= 0) throw error('BILLING_TARGET_CONFLICT', 409);
        amount = balance;
      } else {
        if (
          f.paid > 0 ||
          (f.charges.length && command.percent !== c.plan?.percent)
        )
          throw error('BILLING_REVIEW_REQUIRED', 409);
        percent = command.percent;
        amount = billingSplit(total, percent).signalAmountCents;
      }
      if (
        !Number.isSafeInteger(amount) ||
        amount < 100 ||
        amount > balance ||
        (balance - amount > 0 && balance - amount < 100)
      )
        throw error('BILLING_INVALID_AMOUNT', 422);
      c.plan = await savePlan(client, c, percent);
      charge = (
        await client.query(
          `INSERT INTO crm.order_billing_charges(id,order_id,kind,amount_cents,confirmed_at,order_amount_cents,payment_condition,valid_until,created_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
          [
            uuid(idFactory()),
            c.order.id,
            f.paid > 0 ? 'balance' : amount === total ? 'full' : 'signal',
            amount,
            c.order.confirmed_at,
            total,
            c.order.payment_condition,
            new Date(clock().getTime() + 86400000),
            c.actor.id,
            clock(),
          ],
        )
      ).rows[0];
      await client.query(
        `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,channel_event_id,status,priority,available_at,created_at,queue,attempt_count,max_attempts,updated_at,effect_policy)
        VALUES($1,'billing.checkout.create',$2,NULL,'pending',100,$3,$3,'billing',0,8,$3,'manual')`,
        [`billing:${charge.id}`, charge.id, clock()],
      );
    }
    if (prior || command.action === 'send_existing')
      c.plan = await savePlan(client, c, c.plan.percent);
    const intent = (
      await client.query(
        `INSERT INTO crm.order_billing_send_intents(id,order_id,charge_id,conversation_id,actor_id,action,retry_of_intent_id,supersedes_charge_id,amount_cents,order_version,billing_version,conversation_version,owner_id,order_owner_id,cycle_number,automation_epoch,inbound_revision,confirmed_at,order_amount_cents,payment_condition,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) RETURNING *`,
        [
          uuid(idFactory()),
          c.order.id,
          charge.id,
          c.target.id,
          c.actor.id,
          command.action,
          prior?.id ?? null,
          corrected?.id ?? null,
          charge.amount_cents,
          c.order.version,
          c.plan.version,
          c.target.version,
          c.target.assigned_user_id,
          c.owner,
          c.target.cycle_number,
          c.target.automation_epoch,
          c.target.inbound_revision,
          charge.confirmed_at,
          charge.order_amount_cents,
          charge.payment_condition,
          clock(),
        ],
      )
    ).rows[0];
    await client.query(
      'INSERT INTO crm.order_billing_send_events(id,intent_id,state,occurred_at) VALUES($1,$2,$3,$4)',
      [uuid(idFactory()), intent.id, intent.state, clock()],
    );
    return present(
      charge.checkout_envelope
        ? await compose(client, intent, correlationId)
        : intent,
    );
  }
  /** @param {string} orderId @param {string} token */
  function parseCursor(orderId, token) {
    identifier(token);
    const [body, signature, extra] = token.split('.');
    const expected = createHmac('sha256', envelopeKey)
      .update(`${orderId}\0${body}`)
      .digest();
    const supplied = Buffer.from(signature ?? '', 'base64url');
    if (
      extra ||
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw error();
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (
        Object.keys(value).sort().join(',') !== 'i,t' ||
        typeof value.t !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value.t)
      )
        throw error();
      identifier(value.i);
      return value;
    } catch {
      throw error();
    }
  }
  return Object.freeze({
    /** @param {any} client @param {string} orderId */
    async lockOrder(client, orderId) {
      return lockBillingSend(client, { orderId });
    },
    /** @param {any} client @param {string} orderId */
    async externalPaymentRecorded(client, orderId) {
      const intents = await lockBillingSend(client, { orderId });
      for (const intent of intents) {
        if (!['waiting_link', 'queued'].includes(intent.state)) continue;
        const reason = await billingSendBlockReason(client, intent, {
          enabled,
          now: clock(),
        });
        if (reason) await blockBillingSend(client, intent.id, reason, clock());
      }
    },
    enabled,
    /** @param {any} client @param {string} chargeId */
    async lockCharge(client, chargeId) {
      await lockBillingSend(client, { chargeId });
    },
    /** Financial creation is skipped after an intent loses its send authority.
     * @param {any} client @param {string} chargeId */
    async checkoutAllowed(client, chargeId) {
      const intents = (await lockBillingSend(client, { chargeId })).filter(
        (/** @type {any} */ intent) => intent.charge_id === chargeId,
      );
      if (!intents.length) return true;
      let allowed = false;
      for (const intent of intents) {
        if (intent.state !== 'waiting_link') continue;
        const reason = await billingSendBlockReason(client, intent, {
          enabled,
          now: clock(),
        });
        if (reason) await blockBillingSend(client, intent.id, reason, clock());
        else allowed = true;
      }
      return allowed;
    },
    /** @param {any} client @param {string} chargeId @param {string} correlationId */
    async checkoutCreated(client, chargeId, correlationId) {
      const intents = await lockBillingSend(client, { chargeId });
      for (const intent of intents)
        if (intent.charge_id === chargeId)
          await compose(client, intent, correlationId);
    },
    /** @param {any} client @param {string} chargeId @param {string} _correlationId */
    async paymentRecorded(client, chargeId, _correlationId) {
      const intents = await lockBillingSend(client, { chargeId });
      for (const intent of intents) {
        if (!['waiting_link', 'queued'].includes(intent.state)) continue;
        const reason = await billingSendBlockReason(client, intent, {
          enabled,
          now: clock(),
        });
        if (reason) await blockBillingSend(client, intent.id, reason, clock());
      }
    },
    authorizeRead: (/** @type {any} */ input) =>
      options.access.authorizeRead(input),
    authorizeWrite: (/** @type {any} */ input) =>
      options.access.authorizeWrite(input),
    /** @param {any} input */
    async submit(input) {
      if (!enabled) throw error('BILLING_DISABLED', 503);
      const {
        actor: supplied,
        orderId,
        idempotencyKey: requestKey,
        correlationId,
        ...raw
      } = input;
      const command = readBillingSendCommand(raw);
      identifier(requestKey);
      identifier(correlationId);
      try {
        return await database.transaction(async (/** @type {any} */ client) => {
          const c = await context(
            client,
            { actor: supplied, orderId },
            command.conversationId,
            true,
          );
          const store = new PostgresIdempotencyRecordStore({
            database: {
              query: client.query.bind(client),
              transaction: async (work) => work(client),
            },
            envelopeKey: idempotencyKey,
          });
          return store.execute(
            {
              scope: `billing.chat:${orderId}`,
              key: requestKey,
              fingerprint: fingerprintCommand({
                actorId: c.actor.id,
                ...command,
              }),
              actor: c.actor.id,
              action: 'billing.send.intent',
              target: { type: 'order', id: orderId },
              version: `${command.expectedVersion}:${command.expectedBillingVersion}:${command.expectedConversationVersion}`,
              reason: 'BILLING_SEND_INTENT',
              correlationId,
            },
            async () => {
              const f = await financials(client, orderId);
              eligible(c, command, f);
              const result = await reserve(
                client,
                c,
                command,
                f,
                correlationId,
              );
              await new PostgresAuditTrail(client, { clock }).append({
                actor: c.actor.id,
                action: 'billing.send.intent',
                target: { type: 'billing-intent', id: result.id },
                version: result.version,
                reason: `BILLING_SEND_${command.action.toUpperCase()}`,
                correlationId,
              });
              return result;
            },
          );
        });
      } catch (e) {
        if (/** @type {any} */ (e).code === 'BILLING_MINIMUM_AMOUNT')
          throw error('BILLING_INVALID_AMOUNT', 422);
        if (/** @type {any} */ (e).code === 'IDEMPOTENCY_KEY_REUSED')
          throw error('IDEMPOTENCY_CONFLICT', 409);
        if (/** @type {any} */ (e).code === '23505')
          throw error('BILLING_ACTIVE_CHARGE', 409);
        throw e;
      }
    },
    /** @param {any} input */
    async getIntent(input) {
      if (!receiving) throw error('BILLING_DISABLED', 503);
      return database.transaction(async (/** @type {any} */ client) => {
        const row = (
          await client.query(
            'SELECT * FROM crm.order_billing_send_intents WHERE id=$1 AND order_id=$2',
            [uuid(input.intentId), identifier(input.orderId)],
          )
        ).rows[0];
        await context(client, input, row?.conversation_id ?? null, false);
        if (!row) throw error('BILLING_NOT_FOUND', 404);
        const current = (
          await client.query(
            'SELECT * FROM crm.order_billing_send_intents WHERE id=$1',
            [row.id],
          )
        ).rows[0];
        return present(current);
      });
    },
    /** @param {any} input */
    async getHistory(input) {
      if (!receiving) throw error('BILLING_DISABLED', 503);
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw error();
      const cursor =
        input.cursor === null || input.cursor === undefined
          ? null
          : parseCursor(identifier(input.orderId), input.cursor);
      return database.transaction(async (/** @type {any} */ client) => {
        const c = await context(client, input, null, false);
        const f = await financials(client, c.order.id);
        const rows = (
          await client.query(
            `WITH events AS (
          SELECT 'charge:'||id::text AS id,'charge' AS kind,id AS charge_id,NULL::uuid AS intent_id,amount_cents,status,created_at AS occurred_at,NULL::uuid AS supersedes_charge_id,NULL::uuid AS retry_of_intent_id,NULL::uuid AS external_receipt_id FROM crm.order_billing_charges WHERE order_id=$1
          UNION ALL SELECT 'receipt:'||p.id,'receipt',p.charge_id,NULL,p.principal_amount_cents,CASE WHEN p.application_valid THEN 'paid' ELSE 'review' END,p.verified_at,NULL,NULL,NULL FROM crm.order_billing_payments p JOIN crm.order_billing_charges c ON c.id=p.charge_id WHERE c.order_id=$1
          UNION ALL SELECT 'refund:'||r.id,'refund',p.charge_id,NULL,r.amount_cents,'review',r.created_at,NULL,NULL,NULL FROM crm.order_billing_refunds r JOIN crm.order_billing_payments p ON p.id=r.payment_id JOIN crm.order_billing_charges c ON c.id=p.charge_id WHERE c.order_id=$1
          UNION ALL SELECT 'intent:'||e.id,CASE WHEN i.action='correct' THEN 'correction' ELSE 'intent' END,i.charge_id,i.id,i.amount_cents,e.state,e.occurred_at,i.supersedes_charge_id,i.retry_of_intent_id,NULL FROM crm.order_billing_send_events e JOIN crm.order_billing_send_intents i ON i.id=e.intent_id WHERE i.order_id=$1
          UNION ALL SELECT 'external:'||e.id,'external_receipt',NULL,NULL,e.amount_cents,CASE WHEN e.application_valid THEN 'paid' ELSE 'review' END,e.recorded_at,NULL,NULL,e.id FROM crm.order_billing_external_receipts e WHERE e.order_id=$1
          UNION ALL SELECT 'external-reversal:'||r.id,'external_reversal',NULL,NULL,e.amount_cents,'closed',r.recorded_at,NULL,NULL,e.id FROM crm.order_billing_external_reversals r JOIN crm.order_billing_external_receipts e ON e.id=r.receipt_id WHERE e.order_id=$1
          UNION ALL SELECT 'payment-check:'||e.id,'payment_check',k.charge_id,NULL,c.amount_cents,e.status,e.occurred_at,NULL,NULL,NULL FROM crm.order_billing_payment_check_events e JOIN crm.order_billing_payment_checks k ON k.id=e.check_id JOIN crm.order_billing_charges c ON c.id=k.charge_id WHERE c.order_id=$1
        ) SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant FROM events
        WHERE ($2::timestamptz IS NULL OR (occurred_at,id)<($2::timestamptz,$3::text)) ORDER BY occurred_at DESC,id DESC LIMIT $4`,
            [c.order.id, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
          )
        ).rows;
        const page = rows.slice(0, limit),
          last = page.at(-1);
        let nextCursor = null;
        if (rows.length > limit) {
          const body = Buffer.from(
            JSON.stringify({ t: last.instant, i: last.id }),
          ).toString('base64url');
          nextCursor = `${body}.${createHmac('sha256', envelopeKey).update(`${c.order.id}\0${body}`).digest('base64url')}`;
        }
        return {
          orderId: c.order.id,
          orderVersion: Number(c.order.version),
          billingVersion: Number(c.plan?.version ?? 0),
          totalAmountCents: cents(c.order.final_amount_cents),
          receivedAmountCents: f.paid,
          balanceAmountCents: Math.max(
            0,
            cents(c.order.final_amount_cents) - f.paid,
          ),
          nextCursor,
          items: page.map((/** @type {any} */ row) => ({
            id: row.id,
            kind: row.kind,
            chargeId: row.charge_id,
            intentId: row.intent_id,
            externalReceiptId: row.external_receipt_id ?? null,
            source: row.kind.startsWith('external')
              ? 'external'
              : ['receipt', 'refund'].includes(row.kind)
                ? 'infinitepay'
                : null,
            supersedesChargeId: row.supersedes_charge_id ?? null,
            retryOfIntentId: row.retry_of_intent_id ?? null,
            amountCents: cents(row.amount_cents),
            status: row.status,
            occurredAt: row.instant,
          })),
        };
      });
    },
  });
}
