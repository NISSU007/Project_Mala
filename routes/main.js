const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { dbAll } = require('../config/db');
const { getBaseURL, getTable } = require('../utils/helpers');

// หน้าแรกเลือกบทบาทการใช้งาน
router.get('/', async (req, res) => {
  try {
    const tables = await dbAll('SELECT * FROM "Table" ORDER BY Table_ID');
    res.render('index', { tables, baseURL: getBaseURL(req) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// แสดง QR Code สำหรับสแกนเข้าโต๊ะ
router.get('/qr', async (req, res) => {
  try {
    const baseURL = getBaseURL(req);
    const tables = await dbAll('SELECT * FROM "Table" ORDER BY Table_ID');
    for (const t of tables) {
      t.fullURL = baseURL + t.QR_Code_URL;
      t.qrImage = await QRCode.toDataURL(t.fullURL, { width: 320, margin: 1 });
    }
    res.render('staff/qr', { tables, baseURL, single: false });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/qr/:tableId', async (req, res) => {
  try {
    const baseURL = getBaseURL(req);
    const t = await getTable(req.params.tableId);
    if (!t) return res.status(404).send('ไม่พบโต๊ะ');
    t.fullURL = baseURL + t.QR_Code_URL;
    t.qrImage = await QRCode.toDataURL(t.fullURL, { width: 480, margin: 1 });
    res.render('staff/qr', { tables: [t], baseURL, single: true });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;