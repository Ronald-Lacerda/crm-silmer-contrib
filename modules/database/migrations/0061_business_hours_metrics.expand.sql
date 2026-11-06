-- ACT-T04 / RFC 048 / ADR 061: expediente-v1 is the single source of business time for
-- the API, the Dashboard and the tests. Monday to Friday, 09:00-12:00 and
-- 13:00-18:00 America/Sao_Paulo, no holidays. A different policy creates a
-- `_v2`; these functions are never rewritten in place.

-- Business minutes inside [from_at, to_at): the sum, per local day, of the
-- intersection of the interval with each block. An empty or inverted interval
-- is zero, never negative.
CREATE FUNCTION crm.business_minutes_v1(from_at timestamptz, to_at timestamptz)
RETURNS numeric
LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(sum(greatest(extract(epoch FROM
           least(b.lt, d + blk.ends) - greatest(b.lf, d + blk.starts)), 0)) / 60, 0)
  FROM (SELECT from_at AT TIME ZONE 'America/Sao_Paulo' AS lf,
               to_at AT TIME ZONE 'America/Sao_Paulo' AS lt) b
  CROSS JOIN LATERAL generate_series(date_trunc('day', b.lf),
                                     date_trunc('day', b.lt),
                                     interval '1 day') d
  CROSS JOIN (VALUES (time '09:00', time '12:00'),
                     (time '13:00', time '18:00')) blk(starts, ends)
  WHERE b.lt > b.lf AND extract(isodow FROM d) < 6
$$;

-- The instant at which `minutes` business minutes have elapsed since from_at
-- (the inverse of business_minutes_v1). It dates when an unanswered wait
-- crossed its threshold, so the episode is credited to the owner of that
-- instant. The horizon covers any weekend for the minutes requested.
CREATE FUNCTION crm.business_deadline_v1(from_at timestamptz, minutes numeric)
RETURNS timestamptz
LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS $$
  SELECT (slot.starts_at + (minutes - (slot.total - slot.length)) * interval '1 minute')
           AT TIME ZONE 'America/Sao_Paulo'
  FROM (
    SELECT open.starts_at, open.length,
           sum(open.length) OVER (ORDER BY open.starts_at) AS total
    FROM (
      SELECT greatest(b.lf, d + blk.starts) AS starts_at,
             extract(epoch FROM (d + blk.ends) - greatest(b.lf, d + blk.starts)) / 60 AS length
      FROM (SELECT from_at AT TIME ZONE 'America/Sao_Paulo' AS lf) b
      CROSS JOIN LATERAL generate_series(
        date_trunc('day', b.lf),
        date_trunc('day', b.lf) + (ceil(greatest(minutes, 0) / 480) * 2 + 7) * interval '1 day',
        interval '1 day') d
      CROSS JOIN (VALUES (time '09:00', time '12:00'),
                         (time '13:00', time '18:00')) blk(starts, ends)
      WHERE extract(isodow FROM d) < 6 AND d + blk.ends > b.lf
    ) open
  ) slot
  WHERE minutes >= 0 AND slot.total >= minutes
  ORDER BY slot.starts_at
  LIMIT 1
$$;

-- Effective human sends by author and send clock (attendance and response).
CREATE INDEX messages_effective_human_sent_idx
  ON crm.messages (author_id, sent_at)
  WHERE direction = 'outbound' AND author_kind = 'human' AND status = 'sent';

-- Handoff cohort of the period (time to claim and first response).
CREATE INDEX handoffs_seller_created_idx
  ON crm.handoffs (created_at)
  WHERE target_role = 'Vendedor';

-- Ownership history of a conversation includes its resolved handoffs; the
-- existing index covers only the active (pending/accepted) one.
CREATE INDEX handoffs_conversation_created_idx
  ON crm.handoffs (conversation_id, created_at);
