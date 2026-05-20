# Plan: End-of-Shift Employee Texting Automation

**Source procedure:** `PROCEDURE: Labor Controls — Employee End of Shift Texting` (rev. 4.10.26)
**Owner of manual process:** Claudia Gomez, Labor Control
**Clients in scope:** Kohl's, Target, The Home Depot
**Goal:** Replace the Epay → Excel → Text Request manual workflow with a scheduled job inside the FIT platform.

---

## 1. What the manual process does today

For each shift end time block (8:00 AM through 4:30 PM CT, see PDF p.2), the Labor Control lead:

1. Pulls an Epay "Punches Report" for the date range.
2. Pastes punches into the **Labor Control Tracking** workbook, on the tab matching the shift end time.
3. Filters out non-applicable rows by repeatedly sorting and cutting:
   - Sub/SUB punches
   - Lunch rate-type rows
   - Rows that already have a `Time Out`
   - Rows flagged in the `EXCEPTION` column
   - Rows whose `Out per Schedule` ≠ the current shift block
   - Manager/supervisor punches (visual scan)
4. Copies the remaining `First Name | Last Name | Phone` into a Text Log tab.
5. In **Text Request**, creates a Group Message and sends:
   - **T-20 min:** "End of Shift Warning" (English + Spanish, two sends)
   - **T+5 min:** "End of Shift CLOCKED OUT" (English + Spanish, scheduled)
6. Emails a summary to `mmartin@prestigeusa.net`.

Two notifications per shift × two languages × ~13 shift blocks × 3 clients = a heavily repetitive workflow that maps cleanly onto our existing schema.

## 2. How it maps to the existing schema

The current schema already has the pieces — we mostly need new rows/types, not new tables:

| Manual artifact | Existing table / column |
|---|---|
| Epay punches export | `punches` (already modeled IN/OUT, paired) |
| Open punch (no OUT) | `punches` with `paired_punch_id IS NULL` — index `idx_punches_unpaired` exists |
| Excel "EXCEPTION" rows | `punch_exceptions` (extend exception types) |
| Text Request sends | `notifications` (channel=SMS) — needs two new `notification_type`s |
| English + Spanish copies | `notifications.language` already supports `en`/`es` |
| Email to Mary Martin | `notifications` with `channel='EMAIL'`, `recipient_type='MANAGER'` |
| Shift end time blocks | **new** `shift_blocks` table |

## 3. Proposed changes

### 3.1 Schema migration `20260520000000_end_of_shift_texting.sql`

