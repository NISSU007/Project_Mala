// ===== นำเข้าโมดูล =====
const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');

// ===== นำเข้า Helpers =====
const { orderNo, baht, STATUS, CATEGORY_ICON, getLocalIP } = require('./utils/helpers');

// ===== ตั้งค่าแอป =====
const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== ตั้งค่า cookie-session =====
app.use(
  cookieSession({
    name: 'mala_session',
    keys: ['mala-secret-key-1', 'mala-secret-key-2'], // คีย์สำหรับเข้ารหัส session
    maxAge: 24 * 60 * 60 * 1000 // หมดอายุภายใน 24 ชั่วโมง
  })
);

// ===== ตัวแปรที่ใช้ได้ทุกหน้า EJS =====
app.locals.orderNo = orderNo;
app.locals.baht = baht;
app.locals.STATUS = STATUS;
app.locals.CATEGORY_ICON = CATEGORY_ICON;

// ===== นำเข้า Routes ที่แยกตาม Actors =====
const mainRoutes = require('./routes/main');
const customerRoutes = require('./routes/customer');
const cashierRoutes = require('./routes/cashier');
const kitchenRoutes = require('./routes/kitchen');
const counterRoutes = require('./routes/counter');

// ===== ใช้งาน Routes =====
app.use('/', mainRoutes);
app.use('/', customerRoutes);
app.use('/', cashierRoutes);
app.use('/', kitchenRoutes);
app.use('/', counterRoutes);

// ===== เริ่มเซิร์ฟเวอร์ =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('เปิดบนเครื่องนี้  : http://localhost:' + PORT);
  console.log('ให้มือถือสแกนผ่าน : http://' + getLocalIP() + ':' + PORT + '/qr');
});