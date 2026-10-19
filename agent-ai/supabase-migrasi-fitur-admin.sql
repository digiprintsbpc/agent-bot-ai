-- ============================================================
-- Migrasi FITUR ADMIN (dashboard, pengeluaran, dsb.)
-- Jalankan di Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. PENGELUARAN (catat pengeluaran via /keluar)
create table if not exists pengeluaran (
  id         uuid primary key default gen_random_uuid(),
  tanggal    timestamptz not null default now(),
  nominal    numeric not null,
  keterangan text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pengeluaran_tanggal on pengeluaran (tanggal desc);
