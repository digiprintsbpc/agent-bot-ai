# Agent AI — Asisten Pribadi di Vercel

Agent AI Telegram: ngobrol natural (dengan memory), skill toko (stok/pesanan/omset
via Supabase), skill security-audit, dan catatan penting. Otak: **Groq** (utama,
gratis) dengan **failover otomatis ke NVIDIA** (cadangan, gratis)
dan **EXTRA** (cadangan tambahan OpenAI-compatible, opsional).

## Arsitektur

```
Telegram --webhook--> Vercel Function (/api/telegram)
                            |-- Groq API  (utama)
                            |-- NVIDIA API (cadangan otomatis)
                            |-- Supabase: agent_memory, agent_notes, agent_activity (+ tabel toko)
                            +-- Dashboard: /dashboard.html
```

## 1. Database (sekali saja)

Buka Supabase Dashboard → SQL Editor → jalankan isi file
`supabase-migrasi-agent.sql`. Tabel toko (products, orders, dll) sudah ada
dari migrasi sebelumnya — tidak perlu diulang.

## 2. Bot Telegram (sekali saja)

1. Chat ke **@BotFather** di Telegram → `/newbot` → ikuti langkahnya → catat token.
2. Catat juga **numeric ID** Telegram-mu (chat ke @userinfobot).

## 3. API Key AI (sekali saja)

- **Groq** (utama, gratis): https://console.groq.com/keys → Create API Key.
- **NVIDIA** (cadangan, gratis): https://build.nvidia.com → login → API Keys
  (atau pakai key `nvidia-build` yang sudah ada).

## 4. Deploy ke Vercel

1. Push folder ini ke GitHub (repo baru, mis. `agent-ai`).
2. Di https://vercel.com → Add New → Project → Import repo tersebut.
3. Saat import, isi **Environment Variables** (atau sesudahnya di
   Settings → Environment Variables):
   - `TELEGRAM_BOT_TOKEN` — token dari BotFather
   - `TELEGRAM_ALLOWED_ID` — numeric ID Telegram-mu
   - `WEBHOOK_SECRET` — string acak (mis. hasil `openssl rand -hex 16`)
   - `GROQ_API_KEY`, `GROQ_MODEL` (= `openai/gpt-oss-120b`)
   - `NVIDIA_API_KEY`, `NVIDIA_MODEL` (= `meta/llama-3.2-11b-vision-instruct`)
   - `EXTRA_NAME`, `EXTRA_API_KEY`, `EXTRA_BASE_URL`, `EXTRA_MODEL`
     (opsional — provider OpenAI-compatible tambahan, mis. `glm-5.3`)
   - `SUPABASE_URL` (= `https://evldginxhscydjhmdkjn.supabase.co`)
   - `SUPABASE_SERVICE_KEY` — service_role key (Reveal di dashboard Supabase)
4. Deploy. Catat URL project, mis. `https://agent-ai.vercel.app`.

## 5. Pasang webhook (sekali saja)

Buka di browser (ganti TOKEN, URL, RAHASIA):

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://PROJECT.vercel.app/api/telegram&secret_token=RAHASIA
```

Harus balas `{"ok":true}`. Kirim "halo" ke bot untuk tes.

## Perintah & skill

- `/start` — bantuan
- `/ingat <teks>` — simpan catatan penting (tidak pernah lupa)
- `/catatan` — lihat semua catatan
- `/toko <pertanyaan>` — paksa jawab dari database toko
- `/audit <kode/pertanyaan>` — review keamanan (security-audit skill)
- Tanpa prefix: sapaan dijawab instan (tanpa API call), pertanyaan toko
  otomatis query database, sisanya ngobrol dengan memory.

## Dashboard

Buka `https://PROJECT.vercel.app/dashboard.html` untuk melihat aktivitas agent.

## Catatan

- Vercel Hobby: function timeout ±10 detik. Groq sangat cepat sehingga
  biasanya cukup. Kalau sering timeout, pertimbangkan Vercel Pro.
- Kuota gratis Groq/NVIDIA ada batas harian — kalau kena 429, agent otomatis
  coba provider cadangan, lalu bilang terus terang bila keduanya habis.

## Kredit
Frontend kantor 3D di `public/kerja/` diadaptasi dari
[humaedihume/kantor-agent](https://github.com/humaedihume/kantor-agent) (MIT),
termasuk three.js (MIT). Buka di `/kerja/`.
