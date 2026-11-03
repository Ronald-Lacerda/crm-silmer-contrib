import { createHash, randomUUID } from 'node:crypto';
import {
  OrderAssistanceError,
  requireAssistanceOwner,
} from '../application/order-assistance.js';
import {
  decryptAssistance,
  encryptAssistance,
} from '../application/order-assistance-envelope.js';

/** OA-T01: all observations and decisions serialize on the conversation row. */
export class PostgresOrderAssistanceRepository {
  /** @param {{database:any,envelopeKey:Buffer,createPending:(tx:any,input:any,details:any)=>Promise<any>,clock?:()=>Date}} options */
  constructor(options) {
    this.database = options.database;
    this.key = options.envelopeKey;
    this.createPending = options.createPending;
    this.clock = options.clock ?? (() => new Date());
  }

  /** @param {any} input */
  async observe(input) {
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const conversation = await this.conversation(tx, input.conversationId);
      if (
        conversation.terminal_at ||
        Number(conversation.inbound_revision) !== input.sourceRevision ||
        Number(conversation.automation_epoch) !== input.automationEpoch
      )
        return { accepted: true, stale: true, suggested: false };
      if (input.evidenceMessageId)
        await this.evidence(
          tx,
          input.conversationId,
          input.evidenceMessageId,
          input.sourceRevision,
        );
      const previous = (
        await tx.query(
          'SELECT * FROM crm.order_assistance_evaluations WHERE conversation_id=$1 AND source_revision=$2',
          [input.conversationId, input.sourceRevision],
        )
      ).rows[0];
      if (
        previous &&
        previous.signal !== 'analysis_failed' &&
        Number(previous.automation_epoch) === input.automationEpoch
      )
        return { accepted: true, duplicate: true, suggested: false };
      const now = this.clock().toISOString();
      const evaluationId = previous?.id ?? randomUUID();
      await tx.query(
        `INSERT INTO crm.order_assistance_evaluations
          (id,conversation_id,source_revision,automation_epoch,signal,evidence_message_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (conversation_id,source_revision) DO UPDATE SET signal=EXCLUDED.signal,evidence_message_id=EXCLUDED.evidence_message_id,automation_epoch=EXCLUDED.automation_epoch,created_at=EXCLUDED.created_at,blocked_reason=NULL`,
        [
          evaluationId,
          input.conversationId,
          input.sourceRevision,
          input.automationEpoch,
          input.signal,
          input.evidenceMessageId,
          now,
        ],
      );
      await tx.query(
        `UPDATE crm.order_assistance_suggestions SET status='obsolete',version=version+1,resolved_at=$3
        WHERE conversation_id=$1 AND status='pending' AND (source_revision<>$2 OR automation_epoch<>$4)`,
        [
          input.conversationId,
          input.sourceRevision,
          now,
          input.automationEpoch,
        ],
      );
      let suggestionId = null;
      let blockedReason = null;
      if (input.signal === 'purchase_confirmed') {
        const subjects = await this.subjects(tx, input.conversationId);
        const target = this.target(subjects, input.subjectId);
        const pending = await this.pending(tx, input.conversationId);
        blockedReason = pending
          ? 'pending_order_exists'
          : target.blocked
            ? 'subject_target_required'
            : null;
        if (!blockedReason) {
          const repeated = (
            await tx.query(
              'SELECT id,status FROM crm.order_assistance_suggestions WHERE conversation_id=$1 AND evidence_message_id=$2',
              [input.conversationId, input.evidenceMessageId],
            )
          ).rows[0];
          if (!repeated || ['pending', 'obsolete'].includes(repeated.status)) {
            suggestionId = repeated?.id ?? randomUUID();
            const details = encryptAssistance(
              {
                productSummary: input.productSummary,
                briefing: input.briefing,
              },
              `order-assistance:${suggestionId}`,
              this.key,
            );
            if (repeated) {
              await tx.query(
                `UPDATE crm.order_assistance_suggestions SET evaluation_id=$2,subject_id=$3,source_revision=$4,automation_epoch=$5,status='pending',version=version+1,details_envelope=$6::jsonb,resolved_at=NULL,subject_version=$7 WHERE id=$1`,
                [
                  suggestionId,
                  evaluationId,
                  target.subject?.id ?? null,
                  input.sourceRevision,
                  input.automationEpoch,
                  JSON.stringify(details),
                  target.subject?.version ?? null,
                ],
              );
            } else
              await tx.query(
                `INSERT INTO crm.order_assistance_suggestions
              (id,conversation_id,evaluation_id,evidence_message_id,subject_id,source_revision,automation_epoch,status,details_envelope,created_at,subject_version)
              VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,$9,$10)`,
                [
                  suggestionId,
                  input.conversationId,
                  evaluationId,
                  input.evidenceMessageId,
                  target.subject?.id ?? null,
                  input.sourceRevision,
                  input.automationEpoch,
                  JSON.stringify(details),
                  now,
                  target.subject?.version ?? null,
                ],
              );
            await this.audit(
              tx,
              'AUTOMATION_EXECUTOR',
              'order.assistance.suggested',
              input.conversationId,
              input.correlationId,
              'purchase_confirmed',
            );
          }
        }
      }
      if (blockedReason)
        await tx.query(
          'UPDATE crm.order_assistance_evaluations SET blocked_reason=$2 WHERE id=$1',
          [evaluationId, blockedReason],
        );
      await this.changed(tx, input.conversationId, now);
      return {
        accepted: true,
        suggested: Boolean(suggestionId),
        suggestion_id: suggestionId,
        blocked_reason: blockedReason,
      };
    });
  }

  /** @param {any} input */
  async list(input) {
    if (input.actor?.kind !== 'human')
      throw new OrderAssistanceError(403, 'FORBIDDEN');
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const conversation = await this.conversation(tx, input.conversationId);
      const rows = (
        await tx.query(
          `SELECT suggestion.*,decision.reason AS decision_reason,decision.created_at AS decided_at FROM crm.order_assistance_suggestions suggestion LEFT JOIN crm.order_assistance_decisions decision ON decision.suggestion_id=suggestion.id WHERE suggestion.conversation_id=$1 ORDER BY suggestion.created_at DESC,suggestion.id DESC LIMIT 20`,
          [input.conversationId],
        )
      ).rows;
      const evaluations = (
        await tx.query(
          `SELECT id,signal,blocked_reason,source_revision,created_at FROM crm.order_assistance_evaluations WHERE conversation_id=$1 ORDER BY source_revision DESC LIMIT 20`,
          [input.conversationId],
        )
      ).rows;
      const decisions = (
        await tx.query(
          `SELECT * FROM crm.order_assistance_decisions WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
          [input.conversationId],
        )
      ).rows;
      const target = this.target(
        await this.subjects(tx, input.conversationId),
        null,
      );
      const blockedReason = (await this.pending(tx, input.conversationId))
        ? 'pending_order_exists'
        : target.blocked
          ? 'subject_target_required'
          : null;
      return {
        blockedReason,
        sourceRevision: Number(conversation.inbound_revision),
        conversationVersion: Number(conversation.version),
        suggestions: rows.map((/** @type {any} */ row) => {
          const details = decryptAssistance(
            row.details_envelope,
            `order-assistance:${row.id}`,
            this.key,
          );
          const obsolete =
            row.status === 'pending' &&
            (Number(row.source_revision) !==
              Number(conversation.inbound_revision) ||
              Number(row.automation_epoch) !==
                Number(conversation.automation_epoch) ||
              conversation.terminal_at);
          return {
            id: row.id,
            status: obsolete ? 'obsolete' : row.status,
            version: Number(row.version),
            productSummary: details.productSummary,
            evidenceMessageId: row.evidence_message_id,
            sourceRevision: Number(row.source_revision),
            createdAt: new Date(row.created_at).toISOString(),
            reason: row.decision_reason ?? 'purchase_confirmed',
            decidedAt: row.decided_at
              ? new Date(row.decided_at).toISOString()
              : null,
          };
        }),
        analysisHistory: evaluations.map((/** @type {any} */ row) => ({
          id: row.id,
          signal: row.signal,
          blockedReason: row.blocked_reason,
          sourceRevision: Number(row.source_revision),
          createdAt: new Date(row.created_at).toISOString(),
        })),
        evaluations: decisions.map((/** @type {any} */ row) => ({
          id: row.id,
          decision: row.decision,
          reason: row.reason,
          suggestionId: row.suggestion_id,
          sourceMessageId: row.source_message_id,
          orderId: row.order_id,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    });
  }

  /** @param {any} input */
  async decide(input) {
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const conversation = await this.conversation(tx, input.conversationId);
      requireAssistanceOwner(input.actor, conversation);
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            input.conversationId,
            input.suggestionId ?? null,
            input.decision,
            input.reason,
            input.sourceMessageId ?? null,
            input.expectedVersion ?? null,
            input.expectedConversationVersion,
            input.expectedSourceRevision,
          ]),
        )
        .digest('hex');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `order-assistance:${input.actor.id}:${input.idempotencyKey}`,
      ]);
      const replay = (
        await tx.query(
          `SELECT command.fingerprint,decision.* FROM crm.order_assistance_commands command JOIN crm.order_assistance_decisions decision ON decision.id=command.decision_id WHERE command.actor_id=$1 AND command.idempotency_key=$2`,
          [input.actor.id, input.idempotencyKey],
        )
      ).rows[0];
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new OrderAssistanceError(409, 'IDEMPOTENCY_KEY_REUSED');
        return this.decisionResult(tx, replay, true);
      }
      if (conversation.terminal_at && input.decision !== 'missed')
        throw new OrderAssistanceError(409, 'CONVERSATION_CLOSED');
      if (
        Number(conversation.version) !== input.expectedConversationVersion ||
        Number(conversation.inbound_revision) !== input.expectedSourceRevision
      )
        throw new OrderAssistanceError(409, 'ASSISTANCE_STALE');
      let suggestion = null;
      let order = null;
      const now = this.clock().toISOString();
      if (input.decision === 'missed') {
        await this.evidence(
          tx,
          input.conversationId,
          input.sourceMessageId,
          input.expectedSourceRevision,
        );
        const existing = (
          await tx.query(
            `SELECT * FROM crm.order_assistance_decisions WHERE conversation_id=$1 AND source_message_id=$2 AND decision='missed'`,
            [input.conversationId, input.sourceMessageId],
          )
        ).rows[0];
        if (existing) return this.decisionResult(tx, existing, true);
      } else {
        suggestion = (
          await tx.query(
            `SELECT * FROM crm.order_assistance_suggestions WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
            [input.suggestionId, input.conversationId],
          )
        ).rows[0];
        if (!suggestion)
          throw new OrderAssistanceError(404, 'SUGGESTION_NOT_FOUND');
        if (
          suggestion.status !== 'pending' ||
          Number(suggestion.version) !== input.expectedVersion
        )
          throw new OrderAssistanceError(409, 'ASSISTANCE_STALE');
        if (input.decision === 'accept') {
          if (
            Number(suggestion.source_revision) !==
              Number(conversation.inbound_revision) ||
            Number(suggestion.automation_epoch) !==
              Number(conversation.automation_epoch)
          )
            throw new OrderAssistanceError(409, 'ASSISTANCE_STALE');
          const subjects = await this.subjects(tx, input.conversationId);
          const target = this.target(subjects, suggestion.subject_id);
          if (
            target.blocked ||
            (target.subject?.id ?? null) !== suggestion.subject_id ||
            (target.subject &&
              Number(target.subject.version) !==
                Number(suggestion.subject_version))
          )
            throw new OrderAssistanceError(409, 'SUBJECT_TARGET_REQUIRED');
          if (await this.pending(tx, input.conversationId))
            throw new OrderAssistanceError(409, 'ORDER_PENDING_EXISTS');
          const details = decryptAssistance(
            suggestion.details_envelope,
            `order-assistance:${suggestion.id}`,
            this.key,
          );
          if (suggestion.subject_id) {
            const snapshot = (
              await tx.query(
                'SELECT * FROM crm.subject_briefings WHERE subject_id=$1 FOR UPDATE',
                [suggestion.subject_id],
              )
            ).rows[0];
            details.baseBriefing = snapshot?.envelope
              ? decryptAssistance(
                  snapshot.envelope,
                  snapshot.legacy_conversation_id
                    ? `n8n-briefing:${snapshot.legacy_conversation_id}:${snapshot.version}`
                    : `n8n-subject-briefing:${suggestion.subject_id}:${snapshot.version}`,
                  this.key,
                )
              : {};
          }
          const created = await this.createPending(
            tx,
            { ...input, subjectId: suggestion.subject_id },
            details,
          );
          if (!created.created)
            throw new OrderAssistanceError(409, 'ORDER_PENDING_EXISTS');
          order = created.order;
          await this.linkOrder(
            tx,
            conversation,
            suggestion,
            order,
            input.actor,
            now,
            created.briefing ?? details.briefing ?? {},
          );
        }
        await tx.query(
          `UPDATE crm.order_assistance_suggestions SET status=$2,version=version+1,resolved_at=$3 WHERE id=$1`,
          [
            suggestion.id,
            { accept: 'accepted', defer: 'deferred', reject: 'rejected' }[
              /** @type {'accept'|'defer'|'reject'} */ (input.decision)
            ],
            now,
          ],
        );
      }
      const decision = (
        await tx.query(
          `INSERT INTO crm.order_assistance_decisions (id,conversation_id,suggestion_id,source_message_id,actor_id,decision,reason,order_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            randomUUID(),
            input.conversationId,
            suggestion?.id ?? null,
            input.sourceMessageId ?? suggestion?.evidence_message_id ?? null,
            input.actor.id,
            input.decision,
            input.reason,
            order?.id ?? null,
            now,
          ],
        )
      ).rows[0];
      await tx.query(
        `INSERT INTO crm.order_assistance_commands (actor_id,idempotency_key,fingerprint,decision_id) VALUES ($1,$2,$3,$4)`,
        [input.actor.id, input.idempotencyKey, fingerprint, decision.id],
      );
      await this.audit(
        tx,
        input.actor.id,
        'order.assistance.' + input.decision,
        input.conversationId,
        input.correlationId,
        input.reason,
      );
      await this.changed(tx, input.conversationId, now);
      return this.decisionResult(tx, decision, false);
    });
  }

  /** @param {number} days */
  async metrics(days) {
    const since = new Date(
      this.clock().getTime() - days * 86400000,
    ).toISOString();
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const decisions = (
        await tx.query(
          `SELECT count(*) FILTER (WHERE decision='accept') AS accepted,count(*) FILTER (WHERE decision='defer') AS deferred,count(*) FILTER (WHERE decision='reject') AS rejected,count(*) FILTER (WHERE decision='missed') AS missed,avg(GREATEST(0,EXTRACT(EPOCH FROM (decision.created_at-suggestion.created_at)))) FILTER (WHERE suggestion.id IS NOT NULL) AS average_decision_seconds,avg(GREATEST(0,EXTRACT(EPOCH FROM (orders.created_at-message.occurred_at)))) FILTER (WHERE decision.decision='accept') AS average_creation_seconds FROM crm.order_assistance_decisions decision LEFT JOIN crm.order_assistance_suggestions suggestion ON suggestion.id=decision.suggestion_id LEFT JOIN crm.orders orders ON orders.id=decision.order_id LEFT JOIN crm.messages message ON message.id=decision.source_message_id WHERE decision.created_at >= $1`,
          [since],
        )
      ).rows[0];
      const suggestions = (
        await tx.query(
          `SELECT count(*) AS total,count(*) FILTER (WHERE suggestion.status='pending' AND suggestion.source_revision=conversation.inbound_revision AND suggestion.automation_epoch=conversation.automation_epoch AND conversation.terminal_at IS NULL) AS pending FROM crm.order_assistance_suggestions suggestion JOIN crm.conversations conversation ON conversation.id=suggestion.conversation_id WHERE suggestion.created_at >= $1`,
          [since],
        )
      ).rows[0];
      const observations = (
        await tx.query(
          `SELECT count(*) AS total,count(*) FILTER (WHERE signal='analysis_failed') AS failures,count(*) FILTER (WHERE signal NOT IN ('analysis_failed','purchase_confirmed') OR blocked_reason IS NOT NULL) AS without_suggestion,count(*) FILTER (WHERE blocked_reason='subject_target_required') AS ambiguous FROM crm.order_assistance_evaluations WHERE created_at >= $1`,
          [since],
        )
      ).rows[0];
      const manual = (
        await tx.query(
          `SELECT count(*) AS total FROM crm.orders orders WHERE orders.created_by_kind='user' AND orders.created_at >= $1 AND orders.conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm.order_assistance_decisions decision WHERE decision.order_id=orders.id AND decision.decision='accept')`,
          [since],
        )
      ).rows[0];
      return {
        days,
        suggestions: Number(suggestions.total),
        pending: Number(suggestions.pending),
        accepted: Number(decisions.accepted),
        deferred: Number(decisions.deferred),
        rejected: Number(decisions.rejected),
        missed: Number(decisions.missed),
        manualWithoutSuggestion: Number(manual.total),
        averageDecisionSeconds:
          decisions.average_decision_seconds === null
            ? null
            : Number(decisions.average_decision_seconds),
        averageCreationSeconds:
          decisions.average_creation_seconds === null
            ? null
            : Number(decisions.average_creation_seconds),
        observations: Number(observations.total),
        observationFailures: Number(observations.failures),
        ambiguousTargets: Number(observations.ambiguous),
        observationsWithoutSuggestion: Number(observations.without_suggestion),
      };
    });
  }

  /** @param {any} tx @param {string} id */
  async conversation(tx, id) {
    const row = (
      await tx.query('SELECT * FROM crm.conversations WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (!row) throw new OrderAssistanceError(404, 'CONVERSATION_NOT_FOUND');
    return row;
  }
  /** @param {any} tx @param {string} conversationId @param {string} id @param {number} revision */
  async evidence(tx, conversationId, id, revision) {
    const row = (
      await tx.query(
        `SELECT id FROM crm.messages WHERE conversation_id=$1 AND id=$2 AND direction='inbound' AND author_kind='contact' AND inbound_revision <= $3`,
        [conversationId, id, revision],
      )
    ).rows[0];
    if (!row) throw new OrderAssistanceError(400, 'INVALID_PURCHASE_EVIDENCE');
    return row;
  }
  /** @param {any} tx @param {string} id */
  async subjects(tx, id) {
    return (
      await tx.query(
        'SELECT id,order_id,is_current,selected_source,version FROM crm.conversation_subjects WHERE conversation_id=$1 FOR UPDATE',
        [id],
      )
    ).rows;
  }
  /** @param {any[]} subjects @param {string|null} requested */
  target(subjects, requested) {
    if (!subjects.length) return { blocked: Boolean(requested), subject: null };
    const subject = requested
      ? subjects.find((value) => value.id === requested)
      : subjects.length === 1
        ? subjects[0]
        : subjects.find(
            (value) => value.is_current && value.selected_source === 'human',
          );
    const valid =
      subject &&
      !subject.order_id &&
      (subjects.length === 1 ||
        (subject.is_current && subject.selected_source === 'human'));
    return { blocked: !valid, subject: valid ? subject : null };
  }
  /** @param {any} tx @param {string} id */
  async pending(tx, id) {
    return Boolean(
      (
        await tx.query(
          `SELECT orders.id FROM crm.orders orders WHERE orders.status='pendente' AND (orders.conversation_id=$1 OR EXISTS (SELECT 1 FROM crm.conversation_subjects subject WHERE subject.conversation_id=$1 AND subject.order_id=orders.id)) LIMIT 1`,
          [id],
        )
      ).rows[0],
    );
  }
  /** @param {any} tx @param {any} row @param {boolean} duplicate */
  async decisionResult(tx, row, duplicate) {
    const order = row.order_id
      ? (
          await tx.query('SELECT id,number FROM crm.orders WHERE id=$1', [
            row.order_id,
          ])
        ).rows[0]
      : null;
    return {
      decision: {
        id: row.id,
        decision: row.decision,
        reason: row.reason,
        suggestionId: row.suggestion_id,
        orderId: row.order_id,
        createdAt: new Date(row.created_at).toISOString(),
      },
      order,
      duplicate,
    };
  }
  /** @param {any} tx @param {any} conversation @param {any} suggestion @param {any} order @param {any} actor @param {string} now @param {any} briefing */
  async linkOrder(tx, conversation, suggestion, order, actor, now, briefing) {
    let subjectId = suggestion.subject_id;
    if (subjectId)
      await tx.query(
        `UPDATE crm.conversation_subjects SET kind='pedido',order_id=$2,version=version+1,updated_at=$3 WHERE id=$1`,
        [subjectId, order.id, now],
      );
    else {
      subjectId = randomUUID();
      await tx.query(
        `INSERT INTO crm.conversation_subjects (id,conversation_id,contact_id,order_id,kind,position,is_current,selected_source,selected_by,selected_at,created_by,created_by_kind,created_at,updated_at) SELECT $1,$2,identity.current_contact_id,$3,'pedido',1,true,'human',$4,$5,$4,'human',$5,$5 FROM crm.contact_identities identity WHERE identity.id=$6`,
        [
          subjectId,
          conversation.id,
          order.id,
          actor.id,
          now,
          conversation.contact_identity_id,
        ],
      );
    }
    const previousSnapshot = (
      await tx.query(
        'SELECT version FROM crm.subject_briefings WHERE subject_id=$1 FOR UPDATE',
        [subjectId],
      )
    ).rows[0];
    const briefingVersion = Number(previousSnapshot?.version ?? 0) + 1;
    const subjectEnvelope = encryptAssistance(
      briefing,
      `n8n-subject-briefing:${subjectId}:${briefingVersion}`,
      this.key,
    );
    await tx.query(
      `INSERT INTO crm.subject_briefings (subject_id,version,envelope,legacy_conversation_id,updated_at) VALUES ($1,$4,$2::jsonb,NULL,$3) ON CONFLICT (subject_id) DO UPDATE SET version=EXCLUDED.version,envelope=EXCLUDED.envelope,legacy_conversation_id=NULL,updated_at=EXCLUDED.updated_at`,
      [subjectId, JSON.stringify(subjectEnvelope), now, briefingVersion],
    );
    await tx.query(
      `INSERT INTO crm.message_subject_links (message_id,subject_id,conversation_id,assigned_by,assigned_by_kind,assigned_at) VALUES ($1,$2,$3,$4,'human',$5) ON CONFLICT DO NOTHING`,
      [
        suggestion.evidence_message_id,
        subjectId,
        conversation.id,
        actor.id,
        now,
      ],
    );
  }
  /** @param {any} tx @param {string} actor @param {string} action @param {string} target @param {string} correlation @param {string} reason */
  async audit(tx, actor, action, target, correlation, reason) {
    await tx.query(
      `INSERT INTO crm.audit_events (id,actor_id,action,target_type,target_id,version,reason,correlation_id,occurred_at) VALUES ($1,$2,$3,'conversation',$4,'1',$5,$6,$7)`,
      [
        randomUUID(),
        actor,
        action,
        target,
        reason,
        correlation,
        this.clock().toISOString(),
      ],
    );
  }
  /** @param {any} tx @param {string} id @param {string} now */
  async changed(tx, id, now) {
    await tx.query(
      `INSERT INTO crm.domain_events (id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,correlation_id,occurred_at)
      SELECT $1,'conversation',$2,COALESCE((SELECT max(aggregate_version) FROM crm.domain_events WHERE aggregate_type='conversation' AND aggregate_id=$2 AND event_type='conversation.order_assistance.changed'),0)+1,'conversation.order_assistance.changed',$3::jsonb,$1,$4`,
      [randomUUID(), id, JSON.stringify({ conversationId: id }), now],
    );
  }
}
