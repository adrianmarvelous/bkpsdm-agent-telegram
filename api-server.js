/**
 * API Server — Ekspos data jadwal & tugas dari BKPSDM backend
 *
 * Cara pakai:
 *   npm install express
 *   node api-server.js
 *
 * Endpoint:
 *   GET  /api/jadwal/hari-ini       — Jadwal rapat hari ini
 *   GET  /api/jadwal/tanggal?date=  — Jadwal by tanggal (YYYY-MM-DD)
 *   GET  /api/jadwal/minggu-ini     — Jadwal minggu ini
 *   GET  /api/jadwal/semua          — Semua jadwal
 *   GET  /api/jadwal/detail?id=     — Detail jadwal by ID
 *   GET  /api/tugas/hari-ini        — Tugas hari ini
 *   GET  /api/tugas/tanggal?date=   — Tugas by tanggal
 *   GET  /api/tugas/semua           — Semua tugas
 *   GET  /api/health                — Health check
 */
const express = require('express');
const api = require('./src/services/apiClient');

const app = express();
const PORT = process.env.API_PORT || 3000;

// Middleware
app.use(express.json());

// ===================== JADWAL =====================

/** GET /api/jadwal/hari-ini */
app.get('/api/jadwal/hari-ini', async (req, res) => {
  try {
    const data = await api.getJadwalHariIni();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/jadwal/tanggal?date=YYYY-MM-DD */
app.get('/api/jadwal/tanggal', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'Parameter "date" required (YYYY-MM-DD)' });
    const data = await api.getJadwalByTanggal(date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/jadwal/minggu-ini */
app.get('/api/jadwal/minggu-ini', async (req, res) => {
  try {
    const data = await api.getJadwalMingguIni();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/jadwal/semua */
app.get('/api/jadwal/semua', async (req, res) => {
  try {
    const data = await api.getSemuaJadwal();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/jadwal/detail?id=xxx */
app.get('/api/jadwal/detail', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: 'Parameter "id" required' });
    const data = await api.getJadwalById(id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== TUGAS =====================

/** GET /api/tugas/hari-ini */
app.get('/api/tugas/hari-ini', async (req, res) => {
  try {
    const data = await api.getTugasHariIni();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/tugas/tanggal?date=YYYY-MM-DD */
app.get('/api/tugas/tanggal', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'Parameter "date" required (YYYY-MM-DD)' });
    const data = await api.getTugasByTanggal(date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/tugas/semua */
app.get('/api/tugas/semua', async (req, res) => {
  try {
    const data = await api.getSemuaTugas();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== ABSENSI (CSV) =====================

/** GET /api/absensi/hari-ini */
app.get('/api/absensi/hari-ini', async (req, res) => {
  try {
    const data = await api.getAbsensiHariIni();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/absensi/tanggal?date=YYYY-MM-DD */
app.get('/api/absensi/tanggal', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'Parameter "date" required (YYYY-MM-DD)' });
    const data = await api.getAbsensiByTanggal(date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== HEALTH =====================

/** GET /api/health */
app.get('/api/health', async (req, res) => {
  try {
    const health = await api.healthCheck();
    res.json({ success: true, data: health });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== START =====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 API Server BKPSDM berjalan di http://0.0.0.0:${PORT}`);
  console.log(`📅 Jadwal:  /api/jadwal/hari-ini`);
  console.log(`📋 Tugas:   /api/tugas/hari-ini`);
  console.log(`❤️  Health:  /api/health`);
});
