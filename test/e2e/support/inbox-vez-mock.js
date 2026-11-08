// @ts-nocheck -- synthetic API simulator for the Caixa e2e specs.
// RFC 052 prototype: the API contract assumed by INBOX-VEZ-02/03, mocked in
// the browser with Playwright `page.route`. It also answers master's legacy
// queries (workQueue, sort=urgency) so BEFORE and AFTER read the same data.
import {
  ME,
  NOW,
  OTHER,
  buildItems,
  businessMinutesBetween,
  threadOf,
} from './inbox-vez-fixtures.js';

const BUCKET_ORDER = ['respond', 'awaiting', 'silent', 'lost'];
const failed = (item) =>
  ['failed', 'outcome_unknown'].includes(item.deliveryIssue?.status ?? '');

/** @param {Record<string, any>[]} items @param {string} bucket */
function sortBucket(items, bucket) {
  const by = (key) => (a, b) => String(key(a)).localeCompare(String(key(b)));
  if (bucket === 'respond')
    return [...items].sort(
      (a, b) =>
        Number(failed(b)) - Number(failed(a)) ||
        String(a.turnSince).localeCompare(String(b.turnSince)),
    );
  if (bucket === 'awaiting')
    return [...items].sort(by((item) => item.turnSince)).reverse();
  if (bucket === 'silent') return [...items].sort(by((item) => item.turnSince));
  return [...items]
    .sort(by((item) => item.lostOutcome?.occurredAt ?? ''))
    .reverse();
}

/** @param {Record<string, any>} item @param {URLSearchParams} params */
function matchesScope(item, params) {
  const owner = params.get('owner') ?? 'all';
  if (owner === 'mine' && item.assignedUser?.id !== ME.id) return false;
  if (owner === 'unassigned' && item.assignedUser) return false;
  const person = params.get('assignedUserId');
  if (person && item.assignedUser?.id !== person) return false;
  if (params.get('unassignedHumanHandoff') === 'true' && item.assignedUser)
    return false;
  if (
    params.get('orderReady') === 'true' &&
    !(
      item.reviewOrder?.status === 'pendente' &&
      item.reviewOrder?.readyForConfirmation === true
    )
  )
    return false;
  return true;
}

const SILENT_AFTER_MINUTES = 72 * 60;

/**
 * @param {import('playwright').Page} page
 * @param {{writes?: Array<{method: string, path: string, body: any}>, unmocked?: string[]}} [log]
 * @param {{
 *   fixedClock?: boolean,  // default true; false keeps the browser's real clock
 *   now?: string,          // ISO server/browser clock; default NOW (Fri 14:30 SP)
 *   extras?: boolean,      // round-2 fixtures (see fixtures.mjs)
 *   bulk?: boolean,        // 104 fillers each in silent/lost: P1-C targets past page one
 *   admin?: boolean,       // the session user is a COMMERCIAL_ADMIN
 *   failBuckets?: boolean,  // GET /inbox/buckets answers 503
 *   commandErrors?: Record<string, {status: number, code: string}>, // forced refusal per command path ('lead-outcome', 'reminder')
 *   legacyApi?: boolean,   // P1-D: pre-RFC-052 API (no bucket/turnAsOf, no /inbox/buckets)
 * }} [options]
 */
