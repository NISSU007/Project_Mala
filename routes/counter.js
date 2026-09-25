const express = require('express');
const router = express.Router();
const { dbGet, dbRun } = require('../config/db');
const { STATUS, notifyCount, orderNo, getOrderFull, getOrdersByStatus, getEmployee } = require('../utils/helpers');

async function counterCounts() {
  const a = await dbGet('SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status = ?', [STATUS.COOKED]);
  const b = await dbGet('SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status = ?', [STATUS.READY]);
  return { cooked: a.n, ready: b.n };
}

// UC10: แสดงออเดอร์ที่พร้อมเสิร์ฟ
router.get('/counter', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.COOKED]);
    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/index', { list, selected, employee, counts: await counterCounts(), page: 'ready' });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC09: อัปเดตสถานะออเดอร์ (พร้อมเสิร์ฟ)
router.get('/counter/status', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.COOKED]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/status', { list, selected, employee, counts: await counterCounts(), page: 'status', success: req.query.success });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/counter/status/:orderId', async (req, res) => {
  try {
    const r = await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.READY, req.params.orderId, STATUS.COOKED]);
    if (r.changes > 0) notifyCount[req.params.orderId] = 1;
    const o = await dbGet('SELECT Reference_Code FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    res.redirect('/counter/status?success=' + encodeURIComponent(orderNo(o ? o.Reference_Code : '')));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC11: แจ้งเตือนและยืนยันการรับอาหาร
router.get('/counter/notify', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.READY]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    if (selected) selected.notify = notifyCount[selected.Order_ID] || 0;
    const employee = await getEmployee('หน้าเคาน์เตอร์');
    res.render('counter/notify', {
      list, selected, employee, counts: await counterCounts(), page: 'notify',
      message: req.query.message
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/counter/notify/:orderId', (req, res) => {
  const id = req.params.orderId;
  notifyCount[id] = (notifyCount[id] || 0) + 1;
  res.redirect('/counter/notify?id=' + id + '&message=renotify');
});

router.post('/counter/complete/:orderId', async (req, res) => {
  try {
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.DONE, req.params.orderId, STATUS.READY]);
    delete notifyCount[req.params.orderId];
    res.redirect('/counter/notify?message=done');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;