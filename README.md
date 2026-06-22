# Prestige FIT Platform

**FIT (Frontline Investment Tool)** — Prestige Maintenance USA's labor operations command center. Production: https://fitfrontline.net

A labor-cost intelligence layer that sits on top of ePay and WinTeam: ingests labor reports, reconciles them against schedules and contracts, and drives outbound exception notifications.

## Architecture

Four tiers:

- **Frontend** — Vite + React 18 + TypeScript SPA in `/web` (Tailwind, Radix UI, Chart.js, `@supabase/supabase-js`). Deployed on Vercel (team `sparkstrategies`, project `prestige-fit-platform`) and served at fitfrontline.net.
- **Backend** — Supabase (project `sshhcpzleurztzksrlvr`, PostgreSQL 17): system of record, Supabase Auth, Edge Functions (Deno/TypeScript).
- **Integration / orchestration** — Microsoft Power Automate flows route inbound ePay emails to the Edge Functions; the same flows generate the outbound summary email.
- **Outbound** — Employee/manager SMS via Text Request, summary emails via Power Automate, and a WinTeam budget export file.

## Repository layout

```
prestige-fit-platform/
├── web/                              Vite + React frontend (Vercel-deployed)
│   ├── src/
│   │   ├── pages/                    Labor Control, Forms, Reports
│   │   ├── components/               TabNav, DateClockBar, EpayReportChecklist, ...
│   │   └── lib/supabase.ts
│   └── vite.config.ts
├── supabase/
│   ├── config.toml                   Per-function verify_jwt posture
│   ├── functions/                    Edge Functions (Deno)
│   │   ├── epay-import-email/        Power Automate webhook (ePay emails)
│   │   ├── epay-import/              Parses ePay XLSX → labor_control_tracking
│   │   ├── awr-import/               Loads AWR XLSX (legacy/unclassified — see spec §4.4)
│   │   ├── master-schedule-import/   Parses schedule XLSX into a pending revision
│   │   ├── master-schedule-apply/    Applies an approved schedule revision
│   │   ├── blueforce-tracker-import/ Imports Blueforce tracker (exceptions)
│   │   ├── shift-block-runner/       Scheduled; evaluates shift blocks → SMS
│   │   ├── notify-summary-email/     Outbound summary/digest
│   │   ├── wt-budget-export/         WinTeam budget CSV
│   │   └── _shared/                  Shared parsers (parse-punches-report, parse-awr, ...)
│   └── migrations/                   28 SQL migrations
├── vercel.json
└── README.md
```

## Data model (overview)

Live schema is ~40 tables across these domains. Field-level detail lives in the DB; see the technical spec §4 for the canonical inventory.

- **Identity & reference:** `employee` (~760), `site` (~310), `regions`, `departments`, `labor_type`
- **Ingestion & provenance:** `epay_imports`, `email_imports`, `email_allowed_senders`, `epay_expected_report`, `master_schedule_revision`/`master_schedule_change`, `awr_import`/`awr_data`
- **Labor cost tracking (core):** `labor_control_tracking` (~7,950), `hours_log`
- **Scheduling:** `schedule_slot`, `shift_blocks`, `job_site_schedules`
- **Overtime:** `excess_hours_alerts` (built but unpopulated)
- **Notifications & exceptions:** `notifications` (~1,500), `message_templates` (EN/ES), `punch_exceptions`, `store_exception`, `short_staff_exception`, `shift_form_recipient`
- **WinTeam mirror:** `winteam_*` reference tables (largely seeded from manual baseline exports; not a live API integration)
- **Compliance:** `audit_log` (~2,100)
- **Contract/billing:** `contract_bill_rate`

> **Source-of-truth caveat:** the live Supabase project is the authority. The repo's migrations cover most but not all of the live schema — the `winteam_*` reference tables were seeded via direct schema edits. Reconciliation work is tracked in the technical spec §9.3.

## Integrations

| Integration | Direction | Mechanism |
|---|---|---|
| ePay labor (Punches) report | Inbound | Email → Power Automate "Epay Email to Supabase Webhook" → `epay-import-email` → `epay-import` |
| Master schedule | Inbound | `master-schedule-import` (file) → operator approves → `master-schedule-apply` |
| WinTeam — Schedule report | Inbound (manual) | Periodic manual export from WinTeam |
| WinTeam — Employee master list | Inbound (manual) | Periodic manual export from WinTeam |
| WinTeam budget | Outbound | `wt-budget-export` (file) |
| Text Request SMS | Outbound | `shift-block-runner` → Text Request API |
| Summary email | Outbound | Power Automate "Notify Summary Email" + `notify-summary-email` |
| Blueforce Tracker | Inbound | `blueforce-tracker-import` → exceptions process |
| Shift form / Exceptions form | Inbound (users) | Web app → Supabase |

See the technical spec §6 for full integration contracts.

### WinTeam scheduled exports — file naming

WinTeam scheduled reports export to CSV named `%ID%_%yyyyMMdd%_%HHmm%`
(report identifier, then date, then 24-hour time). The leading identifier tells
inbound automation which report a file is, so files can be routed by that prefix.

| Report | Identifier (`%ID%`) | Example file | Schedule |
|---|---|---|---|
| Employee List | `113` | `113_20260622_1736.csv` | **Daily, 6:00pm CST** |
| Schedule Report (Master Schedule List) | `SCHEDULE REPORT91` | `SCHEDULE REPORT91_20260615_0600.csv` | Manual / periodic |

**Employee List (`113`)** columns: `EmployeeID, FirstName, LastName, Phone1, Phone2, PrimaryJob, PrimaryJobSite, EEStatus` — maps to the `employee` table (`PrimaryJob` = primary job/site code, `PrimaryJobSite` = site name, `EEStatus` = Active/…). Contains employee PII (names, phone numbers); don't commit sample files.

## Setup

### Frontend (web)

```bash
cd web
cp .env.example .env.local   # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev                  # local dev server
npm run build                # production build (run by Vercel)
```

### Backend (Supabase)

```bash
npm install -g supabase
supabase login
supabase link --project-ref sshhcpzleurztzksrlvr
supabase db push             # apply migrations
supabase functions deploy    # deploy Edge Functions; reads supabase/config.toml
```

`supabase/config.toml` declares per-function `verify_jwt` posture. The two Power Automate webhooks (`epay-import-email`, `notify-summary-email`) authenticate with the `x-fit-shared-secret` header instead of a Supabase JWT and have `verify_jwt = false`. All other functions verify a Supabase Auth JWT from the calling user.

## Deployment

- **Frontend** — automatic on push to `main` via Vercel's GitHub integration. Production domain: fitfrontline.net (apex; `www` 308-redirects in). DNS at GoDaddy.
- **Backend** — `supabase db push` for migrations, `supabase functions deploy` for Edge Functions. Both target project `sshhcpzleurztzksrlvr`.

## Operational notes

- ePay intake mailbox: currently a personal inbox; cutover to a dedicated Microsoft mailbox is pending credentials.
- Text Request send path: stable credentials still pending. Most notification history (~1,450) was generated in stub mode (`TEXT_REQUEST_STUB=true`).
- Inbound SMS response handling (employee corrections/surveys) is not yet designed.

For the full open-items list and risk register, see the technical spec §9.