export async function installMocks(page, log = {}, options = {}) {
  const nowIso = options.now ?? NOW;
  const realClock = options.fixedClock === false;
  const legacy = options.legacyApi === true;
  const items = structuredClone(
    buildItems(nowIso, { extras: options.extras, bulk: options.bulk }),
  );
  const open = () => items.filter((item) => !item.archivedAt);
  /** The instant the "SQL" computed this response; one per response. */
  const clockNow = () => (realClock ? new Date().toISOString() : nowIso);

  /** Bucket by turn alone, as after Reabrir (lost cleared). */
  const naturalBucket = (item, asOf) => {
    if (item.lastMessage?.direction === 'inbound') return 'respond';
    const quiet = (Date.parse(asOf) - Date.parse(item.turnSince)) / 60_000;
    return quiet >= SILENT_AFTER_MINUTES ? 'silent' : 'awaiting';
  };
  /** D2: a future reminder of the actor moves a silent conversation to awaiting. */
  const effectiveBucket = (item, asOf) => {
    if (!item.bucket) return item.bucket ?? null;
    if (
      item.bucket === 'silent' &&
      item.reminder?.userId === ME.id &&
      Date.parse(item.reminder.remindAt) > Date.parse(asOf)
    )
      return 'awaiting';
    return item.bucket;
  };
  /** Contract view of an item (list and detail share it). */
  const present = (item, asOf) => {
    const { reminder, ...rest } = item;
    delete rest.outcomeVersion;
    const view = {
      ...rest,
      bucket: effectiveBucket(item, asOf),
      turnAsOf: asOf,
      reminder: reminder
        ? { remindAt: reminder.remindAt, mine: reminder.userId === ME.id }
        : null,
    };
    if (realClock && item.bucket)
      view.turnBusinessMinutes = businessMinutesBetween(item.turnSince, asOf);
    if (legacy) {
      delete view.bucket;
      delete view.turnAsOf;
    }
    return view;
  };
  /** Version of the latest outcome event (the API's lead_outcome_events). */
  const latestOutcomeVersion = (item) =>
    item.outcomeVersion ?? item.lostOutcome?.version ?? 0;
  const isOwnerOrAdmin = (item) =>
    options.admin === true || item.assignedUser?.id === ME.id;
  const problem = (json, status, code) =>
    json({ type: 'about:blank', title: code, status, code }, status);
  // Vue ignores a DOM event whose time equals its listener's attach time;
  // a frozen clock makes every keyboard event look stale, so keyboard checks
  // run on the real clock.
  if (!realClock) await page.clock.setFixedTime(new Date(nowIso));
  // A route cannot keep an event stream open; a connected EventSource that
  // never sends keeps the live notice out of both BEFORE and AFTER.
  await page.addInitScript(() => {
    class ConnectedSource extends globalThis.EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new globalThis.Event('open'));
        }, 20);
      }
      close() {
        this.readyState = 2;
      }
    }
    globalThis.EventSource = ConnectedSource;
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const params = url.searchParams;
    const method = request.method();
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        json: body,
        headers: { 'cache-control': 'private, no-store' },
      });
    if (path === '/api/v1/sessions/current')
      return json({
        user: {
          ...ME,
          functionName: 'Vendedor',
          capabilities: options.admin ? ['COMMERCIAL_ADMIN'] : [],
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n: connected\n\n',
      });
    if (path === '/api/v1/users/assignable')
      return json({ users: [ME, OTHER] });
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });

    // Items grouped by the bucket this actor sees (D2), at this instant.
    const asOf = clockNow();
    const inBucket = (bucket) =>
      open().filter((item) => effectiveBucket(item, asOf) === bucket);

    if (path === '/api/v1/inbox/buckets') {
      if (legacy) return json({ code: 'NOT_FOUND' }, 404);
      if (options.failBuckets) return problem(json, 503, 'SERVICE_UNAVAILABLE');
      const counts = Object.fromEntries(
        BUCKET_ORDER.map((bucket) => [
          bucket,
          inBucket(bucket).filter((item) => matchesScope(item, params)).length,
        ]),
      );
      return json(counts);
    }

    if (path === '/api/v1/inbox/conversations') {
      // The API refuses these combinations (operation-runtime.js).
      if (
        (params.get('orderReady') === 'true' && !params.has('bucket')) ||
        (params.has('assignedUserId') &&
          (params.get('owner') ?? 'all') !== 'all')
      )
        return problem(json, 400, 'INVALID_FILTER');
      let matches;
      if (params.get('archived') === 'true')
        matches = items.filter((item) => item.archivedAt);
      else if (params.get('terminal') === 'true') matches = [];
      else if (params.has('bucket') && !legacy) {
        const bucket = params.get('bucket');
        matches = sortBucket(inBucket(bucket), bucket);
      } else {
        // master: Todas in urgency order, or the Atender/Fechar queues. The
        // legacy API lands here for every query and ignores `bucket` (P1-D).
        matches = BUCKET_ORDER.flatMap((bucket) =>
          sortBucket(inBucket(bucket), bucket),
        );
        const queue = params.get('workQueue');
        const mineOrUnassigned = (item) =>
          !item.assignedUser || item.assignedUser.id === ME.id;
        if (queue === 'attention')
          matches = matches.filter(
            (item) =>
              mineOrUnassigned(item) &&
              (item.waitingSince || item.handoff?.status === 'pending'),
          );
        if (queue === 'closing')
          matches = matches.filter(
            (item) =>
              mineOrUnassigned(item) &&
              item.reviewOrder?.readyForConfirmation === true,
          );
      }
      matches = matches.filter((item) => matchesScope(item, params));
      const limit = Number(params.get('limit') ?? 100);
      const cursor = params.get('cursor');
      const offset = cursor?.startsWith('o:')
        ? Number(cursor.slice(2)) || 0
        : 0;
      const end = offset + limit;
      return json({
        items: matches.slice(offset, end).map((item) => present(item, asOf)),
        totalCount: matches.length,
        nextCursor: end < matches.length ? `o:${end}` : null,
      });
    }

    const conversationPath =
      /^\/api\/v1\/(?:inbox\/)?conversations\/([^/]+)(?:\/(.+))?$/u.exec(path);
    const item = conversationPath
      ? items.find((candidate) => candidate.id === conversationPath[1])
      : null;
    const tail = conversationPath?.[2] ?? '';

    if (method !== 'GET') {
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        // no JSON body (e.g. DELETE)
      }
      log.writes?.push({ method, path, body });
      const forced = options.commandErrors?.[tail];
      if (item && forced) return problem(json, forced.status, forced.code);
      if (item && tail === 'messages') {
        // A human reply: the team spoke last, so the turn is the customer's.
        item.version += 1;
        item.bucket = 'awaiting';
        item.turnSince = asOf;
        item.waitingSince = null;
        item.lastMessage = {
          id: `sent-${item.id}`,
          type: 'text',
          direction: 'outbound',
          authorKind: 'human',
          status: 'sent',
          deliveryStatus: 'sent',
          preview: body?.content?.text ?? '',
          text: body?.content?.text ?? '',
          occurredAt: asOf,
        };
        item.deliveryIssue = null;
        return json({ accepted: true });
      }
      if (item && tail === 'lead-outcome') {
        // Mirrors lead-outcome-runtime.js: owner or admin (403), then the
        // conversation version, eligibility, the outcome version, the rules.
        if (!isOwnerOrAdmin(item)) return problem(json, 403, 'FORBIDDEN');
        if (body?.expectedConversationVersion !== item.version)
          return problem(json, 409, 'VERSION_CONFLICT');
        if (!item.assignedUser || item.automationState !== 'human')
          return problem(json, 409, 'LEAD_NOT_ELIGIBLE');
        if (body?.expectedOutcomeVersion !== latestOutcomeVersion(item))
          return problem(json, 409, 'VERSION_CONFLICT');
        if (body?.outcome === 'lost') {
          if (item.lostOutcome) return problem(json, 409, 'LEAD_ALREADY_LOST');
          if (item.order?.status === 'pendente')
            return problem(json, 409, 'LEAD_HAS_ORDER');
        } else if (!item.lostOutcome) {
          return problem(json, 409, 'LEAD_NOT_LOST');
        }
        // lead_outcome_events is a table of its own: the conversation's
        // version does not move.
        const outcomeVersion = latestOutcomeVersion(item) + 1;
        item.outcomeVersion = outcomeVersion;
        if (body?.outcome === 'lost') {
          item.bucket = 'lost';
          item.lostOutcome = {
            reasonCode: body.reasonCode,
            occurredAt: asOf,
            version: outcomeVersion,
          };
        } else {
          // `reopened` (Corrigir perda): back to the bucket the turn dictates.
          item.bucket = naturalBucket(item, asOf);
          item.lostOutcome = null;
        }
        return json({
          conversationId: item.id,
          outcome: body?.outcome,
          outcomeVersion,
          reasonCode: body?.reasonCode ?? null,
          hasNote: Boolean(body?.note),
          ownerId: item.assignedUser.id,
          markedBy: ME.id,
          markedAt: asOf,
        });
      }
      if (item && tail === 'reminder') {
        // Mirrors conversation-reminder-runtime.js: version, open universe,
        // then the window (future, up to 90 days). No conversation bump.
        if (body?.expectedVersion !== item.version)
          return problem(json, 409, 'VERSION_CONFLICT');
        if (item.archivedAt || item.terminalAt)
          return problem(json, 409, 'ACTION_NOT_AVAILABLE');
        const at = Date.parse(body?.remindAt ?? '');
        const base = Date.parse(asOf);
        if (!(at > base) || at > base + 90 * 86_400_000)
          return problem(json, 422, 'INVALID_REMINDER_DATE');
        // D2: the reminder belongs to the actor. Only a silent conversation
        // moves (to awaiting, for this actor, until remindAt); the bucket
        // itself stays `silent` underneath and returns when the date passes.
        item.reminder = { remindAt: new Date(at).toISOString(), userId: ME.id };
        return json({
          conversationId: item.id,
          remindAt: item.reminder.remindAt,
          decisionVersion: 1,
        });
      }
      return json({ code: 'NOT_MOCKED' }, 405);
    }

    if (item && path.startsWith('/api/v1/inbox/conversations/')) {
      if (tail === 'subjects')
        return json({
          currentSubjectId: null,
          needsSubjectMessageIds: [],
          links: [],
          orders: [],
          ordersHasMore: false,
          subjects: [],
        });
      if (tail === 'handoff')
        return json({
          handoff: item.handoff
            ? {
                ...item.handoff,
                summary:
                  'Motivo: cliente pediu prazo curto. Atenção: confirmar a data da formatura.',
              }
            : null,
        });
      if (!tail)
        return json({
          conversation: present(item, asOf),
          messages: threadOf(item),
          suggestion: null,
        });
    }
    if (item && tail === 'order')
      return json({
        order: item.reviewOrder
          ? {
              ...item.reviewOrder,
              missingFields: [],
              totalPieces: 30,
              finalAmountCents: 189000,
              ficha: { items: [], summary: {} },
            }
          : null,
      });
    if (item && tail === 'lead-outcome') {
      if (!isOwnerOrAdmin(item)) return problem(json, 403, 'FORBIDDEN');
      const outcomeVersion = latestOutcomeVersion(item);
      return json({
        state: item.lostOutcome
          ? 'lost'
          : outcomeVersion
            ? 'reopened_manual'
            : 'open',
        outcomeVersion,
        reasonCode: item.lostOutcome?.reasonCode ?? null,
        ownerId: item.assignedUser?.id ?? null,
        markedBy: null,
        markedAt: item.lostOutcome?.occurredAt ?? null,
        reopenedAt: null,
      });
    }
    const order = /^\/api\/v1\/orders\/([^/]+)$/u.exec(path);
    if (order) {
      const found = items.find(
        (candidate) => candidate.reviewOrder?.id === order[1],
      );
      return json({
        order: found
          ? {
              ...found.reviewOrder,
              missingFields: [],
              totalPieces: 30,
              finalAmountCents: 189000,
              ficha: { items: [], summary: {} },
            }
          : null,
      });
    }
    log.unmocked?.push(`${method} ${path}`);
    return json({ code: 'NOT_FOUND' }, 404);
  });
}