```sql
-- Shift end time blocks (the 13 rows from p.2 of the PDF)
CREATE TABLE public.shift_blocks (
    id              SERIAL PRIMARY KEY,
    label           VARCHAR(50)  NOT NULL UNIQUE,        -- e.g. "10:30am End"
    end_time_local  TIME         NOT NULL,               -- 10:30:00
    end_timezone    VARCHAR(20)  NOT NULL DEFAULT 'America/Chicago',
    clients         TEXT[]       NOT NULL,               -- ['TARGET','HOME_DEPOT']
    warning_offset  INTERVAL     NOT NULL DEFAULT '20 minutes',  -- T-minus warning
    clocked_offset  INTERVAL     NOT NULL DEFAULT '5 minutes',   -- T-plus clocked-out
    active          BOOLEAN      NOT NULL DEFAULT TRUE
);

-- Extend notification_type to cover the two new shift messages
ALTER TABLE public.notifications
    DROP CONSTRAINT notifications_notification_type_check;
ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_notification_type_check
    CHECK (notification_type IN (
        'MISSING_PUNCH', 'EXCESS_HOURS', 'STOP_WORK_ORDER', 'PUNCH_CORRECTION',
        'END_OF_SHIFT_WARNING', 'END_OF_SHIFT_CLOCKED_OUT'
    ));

-- Link a notification to the shift block it was generated for
ALTER TABLE public.notifications
    ADD COLUMN shift_block_id INTEGER REFERENCES public.shift_blocks(id),
    ADD COLUMN scheduled_for  TIMESTAMPTZ;        -- distinct from sent_at for delayed sends
CREATE INDEX idx_notifications_shift_block ON public.notifications(shift_block_id);

-- Standard message templates (en + es), versioned, so Labor Control can edit
CREATE TABLE public.message_templates (
    id                SERIAL PRIMARY KEY,
    notification_type VARCHAR(30)  NOT NULL,
    language          VARCHAR(5)   NOT NULL CHECK (language IN ('en','es')),
    body              TEXT         NOT NULL,            -- ≤160 chars, validated app-side
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (notification_type, language, active) DEFERRABLE INITIALLY DEFERRED
);

-- Seed the 13 shift blocks from the PDF
INSERT INTO public.shift_blocks (label, end_time_local, clients) VALUES
    ('8:00am End',  '08:00', ARRAY['TARGET']),
    ('8:30am End',  '08:30', ARRAY['TARGET']),
    ('9:00am End',  '09:00', ARRAY['TARGET']),
    ('9:30am End',  '09:30', ARRAY['TARGET']),
    ('10:00am End', '10:00', ARRAY['TARGET','HOME_DEPOT']),
    ('10:30am End', '10:30', ARRAY['TARGET','HOME_DEPOT']),
    ('11:00am End', '11:00', ARRAY['TARGET','HOME_DEPOT']),
    ('11:30am End', '11:30', ARRAY['TARGET','HOME_DEPOT']),
    ('12:00pm End', '12:00', ARRAY['TARGET','HOME_DEPOT','KOHLS']),
    ('1:30pm End',  '13:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('2:00pm End',  '14:00', ARRAY['TARGET','KOHLS']),   -- multi-TZ for Kohl's, see §5
    ('2:30pm End',  '14:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('3:30pm End',  '15:30', ARRAY['HOME_DEPOT','KOHLS']),
    ('4:30pm End',  '16:30', ARRAY['KOHLS']);
```

### 3.2 Edge functions (Deno / Supabase)

| Function | Trigger | Responsibility |
|---|---|---|
| `epay-import` (already planned) | pg_cron or manual | Upsert raw punches into `punches`. Prerequisite — do not duplicate work here. |
| `shift-block-runner` | `pg_cron` every minute | For each `shift_blocks` row, if `now() == end_time - warning_offset` (in tz) **or** `now() == end_time + clocked_offset`, enqueue notifications. |
| `notification-sender` | DB trigger on `notifications` insert with `scheduled_for <= now()`, or pg_cron sweep | Send via Twilio (replacing Text Request). Update `delivery_status`, `twilio_sid`. |
| `daily-summary-email` | `pg_cron` at 17:00 CT | Email Mary Martin (`mmartin@prestigeusa.net`) the day's send counts per shift block. |

