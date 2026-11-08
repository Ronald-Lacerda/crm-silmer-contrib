/** Shared lock order for billing callbacks, transport and command recovery.
 * No locks for ordinary Inbox commands. Never acquire these after a message lock.
 * @param {any} client @param {{chargeId?:string,commandId?:string,externalMessageId?:string,conversationId?:string}} selector
 */
export async function lockBillingSend(client, selector) {
  // Serialize discovery with admission, including the zero-intent case. A
  // financial callback must not discover a newly admitted intent after it
  // already holds the order/charge locks (which would invert the lock order).
  const orderId = (
    await client.query(
      `SELECT order_id FROM crm.order_billing_charges WHERE id=$1::uuid
    UNION SELECT order_id FROM crm.order_billing_send_intents WHERE command_id=$2
    UNION SELECT i.order_id FROM crm.order_billing_send_intents i JOIN crm.messages m ON m.id=i.message_id WHERE m.external_message_id=$3 AND m.conversation_id=$4`,
      [
        selector.chargeId ?? null,
        selector.commandId ?? null,
        selector.externalMessageId ?? null,
        selector.conversationId ?? null,
      ],
    )
  ).rows;
  for (const row of orderId.sort((/** @type {any} */ a, /** @type {any} */ b) =>
    a.order_id.localeCompare(b.order_id),
  ))
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('billing-send-order:'||$1,0))",
      [row.order_id],
    );
  const rows = (
    await client.query(
      `SELECT i.*,o.conversation_id AS primary_conversation_id FROM crm.order_billing_send_intents i
    JOIN crm.orders o ON o.id=i.order_id WHERE ($1::uuid IS NOT NULL AND i.order_id=(SELECT order_id FROM crm.order_billing_charges WHERE id=$1))
      OR ($2::text IS NOT NULL AND i.command_id=$2)
      OR ($3::text IS NOT NULL AND i.message_id IN (SELECT id FROM crm.messages WHERE external_message_id=$3 AND conversation_id=$4))
    ORDER BY i.id`,
      [
        selector.chargeId ?? null,
        selector.commandId ?? null,
        selector.externalMessageId ?? null,
        selector.conversationId ?? null,
      ],
    )
  ).rows;
  if (!rows.length) return [];
  const actors = [
    ...new Set(rows.map((/** @type {any} */ r) => r.actor_id)),
  ].sort();
  await client.query(
    'SELECT id FROM crm.users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',
    [actors],
  );
  await client.query(
    'SELECT user_id FROM crm.user_functions WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR SHARE',
    [actors],
  );
  await client.query(
    'SELECT user_id,capability FROM crm.user_capabilities WHERE user_id=ANY($1::text[]) ORDER BY user_id,capability FOR SHARE',
    [actors],
  );
  const conversations = [
    ...new Set(
      rows
        .flatMap((/** @type {any} */ r) => [
          r.conversation_id,
          r.primary_conversation_id,
        ])
        .filter(Boolean),
    ),
  ].sort();
  await client.query(
    'SELECT id FROM crm.conversations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
    [conversations],
  );
  await client.query(
    'SELECT id FROM crm.contact_identities WHERE id IN (SELECT contact_identity_id FROM crm.conversations WHERE id=ANY($1::text[])) ORDER BY id FOR SHARE',
    [conversations],
  );
  await client.query(
    'SELECT id FROM crm.conversation_subjects WHERE conversation_id=ANY($1::text[]) ORDER BY id FOR SHARE',
    [conversations],
  );
  const orders = [
    ...new Set(rows.map((/** @type {any} */ r) => r.order_id)),
  ].sort();
  await client.query(
    'SELECT id FROM crm.orders WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
    [orders],
  );
  await client.query(
    'SELECT order_id FROM crm.order_billing_plans WHERE order_id=ANY($1::text[]) ORDER BY order_id FOR UPDATE',
    [orders],
  );
  await client.query(
    'SELECT id FROM crm.order_billing_charges WHERE order_id=ANY($1::text[]) ORDER BY id FOR UPDATE',
    [orders],
  );
  return (
    await client.query(
      'SELECT * FROM crm.order_billing_send_intents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [rows.map((/** @type {any} */ r) => r.id)],
    )
  ).rows;
}

/** Semantic guard: plan version advances during creation/payment; it is not the agreement.
 * @param {any} client @param {any} intent @param {{enabled:boolean,now:Date,checkRevision?:boolean}} options
 * @returns {Promise<string|null>}
 */
