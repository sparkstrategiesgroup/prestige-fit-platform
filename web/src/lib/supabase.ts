import { createClient } from "@supabase/supabase-js";

// Public defaults. The Supabase anon key is intended to ship to browsers —
// row-level security is the actual access boundary. Override via env vars
// in any environment that points at a different Supabase project.
const DEFAULT_URL = "https://sshhcpzleurztzksrlvr.supabase.co";
const DEFAULT_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNzaGhjcHpsZXVyenR6a3NybHZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2ODQ3ODQsImV4cCI6MjA5MzI2MDc4NH0.bIdwa6Kce_-wQvQkFhGX9ryfKHx2QX98QBCVW_pZJhs";

const url = import.meta.env.VITE_SUPABASE_URL ?? DEFAULT_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? DEFAULT_ANON;

export const supabase = createClient(url, anon);
