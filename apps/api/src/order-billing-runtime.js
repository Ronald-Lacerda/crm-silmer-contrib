import { randomUUID } from 'node:crypto';
import { PostgresAuditTrail } from '@crm-silmer/audit-privacy';
import { authorize } from '@crm-silmer/identity-access';
import {
  fingerprintCommand,
  PostgresIdempotencyRecordStore,
} from '@crm-silmer/integration-reliability';
import {
  BillingError,
  billingCents,
  billingIdentifier,
  billingPercent,
  billingSplit,
  billingUrl,
  decryptOrderPrivateJson,
  encryptOrderPrivateJson,
} from '@crm-silmer/orders';

/** @param {unknown} value */
function uuid(value) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new BillingError(400, 'INVALID_REQUEST');
  return value;
}
/** @param {any} value */
function iso(value) {
  return value ? new Date(value).toISOString() : null;
}
/** @param {any} row @param {any} snapshot */
function matches(row, snapshot) {
  return (
    row.status === 'confirmado' &&
    !row.cancelled_at &&
    Number(row.final_amount_cents) ===
      Number(snapshot.order_amount_cents ?? snapshot.final_amount_cents) &&
    iso(row.confirmed_at) === iso(snapshot.confirmed_at) &&
    row.payment_condition === snapshot.payment_condition
  );
}
/** @param {any} value @param {string} name */
function key(value, name) {
  const result = Buffer.from(value ?? '', 'base64');
  if (result.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return result;
}
/** @param {any} client @param {any} supplied @param {boolean} write */
async function actorFor(client, supplied, write) {
  if (supplied?.kind !== 'human') throw new BillingError(403, 'FORBIDDEN');
  const row = (
    await client.query(
      `SELECT u.id,f.function_name FROM crm.users u JOIN crm.user_functions f ON f.user_id=u.id WHERE u.id=$1 AND u.disabled_at IS NULL FOR SHARE OF u,f`,
      [supplied.id],
    )
  ).rows[0];
  if (!row) throw new BillingError(403, 'FORBIDDEN');
  const grants = await client.query(
    'SELECT capability FROM crm.user_capabilities WHERE user_id=$1 FOR SHARE',
    [row.id],
  );
  const actor = {
    id: row.id,
    kind: /** @type {const} */ ('human'),
    functionName: row.function_name,
    capabilities: grants.rows.map(
      (/** @type {any} */ grant) => grant.capability,
    ),
  };
  authorize(actor, write ? 'order.edit' : 'order.read');
  return actor;
}
/** Conversation before order matches the commercial writer's lock order.
 * @param {any} client @param {string} orderId */
async function lockOrder(client, orderId) {
  const before = (
    await client.query('SELECT conversation_id FROM crm.orders WHERE id=$1', [
      orderId,
    ])
  ).rows[0];
  if (!before) throw new BillingError(404, 'ORDER_NOT_FOUND');
  let owner = null;
  if (before.conversation_id) {
    owner =
      (
        await client.query(
          'SELECT assigned_user_id FROM crm.conversations WHERE id=$1 FOR UPDATE',
          [before.conversation_id],
        )
      ).rows[0]?.assigned_user_id ?? null;
  }
  const row = (
    await client.query('SELECT * FROM crm.orders WHERE id=$1 FOR UPDATE', [
      orderId,
    ])
  ).rows[0];
  if (!row || row.conversation_id !== before.conversation_id)
    throw new BillingError(409, 'VERSION_CONFLICT');
  row.billing_owner_id = row.conversation_id ? owner : row.manual_owner_id;
  return row;
}
/** @param {any} actor @param {any} order */
function owns(actor, order) {
  return (
    actor.id === order.billing_owner_id ||
    actor.capabilities.includes('COMMERCIAL_ADMIN')
  );
}

/** @param {any} database @param {{access:any,environment?:Record<string,string|undefined>,clock?:()=>Date,idFactory?:()=>string}} options */
export function createOrderBillingRuntime(database, options) {
  const environment = options.environment ?? process.env;
  const enabled = environment.ORDER_BILLING_ENABLED === 'true';
  const receiving =
    enabled || environment.ORDER_BILLING_RECEIVE_ENABLED === 'true';
  const envelopeKey = key(
    environment.N8N_INTEGRATION_ENVELOPE_KEY,
    'N8N_INTEGRATION_ENVELOPE_KEY',
  );
  const idempotencyKey = key(
    environment.IDEMPOTENCY_ENVELOPE_KEY,
    'IDEMPOTENCY_ENVELOPE_KEY',
  );
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  /** @param {any} client @param {any} input */
  const audit = (client, input) => new PostgresAuditTrail(client).append(input);
  /** @param {any} client @param {string} orderId */
  async function planFor(client, orderId) {
    return (
      (
        await client.query(
          'SELECT * FROM crm.order_billing_plans WHERE order_id=$1 FOR UPDATE',
          [orderId],
        )
      ).rows[0] ?? null
    );
  }
  /** @param {any} client @param {string} orderId @returns {Promise<any[]>} */
  async function chargesFor(client, orderId) {
    return (
      await client.query(
        `SELECT c.*,j.status AS job_status FROM crm.order_billing_charges c
      LEFT JOIN crm.outbox_jobs j ON j.job_type='billing.checkout.create' AND j.idempotency_key=c.id::text
      WHERE c.order_id=$1 ORDER BY c.created_sequence`,
        [orderId],
      )
    ).rows;
  }
  /** @param {any} client @param {string} orderId @returns {Promise<any[]>} */
  async function paymentsFor(client, orderId) {
    return (
      await client.query(
        `SELECT p.* FROM crm.order_billing_payments p JOIN crm.order_billing_charges c ON c.id=p.charge_id WHERE c.order_id=$1 ORDER BY p.verified_at,p.id`,
        [orderId],
      )
    ).rows;
  }
  /** @param {any[]} payments */
  function received(payments) {
    return payments
      .filter((p) => p.application_valid)
      .reduce(
        (sum, p) =>
          sum +
          Math.max(
            0,
            Number(p.applied_amount_cents) - Number(p.refunded_amount_cents),
          ),
        0,
      );
  }
  /** @param {any} order @param {any} plan @param {any[]} charges @param {number} paid */
  function blocked(order, plan, charges, paid) {
    // ADR 068: a cancelled order is terminal and never gets a new charge.
    if (order.cancelled_at) return 'ORDER_CANCELLED';
    if (order.origin === 'loja') return 'BILLING_STORE_ORDER';
    if (order.status !== 'confirmado') return 'BILLING_ORDER_NOT_CONFIRMED';
    if (
      !Number.isSafeInteger(Number(order.final_amount_cents)) ||
      Number(order.final_amount_cents) < 100
    )
      return 'BILLING_INVALID_AMOUNT';
    if (!plan && (order.paid_on || order.finance_payment_review_required))
      return 'BILLING_LEGACY_PAYMENT';
    if (plan?.review_required || charges.some((c) => c.status === 'review'))
      return 'BILLING_REVIEW_REQUIRED';
    if (
      charges.some((c) =>
        ['queued', 'creating', 'waiting', 'unknown'].includes(c.status),
      )
    )
      return 'BILLING_ACTIVE_CHARGE';
    if (paid >= Number(order.final_amount_cents)) return 'BILLING_ALREADY_PAID';
    return null;
  }
  /** @param {any} client @param {any} order @param {any} actor */
  async function view(client, order, actor) {
    const plan = await planFor(client, order.id);
    const charges = await chargesFor(client, order.id);
    const payments = await paymentsFor(client, order.id);
    const paid = received(payments);
    const canManage = owns(actor, order);
    return {
      billing: {
        enabled,
        managed: Boolean(plan),
        canManage,
        version: Number(plan?.version ?? 0),
        orderVersion: Number(order.version),
        percent: plan?.percent ?? null,
        totalAmountCents: Number(order.final_amount_cents ?? 0),
        receivedAmountCents: paid,
        balanceAmountCents: Math.max(
          0,
          Number(order.final_amount_cents ?? 0) - paid,
        ),
        blockedReason: !canManage
          ? 'FORBIDDEN'
          : !enabled
            ? 'BILLING_DISABLED'
            : blocked(order, plan, charges, paid),
        reviewRequired: Boolean(plan?.review_required),
        charges: charges.map((c) => {
          const receipts = payments.filter((p) => p.charge_id === c.id);
          const receipt = receipts[0];
          const secret =
            c.checkout_envelope && canManage
              ? decryptOrderPrivateJson(
                  c.checkout_envelope,
                  `billing-checkout:${c.id}`,
                  envelopeKey,
                )
              : null;
          const receiptSecret =
            receipt?.receipt_envelope && canManage
              ? decryptOrderPrivateJson(
                  receipt.receipt_envelope,
                  `billing-receipt:${receipt.transaction_nsu}`,
                  envelopeKey,
                )
              : null;
          const uncertain =
            ['queued', 'creating'].includes(c.status) &&
            (['outcome_unknown', 'dead_letter'].includes(c.job_status) ||
              (c.reserved_at &&
                clock().getTime() - new Date(c.reserved_at).getTime() >
                  120000));
          return {
            id: c.id,
            kind: c.kind,
            amountCents: Number(c.amount_cents),
            status: uncertain ? 'unknown' : c.status,
            checkoutUrl: secret?.url ?? null,
            receiptUrl: receiptSecret?.url ?? null,
            method: receipt?.method ?? null,
            installments: receipt?.installments ?? null,
            createdAt: iso(c.created_at),
            validUntil: iso(c.valid_until),
            paidAt: iso(receipt?.verified_at),
            refundedAmountCents: receipts.reduce(
              (sum, p) => sum + Number(p.refunded_amount_cents),
              0,
            ),
            refundableAmountCents: receipts.reduce(
              (sum, p) =>
                sum +
                Number(p.principal_amount_cents) -
                Number(p.refunded_amount_cents),
              0,
            ),
            transactionNsu: canManage
              ? (receipt?.transaction_nsu ?? null)
              : null,
          };
        }),
      },
    };
  }
  /** @param {any} client @param {any} order @param {any} plan @param {number} percent @param {any} actor */
  async function savePlan(client, order, plan, percent, actor) {
    if (!plan)
      return (
        await client.query(
          `INSERT INTO crm.order_billing_plans(order_id,percent,confirmed_at,final_amount_cents,payment_condition,created_by,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
          [
            order.id,
            percent,
            order.confirmed_at,
            order.final_amount_cents,
            order.payment_condition,
            actor.id,
            clock(),
          ],
        )
      ).rows[0];
    return (
      await client.query(
        'UPDATE crm.order_billing_plans SET percent=$2,version=version+1,updated_at=$3 WHERE order_id=$1 RETURNING *',
        [order.id, percent, clock()],
      )
    ).rows[0];
  }
  /** @param {any} client @param {string} orderId */
  async function refreshSettlement(client, orderId) {
    // The database guard derives the only legal paid_on from current applied receipts.
    return (
      await client.query(
        'UPDATE crm.orders SET version=version+1,updated_at=$2 WHERE id=$1 RETURNING *',
        [orderId, clock()],
      )
    ).rows[0];
  }
  /** @param {any} input @param {string} action @param {(client:any,order:any,plan:any,actor:any)=>Promise<any>} work @param {boolean} [emitting] */
  async function humanCommand(input, action, work, emitting = true) {
    if (!(emitting ? enabled : receiving))
      throw new BillingError(503, 'BILLING_DISABLED');
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !Number.isSafeInteger(input.expectedBillingVersion) ||
      input.expectedBillingVersion < 0
    )
      throw new BillingError(400, 'INVALID_EXPECTED_VERSION');
    return database.transaction(async (/** @type {any} */ client) => {
      const actor = await actorFor(client, input.actor, true);
      const order = await lockOrder(client, billingIdentifier(input.orderId));
      if (!owns(actor, order)) throw new BillingError(403, 'FORBIDDEN');
      const plan = await planFor(client, order.id);
      const bound = {
        query: client.query.bind(client),
        transaction: async (/** @type {any} */ operation) => operation(client),
      };
      const idempotency = new PostgresIdempotencyRecordStore({
        database: bound,
        envelopeKey: idempotencyKey,
      });
      const payload = { ...input };
      delete payload.actor;
      delete payload.correlationId;
      delete payload.idempotencyKey;
      return idempotency.execute(
        {
          scope: `billing.${action}:${actor.id}`,
          key: input.idempotencyKey,
          fingerprint: fingerprintCommand(payload),
          actor: actor.id,
          action: `billing.${action}`,
          target: { type: 'order', id: order.id },
          version: `${input.expectedVersion}:${input.expectedBillingVersion}`,
          reason: `BILLING_${action.toUpperCase()}`,
          correlationId: input.correlationId,
        },
        async () => {
          // ADR 068/OLIST-45: cancellation is terminal; checked inside the
          // replay so a receipt issued before the cancellation still replays.
          if (order.cancelled_at)
            throw new BillingError(409, 'ORDER_CANCELLED');
          if (
            Number(order.version) !== input.expectedVersion ||
            Number(plan?.version ?? 0) !== input.expectedBillingVersion
          )
            throw new BillingError(409, 'VERSION_CONFLICT');
          const result = await work(client, order, plan, actor);
          await audit(client, {
            actor: actor.id,
            action: `billing.${action}`,
            target: { type: 'order', id: order.id },
            version: input.expectedBillingVersion + 1,
            reason: `BILLING_${action.toUpperCase()}`,
            correlationId: input.correlationId,
          });
          return result;
        },
      );
    });
  }
  /** @param {any} client @param {string} chargeId */
  async function chargeContext(client, chargeId) {
    const existing = (
      await client.query(
        'SELECT order_id FROM crm.order_billing_charges WHERE id=$1',
        [uuid(chargeId)],
      )
    ).rows[0];
    if (!existing) throw new BillingError(404, 'BILLING_CHARGE_NOT_FOUND');
    const order = await lockOrder(client, existing.order_id);
    const plan = await planFor(client, order.id);
    const charge = (
      await client.query(
        'SELECT * FROM crm.order_billing_charges WHERE id=$1 FOR UPDATE',
        [chargeId],
      )
    ).rows[0];
    return { order, plan, charge };
  }
  /** @param {any} client @param {any} context @param {string} action @param {string} correlationId */
  async function automaticAudit(client, context, action, correlationId) {
    await audit(client, {
      actor: 'system:order-billing',
      action: `billing.${action}`,
      target: { type: 'billing-charge', id: context.charge.id },
      version: Number(context.plan.version) + 1,
      reason: `BILLING_${action.toUpperCase()}`,
      correlationId,
    });
  }
  /** @param {(client:any)=>Promise<any>} work */
  async function receive(work) {
    if (!receiving) throw new BillingError(503, 'BILLING_DISABLED');
    try {
      return await database.transaction(work);
    } catch (error) {
      if (/** @type {any} */ (error).code === '23505')
        throw new BillingError(409, 'BILLING_TRANSACTION_CONFLICT');
      throw error;
    }
  }
  return Object.freeze({
    authorizeRead: (/** @type {any} */ input) =>
      options.access.authorizeRead(input),
    authorizeWrite: (/** @type {any} */ input) =>
      options.access.authorizeWrite(input),
    /** @param {any} input */
    async get(input) {
      if (!receiving) throw new BillingError(503, 'BILLING_DISABLED');
      return database.transaction(async (/** @type {any} */ client) => {
        const actor = await actorFor(client, input.actor, false);
        return view(
          client,
          await lockOrder(client, billingIdentifier(input.orderId)),
          actor,
        );
      });
    },
    /** @param {any} input */
    async configure(input) {
      const percent = billingPercent(input.percent);
      return humanCommand(
        input,
        'configure',
        async (client, order, plan, actor) => {
          const charges = await chargesFor(client, order.id);
          const reason = blocked(
            order,
            plan,
            charges,
            received(await paymentsFor(client, order.id)),
          );
          if (reason) throw new BillingError(409, reason);
          if (charges.length)
            throw new BillingError(409, 'BILLING_CONDITION_LOCKED');
          billingSplit(Number(order.final_amount_cents), percent);
          await savePlan(client, order, plan, percent, actor);
          return view(client, order, actor);
        },
      );
    },
    /** @param {any} input */
    async issue(input) {
      const percent = billingPercent(input.percent);
      return humanCommand(
        input,
        'issue',
        async (client, order, plan, actor) => {
          const charges = await chargesFor(client, order.id);
          const paid = received(await paymentsFor(client, order.id));
          const reason = blocked(order, plan, charges, paid);
          if (reason) throw new BillingError(409, reason);
          if (charges.length && percent !== plan.percent)
            throw new BillingError(409, 'BILLING_CONDITION_LOCKED');
          const split = billingSplit(Number(order.final_amount_cents), percent);
          const amount =
            paid > 0 || percent === 0
              ? Number(order.final_amount_cents) - paid
              : split.signalAmountCents;
          if (amount < 100)
            throw new BillingError(422, 'BILLING_MINIMUM_AMOUNT');
          await savePlan(client, order, plan, percent, actor);
          const id = uuid(idFactory());
          const now = clock();
          await client.query(
            `INSERT INTO crm.order_billing_charges(id,order_id,kind,amount_cents,confirmed_at,order_amount_cents,payment_condition,valid_until,created_by,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
            [
              id,
              order.id,
              paid > 0
                ? 'balance'
                : percent > 0 && percent < 100
                  ? 'signal'
                  : 'full',
              amount,
              order.confirmed_at,
              order.final_amount_cents,
              order.payment_condition,
              new Date(now.getTime() + 86400000),
              actor.id,
              now,
            ],
          );
          await client.query(
            `INSERT INTO crm.outbox_jobs(id,job_type,idempotency_key,channel_event_id,status,priority,available_at,created_at,queue,attempt_count,max_attempts,updated_at,effect_policy)
          VALUES ($1,'billing.checkout.create',$2,NULL,'pending',100,$3,$3,'billing',0,8,$3,'manual')`,
            [`billing:${id}`, id, now],
          );
          return view(client, order, actor);
        },
      );
    },
    /** @param {any} input */
    async lookup(input) {
      return receive(async (client) => {
        const { charge } = await chargeContext(client, input.chargeId);
        const secret = charge.checkout_envelope
          ? decryptOrderPrivateJson(
              charge.checkout_envelope,
              `billing-checkout:${charge.id}`,
              envelopeKey,
            )
          : null;
        return {
          chargeId: charge.id,
          amountCents: Number(charge.amount_cents),
          status: charge.status,
          checkoutUrl: secret?.url ?? null,
          validUntil: iso(charge.valid_until),
        };
      });
    },
    /** @param {any} input */
    async reserve(input) {
      billingIdentifier(input.executionId);
      return receive(async (client) => {
        const context = await chargeContext(client, input.chargeId);
        const { order, plan, charge } = context;
        if (
          !enabled ||
          charge.status !== 'queued' ||
          new Date(charge.valid_until) <= clock() ||
          plan.review_required ||
          !matches(order, charge)
        )
          return { allowed: false, chargeId: charge.id };
        await client.query(
          "UPDATE crm.order_billing_charges SET status='creating',execution_id=$2,reserved_at=$3,updated_at=$3 WHERE id=$1",
          [charge.id, input.executionId, clock()],
        );
        await client.query(
          'UPDATE crm.order_billing_plans SET version=version+1,updated_at=$2 WHERE order_id=$1',
          [order.id, clock()],
        );
        await automaticAudit(client, context, 'reserved', input.correlationId);
        return {
          allowed: true,
          chargeId: charge.id,
          amountCents: Number(charge.amount_cents),
          description: `Pedido ${order.number} - ${charge.kind === 'signal' ? 'sinal' : charge.kind === 'balance' ? 'saldo' : 'pagamento integral'}`,
          validUntil: iso(charge.valid_until),
        };
      });
    },
    /** @param {any} input */
    async created(input) {
      const url = billingUrl(input.checkoutUrl);
      return receive(async (client) => {
        const context = await chargeContext(client, input.chargeId);
        const { charge, order } = context;
        if (!charge.execution_id || charge.execution_id !== input.executionId)
          throw new BillingError(409, 'BILLING_EXECUTION_CONFLICT');
        if (charge.checkout_envelope) {
          if (
            decryptOrderPrivateJson(
              charge.checkout_envelope,
              `billing-checkout:${charge.id}`,
              envelopeKey,
            ).url !== url
          )
            throw new BillingError(409, 'BILLING_CHECKOUT_CONFLICT');
          return { recorded: true, chargeId: charge.id };
        }
        await client.query(
          `UPDATE crm.order_billing_charges SET checkout_envelope=$2::jsonb,status=CASE WHEN status IN ('creating','unknown','queued') THEN 'waiting' ELSE status END,updated_at=$3 WHERE id=$1`,
          [
            charge.id,
            JSON.stringify(
              encryptOrderPrivateJson(
                { url },
                `billing-checkout:${charge.id}`,
                envelopeKey,
              ),
            ),
            clock(),
          ],
        );
        await client.query(
          'UPDATE crm.order_billing_plans SET version=version+1,updated_at=$2 WHERE order_id=$1',
          [order.id, clock()],
        );
        await automaticAudit(client, context, 'created', input.correlationId);
        return { recorded: true, chargeId: charge.id };
      });
    },
    /** @param {any} input */
    async payment(input) {
      const nsu = billingIdentifier(input.transactionNsu);
      const slug = billingIdentifier(input.invoiceSlug);
      const amount = billingCents(input.amountCents);
      const paid = billingCents(input.paidAmountCents);
      const receiptUrl = billingUrl(input.receiptUrl, true);
      if (
        !['pix', 'credit_card'].includes(input.method) ||
        !Number.isInteger(input.installments) ||
        input.installments < 1 ||
        input.installments > 12 ||
        (input.method === 'pix' && input.installments !== 1)
      )
        throw new BillingError(400, 'BILLING_INVALID_PAYMENT');
      return receive(async (client) => {
        const context = await chargeContext(client, input.chargeId);
        const { order, plan, charge } = context;
        if (
          !charge.execution_id ||
          amount !== Number(charge.amount_cents) ||
          paid < amount
        )
          throw new BillingError(422, 'BILLING_PAYMENT_MISMATCH');
        const previous = (
          await client.query(
            'SELECT * FROM crm.order_billing_payments WHERE crm.infinitepay_transaction_key(transaction_nsu)=crm.infinitepay_transaction_key($1)',
            [nsu],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.charge_id !== charge.id ||
            previous.invoice_slug !== slug ||
            Number(previous.principal_amount_cents) !== amount ||
            Number(previous.paid_amount_cents) !== paid ||
            previous.method !== input.method ||
            previous.installments !== input.installments
          )
            throw new BillingError(409, 'BILLING_TRANSACTION_CONFLICT');
          if (receiptUrl && !previous.receipt_envelope) {
            await client.query(
              'UPDATE crm.order_billing_payments SET receipt_envelope=$2::jsonb WHERE id=$1',
              [
                previous.id,
                JSON.stringify(
                  encryptOrderPrivateJson(
                    { url: receiptUrl },
                    `billing-receipt:${previous.transaction_nsu}`,
                    envelopeKey,
                  ),
                ),
              ],
            );
            await automaticAudit(
              client,
              context,
              'receipt_attached',
              input.correlationId,
            );
          } else if (
            receiptUrl &&
            decryptOrderPrivateJson(
              previous.receipt_envelope,
              `billing-receipt:${previous.transaction_nsu}`,
              envelopeKey,
            ).url !== receiptUrl
          )
            throw new BillingError(409, 'BILLING_RECEIPT_CONFLICT');
          return { recorded: true, chargeId: charge.id, duplicate: true };
        }
        const existing = await paymentsFor(client, order.id);
        const alreadyPaid = existing.some((p) => p.charge_id === charge.id);
        const applicable =
          !alreadyPaid &&
          !plan.review_required &&
          charge.status !== 'closed' &&
          charge.status !== 'review' &&
          matches(order, charge) &&
          received(existing) + amount <= Number(order.final_amount_cents);
        await client.query(
          "INSERT INTO crm.infinitepay_transactions(transaction_nsu,owner_kind,owner_id,created_at) VALUES ($1,'billing',$2,$3)",
          [nsu, charge.id, clock()],
        );
        await client.query(
          `INSERT INTO crm.order_billing_payments(id,charge_id,transaction_nsu,invoice_slug,principal_amount_cents,paid_amount_cents,applied_amount_cents,application_valid,method,installments,receipt_envelope,verified_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
          [
            idFactory(),
            charge.id,
            nsu,
            slug,
            amount,
            paid,
            applicable ? amount : 0,
            applicable,
            input.method,
            input.installments,
            receiptUrl
              ? JSON.stringify(
                  encryptOrderPrivateJson(
                    { url: receiptUrl },
                    `billing-receipt:${nsu}`,
                    envelopeKey,
                  ),
                )
              : null,
            clock(),
          ],
        );
        await client.query(
          'UPDATE crm.order_billing_charges SET status=$2,updated_at=$3 WHERE id=$1',
          [charge.id, applicable ? 'paid' : 'review', clock()],
        );
        await client.query(
          'UPDATE crm.order_billing_plans SET review_required=review_required OR $2,version=version+1,updated_at=$3 WHERE order_id=$1',
          [order.id, !applicable, clock()],
        );
        // A cancelled order is immutable (migration 0070): the receipt stays
        // as unapplied evidence for human review, the order row is untouched.
        if (!order.cancelled_at) await refreshSettlement(client, order.id);
        await automaticAudit(
          client,
          context,
          applicable ? 'payment_recorded' : 'payment_review',
          input.correlationId,
        );
        return {
          recorded: true,
          chargeId: charge.id,
          reviewRequired: !applicable,
        };
      });
    },
    /** @param {any} input */
    async refund(input) {
      const amount = billingCents(input.amountCents);
      return humanCommand(
        input,
        'refund',
        async (client, order, plan, actor) => {
          if (!plan) throw new BillingError(409, 'BILLING_NOT_MANAGED');
          const chargeId = uuid(input.chargeId);
          const payments = (await paymentsFor(client, order.id)).filter(
            (p) => p.charge_id === chargeId,
          );
          const remaining = payments.reduce(
            (sum, p) =>
              sum +
              Number(p.principal_amount_cents) -
              Number(p.refunded_amount_cents),
            0,
          );
          if (!payments.length || amount > remaining)
            throw new BillingError(422, 'BILLING_INVALID_REFUND');
          let toRefund = amount;
          for (const payment of payments) {
            const part = Math.min(
              toRefund,
              Number(payment.principal_amount_cents) -
                Number(payment.refunded_amount_cents),
            );
            if (part > 0) {
              await client.query(
                'UPDATE crm.order_billing_payments SET refunded_amount_cents=refunded_amount_cents+$2 WHERE id=$1',
                [payment.id, part],
              );
              await client.query(
                'INSERT INTO crm.order_billing_refunds(id,payment_id,amount_cents,actor_id,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
                [
                  idFactory(),
                  payment.id,
                  part,
                  actor.id,
                  input.correlationId,
                  clock(),
                ],
              );
            }
            toRefund -= part;
          }
          await client.query(
            "UPDATE crm.order_billing_charges SET status='review',updated_at=$2 WHERE id=$1",
            [chargeId, clock()],
          );
          await client.query(
            'UPDATE crm.order_billing_plans SET review_required=true,version=version+1,updated_at=$2 WHERE order_id=$1',
            [order.id, clock()],
          );
          const saved = await refreshSettlement(client, order.id);
          saved.billing_owner_id = order.billing_owner_id;
          return view(client, saved, actor);
        },
        false,
      );
    },
    /** @param {any} input */
    async reconcile(input) {
      if (
        input.confirmedProviderReview !== true ||
        !['apply_current', 'close_unpaid'].includes(input.decision)
      )
        throw new BillingError(400, 'BILLING_REVIEW_CONFIRMATION_REQUIRED');
      return humanCommand(
        input,
        'reconcile',
        async (client, order, plan, actor) => {
          if (!plan) throw new BillingError(409, 'BILLING_NOT_MANAGED');
          const charges = await chargesFor(client, order.id);
          const payments = await paymentsFor(client, order.id);
          const unpaid = charges.filter(
            (c) =>
              !payments.some((p) => p.charge_id === c.id) &&
              c.status !== 'closed',
          );
          if (unpaid.some((c) => new Date(c.valid_until) > clock()))
            throw new BillingError(409, 'BILLING_LINK_STILL_VALID');
          for (const c of unpaid)
            await client.query(
              "UPDATE crm.order_billing_charges SET status='closed',updated_at=$2 WHERE id=$1",
              [c.id, clock()],
            );
          if (input.decision === 'apply_current') {
            if (order.status !== 'confirmado')
              throw new BillingError(409, 'BILLING_ORDER_NOT_CONFIRMED');
            const net = payments.reduce(
              (sum, p) =>
                sum +
                Number(p.principal_amount_cents) -
                Number(p.refunded_amount_cents),
              0,
            );
            if (net > Number(order.final_amount_cents))
              throw new BillingError(409, 'BILLING_OVERPAID');
            await client.query(
              `UPDATE crm.order_billing_payments p SET application_valid=true,applied_amount_cents=principal_amount_cents FROM crm.order_billing_charges c WHERE c.id=p.charge_id AND c.order_id=$1`,
              [order.id],
            );
            await client.query(
              "UPDATE crm.order_billing_charges c SET status='paid',updated_at=$2 WHERE order_id=$1 AND EXISTS(SELECT 1 FROM crm.order_billing_payments p WHERE p.charge_id=c.id)",
              [order.id, clock()],
            );
            await client.query(
              'UPDATE crm.order_billing_plans SET review_required=false,confirmed_at=$2,final_amount_cents=$3,payment_condition=$4,version=version+1,updated_at=$5 WHERE order_id=$1',
              [
                order.id,
                order.confirmed_at,
                order.final_amount_cents,
                order.payment_condition,
                clock(),
              ],
            );
          } else {
            const outstandingReview = payments.some(
              (p) => !p.application_valid,
            );
            await client.query(
              'UPDATE crm.order_billing_plans SET review_required=$2,version=version+1,updated_at=$3 WHERE order_id=$1',
              [order.id, outstandingReview, clock()],
            );
          }
          const saved = await refreshSettlement(client, order.id);
          saved.billing_owner_id = order.billing_owner_id;
          return view(client, saved, actor);
        },
        false,
      );
    },
  });
}
