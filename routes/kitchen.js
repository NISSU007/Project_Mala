const express = require('express');
const router = express.Router();
const { dbGet, dbRun } = require('../config/db');
const { STATUS, orderNo, getOrderFull, getOrdersByStatus, getEmployee } = require('../utils/helpers');

// UC08: แสดงรายละเอียดออเดอร์ที่ต้องปรุง และพิมพ์รายการอาหาร
router.get('/kitchen', async (req, res) => {
  try {
    const tab = req.query.tab || 'preparing';
    const q = (req.query.q || '').trim();

    const preparing = await getOrdersByStatus([STATUS.PREPARING], q);
    const cooked = await getOrdersByStatus([STATUS.COOKED], q);
    const doneToday = await dbGet(
      `SELECT COUNT(*) AS n FROM "Order" WHERE Order_Status IN (?, ?)
       AND date(Order_Date_Time, 'localtime') = date('now', 'localtime')`,
      [STATUS.READY, STATUS.DONE]
    );

    let list = preparing;
    if (tab === 'cooked') list = cooked;
    if (tab === 'all') list = await getOrdersByStatus([STATUS.PREPARING, STATUS.COOKED, STATUS.READY], q);

    let selected = null;
    if (req.query.id) selected = await getOrderFull(req.query.id);

    const employee = await getEmployee('ครัว');
    res.render('kitchen/index', {
      tab, q, list, selected, employee,
      counts: { preparing: preparing.length, cooked: cooked.length, done: doneToday.n },
      success: req.query.success
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/kitchen/print/:orderId', async (req, res) => {
  try {
    const order = await getOrderFull(req.params.orderId);
    if (!order) return res.status(404).send('ไม่พบออเดอร์');
    res.render('kitchen/print', { order });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC09: อัปเดตสถานะออเดอร์ (กรณีพนักงานครัวปรุงอาหารเสร็จ)
router.get('/kitchen/status', async (req, res) => {
  try {
    const list = await getOrdersByStatus([STATUS.PREPARING]);
    let selected = null;
    const id = req.query.id || (list[0] ? list[0].Order_ID : null);
    if (id) selected = await getOrderFull(id);
    const employee = await getEmployee('ครัว');
    res.render('kitchen/status', { list, selected, employee, success: req.query.success });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/kitchen/status/:orderId', async (req, res) => {
  try {
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ? AND Order_Status = ?',
      [STATUS.COOKED, req.params.orderId, STATUS.PREPARING]);
    const o = await dbGet('SELECT Reference_Code FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    res.redirect('/kitchen?success=' + encodeURIComponent(orderNo(o ? o.Reference_Code : '')));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;