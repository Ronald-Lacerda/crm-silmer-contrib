-- ACT-T04 / RFC 048 / ADR 061: expediente-v1 is the single source of business time for
-- the API, the Dashboard and the tests. Monday to Friday, 09:00-12:00 and
-- 13:00-18:00 America/Sao_Paulo, no holidays. A different policy creates a
-- `_v2`; these functions are never rewritten in place.

-- Business-minute index of an instant: business minutes elapsed since the
-- Monday 2000-01-03 00:00 in Sao Paulo wall clock (weeks of 2400 minutes,
-- weekdays of 480). Pure arithmetic in PL/pgSQL, no row generation: it runs
-- once per wait in the metrics and must stay cheap.
CREATE FUNCTION crm.business_minute_index_v1(at timestamptz)
RETURNS numeric
LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE
AS $$
DECLARE
  local_at timestamp := at AT TIME ZONE 'America/Sao_Paulo';
  days numeric := floor(extract(epoch FROM local_at - timestamp '2000-01-03') / 86400);
  weeks numeric := floor(days / 7);
  weekday numeric := days - weeks * 7;
  minute numeric := extract(epoch FROM local_at::time) / 60;
BEGIN
  RETURN weeks * 2400 + least(weekday, 5) * 480
    + CASE WHEN weekday < 5
        THEN least(greatest(minute, 540), 720) - 540
             + least(greatest(minute, 780), 1080) - 780
        ELSE 0 END;
END;
$$;

-- Business minutes inside [from_at, to_at): the intersection of the interval
-- with each block of each weekday. An empty or inverted interval is zero,
-- never negative.
CREATE FUNCTION crm.business_minutes_v1(from_at timestamptz, to_at timestamptz)
RETURNS numeric
LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE
AS $$
BEGIN
  RETURN greatest(crm.business_minute_index_v1(to_at)
                  - crm.business_minute_index_v1(from_at), 0);
END;
$$;

-- The first instant at which `minutes` (> 0) business minutes have elapsed
-- since from_at (the inverse of business_minutes_v1); null otherwise. It
-- dates when an unanswered wait crossed its threshold, so the episode is
-- credited to the owner of that instant.
CREATE FUNCTION crm.business_deadline_v1(from_at timestamptz, minutes numeric)
RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT PARALLEL SAFE
AS $$
DECLARE
  target numeric;
  weeks numeric;
  remainder numeric;
  weekday numeric;
  minute numeric;
BEGIN
  IF minutes <= 0 THEN
    RETURN NULL;
  END IF;
  target := crm.business_minute_index_v1(from_at) + minutes;
  -- The earliest instant reaching the target: a remainder in (0, 2400]
  -- and, inside the weekday, a minute in (0, 480].
  weeks := ceil(target / 2400) - 1;
  remainder := target - weeks * 2400;
  weekday := ceil(remainder / 480) - 1;
  minute := remainder - weekday * 480;
  RETURN (timestamp '2000-01-03' + (weeks * 7 + weekday) * interval '1 day'
          + CASE WHEN minute <= 180
              THEN interval '9 hours' + minute * interval '1 minute'
              ELSE interval '13 hours' + (minute - 180) * interval '1 minute' END)
         AT TIME ZONE 'America/Sao_Paulo';
END;
$$;

-- Human replies of a conversation by reply clock (sent time, else queue
-- time): last reply before an instant and replies inside the lookback.
CREATE INDEX messages_human_reply_clock_idx
  ON crm.messages (conversation_id, (coalesce(sent_at, occurred_at)))
  WHERE direction = 'outbound' AND author_kind = 'human' AND status = 'sent';

-- Handoff cohort of the period (time to claim and first response).
CREATE INDEX handoffs_seller_created_idx
  ON crm.handoffs (created_at)
  WHERE target_role = 'Vendedor';

-- Ownership history of a conversation includes its resolved handoffs; the
-- existing index covers only the active (pending/accepted) one.
CREATE INDEX handoffs_conversation_created_idx
  ON crm.handoffs (conversation_id, created_at);