export async function billingSendBlockReason(client, intent, options) {
  if (!options.enabled) return 'SENDING_DISABLED';
  const row = (
    await client.query(
      `SELECT i.*,u.disabled_at,f.function_name,
    EXISTS(SELECT 1 FROM crm.user_capabilities WHERE user_id=i.actor_id AND capability='COMMERCIAL_ADMIN') AS admin,
    c.assigned_user_id AS current_owner,c.provider,c.provider_account_id,c.automation_state,c.automation_epoch AS current_epoch,c.cycle_number AS current_cycle,c.inbound_revision AS current_revision,c.terminal_at,
    ci.current_contact_id,o.contact_id,ci.id AS identity_id,
    o.status AS order_status,o.confirmed_at AS current_confirmed_at,o.final_amount_cents AS current_total,o.payment_condition AS current_condition,
    CASE WHEN o.conversation_id IS NULL THEN o.manual_owner_id ELSE primary_c.assigned_user_id END AS current_order_owner,
    o.conversation_id AS primary_id,p.review_required,
    ch.status AS charge_status,ch.valid_until,
    COALESCE((SELECT sum(greatest(0,bp.applied_amount_cents-bp.refunded_amount_cents)) FROM crm.order_billing_payments bp JOIN crm.order_billing_charges bc ON bc.id=bp.charge_id WHERE bc.order_id=i.order_id AND bp.application_valid),0) AS covered
    FROM crm.order_billing_send_intents i JOIN crm.users u ON u.id=i.actor_id
    LEFT JOIN crm.user_functions f ON f.user_id=u.id JOIN crm.conversations c ON c.id=i.conversation_id
    JOIN crm.contact_identities ci ON ci.id=c.contact_identity_id JOIN crm.orders o ON o.id=i.order_id
    LEFT JOIN crm.conversations primary_c ON primary_c.id=o.conversation_id
    JOIN crm.order_billing_plans p ON p.order_id=o.id JOIN crm.order_billing_charges ch ON ch.id=i.charge_id WHERE i.id=$1`,
      [intent.id],
    )
  ).rows[0];
  if (!row || row.disabled_at || row.function_name !== 'Vendedor')
    return 'ACTOR_DISABLED';
  if (
    row.provider === 'meta' &&
    (row.provider_account_id === 'dev-phone-number' ||
      row.provider_account_id.startsWith('synthetic-'))
  )
    return 'CONVERSATION_CLOSED';
  if (
    row.current_owner !== row.owner_id ||
    row.current_order_owner !== row.order_owner_id ||
    (!row.admin &&
      (row.current_owner !== row.actor_id ||
        row.current_order_owner !== row.actor_id))
  )
    return 'OWNER_CHANGED';
  if (
    row.terminal_at ||
    row.automation_state !== 'human' ||
    Number(row.current_epoch) !== Number(row.automation_epoch) ||
    Number(row.current_cycle) !== Number(row.cycle_number)
  )
    return 'CONVERSATION_CLOSED';
  if (
    row.primary_id !== row.conversation_id &&
    !(
      await client.query(
        'SELECT 1 FROM crm.conversation_subjects WHERE conversation_id=$1 AND order_id=$2 AND contact_id=$3',
        [row.conversation_id, row.order_id, row.contact_id],
      )
    ).rows.length
  )
    return 'AGREEMENT_CHANGED';
  if (
    row.current_contact_id !== row.contact_id &&
    !(
      await client.query(
        "SELECT 1 FROM crm.identity_links WHERE contact_identity_id=$1 AND source_contact_id=$2 AND target_contact_id=$3 AND status='active'",
        [row.identity_id, row.contact_id, row.current_contact_id],
      )
    ).rows.length
  )
    return 'AGREEMENT_CHANGED';
  if (
    row.order_status !== 'confirmado' ||
    new Date(row.current_confirmed_at).getTime() !==
      new Date(row.confirmed_at).getTime() ||
    String(row.current_total) !== String(row.order_amount_cents) ||
    row.current_condition !== row.payment_condition ||
    row.review_required ||
    row.charge_status === 'review'
  )
    return 'AGREEMENT_CHANGED';
  if (
    row.charge_status === 'paid' ||
    BigInt(row.covered) + BigInt(row.amount_cents) > BigInt(row.current_total)
  )
    return 'PAYMENT_CONFIRMED';
  if (
    new Date(row.valid_until) <= options.now ||
    row.charge_status === 'closed'
  )
    return 'CHARGE_EXPIRED';
  if (
    options.checkRevision &&
    Number(row.current_revision) !== Number(row.queued_source_revision)
  )
    return 'INBOUND_CHANGED';
  return null;
}

/** @param {any} client @param {string} intentId @param {string} reason @param {Date} now */
export async function blockBillingSend(client, intentId, reason, now) {
  const changed = (
    await client.query(
      `UPDATE crm.order_billing_send_intents SET state='blocked',blocked_reason=$2,failure_stage=NULL,version=version+1,updated_at=$3
    WHERE id=$1 AND state IN ('waiting_link','queued','sending') RETURNING *`,
      [intentId, reason, now],
    )
  ).rows[0];
  if (!changed) return;
  await client.query(
    "INSERT INTO crm.order_billing_send_events(id,intent_id,state,occurred_at) VALUES(gen_random_uuid(),$1,'blocked',$2)",
    [intentId, now],
  );
  await client.query(
    `INSERT INTO crm.audit_events(id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at)
    VALUES(gen_random_uuid()::text,'system:billing-send','billing.send.blocked','billing-intent',$1,$2,$3,$1,$4)`,
    [intentId, String(changed.version), reason, now],
  );
  if (changed.message_id) {
    const message = await client.query(
      "UPDATE crm.messages SET status='failed',delivery_status='failed',delivery_status_at=$2,delivery_failure_code='BILLING_SEND_BLOCKED' WHERE id=$1 AND status IN ('queued','sending') AND external_message_id IS NULL RETURNING id",
      [changed.message_id, now],
    );
    await client.query(
      "UPDATE crm.n8n_commands SET status='failed',retryable=false,retry_safe=false,last_error_code='BILLING_SEND_BLOCKED',locked_by=NULL,locked_until=NULL,updated_at=$2,completed_at=$2 WHERE command_id=$1 AND status IN ('pending','processing') AND external_message_id IS NULL",
      [changed.command_id, now],
    );
    if (message.rows.length) {
      await client.query(
        `INSERT INTO crm.domain_events(id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,correlation_id,occurred_at)
         SELECT $1,'conversation',$2,
           COALESCE((SELECT max(aggregate_version) FROM crm.domain_events WHERE aggregate_type='conversation' AND aggregate_id=$2 AND event_type='conversation.message_delivery_changed'),0)+1,
           'conversation.message_delivery_changed',$3::jsonb,$4,$5`,
        [
          `billing-block:${intentId}`,
          changed.conversation_id,
          JSON.stringify({ conversationId: changed.conversation_id }),
          changed.command_id,
          now,
        ],
      );
    }
  }
}
