const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { dbAll, dbGet, dbRun } = require('../config/db');
const {
  STATUS, SPICE_LEVELS, PAYMENT_TIMEOUT_MIN, notifyCount,
  groupOf, getTable, getCart, getOrCreateCart, getOrderItems,
  recalcTotal, getOrderFull, makeReferenceCode, cutStock
} = require('../utils/helpers');

// Middleware บันทึก Table_ID ลงใน Session
router.use('/table/:tableId', (req, res, next) => {
  if (req.params.tableId) {
    req.session.tableId = req.params.tableId; // บันทึก Session
  }
  next();
});

// UC01: แสดงรายการอาหาร
router.get('/table/:tableId', (req, res) => {
  res.redirect('/table/' + req.params.tableId + '/menu');
});

router.get('/table/:tableId/menu', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะนี้ กรุณาสแกน QR Code ใหม่');

    const tab = req.query.tab || 'all';
    const categories = await dbAll('SELECT * FROM Category ORDER BY Category_ID');
    categories.forEach((c) => (c.group = groupOf(c.Category_Name)));

    const menus = await dbAll(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID
       ORDER BY m.Category_ID, m.Menu_ID`
    );
    menus.forEach((m) => {
      m.group = groupOf(m.Category_Name);
      m.soldOut = m.Is_Available === 0 || m.Stock_Quantity <= 0;
    });

    const rawCats = categories.filter((c) => c.group === 'raw');
    const selectedCat = Number(req.query.cat) || (rawCats[0] ? rawCats[0].Category_ID : 0);

    const cart = await getCart(table.Table_ID);
    let cartCount = 0;
    let cartTotal = 0;
    if (cart) {
      const s = await dbGet(
        'SELECT IFNULL(SUM(Quantity),0) AS qty, IFNULL(SUM(Subtotal),0) AS total FROM Order_Detail WHERE Order_ID = ?',
        [cart.Order_ID]
      );
      cartCount = s.qty;
      cartTotal = s.total;
    }

    res.render('customer/menu', {
      table, tab, categories, rawCats, selectedCat, menus,
      cartCount, cartTotal,
      added: req.query.added,
      error: req.query.error
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC02: เลือกและปรับแต่งรายการอาหาร
router.get('/table/:tableId/item/:menuId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const menu = await dbGet(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID WHERE m.Menu_ID = ?`,
      [req.params.menuId]
    );
    if (!table || !menu) return res.status(404).send('ไม่พบรายการ');
    menu.soldOut = menu.Is_Available === 0 || menu.Stock_Quantity <= 0;
    menu.isSoup = menu.Category_Name === 'ซุป';

    let editItem = null;
    if (req.query.edit) {
      editItem = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ?', [req.query.edit]);
    }

    res.render('customer/item', {
      table, menu, editItem,
      spiceLevels: SPICE_LEVELS,
      error: req.query.error,
      backTab: groupOf(menu.Category_Name)
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/add', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const { menuId, spice, note, detailId } = req.body;
    const qty = Math.max(1, parseInt(req.body.qty, 10) || 1);
    const menu = await dbGet(
      `SELECT m.*, c.Category_Name FROM Menu m
       LEFT JOIN Category c ON m.Category_ID = c.Category_ID WHERE m.Menu_ID = ?`,
      [menuId]
    );
    if (!menu) return res.redirect('/table/' + tableId + '/menu');

    const backURL = '/table/' + tableId + '/item/' + menuId + (detailId ? '?edit=' + detailId + '&' : '?');

    if (menu.Is_Available === 0 || menu.Stock_Quantity <= 0) {
      return res.redirect(backURL + 'error=soldout');
    }

    const isSoup = menu.Category_Name === 'ซุป';
    if (isSoup && !SPICE_LEVELS.includes(spice)) {
      return res.redirect(backURL + 'error=spice');
    }

    const spiceValue = isSoup ? spice : null;
    const soupValue = isSoup ? menu.Menu_Name : null;
    const noteValue = (note || '').trim();
    const finalQty = isSoup ? 1 : qty;

    const cart = await getOrCreateCart(tableId);

    if (detailId) {
      await dbRun(
        `UPDATE Order_Detail SET Quantity = ?, Unit_Price = ?, Subtotal = ?, Spiciness_Level = ?, Soup_Type = ?, Special_Note = ?
         WHERE Order_Detail_ID = ? AND Order_ID = ?`,
        [finalQty, menu.Price, finalQty * menu.Price, spiceValue, soupValue, noteValue, detailId, cart.Order_ID]
      );
      await recalcTotal(cart.Order_ID);
      return res.redirect('/table/' + tableId + '/cart');
    }

    const same = await dbGet(
      `SELECT * FROM Order_Detail WHERE Order_ID = ? AND Menu_ID = ?
       AND IFNULL(Spiciness_Level,'') = ? AND IFNULL(Special_Note,'') = ?`,
      [cart.Order_ID, menu.Menu_ID, spiceValue || '', noteValue]
    );
    if (same && !isSoup) {
      const newQty = same.Quantity + finalQty;
      await dbRun('UPDATE Order_Detail SET Quantity = ?, Subtotal = ? WHERE Order_Detail_ID = ?',
        [newQty, newQty * same.Unit_Price, same.Order_Detail_ID]);
    } else {
      await dbRun(
        `INSERT INTO Order_Detail (Order_ID, Menu_ID, Quantity, Unit_Price, Subtotal, Spiciness_Level, Soup_Type, Special_Note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cart.Order_ID, menu.Menu_ID, finalQty, menu.Price, finalQty * menu.Price, spiceValue, soupValue, noteValue]
      );
    }
    await recalcTotal(cart.Order_ID);
    res.redirect('/table/' + tableId + '/menu?tab=' + groupOf(menu.Category_Name) + '&cat=' + menu.Category_ID + '&added=' + encodeURIComponent(menu.Menu_Name));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC03: แก้ไขรายการอาหารในตะกร้า
router.get('/table/:tableId/cart', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const cart = await getCart(table.Table_ID);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);
    res.render('customer/cart', { table, cart, items, total, error: req.query.error });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/update/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (!cart) return res.redirect('/table/' + tableId + '/cart');
    const item = await dbGet('SELECT * FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
      [req.params.detailId, cart.Order_ID]);
    if (item) {
      const newQty = req.body.action === 'plus' ? item.Quantity + 1 : item.Quantity - 1;
      if (newQty <= 0) {
        await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ?', [item.Order_Detail_ID]);
      } else {
        await dbRun('UPDATE Order_Detail SET Quantity = ?, Subtotal = ? WHERE Order_Detail_ID = ?',
          [newQty, newQty * item.Unit_Price, item.Order_Detail_ID]);
      }
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/cart/delete/:detailId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    if (cart) {
      await dbRun('DELETE FROM Order_Detail WHERE Order_Detail_ID = ? AND Order_ID = ?',
        [req.params.detailId, cart.Order_ID]);
      await recalcTotal(cart.Order_ID);
    }
    res.redirect('/table/' + tableId + '/cart');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC04: ยืนยันคำสั่งซื้อ
router.post('/table/:tableId/cart/confirm', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');
    res.redirect('/table/' + tableId + '/summary');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/table/:tableId/summary', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const cart = await getCart(req.params.tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + req.params.tableId + '/cart?error=empty');
    const total = items.reduce((sum, it) => sum + it.Subtotal, 0);
    res.render('customer/summary', { table, cart, items, total });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/checkout', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    const cart = await getCart(tableId);
    const items = cart ? await getOrderItems(cart.Order_ID) : [];
    if (items.length === 0) return res.redirect('/table/' + tableId + '/cart?error=empty');

    const ref = await makeReferenceCode(table);
    await recalcTotal(cart.Order_ID);
    await dbRun(
      'UPDATE "Order" SET Order_Status = ?, Reference_Code = ?, Order_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?',
      [STATUS.WAIT_PAY, ref, cart.Order_ID]
    );
    await dbRun('UPDATE "Table" SET Table_Status = ? WHERE Table_ID = ?', ['มีลูกค้า', tableId]);
    res.redirect('/table/' + tableId + '/payment/' + cart.Order_ID);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC05: เลือกช่องทางการชำระเงิน และชำระเงิน
async function expireOrder(order) {
  const cart = await getCart(order.Table_ID);
  if (cart) {
    await dbRun('UPDATE Order_Detail SET Order_ID = ? WHERE Order_ID = ?', [cart.Order_ID, order.Order_ID]);
    await dbRun('DELETE FROM "Order" WHERE Order_ID = ?', [order.Order_ID]);
    await recalcTotal(cart.Order_ID);
  } else {
    await dbRun('UPDATE "Order" SET Order_Status = ?, Reference_Code = NULL WHERE Order_ID = ?',
      [STATUS.CART, order.Order_ID]);
  }
}

router.get('/table/:tableId/payment/:orderId', async (req, res) => {
  const tableId = req.params.tableId;
  try {
    const table = await getTable(tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!table || !order) return res.redirect('/table/' + tableId + '/menu');

    if (order.Order_Status !== STATUS.WAIT_PAY) {
      return res.redirect('/table/' + tableId + '/order/' + order.Order_ID);
    }

    const age = await dbGet(
      "SELECT (julianday('now') - julianday(Order_Date_Time)) * 86400 AS sec FROM \"Order\" WHERE Order_ID = ?",
      [order.Order_ID]
    );
    const secondsLeft = Math.max(0, Math.floor(PAYMENT_TIMEOUT_MIN * 60 - age.sec));

    if (!order.Payment_ID && secondsLeft <= 0) {
      await expireOrder(order);
      return res.redirect('/table/' + tableId + '/cart?error=expired');
    }

    let method = req.query.method || null;
    if (order.Payment_Method === 'เงินสด' && !method) method = 'cash';

    let qrImage = null;
    if (method === 'qr') {
      const payload = 'MALA-PAY|REF:' + order.Reference_Code + '|AMOUNT:' + order.Total_Price;
      qrImage = await QRCode.toDataURL(payload, { width: 260, margin: 1 });
    }

    res.render('customer/payment', { table, order, method, qrImage, secondsLeft, hasPayment: !!order.Payment_ID });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/payment/:orderId/cash', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!order || order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        'INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status) VALUES (?, ?, ?, ?, ?)',
        [orderId, 'เงินสด', 0, 0, 'รอชำระ']
      );
    } else {
      await dbRun('UPDATE Payment SET Payment_Method = ?, Payment_Status = ? WHERE Order_ID = ?', ['เงินสด', 'รอชำระ', orderId]);
    }
    res.redirect('/table/' + tableId + '/payment/' + orderId + '?method=cash');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.post('/table/:tableId/payment/:orderId/qr', async (req, res) => {
  const { tableId, orderId } = req.params;
  try {
    const order = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [orderId]);
    if (!order || order.Order_Status !== STATUS.WAIT_PAY) return res.redirect('/table/' + tableId + '/order/' + orderId);
    const txn = 'TXN' + Date.now();
    const pay = await dbGet('SELECT * FROM Payment WHERE Order_ID = ?', [orderId]);
    if (!pay) {
      await dbRun(
        `INSERT INTO Payment (Order_ID, Payment_Method, Payment_Amount, Change_Amount, Payment_Status, Transaction_Ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, 'QR Code', order.Total_Price, 0, 'ชำระแล้ว', txn]
      );
    } else {
      await dbRun(
        `UPDATE Payment SET Payment_Method = ?, Payment_Amount = ?, Change_Amount = 0, Payment_Status = ?,
         Transaction_Ref = ?, Payment_Date_Time = CURRENT_TIMESTAMP WHERE Order_ID = ?`,
        ['QR Code', order.Total_Price, 'ชำระแล้ว', txn, orderId]
      );
    }
    await dbRun('UPDATE "Order" SET Order_Status = ? WHERE Order_ID = ?', [STATUS.PREPARING, orderId]);
    await cutStock(orderId);
    res.redirect('/table/' + tableId + '/order/' + orderId);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// UC07: ติดตามสถานะคำสั่งซื้อ และแสดงรายละเอียดออเดอร์
router.get('/table/:tableId/order/:orderId', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    const order = await getOrderFull(req.params.orderId);
    if (!table || !order || order.Order_Status === STATUS.CART) {
      return res.redirect('/table/' + req.params.tableId + '/menu');
    }
    res.render('customer/order', { table, order, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get('/table/:tableId/orders', async (req, res) => {
  try {
    const table = await getTable(req.params.tableId);
    if (!table) return res.status(404).send('ไม่พบโต๊ะ');
    const orders = await dbAll(
      `SELECT o.*, strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time
       FROM "Order" o
       WHERE o.Table_ID = ? AND o.Order_Status != ?
       AND date(o.Order_Date_Time, 'localtime') = date('now', 'localtime')
       ORDER BY o.Order_ID DESC`,
      [table.Table_ID, STATUS.CART]
    );
    res.render('customer/orders', { table, orders });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// API Polling สำหรับเช็คสถานะ
router.get('/api/order/:orderId', async (req, res) => {
  try {
    const order = await dbGet('SELECT Order_ID, Order_Status FROM "Order" WHERE Order_ID = ?', [req.params.orderId]);
    if (!order) return res.json({ ok: false });
    res.json({ ok: true, status: order.Order_Status, notify: notifyCount[order.Order_ID] || 0 });
  } catch (err) {
    res.json({ ok: false });
  }
});

module.exports = router;