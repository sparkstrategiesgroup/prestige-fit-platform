# Prestige FIT Platform

Backend infrastructure for the **Frontline Investment Tool (FIT)** — Prestige Maintenance USA's labor operations command center.

## What's here

```
prestige-fit-platform/
├── supabase/
│   └── migrations/
│       └── 20260501000000_initial_schema.sql   ← Full schema (10 tables, RLS, pg_cron)
├── .gitignore
└── README.md
```

## Tables

| Table | Purpose |
|-------|---------|
| `regions` | Geographic operating zones (1000-series TX, 2000 MO/KS, etc.) |
| `departments` | PAM notification groups with Outlook distribution lists |
| `employees` | Central employee records, linked to Supabase Auth |
| `job_sites` | Customer locations with IVR phone and geofence data |
| `punches` | Individual clock-in/out events (IVR, Epay App, Manual) |
| `hours_log` | Daily aggregated hours by employee/site/task (primary reporting table) |
| `punch_exceptions` | PAM-detected missing/flagged punches |
| `notifications` | Outbound SMS and email (Twilio integration) |
| `excess_hours_alerts` | Weekly OT tracking with FRI/SAT forecasts |
| `audit_log` | Compliance audit trail |

## Setup

See the setup guide document for full instructions. Quick version:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

## Architecture

- **Database**: Supabase (PostgreSQL 15+)
- **Auth**: Supabase Auth with role-based RLS (admin vs. regional manager)
- **SMS**: Twilio Edge Functions (to be deployed)
- **Data Import**: Epay CSV import Edge Function (to be built)
- **Frontend**: Lovable.dev (separate repo)
