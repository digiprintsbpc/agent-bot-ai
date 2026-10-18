-- ============================================================
-- Migrasi Fitur Jualan — Digiprint
-- Jalankan di Supabase SQL Editor (sekali saja)
-- Isi:
--   1) Tabel ai_pause (AI handoff/pause 8 jam)
--   2) Kolom wa_outbox.image_url (kirim gambar TG → WA)
--   3) Kolom orders.reminder_sent_at (pengingat bayar otomatis)
-- ============================================================

-- ---------- 1) Tabel ai_pause ----------
-- Menyimpan daftar customer yang AI-nya sedang di-pause karena
-- Rizal membalas manual via WA. paused_until = waktu AI boleh aktif lagi.
CREATE TABLE IF NOT EXISTS ai_pause (
  user_id TEXT PRIMARY KEY,
  paused_until TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ai_pause ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "full access" ON ai_pause;
CREATE POLICY "full access" ON ai_pause
  FOR ALL USING (true) WITH CHECK (true);

-- ---------- 2) Kolom image_url di wa_outbox ----------
-- Untuk kirim gambar (mis. bukti/foto dari Telegram admin ke WA customer).
-- Kalau kolom belum ada, tambahkan.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wa_outbox' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE wa_outbox ADD COLUMN image_url TEXT;
  END IF;
END $$;

-- ---------- 3) Kolom reminder_sent_at di orders ----------
-- Menandai order pending yang sudah dikirimi pengingat bayar (anti-dobel).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'reminder_sent_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN reminder_sent_at TIMESTAMPTZ;
  END IF;
END $$;

-- ---------- Selesai ----------
-- Verifikasi cepat (opsional, jalankan setelah migrasi):
-- SELECT * FROM ai_pause LIMIT 1;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'wa_outbox';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'orders';
