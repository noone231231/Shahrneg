const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDb(){
  if(!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
      emoji TEXT NOT NULL DEFAULT '📦', description TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
      total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0)
    );
  `);
  const count = await pool.query('SELECT COUNT(*)::int AS c FROM products');
  if(count.rows[0].c === 0){
    const initial = [
      ['دفتر رنگی ۸۰ برگ','دفتر',85000,'📒','دفتر مناسب مدرسه و یادداشت روزانه',20],
      ['دفتر سیمی فانتزی','دفتر',125000,'📔','دفتر سیمی با طرح شاد',15],
      ['خودکار آبی','خودکار',25000,'🖊️','نوشتن روان برای استفاده روزمره',40],
      ['خودکار رنگی','خودکار',35000,'🖍️','مناسب یادداشت‌های رنگی',30],
      ['مداد مشکی HB','مداد',18000,'✏️','مداد HB برای مدرسه و طراحی',50],
      ['مداد رنگی ۱۲ رنگ','مداد',145000,'🌈','بسته ۱۲ رنگ',12],
      ['پاک‌کن سفید','پاک‌کن',20000,'◻️','پاک‌کن نرم و کم‌ریزش',35],
      ['پاک‌کن فانتزی','پاک‌کن',45000,'🧽','پاک‌کن فانتزی و دوست‌داشتنی',25]
    ];
    for(const p of initial) await pool.query('INSERT INTO products(name,category,price,emoji,description,stock) VALUES($1,$2,$3,$4,$5,$6)',p);
  }
}

app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:false}));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-only-change-this-secret', resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:1000*60*60*8}}));
// The HTML files are kept in the repository root so they can be uploaded easily from a phone.
app.get('/index.html',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/login.html',(req,res)=>res.sendFile(path.join(__dirname,'login.html')));
app.get('/admin.html',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
function admin(req,res,next){ if(!req.session.user || req.session.user.role!=='admin') return res.status(401).json({error:'ورود مدیر لازم است'}); next(); }
function cleanProduct(body){ const p={name:String(body.name||'').trim(),category:String(body.category||'').trim(),price:Number(body.price),emoji:String(body.emoji||'📦').trim()||'📦',description:String(body.description||'').trim(),stock:Number(body.stock)}; if(!p.name||!p.category||!Number.isInteger(p.price)||p.price<0||!Number.isInteger(p.stock)||p.stock<0)return null;return p; }

app.get('/api/products',async(req,res)=>{ try{const r=await pool.query('SELECT id,name,category,price,emoji,description,stock FROM products WHERE active=TRUE ORDER BY id DESC');res.json(r.rows);}catch(e){res.status(500).json({error:'خطا در دریافت محصولات'});} });
app.post('/api/orders',async(req,res)=>{
  const {customerName,phone,address,items}=req.body||{};
  if(!String(customerName||'').trim()||!String(phone||'').trim()||!String(address||'').trim()||!Array.isArray(items)||!items.length)return res.status(400).json({error:'اطلاعات سفارش کامل نیست'});
  const requested=new Map(); for(const item of items){const id=Number(item.productId),q=Number(item.quantity);if(!Number.isInteger(id)||!Number.isInteger(q)||q<1||q>99)return res.status(400).json({error:'اقلام سفارش نامعتبر است'});requested.set(id,(requested.get(id)||0)+q);}
  const client=await pool.connect();
  try{await client.query('BEGIN');let total=0,rows=[];for(const [id,q] of requested){const r=await client.query('SELECT id,name,price,stock FROM products WHERE id=$1 AND active=TRUE FOR UPDATE',[id]);const p=r.rows[0];if(!p)throw new Error('محصول پیدا نشد');if(p.stock<q)throw new Error(`موجودی «${p.name}» کافی نیست`);total+=p.price*q;rows.push({p,q});}
    const order=(await client.query('INSERT INTO orders(customer_name,phone,address,total,status) VALUES($1,$2,$3,$4,$5) RETURNING id',[String(customerName).trim(),String(phone).trim(),String(address).trim(),total,'new'])).rows[0];
    for(const r of rows){await client.query('INSERT INTO order_items(order_id,product_id,product_name,price,quantity) VALUES($1,$2,$3,$4,$5)',[order.id,r.p.id,r.p.name,r.p.price,r.q]);await client.query('UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2',[r.q,r.p.id]);}
    await client.query('COMMIT');res.status(201).json({ok:true,orderId:order.id,total});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'ثبت سفارش انجام نشد'});}finally{client.release();}
});
app.post('/api/setup-admin',async(req,res)=>{const{name,email,password,setupKey}=req.body||{};if(!process.env.SETUP_KEY||setupKey!==process.env.SETUP_KEY)return res.status(403).json({error:'کلید راه‌اندازی صحیح نیست'});if(!name||!email||!password||password.length<8)return res.status(400).json({error:'نام، ایمیل و رمز حداقل ۸ کاراکتری لازم است'});try{const exists=await pool.query('SELECT id FROM users WHERE email=$1',[String(email).toLowerCase()]);if(exists.rowCount)return res.status(409).json({error:'این ایمیل قبلاً ثبت شده'});const hash=await bcrypt.hash(password,12);await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin')",[name,String(email).toLowerCase(),hash]);res.json({ok:true});}catch(e){res.status(500).json({error:'ساخت مدیر انجام نشد'});}});
app.post('/api/login',async(req,res)=>{const email=String(req.body?.email||'').toLowerCase().trim(),password=String(req.body?.password||'');try{const r=await pool.query('SELECT id,name,email,password_hash,role FROM users WHERE email=$1',[email]);const u=r.rows[0];if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'ایمیل یا رمز عبور اشتباه است'});req.session.user={id:u.id,name:u.name,email:u.email,role:u.role};res.json({ok:true,user:req.session.user});}catch(e){res.status(500).json({error:'خطا در ورود'});}});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));
app.get('/api/admin/products',admin,async(req,res)=>{try{res.json((await pool.query('SELECT * FROM products ORDER BY id DESC')).rows);}catch(e){res.status(500).json({error:'خطا'});}});
app.post('/api/admin/products',admin,async(req,res)=>{const p=cleanProduct(req.body);if(!p)return res.status(400).json({error:'اطلاعات محصول نامعتبر است'});try{const r=await pool.query('INSERT INTO products(name,category,price,emoji,description,stock) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[p.name,p.category,p.price,p.emoji,p.description,p.stock]);res.status(201).json({id:r.rows[0].id});}catch(e){res.status(500).json({error:'ثبت محصول انجام نشد'});}});
app.put('/api/admin/products/:id',admin,async(req,res)=>{const p=cleanProduct(req.body);if(!p)return res.status(400).json({error:'اطلاعات محصول نامعتبر است'});try{const r=await pool.query('UPDATE products SET name=$1,category=$2,price=$3,emoji=$4,description=$5,stock=$6,updated_at=NOW() WHERE id=$7',[p.name,p.category,p.price,p.emoji,p.description,p.stock,Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:'محصول پیدا نشد'});res.json({ok:true});}catch(e){res.status(500).json({error:'ویرایش محصول انجام نشد'});}});
app.delete('/api/admin/products/:id',admin,async(req,res)=>{try{const r=await pool.query('UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1',[Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:'محصول پیدا نشد'});res.json({ok:true});}catch(e){res.status(500).json({error:'حذف محصول انجام نشد'});}});
app.get('/api/admin/orders',admin,async(req,res)=>{try{const orders=(await pool.query('SELECT * FROM orders ORDER BY id DESC')).rows;const items=(await pool.query('SELECT * FROM order_items ORDER BY id')).rows;const by=new Map();for(const i of items){if(!by.has(i.order_id))by.set(i.order_id,[]);by.get(i.order_id).push(i);}res.json(orders.map(o=>({...o,items:by.get(o.id)||[]})));}catch(e){res.status(500).json({error:'خطا در سفارش‌ها'});}});
app.patch('/api/admin/orders/:id',admin,async(req,res)=>{const allowed=['new','processing','shipped','done','cancelled'],status=String(req.body?.status||'');if(!allowed.includes(status))return res.status(400).json({error:'وضعیت نامعتبر است'});try{const r=await pool.query('UPDATE orders SET status=$1 WHERE id=$2',[status,Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:'سفارش پیدا نشد'});res.json({ok:true});}catch(e){res.status(500).json({error:'تغییر وضعیت انجام نشد'});}});

app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'login.html')));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

initDb().then(()=>app.listen(PORT,()=>console.log(`Shahrnegar running on port ${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
