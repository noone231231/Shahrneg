# راه‌اندازی شهرنگار روی Render

این نسخه برای Node.js + PostgreSQL آماده شده است.

Environment Variables:
- DATABASE_URL = آدرس اتصال PostgreSQL
- SESSION_SECRET = یک رشته طولانی و تصادفی
- SETUP_KEY = یک کلید موقت برای ساخت مدیر
- NODE_ENV = production

Build Command: npm install
Start Command: npm start

بعد از Deploy، یک بار POST به `/api/setup-admin` با `name`, `email`, `password`, `setupKey` بزنید و سپس از `/login.html` وارد پنل شوید.
