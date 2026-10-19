'use strict';
/**
 * lib/invoice.js — Generate PDF invoice untuk pesanan Digiprint.
 *
 * generateInvoice(order) → Buffer (PDF)
 * order: { id, tanggal, nama_penerima, nomor_wa, alamat_lengkap,
 *          total_harga, status, items: [{ nama_produk, qty, harga_satuan, subtotal }] }
 *
 * Menggunakan pdfkit (tambah ke package.json).
 */

const PDFDocument = require('pdfkit');

const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

const STATUS_LABEL = {
  pending: 'BELUM BAYAR',
  diproses: 'DIPROSES',
  dikirim: 'DIKIRIM',
  selesai: 'SELESAI',
  batal: 'BATAL',
};

function fmtDate(d) {
  try {
    return new Date(d).toLocaleDateString('id-ID', {
      day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Asia/Jakarta',
    });
  } catch { return String(d || '-'); }
}

/**
 * Generate PDF invoice. Return Promise<Buffer>.
 */
function generateInvoice(order) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const o = order || {};
      const items = Array.isArray(o.items) ? o.items : [];
      const profile = o._profile || {};

      // ===== Header =====
      // Logo (jika ada)
      if (profile.logo) {
        try {
          const logoRes = await fetch(profile.logo, { signal: AbortSignal.timeout(5000) });
          if (logoRes.ok) {
            const logoBuf = Buffer.from(await logoRes.arrayBuffer());
            doc.image(logoBuf, 50, 40, { width: 60 });
          }
        } catch (e) { /* logo gagal, lanjut tanpa logo */ }
      }
      doc.fontSize(24).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text(profile.nama || 'DIGIPRINT', 120, 50);
      doc.fontSize(10).font('Helvetica').fillColor('#666666')
        .text('Cetak Nota & Kwitansi Custom', 120, 78);
      doc.fontSize(10).fillColor('#666666')
        .text(`WhatsApp: ${profile.kontak || '0812-xxxx-xxxx'}`, 120, 92);
      if (profile.alamat && profile.alamat !== '-') {
        doc.fontSize(9).fillColor('#888888').text(profile.alamat, 120, 106, { width: 250 });
      }

      // Nomor invoice & tanggal (kanan)
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('INVOICE', 400, 50, { align: 'right' });
      doc.fontSize(10).font('Helvetica').fillColor('#333333')
        .text(`No: ${o.id || '-'}`, 400, 72, { align: 'right' })
        .text(`Tanggal: ${fmtDate(o.tanggal)}`, 400, 86, { align: 'right' })
        .text(`Status: ${STATUS_LABEL[o.status] || o.status || '-'}`, 400, 100, { align: 'right' });

      // Garis
      doc.moveTo(50, 125).lineTo(545, 125).strokeColor('#cccccc').stroke();

      // ===== Info customer =====
      let y = 140;
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('Ditagihkan Kepada:', 50, y);
      y += 18;
      doc.fontSize(10).font('Helvetica').fillColor('#333333')
        .text(o.nama_penerima || '-', 50, y);
      y += 15;
      if (o.nomor_wa) { doc.text(`WA: ${o.nomor_wa}`, 50, y); y += 15; }
      if (o.alamat_lengkap) {
        doc.text('Alamat:', 50, y); y += 14;
        doc.text(String(o.alamat_lengkap).slice(0, 200), 50, y, { width: 495 });
        y += 30;
      }

      // ===== Tabel items =====
      y += 10;
      const tableTop = y;
      const colX = { no: 50, nama: 80, qty: 350, harga: 400, subtotal: 475 };

      // Header tabel
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff');
      doc.rect(50, tableTop, 495, 22).fill('#333333');
      doc.fillColor('#ffffff')
        .text('No', colX.no, tableTop + 6, { width: 30 })
        .text('Produk', colX.nama, tableTop + 6, { width: 260 })
        .text('Qty', colX.qty, tableTop + 6, { width: 50 })
        .text('Harga', colX.harga, tableTop + 6, { width: 75 })
        .text('Subtotal', colX.subtotal, tableTop + 6, { width: 70, align: 'right' });

      y = tableTop + 28;
      doc.font('Helvetica').fillColor('#333333');

      if (!items.length) {
        doc.fontSize(10).fillColor('#999999')
          .text('(Detail item tidak tersedia)', 50, y);
        y += 20;
      } else {
        items.forEach((it, i) => {
          const nama = it.nama_produk || it.nama || '-';
          const qty = Number(it.qty || it.jumlah || 0);
          const harga = Number(it.harga_satuan || it.harga || 0);
          const sub = Number(it.subtotal || qty * harga);
          // Zebra striping
          if (i % 2 === 1) doc.rect(50, y - 4, 495, 20).fill('#f5f5f5').fillColor('#333333');
          doc.fontSize(10)
            .text(String(i + 1), colX.no, y, { width: 30 })
            .text(String(nama).slice(0, 60), colX.nama, y, { width: 260 })
            .text(String(qty), colX.qty, y, { width: 50 })
            .text(rp(harga), colX.harga, y, { width: 75 })
            .text(rp(sub), colX.subtotal, y, { width: 70, align: 'right' });
          y += 20;
          if (y > 700) { doc.addPage(); y = 50; } // halaman baru bila penuh
        });
      }

      // ===== Total =====
      y += 10;
      doc.moveTo(350, y).lineTo(545, y).strokeColor('#cccccc').stroke();
      y += 8;
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a1a')
        .text('TOTAL:', 350, y);
      doc.text(rp(o.total_harga), 475, y, { width: 70, align: 'right' });

      // ===== Footer =====
      y += 40;
      doc.fontSize(9).font('Helvetica').fillColor('#999999')
        .text('Terima kasih telah berbelanja di Digiprint! 🙏', 50, y, { align: 'center', width: 495 });
      doc.text('Simpan invoice ini sebagai bukti pembayaran.', 50, y + 14, { align: 'center', width: 495 });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { generateInvoice, rp };
