const os = require('os');
const { dbAll, dbGet, dbRun } = require('../config/db');

const STATUS = {
  CART: 'ตะกร้า',
  WAIT_PAY: 'รอชำระเงิน',
  PREPARING: 'กำลังเตรียมอาหาร',
  COOKED: 'ปรุงเสร็จสิ้น',
  READY: 'พร้อมเสิร์ฟ',
  DONE: 'เสร็จสิ้น'
};

const SPICE_LEVELS = ['ไม่เผ็ด', 'เผ็ดน้อย', 'เผ็ดกลาง', 'เผ็ดมาก'];
const PAYMENT_TIMEOUT_MIN = 15;
const notifyCount = {};

function orderNo(ref) {
  return ref ? ref.replace('-', '') : '-';
}

function baht(n) {
  return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

function groupOf(categoryName) {
  if (categoryName === 'ซุป') return 'soup';
  if (categoryName === 'ของทานเล่น') return 'snack';
  if (categoryName === 'เครื่องดื่ม') return 'drink';
  return 'raw';
}

const CATEGORY_ICON = {
  'ซุป': '🍲', 'เนื้อสัตว์': '🥩', 'ซีฟู้ด': '🦐', 'ผัก': '🥬',
  'ลูกชิ้นและของแปรรูป': '🍢', 'เส้น': '🍜', 'อื่นๆ': '🥚',
  'ของทานเล่น': '🥟', 'เครื่องดื่ม': '🥤'
};

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function getBaseURL(req, port = 3000) {
  if (req.query.base) return req.query.base.replace(/\/$/, '');
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return 'http://' + getLocalIP() + ':' + port;
}

// Database Helper Queries
async function getTable(tableId) {
  return dbGet('SELECT * FROM "Table" WHERE Table_ID = ?', [tableId]);
}

async function getCart(tableId) {
  return dbGet(
    'SELECT * FROM "Order" WHERE Table_ID = ? AND Order_Status = ? ORDER BY Order_ID DESC LIMIT 1',
    [tableId, STATUS.CART]
  );
}

async function getOrCreateCart(tableId) {
  let cart = await getCart(tableId);
  if (!cart) {
    const r = await dbRun(
      'INSERT INTO "Order" (Table_ID, Order_Type, Total_Price, Order_Status) VALUES (?, ?, ?, ?)',
      [tableId, 'ทานที่ร้าน', 0, STATUS.CART]
    );
    cart = await dbGet('SELECT * FROM "Order" WHERE Order_ID = ?', [r.lastID]);
  }
  return cart;
}

async function getOrderItems(orderId) {
  return dbAll(
    `SELECT d.*, m.Menu_Name, m.Image_URL, m.Description, c.Category_Name
     FROM Order_Detail d
     JOIN Menu m ON d.Menu_ID = m.Menu_ID
     LEFT JOIN Category c ON m.Category_ID = c.Category_ID
     WHERE d.Order_ID = ?
     ORDER BY d.Order_Detail_ID`,
    [orderId]
  );
}

async function recalcTotal(orderId) {
  const row = await dbGet('SELECT IFNULL(SUM(Subtotal), 0) AS total FROM Order_Detail WHERE Order_ID = ?', [orderId]);
  await dbRun('UPDATE "Order" SET Total_Price = ? WHERE Order_ID = ?', [row.total, orderId]);
  return row.total;
}

async function getOrderFull(orderId) {
  const order = await dbGet(
    `SELECT o.*, t.Table_Number,
       strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
       strftime('%d/%m/%Y', o.Order_Date_Time, 'localtime') AS Order_Date,
       p.Payment_ID, p.Payment_Method, p.Payment_Amount, p.Change_Amount, p.Payment_Status, p.Transaction_Ref
     FROM "Order" o
     LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
     LEFT JOIN Payment p ON p.Order_ID = o.Order_ID
     WHERE o.Order_ID = ?`,
    [orderId]
  );
  if (!order) return null;
  order.items = await getOrderItems(orderId);
  return order;
}

async function getOrdersByStatus(statusList, search) {
  const marks = statusList.map(() => '?').join(',');
  let sql = `SELECT o.*, t.Table_Number,
       strftime('%H:%M', o.Order_Date_Time, 'localtime') AS Order_Time,
       (SELECT COUNT(*) FROM Order_Detail d WHERE d.Order_ID = o.Order_ID) AS Item_Count
     FROM "Order" o
     LEFT JOIN "Table" t ON o.Table_ID = t.Table_ID
     WHERE o.Order_Status IN (${marks})`;
  const params = [...statusList];
  if (search) {
    sql += ` AND REPLACE(o.Reference_Code, '-', '') LIKE ?`;
    params.push('%' + search.replace('-', '') + '%');
  }
  sql += ' ORDER BY o.Order_Date_Time ASC';
  const orders = await dbAll(sql, params);
  for (const o of orders) o.items = await getOrderItems(o.Order_ID);
  return orders;
}

async function makeReferenceCode(table) {
  const row = await dbGet(
    'SELECT COUNT(*) AS n FROM "Order" WHERE Table_ID = ? AND Reference_Code IS NOT NULL',
    [table.Table_ID]
  );
  return table.Table_Number + '-' + String(row.n + 1).padStart(3, '0');
}

async function cutStock(orderId) {
  const items = await dbAll('SELECT Menu_ID, Quantity FROM Order_Detail WHERE Order_ID = ?', [orderId]);
  for (const it of items) {
    await dbRun('UPDATE Menu SET Stock_Quantity = Stock_Quantity - ? WHERE Menu_ID = ?', [it.Quantity, it.Menu_ID]);
  }
  await dbRun('UPDATE Menu SET Is_Available = 0 WHERE Stock_Quantity <= 0');
}

async function getEmployee(role) {
  return dbGet('SELECT * FROM Employee WHERE Role = ? LIMIT 1', [role]);
}

module.exports = {
  STATUS, SPICE_LEVELS, PAYMENT_TIMEOUT_MIN, notifyCount, CATEGORY_ICON,
  orderNo, baht, groupOf, getLocalIP, getBaseURL,
  getTable, getCart, getOrCreateCart, getOrderItems, recalcTotal,
  getOrderFull, getOrdersByStatus, makeReferenceCode, cutStock, getEmployee
};