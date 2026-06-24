# Power Automate flow — WinTeam Employee List (113) → Supabase

This is the inbound flow that feeds the daily WinTeam **Employee List** report
(scheduled-export file id `113`) into FIT, where it refreshes the `employee`
roster. It is the sibling of the existing **"Epay Email to Supabase Webhook"**
flow and is built the same way; the only differences are the trigger filter and
the target Edge Function.

```
Email (Fit@prestigeusa.net, 113_* attachment)
  → Power Automate "Employee List 113 to Supabase Webhook"
  → POST employee-list-import-email   (x-fit-shared-secret)
  → refreshes public.employee
```

> **Routing rule:** this flow must only POST files whose attachment name starts
> with `113_`. ePay Punches Report emails keep going to `epay-import-email`.
> Routing by the file-name prefix is what keeps the two pipelines separate.

---

## Endpoint

```
POST https://sshhcpzleurztzksrlvr.supabase.co/functions/v1/employee-list-import-email
```

Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `x-fit-shared-secret` | the value of the `EMAIL_INGEST_SHARED_SECRET` Edge Function secret (the **same** secret the ePay flow already sends) |

Body (JSON):

```json
{
  "from": "kneff@sparkstrategiesgroup.com",
  "subject": "Employee List 2026-06-22",
  "received_at": "2026-06-22T22:00:00Z",
  "attachments": [
    {
      "name": "113_20260622_1736.csv",
      "content_type": "text/csv",
      "content_base64": "<attachment contentBytes>"
    }
  ]
}
```

The function accepts the first `.csv` **or** `.xlsx` attachment. Power Automate's
attachment `contentBytes` is already base64, so it can be passed straight into
`content_base64`.

---

## Build steps (Power Automate cloud flow)

1. **Trigger — "When a new email arrives (V3)"**
   - Mailbox: `Fit@prestigeusa.net` (add the shared mailbox under *Advanced
     options → Original Mailbox Address* if the connection is a delegated user).
   - *Include Attachments*: **Yes**
   - *Only with Attachments*: **Yes**
   - (Optional) *From*: `kneff@sparkstrategiesgroup.com` — the daily forwarder.
     Leave broader if other senders may forward the 113 file; the function's
     sender allowlist is the real gate.

2. **(Recommended) Condition — is this the 113 report?**
   Apply to each attachment, and guard the POST so only `113_*` files are sent:
   ```
   startsWith(toLower(items('Apply_to_each')?['Name']), '113_')
   ```
   Put the HTTP action inside the **If yes** branch. This prevents an ePay file
   that lands in the same mailbox from being POSTed to the employee endpoint.

3. **Action — "HTTP"** (inside the loop / If-yes branch)
   - **Method**: `POST`
   - **URI**: the endpoint above
   - **Headers**:
     - `Content-Type` → `application/json`
     - `x-fit-shared-secret` → `EMAIL_INGEST_SHARED_SECRET` value (store it in a
       Power Automate **secure input** / environment variable, not inline)
   - **Body**:
     ```
     {
       "from": "@{triggerOutputs()?['body/from']}",
       "subject": "@{triggerOutputs()?['body/subject']}",
       "received_at": "@{triggerOutputs()?['body/receivedDateTime']}",
       "attachments": [
         {
           "name": "@{items('Apply_to_each')?['Name']}",
           "content_type": "@{items('Apply_to_each')?['ContentType']}",
           "content_base64": "@{items('Apply_to_each')?['ContentBytes']}"
         }
       ]
     }
     ```
   - Mark the body / secret header as **secure input** so the base64 payload and
     secret aren't logged in run history.

4. **(Optional) Inspect the response** — the function returns JSON:
   ```json
   {
     "employee_list_import_id": 12,
     "rows": 760, "matched": 758, "updated": 41, "unmatched": 2,
     "errors": [ ... ]
   }
   ```
   - `unmatched > 0` means EmployeeIDs with no `employee` row (likely new hires);
     they are **not** created (region/department are required and absent from the
     113 report) and are listed in `errors` for manual onboarding.
   - HTTP `200 {"skipped":"duplicate"}` means Power Automate re-delivered the same
     file (matched by SHA-256) — safe to ignore.

---

## Status codes

| Code | Meaning | Action |
| --- | --- | --- |
| `200` | Imported (or duplicate skipped) | none |
| `401` | Shared secret missing/mismatched | fix the `x-fit-shared-secret` header |
| `403` | Sender not in `email_allowed_senders` | add the sender (see below) |
| `400` | Bad JSON / no `.csv`/`.xlsx` attachment | check the body / attachment filter |

Every email (accepted, rejected, or duplicate) is logged in `public.email_imports`;
every parsed file in `public.employee_list_imports`.

## Allowlist

**For now** the allowed sender is `kneff@sparkstrategiesgroup.com` (the test
forward), seeded by migration `20260624000000_employee_list_ingestion.sql`.
`fit@prestigeusa.net` is intentionally **not** allowlisted yet.

**Transition to production (`fit@prestigeusa.net`)** once testing is done:

```sql
INSERT INTO public.email_allowed_senders (email, notes)
VALUES ('fit@prestigeusa.net', 'WinTeam Employee List (113) — production sender')
ON CONFLICT (email) DO NOTHING;

-- optionally retire the test forwarder once fit@ is verified:
UPDATE public.email_allowed_senders SET active = FALSE
WHERE email = 'kneff@sparkstrategiesgroup.com';
```

To allow any other forwarder, use the same `INSERT ... ON CONFLICT DO NOTHING`.

## Prerequisite

The migration must be applied (`supabase db push`) **before** this flow runs —
the function writes to `employee_list_imports` and `email_imports`. The Edge
Function itself is deployed by the existing GitHub Actions workflow on merge to
`main`.
