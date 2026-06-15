-- =============================================================================
-- Reconcile live `winteam_*` schema into source.
--
-- This migration brings the repo into sync with the live Supabase project
-- `sshhcpzleurztzksrlvr`, where 28 winteam_* tables were created out-of-band
-- (no prior migration in the repo). It is fully idempotent — applying this to
-- the existing live project is a no-op except for the new RLS policies on the
-- 15 lookup tables that previously had RLS disabled.
--
-- Behaviour:
--   * CREATE TABLE IF NOT EXISTS for all 28 winteam_* tables.
--   * CREATE INDEX IF NOT EXISTS for non-constraint indexes.
--   * ENABLE ROW LEVEL SECURITY + add a permissive SELECT policy for
--     `authenticated` on each of the 15 lookup tables. Writes remain
--     service_role only (no INSERT/UPDATE/DELETE policies are created).
--   * Reapply table comments so a fresh `db reset` reproduces them.
--
-- Source: live `public` schema on project sshhcpzleurztzksrlvr, captured
-- 2026-06-15. Pure reconciliation — additive only, no drops or type changes.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.winteam_companies (
  company_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_companies_pkey PRIMARY KEY (company_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_departments (
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_departments_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_types (
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_types_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS public.winteam_classifications (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_classifications_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_classifications_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_benefit_classes (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_benefit_classes_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_benefit_classes_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_eeo_categories (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_eeo_categories_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_eeo_categories_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_job_types (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_job_types_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_job_types_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_market_segments (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_market_segments_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_market_segments_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_regions (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_regions_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_regions_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_pay_codes (
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  is_overtime BOOLEAN NOT NULL DEFAULT false,
  is_paid_leave BOOLEAN NOT NULL DEFAULT false,
  is_unpaid_leave BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_pay_codes_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS public.winteam_termination_codes (
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  is_voluntary BOOLEAN NOT NULL DEFAULT false,
  is_eligible_for_rehire BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_termination_codes_pkey PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS public.winteam_timekeeping_groups (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  overtime_threshold_daily NUMERIC(5,2),
  overtime_threshold_weekly NUMERIC(5,2),
  double_time_threshold_daily NUMERIC(5,2),
  meal_break_minutes INTEGER,
  rest_break_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_timekeeping_groups_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_timekeeping_groups_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_gl_accounts (
  account_number TEXT NOT NULL,
  description TEXT NOT NULL,
  account_type TEXT,
  is_labor_account BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_gl_accounts_pkey PRIMARY KEY (account_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_budget_periods (
  id BIGSERIAL NOT NULL,
  fiscal_year INTEGER NOT NULL,
  period_number INTEGER NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'monthly'::text,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_budget_periods_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_budget_periods_fiscal_year_period_number_period_typ_key UNIQUE (fiscal_year, period_number, period_type)
);

CREATE TABLE IF NOT EXISTS public.winteam_assignment_roles (
  id BIGSERIAL NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_assignment_roles_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_assignment_roles_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.winteam_jobs (
  job_number TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  company_number INTEGER,
  name TEXT NOT NULL,
  job_type TEXT,
  address_1 TEXT,
  address_2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  has_payroll_tax BOOLEAN NOT NULL DEFAULT false,
  same_payroll_tax_addr BOOLEAN NOT NULL DEFAULT true,
  phone_1 TEXT,
  phone_2 TEXT,
  phone_3 TEXT,
  sms_opt_in BOOLEAN,
  primary_contact TEXT,
  supervisor_code TEXT,
  supervisor_label TEXT,
  date_to_start DATE,
  review_date DATE,
  date_discontinued DATE,
  service_expiration_date DATE,
  minimum_wage_override NUMERIC(10,4),
  notes TEXT,
  notes_keys_security TEXT,
  directions TEXT,
  parent_job_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_jobs_pkey PRIMARY KEY (job_number),
  CONSTRAINT winteam_jobs_parent_job_number_fkey FOREIGN KEY (parent_job_number) REFERENCES public.winteam_jobs(job_number),
  CONSTRAINT winteam_jobs_company_number_fkey FOREIGN KEY (company_number) REFERENCES public.winteam_companies(company_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_employees (
  employee_number INTEGER NOT NULL,
  ssn_last4 TEXT,
  ssn_encrypted TEXT,
  salutation TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  mailing_address_1 TEXT,
  mailing_address_2 TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  same_physical_address BOOLEAN NOT NULL DEFAULT true,
  physical_address_1 TEXT,
  physical_address_2 TEXT,
  physical_city TEXT,
  physical_state TEXT,
  physical_zip TEXT,
  phone_1 TEXT,
  phone_1_type TEXT,
  phone_1_sms_status TEXT,
  phone_2 TEXT,
  phone_2_type TEXT,
  phone_2_sms_status TEXT,
  phone_3 TEXT,
  phone_3_type TEXT,
  phone_3_sms_status TEXT,
  email TEXT,
  birth_date DATE,
  gender TEXT,
  ethnicity TEXT,
  company_number INTEGER,
  employee_title TEXT,
  hire_date DATE,
  employment_type TEXT,
  eeo_category TEXT,
  current_status TEXT,
  current_status_eff_date DATE,
  future_status TEXT,
  eligible_for_rehire BOOLEAN NOT NULL DEFAULT false,
  benefit_class TEXT,
  classification TEXT,
  employee_type_code TEXT,
  employee_type_label TEXT,
  current_pay_rate NUMERIC(10,4),
  check_distribution TEXT,
  pay_frequency TEXT,
  accrual_type TEXT,
  primary_job_site TEXT,
  supervisor_code TEXT,
  supervisor_label TEXT,
  security_level INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employees_pkey PRIMARY KEY (employee_number),
  CONSTRAINT winteam_employees_company_number_fkey FOREIGN KEY (company_number) REFERENCES public.winteam_companies(company_number),
  CONSTRAINT winteam_employees_primary_job_site_fkey FOREIGN KEY (primary_job_site) REFERENCES public.winteam_jobs(job_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_tax_info (
  employee_number INTEGER NOT NULL,
  fed_filing_status TEXT,
  fed_multiple_jobs BOOLEAN NOT NULL DEFAULT false,
  fed_dependents_amount NUMERIC(10,2) DEFAULT 0,
  fed_other_income NUMERIC(10,2) DEFAULT 0,
  fed_deductions NUMERIC(10,2) DEFAULT 0,
  fed_additional_wh NUMERIC(10,2) DEFAULT 0,
  fed_exempt BOOLEAN NOT NULL DEFAULT false,
  fed_w4_year INTEGER,
  fed_legacy_allowances INTEGER,
  fed_legacy_filing_status TEXT,
  state_code TEXT,
  state_filing_status TEXT,
  state_allowances INTEGER,
  state_additional_wh NUMERIC(10,2) DEFAULT 0,
  state_exempt BOOLEAN NOT NULL DEFAULT false,
  state2_code TEXT,
  state2_filing_status TEXT,
  state2_allowances INTEGER,
  state2_additional_wh NUMERIC(10,2) DEFAULT 0,
  state2_exempt BOOLEAN NOT NULL DEFAULT false,
  local_tax_jurisdiction TEXT,
  local_tax_code TEXT,
  local_exempt BOOLEAN NOT NULL DEFAULT false,
  sui_state TEXT,
  sui_exempt BOOLEAN NOT NULL DEFAULT false,
  workers_comp_code TEXT,
  workers_comp_state TEXT,
  fica_exempt BOOLEAN NOT NULL DEFAULT false,
  medicare_exempt BOOLEAN NOT NULL DEFAULT false,
  new_hire_reported BOOLEAN NOT NULL DEFAULT false,
  new_hire_reported_date DATE,
  new_hire_state TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_tax_info_pkey PRIMARY KEY (employee_number),
  CONSTRAINT winteam_employee_tax_info_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_tax_history (
  id BIGSERIAL NOT NULL,
  employee_number INTEGER NOT NULL,
  effective_date DATE NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by TEXT,
  snapshot JSONB NOT NULL,
  CONSTRAINT winteam_employee_tax_history_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_employee_tax_history_employee_number_effective_date_key UNIQUE (employee_number, effective_date),
  CONSTRAINT winteam_employee_tax_history_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_pay_info (
  employee_number INTEGER NOT NULL,
  pay_type TEXT,
  pay_rate NUMERIC(10,4),
  pay_rate_effective_date DATE,
  salary_type TEXT,
  piece_rate_code TEXT,
  pay_frequency TEXT,
  pay_schedule_code TEXT,
  first_check_date DATE,
  overtime_rule TEXT,
  flsa_status TEXT,
  blended_rate_eligible BOOLEAN NOT NULL DEFAULT false,
  primary_gl_account TEXT,
  secondary_gl_account TEXT,
  cost_center TEXT,
  department_override TEXT,
  check_type TEXT,
  dd_bank_name TEXT,
  dd_account_last4 TEXT,
  dd_routing_last4 TEXT,
  has_garnishments BOOLEAN NOT NULL DEFAULT false,
  vacation_accrual_type TEXT,
  vacation_accrual_rate NUMERIC(8,4),
  sick_accrual_type TEXT,
  sick_accrual_rate NUMERIC(8,4),
  pto_plan_code TEXT,
  tip_credit_eligible BOOLEAN NOT NULL DEFAULT false,
  tip_credit_rate NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_pay_info_pkey PRIMARY KEY (employee_number),
  CONSTRAINT winteam_employee_pay_info_secondary_gl_account_fkey FOREIGN KEY (secondary_gl_account) REFERENCES public.winteam_gl_accounts(account_number),
  CONSTRAINT winteam_employee_pay_info_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE,
  CONSTRAINT winteam_employee_pay_info_primary_gl_account_fkey FOREIGN KEY (primary_gl_account) REFERENCES public.winteam_gl_accounts(account_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_pay_rate_history (
  id BIGSERIAL NOT NULL,
  employee_number INTEGER NOT NULL,
  effective_date DATE NOT NULL,
  end_date DATE,
  pay_type TEXT,
  pay_rate NUMERIC(10,4) NOT NULL,
  change_reason TEXT,
  changed_by TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_pay_rate_history_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_employee_pay_rate_his_employee_number_effective_dat_key UNIQUE (employee_number, effective_date),
  CONSTRAINT winteam_employee_pay_rate_history_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_garnishments (
  id BIGSERIAL NOT NULL,
  employee_number INTEGER NOT NULL,
  garnishment_type TEXT,
  case_number TEXT,
  issuing_state TEXT,
  issuing_agency TEXT,
  amount_type TEXT,
  amount NUMERIC(10,2),
  max_percent_disposable NUMERIC(5,2),
  effective_date DATE,
  end_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_garnishments_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_employee_garnishments_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_status_history (
  id BIGSERIAL NOT NULL,
  employee_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  effective_date DATE NOT NULL,
  end_date DATE,
  termination_code TEXT,
  termination_reason TEXT,
  rehire_eligible BOOLEAN,
  leave_type TEXT,
  expected_return_date DATE,
  actual_return_date DATE,
  suspension_reason TEXT,
  suspension_duration_days INTEGER,
  documentation_on_file BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  processed_by TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_status_history_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_employee_status_histo_employee_number_effective_dat_key UNIQUE (employee_number, effective_date),
  CONSTRAINT winteam_employee_status_history_termination_code_fkey FOREIGN KEY (termination_code) REFERENCES public.winteam_termination_codes(code),
  CONSTRAINT winteam_employee_status_history_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_timekeeping (
  employee_number INTEGER NOT NULL,
  timekeeping_group_id BIGINT,
  timekeeping_group_label TEXT,
  default_hours_per_day NUMERIC(5,2),
  default_hours_per_week NUMERIC(5,2),
  default_shift_start TIME WITHOUT TIME ZONE,
  default_shift_end TIME WITHOUT TIME ZONE,
  schedule_template_code TEXT,
  clock_in_allowed BOOLEAN NOT NULL DEFAULT true,
  clock_in_method TEXT,
  early_clock_in_minutes INTEGER,
  late_clock_out_minutes INTEGER,
  require_job_cost_code BOOLEAN NOT NULL DEFAULT false,
  allow_remote_clock BOOLEAN NOT NULL DEFAULT true,
  ot_daily_threshold NUMERIC(5,2),
  ot_weekly_threshold NUMERIC(5,2),
  ot_exemption_reason TEXT,
  meal_break_required BOOLEAN NOT NULL DEFAULT false,
  meal_break_minutes INTEGER,
  meal_break_auto_deduct BOOLEAN NOT NULL DEFAULT false,
  rest_break_required BOOLEAN NOT NULL DEFAULT false,
  rest_break_minutes INTEGER,
  attendance_policy_code TEXT,
  unexcused_absence_threshold INTEGER,
  time_rounding_rule TEXT,
  rounding_direction TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_timekeeping_pkey PRIMARY KEY (employee_number),
  CONSTRAINT winteam_employee_timekeeping_timekeeping_group_id_fkey FOREIGN KEY (timekeeping_group_id) REFERENCES public.winteam_timekeeping_groups(id),
  CONSTRAINT winteam_employee_timekeeping_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_employee_job_assignments (
  id BIGSERIAL NOT NULL,
  employee_number INTEGER NOT NULL,
  job_number TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  role_id BIGINT,
  role_label TEXT,
  effective_date DATE,
  end_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  scheduled_hours_per_week NUMERIC(5,2),
  cost_center_override TEXT,
  gl_account_override TEXT,
  assignment_notes TEXT,
  assigned_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_employee_job_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_employee_job_assignme_employee_number_job_number_ef_key UNIQUE (employee_number, job_number, effective_date),
  CONSTRAINT winteam_employee_job_assignments_job_number_fkey FOREIGN KEY (job_number) REFERENCES public.winteam_jobs(job_number) ON DELETE CASCADE,
  CONSTRAINT winteam_employee_job_assignments_gl_account_override_fkey FOREIGN KEY (gl_account_override) REFERENCES public.winteam_gl_accounts(account_number),
  CONSTRAINT winteam_employee_job_assignments_employee_number_fkey FOREIGN KEY (employee_number) REFERENCES public.winteam_employees(employee_number) ON DELETE CASCADE,
  CONSTRAINT winteam_employee_job_assignments_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.winteam_assignment_roles(id)
);

CREATE TABLE IF NOT EXISTS public.winteam_job_budgets (
  id BIGSERIAL NOT NULL,
  job_number TEXT NOT NULL,
  budget_period_id BIGINT,
  fiscal_year INTEGER NOT NULL,
  period_number INTEGER NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'monthly'::text,
  period_start_date DATE,
  period_end_date DATE,
  labor_regular_hours NUMERIC(10,2),
  labor_regular_dollars NUMERIC(12,2),
  labor_overtime_hours NUMERIC(10,2),
  labor_overtime_dollars NUMERIC(12,2),
  labor_total_hours NUMERIC(10,2),
  labor_total_dollars NUMERIC(12,2),
  supplies_dollars NUMERIC(12,2),
  equipment_dollars NUMERIC(12,2),
  subcontractor_dollars NUMERIC(12,2),
  other_direct_dollars NUMERIC(12,2),
  total_direct_cost NUMERIC(12,2),
  budgeted_revenue NUMERIC(12,2),
  budgeted_margin NUMERIC(8,4),
  budget_notes TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_job_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_job_budgets_job_number_fiscal_year_period_number_pe_key UNIQUE (job_number, fiscal_year, period_number, period_type),
  CONSTRAINT winteam_job_budgets_budget_period_id_fkey FOREIGN KEY (budget_period_id) REFERENCES public.winteam_budget_periods(id),
  CONSTRAINT winteam_job_budgets_job_number_fkey FOREIGN KEY (job_number) REFERENCES public.winteam_jobs(job_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.winteam_job_gl_budgets (
  id BIGSERIAL NOT NULL,
  job_number TEXT NOT NULL,
  gl_account_number TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  period_number INTEGER NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'monthly'::text,
  budgeted_units NUMERIC(10,2),
  budgeted_rate NUMERIC(10,4),
  budgeted_amount NUMERIC(12,2) NOT NULL,
  actual_units NUMERIC(10,2),
  actual_amount NUMERIC(12,2),
  variance_amount NUMERIC(12,2),
  variance_pct NUMERIC(8,4),
  department_override TEXT,
  cost_center TEXT,
  budget_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_job_gl_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_job_gl_budgets_job_number_gl_account_number_fiscal__key UNIQUE (job_number, gl_account_number, fiscal_year, period_number, period_type),
  CONSTRAINT winteam_job_gl_budgets_job_number_fkey FOREIGN KEY (job_number) REFERENCES public.winteam_jobs(job_number) ON DELETE CASCADE,
  CONSTRAINT winteam_job_gl_budgets_gl_account_number_fkey FOREIGN KEY (gl_account_number) REFERENCES public.winteam_gl_accounts(account_number)
);

CREATE TABLE IF NOT EXISTS public.winteam_job_tier_parameters (
  id BIGSERIAL NOT NULL,
  job_number TEXT NOT NULL,
  effective_date DATE,
  use_dated_tiers BOOLEAN NOT NULL DEFAULT false,
  dept_code TEXT,
  dept_description TEXT,
  job_type TEXT,
  state TEXT,
  market_segment TEXT,
  store TEXT,
  region TEXT,
  not_in_use TEXT,
  sup_viewer TEXT,
  am_viewer TEXT,
  am_viewer_2 TEXT,
  rm_viewer TEXT,
  rm_viewer_2 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT winteam_job_tier_parameters_pkey PRIMARY KEY (id),
  CONSTRAINT winteam_job_tier_parameters_job_number_effective_date_key UNIQUE (job_number, effective_date),
  CONSTRAINT winteam_job_tier_parameters_job_number_fkey FOREIGN KEY (job_number) REFERENCES public.winteam_jobs(job_number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_winteam_garnishments_active ON public.winteam_employee_garnishments USING btree (employee_number, is_active);
CREATE INDEX IF NOT EXISTS idx_winteam_garnishments_emp ON public.winteam_employee_garnishments USING btree (employee_number);
CREATE INDEX IF NOT EXISTS idx_winteam_assignments_active ON public.winteam_employee_job_assignments USING btree (job_number, is_active);
CREATE INDEX IF NOT EXISTS idx_winteam_assignments_emp ON public.winteam_employee_job_assignments USING btree (employee_number);
CREATE INDEX IF NOT EXISTS idx_winteam_assignments_job ON public.winteam_employee_job_assignments USING btree (job_number);
CREATE INDEX IF NOT EXISTS idx_winteam_assignments_primary ON public.winteam_employee_job_assignments USING btree (employee_number, is_primary);
CREATE INDEX IF NOT EXISTS idx_winteam_emp_pay_rate_history_eff ON public.winteam_employee_pay_rate_history USING btree (employee_number, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_winteam_emp_pay_rate_history_emp ON public.winteam_employee_pay_rate_history USING btree (employee_number);
CREATE INDEX IF NOT EXISTS idx_winteam_status_hist_eff ON public.winteam_employee_status_history USING btree (employee_number, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_winteam_status_hist_emp ON public.winteam_employee_status_history USING btree (employee_number);
CREATE INDEX IF NOT EXISTS idx_winteam_status_hist_status ON public.winteam_employee_status_history USING btree (status);
CREATE INDEX IF NOT EXISTS idx_winteam_emp_tax_history_eff ON public.winteam_employee_tax_history USING btree (employee_number, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_winteam_emp_tax_history_emp ON public.winteam_employee_tax_history USING btree (employee_number);
CREATE INDEX IF NOT EXISTS idx_winteam_emp_tax_state ON public.winteam_employee_tax_info USING btree (state_code);
CREATE INDEX IF NOT EXISTS idx_winteam_employees_employee_type ON public.winteam_employees USING btree (employee_type_code);
CREATE INDEX IF NOT EXISTS idx_winteam_employees_hire_date ON public.winteam_employees USING btree (hire_date);
CREATE INDEX IF NOT EXISTS idx_winteam_employees_primary_job ON public.winteam_employees USING btree (primary_job_site);
CREATE INDEX IF NOT EXISTS idx_winteam_employees_status ON public.winteam_employees USING btree (current_status);
CREATE INDEX IF NOT EXISTS idx_winteam_job_budgets_job ON public.winteam_job_budgets USING btree (job_number);
CREATE INDEX IF NOT EXISTS idx_winteam_job_budgets_period ON public.winteam_job_budgets USING btree (fiscal_year, period_number);
CREATE INDEX IF NOT EXISTS idx_winteam_gl_budgets_gl_acct ON public.winteam_job_gl_budgets USING btree (gl_account_number);
CREATE INDEX IF NOT EXISTS idx_winteam_gl_budgets_job ON public.winteam_job_gl_budgets USING btree (job_number);
CREATE INDEX IF NOT EXISTS idx_winteam_gl_budgets_period ON public.winteam_job_gl_budgets USING btree (fiscal_year, period_number);
CREATE INDEX IF NOT EXISTS idx_winteam_tier_params_job ON public.winteam_job_tier_parameters USING btree (job_number);
CREATE INDEX IF NOT EXISTS idx_winteam_jobs_is_active ON public.winteam_jobs USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_winteam_jobs_job_type ON public.winteam_jobs USING btree (job_type);
CREATE INDEX IF NOT EXISTS idx_winteam_jobs_parent ON public.winteam_jobs USING btree (parent_job_number);

-- Row Level Security on the 15 lookup tables that previously had RLS disabled.
ALTER TABLE public.winteam_assignment_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_assignment_roles ON public.winteam_assignment_roles;
CREATE POLICY winteam_lookup_select_assignment_roles ON public.winteam_assignment_roles
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_benefit_classes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_benefit_classes ON public.winteam_benefit_classes;
CREATE POLICY winteam_lookup_select_benefit_classes ON public.winteam_benefit_classes
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_budget_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_budget_periods ON public.winteam_budget_periods;
CREATE POLICY winteam_lookup_select_budget_periods ON public.winteam_budget_periods
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_classifications ON public.winteam_classifications;
CREATE POLICY winteam_lookup_select_classifications ON public.winteam_classifications
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_companies ON public.winteam_companies;
CREATE POLICY winteam_lookup_select_companies ON public.winteam_companies
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_departments ON public.winteam_departments;
CREATE POLICY winteam_lookup_select_departments ON public.winteam_departments
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_eeo_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_eeo_categories ON public.winteam_eeo_categories;
CREATE POLICY winteam_lookup_select_eeo_categories ON public.winteam_eeo_categories
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_employee_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_employee_types ON public.winteam_employee_types;
CREATE POLICY winteam_lookup_select_employee_types ON public.winteam_employee_types
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_gl_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_gl_accounts ON public.winteam_gl_accounts;
CREATE POLICY winteam_lookup_select_gl_accounts ON public.winteam_gl_accounts
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_job_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_job_types ON public.winteam_job_types;
CREATE POLICY winteam_lookup_select_job_types ON public.winteam_job_types
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_market_segments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_market_segments ON public.winteam_market_segments;
CREATE POLICY winteam_lookup_select_market_segments ON public.winteam_market_segments
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_pay_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_pay_codes ON public.winteam_pay_codes;
CREATE POLICY winteam_lookup_select_pay_codes ON public.winteam_pay_codes
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_regions ON public.winteam_regions;
CREATE POLICY winteam_lookup_select_regions ON public.winteam_regions
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_termination_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_termination_codes ON public.winteam_termination_codes;
CREATE POLICY winteam_lookup_select_termination_codes ON public.winteam_termination_codes
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.winteam_timekeeping_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winteam_lookup_select_timekeeping_groups ON public.winteam_timekeeping_groups;
CREATE POLICY winteam_lookup_select_timekeeping_groups ON public.winteam_timekeeping_groups
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.winteam_classifications IS 'WinTeam employee classification (job title category).';
COMMENT ON TABLE public.winteam_companies IS 'WinTeam Company Numbers. Most BSC orgs use Company 1.';
COMMENT ON TABLE public.winteam_departments IS 'WinTeam Department codes (e.g. 4002-Midwest, 4005-Midwest, 1010-Southwest).';
COMMENT ON TABLE public.winteam_employee_types IS 'WinTeam Employee Type codes. Often maps to region/division.';
COMMENT ON TABLE public.winteam_employees IS 'WinTeam PAY: Employee Master File — General tab.';
COMMENT ON TABLE public.winteam_job_tier_parameters IS 'WinTeam Job Master File → Tier Parameters tab.';
COMMENT ON TABLE public.winteam_jobs IS 'WinTeam Job Master File. Each row = one client site/location.';

COMMIT;