The `shift-block-runner` reproduces the Excel filtering chain as a SQL query (this is the core replacement for steps 2–9 of the PDF's "OPEN APPROPRIATE LABOR CONTROL FILE" section):

```sql
-- Eligible employees for a given shift_block at run time:
SELECT DISTINCT e.id, e.first_name, e.last_name, e.cell_phone
FROM   punches p
JOIN   employees e ON e.id = p.employee_id
JOIN   job_sites j ON j.id = p.job_site_id
WHERE  p.punch_date = CURRENT_DATE
  AND  p.punch_type = 'IN'
  AND  p.paired_punch_id IS NULL                       -- open punch
  AND  p.rate_type IS DISTINCT FROM 'LUNCH'            -- filter step 3
  AND  p.task NOT IN ('SUB','SUBSTITUTE')              -- filter step 2
  AND  e.status = 'active'
  AND  e.phone_valid = TRUE                            -- can actually text them
  AND  NOT EXISTS (                                     -- filter step 5: no open exception
       SELECT 1 FROM punch_exceptions pe
       WHERE pe.punch_id = p.id AND pe.resolution_status = 'open'
  )
  AND  e.rate_type NOT IN ('MANAGER','SUPERVISOR')     -- filter step 7
  AND  <shift_block.clients> @> ARRAY[client_of(j.site_number)];
```

The "Out per Schedule" filter (step 6) requires the scheduled-out time per employee/day. The current schema does **not** store scheduled shifts — see Open Question 1 below.

### 3.3 Templates seed

Two `END_OF_SHIFT_WARNING` rows (en, es) and two `END_OF_SHIFT_CLOCKED_OUT` rows (en, es). Exact copy to be sourced from the existing Text Request "End of Shift Warning" / "End of Shift CLOCKED OUT" saved messages — **action item: pull current text from Text Request before migration.**

## 4. Out-of-scope for this PR

- Replacing Text Request entirely with Twilio — depends on phone-number provisioning. For phase 1, keep the existing Twilio Edge Function pattern referenced in the README.
- A UI for editing `shift_blocks` and `message_templates`. Phase 1 is SQL-only; the Lovable.dev front-end can add forms in a follow-up.
- Punch-edit rules from the PDF NOTES (early clock-in adjustment, late-out correction). Those are still done in Epay until we own the system of record.

## 5. Open questions (need answers before coding)

1. **Schedules.** "Out per Schedule" filter (PDF p.3 step 6) requires a per-employee scheduled out time. We have no `schedules` table. Options:
   (a) Add a minimal `employee_schedules(employee_id, work_date, in_time, out_time)` table populated from Epay.
   (b) Derive expected out time from `shift_blocks` assigned to the job_site.
   Recommend (a); confirm with Claudia which source of truth she trusts.
2. **Client mapping.** `job_sites` has no `client` column today; `site_name` carries it as text ("Target # 1234 …"). For the eligibility query above we need a structured `job_sites.client` enum (`TARGET | HOME_DEPOT | KOHLS`). Small additive migration.
3. **Kohl's multi-TZ.** PDF NOTES say Kohl's spans ET/CT/MT/PT. The `2:00pm CT / 1pm MT / 12pm PT / 3pm ET` block implies a single absolute moment. Confirm: do we trigger off the local store TZ (preferred — needs `job_sites.timezone`), or do all Kohl's stores use a fixed wall-clock per block?
4. **Twilio vs Text Request.** The existing README mentions a Twilio Edge Function. Is Text Request being retired entirely, or do we keep it for group messages and only automate the *trigger*? Affects whether `notification-sender` calls Twilio or Text Request's API.
5. **Manager/supervisor flag.** Step 7 is a visual scan. We need either `employees.role` or a flag (`is_manager BOOLEAN`) to make this deterministic.

## 6. Suggested PR sequence

1. **PR A (this plan).** Doc only — gets sign-off on approach and resolves §5 open questions.
2. **PR B.** Migration: `shift_blocks`, `message_templates`, `notifications` extensions, `job_sites.client`, `employees.is_manager`, optional `employee_schedules`.
3. **PR C.** `shift-block-runner` Edge Function + pg_cron schedule + Twilio/Text-Request adapter.
4. **PR D.** `daily-summary-email` Edge Function.
5. **PR E.** Lovable.dev UI for editing templates and shift blocks (separate repo).

## 7. Verification plan

- Unit: SQL eligibility query against a seeded fixture covering each filter step (sub, lunch, paired, exception, wrong shift block, manager).
- Integration: run `shift-block-runner` in a staging Supabase project against a synthetic 8:00am-end shift and assert two `notifications` rows (en + es, type `END_OF_SHIFT_WARNING`) appear with `scheduled_for = 07:40 CT`.
- Parallel-run: for the first two weeks, have the runner write rows but route them to a test Twilio number; Claudia continues the manual process and we diff the eligible-employee lists daily.

---

*Generated by Claude on the `claude/writing-plans-feature-ef94N` branch.*
