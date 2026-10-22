'use strict';
/* Logika halaman tamu kantor 3D: joystick sentuh + panel pemesanan (rakit nota). */
(function () {
  const $ = (id) => document.getElementById(id);
  const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- joystick ----------------
  const joy = $('joy');
  const knob = $('joyKnob');
  if (joy && knob) {
    let pid = null;
    const R = 34;
    const setVec = (dx, dy) => {
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      if (window.__tamuJoy) window.__tamuJoy(dx / R, dy / R);
    };
    const move = (e) => {
      const r = joy.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      setVec(dx, dy);
    };
    joy.addEventListener('pointerdown', (e) => { pid = e.pointerId; joy.setPointerCapture(pid); move(e); });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
    const end = (e) => { if (e.pointerId === pid) { pid = null; setVec(0, 0); } };
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
  }

  // ---------------- ganti kamera (FPP <-> dari atas) ----------------
  const btnKamera = $('btnKamera');
  let modeAtas = false;
  if (btnKamera) btnKamera.addEventListener('click', () => {
    modeAtas = !modeAtas;
    if (window.__tamuKameraMode) window.__tamuKameraMode(modeAtas ? 'atas' : 'fpp');
    btnKamera.textContent = modeAtas ? '🚶 Kembali Jalan Sendiri' : '👀 Lihat Kantor dari Atas';
  });

  // ---------------- panel pemesanan ----------------
  const overlay = $('pesanOverlay');
  const isi = $('pesanIsi');
  const btn = $('btnPesan');
  let katalog = null; // { nota: Map<id, p>, perUkuran: Map<denom, Map<ply, Map<lembar, p>>>, rim: [], digital: [] }
  let pil = { ukuran: null, ply: null, lembar: null };
  let produkAktif = null;
  let qty = 1;
  let cart = [];
  let polling = null;

  const CM = { 2: '±16 × 21 cm', 3: '±11 × 21 cm', 4: '±8 × 21 cm', 6: '±10 × 10 cm', 8: '±10 × 8 cm', 10: '±10 × 6 cm' };
  const LEBAR = { 2: 100, 3: 78, 4: 64, 6: 52, 8: 45, 10: 38 };
  const RANGKAP = { 1: '1 rangkap · putih', 2: '2 rangkap · putih + kuning', 3: '3 rangkap · putih + kuning + pink' };

  function openPanel() {
    overlay.hidden = false;
    if (!katalog) loadKatalog();
    else renderBangun();
  }
  function closePanel() { overlay.hidden = true; }
  if (btn) btn.addEventListener('click', openPanel);
  $('pesanClose').addEventListener('click', closePanel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });

  async function loadKatalog() {
    isi.innerHTML = '<p style="color:var(--muted)">Memuat katalog…</p>';
    try {
      const r = await fetch('/api/web-order?action=katalog');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'gagal');
      const perUkuran = new Map();
      const rim = [];
      const digital = [];
      const notaRe = /^N(\d+)-(\d)P-(50|100)$/;
      for (const p of d.produk) {
        const m = String(p.id).match(notaRe);
        if (m) {
          const [, den, ply, lbr] = m;
          if (!perUkuran.has(den)) perUkuran.set(den, new Map());
          if (!perUkuran.get(den).has(ply)) perUkuran.get(den).set(ply, new Map());
          perUkuran.get(den).get(ply).set(lbr, p);
        } else if (p.tipe === 'digital') digital.push(p);
        else rim.push(p);
      }
      katalog = { perUkuran, rim, digital };
      renderBangun();
    } catch (e) {
      isi.innerHTML = `<div class="errBox">Katalog gagal dimuat. <a href="#" id="cobaLagi">Coba lagi</a></div>`;
      $('cobaLagi').addEventListener('click', (ev) => { ev.preventDefault(); loadKatalog(); });
    }
  }

  function produkDariPilihan() {
    if (!pil.ukuran || !pil.ply || !pil.lembar) return null;
    return katalog.perUkuran.get(pil.ukuran)?.get(pil.ply)?.get(pil.lembar) || null;
  }

  function renderBangun() {
    const ukurans = [...katalog.perUkuran.keys()].sort((a, b) => Number(a) - Number(b));
    let h = '';

    h += `<div class="langkah">1 · Pilih ukuran nota</div><div class="chips">`;
    for (const u of ukurans) {
      h += `<button type="button" class="chipP ${pil.ukuran === u ? 'on' : ''}" data-ukuran="${u}">1/${u} folio<small>${CM[u] || ''}</small></button>`;
    }
    h += `</div>`;

    if (pil.ukuran) {
      const plys = [...katalog.perUkuran.get(pil.ukuran).keys()].sort();
      h += `<div class="langkah">2 · Berapa rangkap (ply)?</div><div class="chips">`;
      for (const p of plys) {
        h += `<button type="button" class="chipP ${pil.ply === p ? 'on' : ''}" data-ply="${p}">${p} ply<small>${RANGKAP[p] || ''}</small></button>`;
      }
      h += `</div>`;
    }
    if (pil.ukuran && pil.ply) {
      const lbrs = [...katalog.perUkuran.get(pil.ukuran).get(pil.ply).keys()].sort((a, b) => Number(a) - Number(b));
      h += `<div class="langkah">3 · Jumlah lembar per buku</div><div class="chips">`;
      for (const l of lbrs) {
        h += `<button type="button" class="chipP ${pil.lembar === l ? 'on' : ''}" data-lembar="${l}">${l} lembar</button>`;
      }
      h += `</div>`;
    }

    const pNota = produkDariPilihan();
    if (pNota) {
      produkAktif = pNota;
      h += `<div class="notaPreview" style="width:${LEBAR[pil.ukuran] || 70}%"><b>NOTA · DIGIPRINT</b><span>${esc(pNota.nama)}</span><span>${RANGKAP[pil.ply] || ''}</span></div>`;
      h += hargaBar(pNota);
    }

    if (katalog.rim.length) {
      h += `<div class="langkah">Paket rim <span>— free ongkir Malang</span></div><div class="chips">`;
      for (const p of katalog.rim) {
        h += `<button type="button" class="chipP ${produkAktif && produkAktif.id === p.id && !pNota ? 'on' : ''}" data-produk="${p.id}">${esc(p.nama.replace(' (free ongkir Malang)', ''))}<small>${rp(p.harga)}</small></button>`;
      }
      h += `</div>`;
      if (produkAktif && katalog.rim.some((p) => p.id === produkAktif.id) && !pNota) h += hargaBar(produkAktif);
    }

    if (katalog.digital.length) {
      h += `<div class="langkah">Produk digital <span>— terkirim otomatis ke WA setelah bayar</span></div><div class="chips">`;
      for (const p of katalog.digital) {
        const habis = !(p.stok > 0);
        h += `<button type="button" class="chipP ${produkAktif && produkAktif.id === p.id ? 'on' : ''}" data-produk="${p.id}" ${habis ? 'disabled' : ''}>${esc(p.nama)}<small>${rp(p.harga)} · stok ${habis ? 'habis' : p.stok}</small></button>`;
      }
      h += `</div>`;
      if (produkAktif && katalog.digital.some((p) => p.id === produkAktif.id)) h += hargaBar(produkAktif);
    }

    h += renderCart();
    isi.innerHTML = h;
    bindBangun();
  }

  function hargaBar(p) {
    return `<div class="hargaBar"><div><div style="font-weight:600">${esc(p.nama)}</div><div class="rp">${rp(p.harga * qty)}</div></div>
      <div class="qtyCtl"><button type="button" id="qMin" aria-label="Kurangi">−</button><b>${qty}</b><button type="button" id="qPlus" aria-label="Tambah">+</button></div></div>
      <button type="button" class="btnUtama" id="btnTambah">＋ Tambah ke Pesanan</button>`;
  }

  function renderCart() {
    if (!cart.length) return '';
    const total = cart.reduce((a, c) => a + c.harga * c.qty, 0);
    let h = `<div class="langkah">Pesananmu</div>`;
    for (const c of cart) {
      h += `<div class="cartItem"><span>${esc(c.nama)} ×${c.qty}</span><span>${rp(c.harga * c.qty)} <button type="button" data-hapus="${c.id}">✕</button></span></div>`;
    }
    h += `<div class="fld"><label>Nama kamu</label><input id="fNama" autocomplete="name" placeholder="cth: Budi"></div>
      <div class="fld"><label>Nomor WhatsApp (aktif, untuk QRIS & invoice)</label><input id="fWa" inputmode="tel" autocomplete="tel" placeholder="cth: 081234567890"></div>
      <div class="fld"><label>Alamat lengkap pengiriman</label><textarea id="fAlamat" rows="2" placeholder="Jalan, nomor rumah, kecamatan, kota — untuk produk digital boleh dikosongi"></textarea></div>
      <div id="errSlot"></div>
      <button type="button" class="btnUtama" id="btnCheckout">Buat Pesanan & Bayar · ${rp(total)}</button>
      <p style="color:var(--muted);font-size:12px;margin-top:8px">Menekan tombol ini akan membuat pesanan dan menampilkan QRIS. QRIS yang sama juga dikirim ke WA kamu.</p>`;
    return h;
  }

  function bindBangun() {
    isi.querySelectorAll('[data-ukuran]').forEach((b) => b.addEventListener('click', () => {
      pil = { ukuran: b.dataset.ukuran, ply: null, lembar: null }; produkAktif = null; qty = 1; renderBangun();
    }));
    isi.querySelectorAll('[data-ply]').forEach((b) => b.addEventListener('click', () => {
      pil.ply = b.dataset.ply; pil.lembar = null; produkAktif = null; qty = 1; renderBangun();
    }));
    isi.querySelectorAll('[data-lembar]').forEach((b) => b.addEventListener('click', () => {
      pil.lembar = b.dataset.lembar; qty = 1; renderBangun();
    }));
    isi.querySelectorAll('[data-produk]').forEach((b) => b.addEventListener('click', () => {
      const semua = [...katalog.rim, ...katalog.digital];
      produkAktif = semua.find((p) => p.id === b.dataset.produk) || null;
      pil = { ukuran: null, ply: null, lembar: null }; qty = 1; renderBangun();
    }));
    const qMin = $('qMin'); const qPlus = $('qPlus');
    if (qMin) qMin.addEventListener('click', () => { qty = Math.max(1, qty - 1); renderBangun(); });
    if (qPlus) qPlus.addEventListener('click', () => { qty = Math.min(100, qty + 1); renderBangun(); });
    const btnTambah = $('btnTambah');
    if (btnTambah) btnTambah.addEventListener('click', () => {
      if (!produkAktif) return;
      const ada = cart.find((c) => c.id === produkAktif.id);
      if (ada) ada.qty = Math.min(100, ada.qty + qty);
      else cart.push({ id: produkAktif.id, nama: produkAktif.nama, harga: produkAktif.harga, qty });
      renderBangun();
    });
    isi.querySelectorAll('[data-hapus]').forEach((b) => b.addEventListener('click', () => {
      cart = cart.filter((c) => c.id !== b.dataset.hapus); renderBangun();
    }));
    const btnCheckout = $('btnCheckout');
    if (btnCheckout) btnCheckout.addEventListener('click', checkout);
  }

  async function checkout() {
    const nama = $('fNama').value.trim();
    let wa = $('fWa').value.replace(/\D/g, '');
    if (wa.startsWith('0')) wa = '62' + wa.slice(1);
    else if (wa.startsWith('8')) wa = '62' + wa;
    const alamat = $('fAlamat').value.trim();
    const err = $('errSlot');
    const gagal = (m) => { if (err) err.innerHTML = `<div class="errBox">${esc(m)}</div>`; };
    if (nama.length < 2) return gagal('Nama wajib diisi ya kak.');
    if (wa.length < 10 || wa.length > 15) return gagal('Nomor WA sepertinya tidak valid. Cek lagi ya.');
    if (!cart.length) return gagal('Pesanannya masih kosong.');

    const btnCheckout = $('btnCheckout');
    btnCheckout.disabled = true;
    btnCheckout.textContent = 'Membuat pesanan…';
    try {
      const r = await fetch('/api/web-order?action=buat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart.map((c) => ({ id: c.id, qty: c.qty })), nama, wa, alamat }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Gagal membuat pesanan');
      renderQris(d);
    } catch (e) {
      gagal(e.message);
      btnCheckout.disabled = false;
      btnCheckout.textContent = 'Coba Lagi';
    }
  }

  function renderQris(d) {
    cart = [];
    isi.innerHTML = `<div class="qrBox">
      <h2 style="margin:0 0 4px">Scan untuk Bayar 💳</h2>
      <div class="oid">Order <b>${esc(d.id)}</b> · simpan nomor ini untuk cek status</div>
      ${d.qr ? `<img src="${esc(d.qr)}" alt="QRIS">` : '<p>Gambar QRIS tidak tersedia — QRIS yang sama sudah dikirim ke WA kamu.</p>'}
      <div class="total">${rp(d.total)}</div>
      <div class="oid">Bayar persis sampai 3 digit terakhir ya kak</div>
      <div class="statusTunggu" id="statusBayar">⏳ Menunggu pembayaran… halaman ini akan berubah sendiri begitu lunas.</div>
      <button type="button" class="btnUtama" id="btnSelesai" hidden>🎉 Selesai — Kembali Jalan-Jalan</button>
    </div>`;
    $('btnSelesai').addEventListener('click', () => { closePanel(); });
    mulaiPolling(d.id);
  }

  function mulaiPolling(orderId) {
    if (polling) clearInterval(polling);
    let tries = 0;
    polling = setInterval(async () => {
      tries++;
      if (tries > 144) { clearInterval(polling); polling = null; return; } // ±12 menit
      try {
        const r = await fetch(`/api/web-order?action=status&id=${encodeURIComponent(orderId)}`);
        const d = await r.json();
        if (!d.ok) return;
        if (['diproses', 'dikirim', 'selesai'].includes(d.status)) {
          clearInterval(polling); polling = null;
          const st = $('statusBayar');
          if (st) {
            st.className = 'statusOk';
            st.textContent = d.status === 'selesai'
              ? '✅ Pembayaran diterima & pesanan selesai! Detailnya sudah dikirim ke WA kamu.'
              : '✅ Pembayaran diterima! Pesananmu sedang disiapkan — invoice sudah dikirim ke WA kamu.';
          }
          const bs = $('btnSelesai');
          if (bs) bs.hidden = false;
          if (window.__tamuRayakan) window.__tamuRayakan();
        } else if (d.status === 'batal') {
          clearInterval(polling); polling = null;
          const st = $('statusBayar');
          if (st) { st.className = 'statusTunggu'; st.style.color = '#c43d3d'; st.textContent = 'Pesanan ini dibatalkan. Silakan buat pesanan baru ya kak.'; }
        }
      } catch { /* abaikan, coba lagi */ }
    }, 5000);
  }
})();
