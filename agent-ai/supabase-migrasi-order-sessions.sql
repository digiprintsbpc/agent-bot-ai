-- =============================================================
-- Migrasi: sesi pesanan pelanggan (mode pelanggan agent AI)
-- Cara pakai: tempel seluruh isi file ini ke Supabase Dashboard
--             > SQL Editor > New query > Run
-- Aman dijalankan ulang (idempoten).
-- =============================================================

-- 1. Kolom untuk menyimpan PayinAja trx_id di orders
alter table orders
  add column if not exists payment_trx_id text;

-- 2. Tabel sesi percakapan pesanan pelanggan (state machine)
create table if not exists order_sessions (
  user_id    text primary key,  -- Telegram chat id pelanggan
  step       text not null default 'idle',
  draft      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists idx_order_sessions_updated on order_sessions (updated_at desc);

-- RLS: samakan dengan tabel agent_* (policy full access role authenticated)
alter table order_sessions enable row level security;
drop policy if exists "agent full access" on order_sessions;
create policy "agent full access" on order_sessions
  for all to authenticated using (true) with check (true);
