# 🔍 گزارش کامل بررسی، تحلیل و ممیزی پروژه — سیستم حسابداری فروشگاهی V42

**تاریخ ممیزی:** ۲۳ اوت ۲۰۲۶ (۱ شهریور ۱۴۰۵)
**دامنه بررسی:** کل ریپازیتوری — بک‌اند (`server.ts` + `src/routes`, `src/middleware`, `src/db`)، سرویس‌های بیزینسی (`src/services`)، فرانت‌اند (`src/App.tsx`, `src/hooks`, `src/components`)، زیرساخت و بهداشت ریپو
**روش:** بازبینی خط‌به‌خط کد توسط ۴ جریان موازی (امنیت بک‌اند / منطق مالی و داده / معماری فرانت / زیرساخت) + تأیید دستی یافته‌های کلیدی

> ⚠️ **جمع‌بندی یک‌خطی:** سیستم دارای **حداقل ۱۵ حفره امنیتی بحرانی** است که مهم‌ترین آن‌ها «احراز هویت fail-open» است؛ یعنی در وضعیت فعلی **هر کسی که به سرور دسترسی شبکه داشته باشد، بدون هیچ توکنی ادمین کامل است**. علاوه بر آن، چند باگ منطق مالی وجود دارد که می‌تواند داده‌های حسابداری را بی‌صدا خراب کند. استقرار عمومی این نسخه **ممنوع** است تا فاز ۱ نقشه راه (بخش ۸) تکمیل شود.

---

## فهرست

1. [خلاصه اجرایی](#۱-خلاصه-اجرایی)
2. [نمای کلی معماری و ارزیابی آن](#۲-نمای-کلی-معماری)
3. [باگ‌های بحرانی امنیتی — P0](#۳-باگ‌های-بحرانی-امنیتی--p0)
4. [باگ‌های بحرانی منطق داده و مالی — P0](#۴-باگ‌های-بحرانی-منطق-داده-و-مالی--p0)
5. [مشکلات High — P1](#۵-مشکلات-high--p1)
6. [مشکلات Medium و Low — P2/P3](#۶-مشکلات-medium-و-low--p2p3)
7. [بدهی فنی ساختاری و بهداشت ریپو](#۷-بدهی-فنی-ساختاری-و-بهداشت-ریپو)
8. [جدول اولویت‌بندی نهایی + نقشه راه اصلاح](#۸-جدول-اولویت‌بندی-و-نقشه-راه)
9. [پیشنهادات ارتقا و نیازهای سیستم](#۹-پیشنهادات-ارتقا-و-نیازهای-سیستم)
10. [نقاط قوت فعلی](#۱٠-نقاط-قوت-فعلی)

---

## ۱. خلاصه اجرایی

| حوزه | وضعیت | خلاصه |
|---|---|---|
| امنیت بک‌اند | 🔴 بحرانی | احراز هویت fail-open، اندپوینت اجرای SQL خام، تزریق SQL از طریق کلیدهای JSON، زنجیره RCE از مسیر بکاپ/ریستور |
| صحت داده مالی | 🔴 بحرانی | نوشته‌های ناموفق بی‌صدا گم می‌شوند، تراکنش‌های چندجدولی غیراتمیک، اعتبارسنجی تراز بدهکار/بستانکار غایب، ماشین‌حالت چک کامنت شده |
| معماری فرانت‌اند | 🟠 ضعیف | App.tsx مونولیت ۲۵۰۰ خطی + هوک کنترلری با ۱۰۲ `useState`؛ code-splitting عملاً غیرفعال؛ هیچ Error Boundary وجود ندارد |
| کارایی | 🟠 ضعیف | ریفچ ۱۶ کالکشن بعد از هر تغییر، محاسبه مانده O(اشخاص×اسناد×اقلام) در هر رندر، بدون virtualization |
| زیرساخت/تست | 🟠 ضعیف | صفر تست قابل اجرا (jest نصب ولی بدون config)، دو lockfile رقیب، tsconfig بدون `strict` |
| بهداشت ریپو | 🔴 بد | ۲۱۶ اسکریپت یک‌بارمصرف fix/patch/test در ریشه (~۴۰٪ فایل‌های tracked)، `data.json` حاوی هش پسورد در git |

---

## ۲. نمای کلی معماری

```
React 19 + Vite + Tailwind4 + zustand/RQ   ←  SPA (فارسی/RTL)
        │ fetch (بدون لایه typed client)
Express 4 (routes: auth, data, database, backup, migration, reports, system, setup, misc)
        │
Drizzle ORM ── PostgreSQL (per-store pools) + الگوی KV («JSON در جدول»)
Cron jobs (node-cron) + Sync Worker (setInterval 10s) + صف آفلاین کلاینت
Sentry (کلاینت+سرور)، JWT Access/Refresh، bcryptjs
```

**ارزیابی:** انتخاب‌ها (Postgres، Drizzle، RQ، zustand، Sentry، RTL فارسی) درست هستند، اما سه انحراف بزرگ ساختاری همه مشکلات را تغذیه می‌کنند:
1. **الگوی KV عمومی روی دیتابیس رابطه‌ای** (`/api/data/:key` + `kv-store.ts`): هر جدول = JSON آزاد → اعتبارسنجی ضعیف، تزریق identifier (بخش ۳-S4)، بازنویسی TRUNCATE+INSERT به‌جای INSERT (بخش ۴-D7).
2. **منطق مالی سمت کلاینت**: شمارش شماره سند، محاسبه مانده، backfill اقساط — همگی در مرورگر → race condition و drift.
3. **هوک خدا (`useAppController`)**: ۱۰۲ state، ایمپورت استاتیک تقریباً همه ۱۰۹ کامپوننت lazy → re-render سراسری و شکست code-splitting.

---

## ۳. باگ‌های بحرانی امنیتی — P0

> همه موارد زیر **دستی تأیید شده‌اند**. ترکیب S1+S2 یعنی takeover کامل سیستم با یک درخواست HTTP.

### S1. احراز هویت fail-open — همه درخواست‌ها ادمین می‌شوند ⛔ (بحرانی‌ترین باگ پروژه)
- **فایل:** `src/middleware/auth.middleware.ts:17-19` و `:34-37`
- **شرح:** اگر توکن نباشد یا verify شود، middleware یک هویت جعلی `{ role: 'admin' }` می‌سازد و `next()` می‌کند:
  ```ts
  if (!token) { req.user = { id:'admin-default', username:'admin', role:'admin' }; return next(); }
  } catch(e) { req.user = { ...role:'admin' }; next(); } // توکن نامعتبر هم ادمین!
  ```
- **اثر:** تمام APIها (فاکتور، چک، کاربران، بکاپ، SQL) عملاً public با دسترسی کامل ادمین هستند.
- **اصلاح:** هر دو شاخه `return res.status(401).json({error:'Unauthorized'})`. هیچ‌وقت هویت نسازید. تست integration بنویسید که توکن غایب/گندیده → 401.

### S2. تصاحب حساب ادمین بدون احراز هویت از `/api/setup/admin`
- **فایل:** `src/routes/setup.routes.ts:69-98` (+ whitelist در `auth.middleware.ts:5`)
- **شرح:** اگر کاربری با آن username یا نقش admin موجود باشد، **username و password همان کاربر بازنویسی می‌شود**؛ وگرنه ادمین جدید ساخته می‌شود. هیچ گارد «setup انجام شده» وجود ندارد.
- **اصلاح:** فقط وقتی `users.length === 0` اجرا شود + bootstrap token که فقط یک‌بار در کنسول سرورِ اولین اجرا چاپ می‌شود؛ سپس hard-reject.

### S3. اندپوینت اجرای SQL خام: `/api/db/execute`
- **فایل:** `src/routes/system.routes.ts:270-295`
- **شرح:** `req.body.query` مستقیم روی pool فعال اجرا می‌شود؛ وقتی `params` نفرستیده شود pg از simple protocol استفاده می‌کند → **multi-statement** ممکن است (`; DROP TABLE ...`). چک `isSelect` صرفاً نمایشی است.
- **اصلاح:** حذف کامل. اگر ابزار debug لازم است: env-flag + نقش ادمین واقعی + کاربر DB فقط‌خواندنی.

### S4. تزریق SQL از طریق کلیدهای JSON → DDL
- **فایل ریشه مشکل:** `src/db/schema-sync.ts:51`:
  ```ts
  await client.query(`ALTER TABLE "${tableName}" ADD COLUMN "${k}" ${colType}`);
  ```
  کلید `k` از body کلاینت می‌آید. چون ALTER پارامتر bind ندارد، simple protocol فعال است → با کلیدی مثل `` inj" ; DROP TABLE users; -- `` اجرای SQL دلخواه. همین الگوی interpolation شناسه‌ها در: `data.routes.ts:147-148,161-162,189-191,267-269,282-283,348-350`، `kv-store.ts:95-97,105-107`، `migration.routes.ts:90-92,101-103`.
- **اصلاح:** اعتبارسنجی سخت‌گیرانه identifier: `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/` و در صورت تخلف 400. (مقادیر همه‌جا parameterized هستند ✓ — فقط شناسه‌ها مشکل دارند.)

### S5. زنجیره RCE معادل: آپلود بکاپ → ریستور `.sql` = اجرای محتوای فایل به‌عنوان SQL
- **فایل:** `backup.routes.ts:478-496` (آپلود با محتوای دلخواه) → `backup.routes.ts:275-306` (خط 286: `pool.query(fileContent)` بدون پارامتر).
- **همچنین:** ریستور JSON خط 294 قبل از re-insert همه جداول را `TRUNCATE ... CASCADE` می‌کند ولی **در یک تراکنش نیست** → یک JSON خراب = دیتابیس پاک‌شده و نیمه‌کاره.
- **اصلاح:** اجرای `.sql` هرگز؛ ریستور فقط از snapshot ساختاریافته JSON از طریق pipeline معمول `setDbData` داخل یک تراکنش واحد.

### S6. مسیر بکاپ تحت کنترل مهاجم → خواندن/نوشتن/حذف فایل دلخواه + سرقت کامل دیتابیس به cloud خودش
- **فایل:** `backup.routes.ts:243-251` (`POST /api/db/backup-config` هر فیلدی incl. `path`، `cloudAuthUrl`، `cloudUser/Pass` را merge می‌کند) → نتیجه: `download/:filename` (خط 316-326) هر فایل هاست، `DELETE` (خط 328-339) حذف فایل دلخواه، `upload` نوشتن هرجا؛ و با `storageType:'cloud'` هر بکاپ (شامل hash پسوردها) به S3 مهاجم آپلود می‌شود (خطوط 122-145).
- **اصلاح:** قفل کردن root بکاپ به ثابت سمت‌سرور (رد path خارج از آن)، ممنوعیت تغییر credential ابری بدون re-auth، allowlist هاست S3.

### S7. لیست‌کردن دایرکتوری دلخواه filesystem
- **فایل:** `backup.routes.ts:498-514` (`/api/db/explore-folders`) و `system.routes.ts:182-192` (`/api/sys/dirs`)
- **اصلاح:** حذف؛ یا محدود به داخل root بکاپ.

### S8. اندپوینت‌های عمومیِ پیکربندی دیتابیس → ریدایرکت DB به سرور مهاجم + SSRF + تزریق در CREATE DATABASE
- **فایل:** whitelist در `auth.middleware.ts:5` شامل `/api/db/config` و `/api/db/test`؛ پیاده‌سازی `system.routes.ts:194-247` (connectionString دلخواه → ذخیره و repoint pool + خط 216 `CREATE DATABASE "${dbName}"` بدون escape) و `:249-263` (اتصال به host/port دلخواه + echo خطای driver).
- **اصلاح:** خارج کردن از public paths؛ فقط در setup اولیه + bootstrap secret؛ اعتبارسنجی dbName با `[A-Za-z0-9_]`؛ پیام خطای عمومی.

### S9. دور زدن ایزوله‌سازی tenant (multi-store)
- **فایل:** `store-context.middleware.ts:5` — `storeId` مستقیم از header `x-store-id` گرفته می‌شود و با هویت کاربر تطبیق داده نمی‌شود؛ `connection.ts:76-96` هر business row را بار می‌کند.
- **باگ جانبی:** برای storeId ناشناخته، `connection.ts:100-101` فلگ PG را false می‌کند و `kv-store.ts:54-66` بی‌صدا روی `data.json` لوکال می‌نویسد → داده tenant اشتباه ذخیره می‌شود.
- **اصلاح:** جدول store-memberships + رزولوشن سمت سرور از روی principal احرازشده؛ 403 در مغایرت؛ حذف fallback JSON.

### S10. افشای اسرار و hash/OTP از طریق API
- `database.routes.ts:49-58,97,186,191`: `db_password` plaintext ذخیره و **در پاسخ GET/PUT برمی‌گردد**.
- `GET /api/data/users` → SELECT * شامل **bcrypt hash** و **currentOTP** (کد 2FA در انتظار!) → 2FA عملاً بی‌معنا.
- **اصلاح:** انتخاب ستون‌های صریح؛ حذف password/currentOTP قبل از res.json؛ credentials دیتابیس فقط سمت سرور.

### S11. Secret های JWT هاردکد/fallback
- `auth.middleware.ts:23-24` (`'super-secret-jwt-key-2024'`, `'super-secret-jwt-refresh-key-2024'`)، `auth.routes.ts:70-71,116,139` (`|| 'default_secret'`)، `data.routes.ts:395,401`.
- **اثر:** هرکس این stringهای public را بداند JWT `role:"admin"` می‌سازد.
- **اصلاح:** بدون default — در نبود/ضعف secret، startup باید crash کند.

### S12. ساخت خودکار ادمین پیش‌فرض admin/admin
- **فایل:** `auth.routes.ts:30-50` — هر مسیری که getUsers را صدا بزند (حتی login ناموفق) در دیتابیس خالی ادمین با پسورد known می‌سازد.
- **اصلاح:** حذف auto-create؛ اجبار به setup wizard؛ block login تا وقتی ادمین وجود ندارد.

### S13. 2FA تزئینی + باگ واقعی در flow
- `auth.routes.ts:100-107`: OTP با `Math.random()` ساخته، در console لاگ، و **در بدنه پاسخ login برگردانده می‌شود** («جهت تست»!).
- `auth.routes.ts:106 vs 116`: tempToken با `'super-secret-jwt-key-2024'` امضا ولی با `'default_secret'` verify می‌شود → **وقتی JWT_SECRET تنظیم نشده باشد همه logins دو مرحله‌ای fail می‌شوند**.
- **اصلاح:** OTP با `crypto.randomInt`، ارسال out-of-band (SMS/ایمیل)، هرگز echo نشود؛ هر توکن با secret اختصاصی خودش verify شود.

### S14. عدم وجود rate-limit، helmet و CORS policy
- grep کل ریپو: هیچ `express-rate-limit`/`helmet`/`cors` وجود ندارد. Login بدون brute-force protection + سیگنال enumeration (401 فوری برای user ناشناس در `auth.routes.ts:84`، 403 متفاوت برای disabled در :85، ~100ms bcrypt برای موجود).
- **اصلاح:** helmet + rate-limit روی `/api/auth/*` (per IP+username) + پیام خطای یکسان و زمان‌بندی یکنواخت + lockout اختیاری.

### S15. مدیریت session ضعیف
- Refresh token روی `/api/auth/refresh` **rotate نمی‌شود** (`auth.routes.ts:134-151`)؛ `tokenVersion` check می‌شود ولی هیچ‌جا bump نمی‌شود → **هیچ مسیر revoke واقعی وجود ندارد**؛ کوکی دزدیده ۷ روز معتبر است.
- Middleware refresh-token را با access-secret هم قبول می‌کند (`auth.middleware.ts:26-32`) → توکن ۷روزه به‌جای access token قابل استفاده است.
- **اصلاح:** rotation با jti جدید + persist؛ bump tokenVersion در logout/تغییر پسورد؛ verifier جدا برای هر نوع توکن.

---

## ۴. باگ‌های بحرانی منطق داده و مالی — P0

### D1. گم شدن بی‌صدای نوشته‌های حسابداری (data-loss cascade)
- **فایل:** `coreService.ts:125-148` (`saveLocalData`)، `:150-172` (`updateLocalData`)، `:174-191` (`appendLocalData`)
- **شرح:** روی 401، `saveLocalData` فقط `return;` (:136) — از نظر UI موفق؛ `updateLocalData`/`appendLocalData` ورودی خود caller را برمی‌گردانند انگار server ack کرده (:160,184). بعد از retry ها فقط `console.error`. خواندن هم روی 401 مقدار پیش‌فرض برمی‌گرداند (:99-101). retry بدون idempotency key → POST تایم‌اوت‌شده می‌تواند double-commit شود.
- **سناریو:** ثبت فاکتور/رسید در لحظه انقضای توکن → کاربر فکر می‌کند ثبت شد؛ داده هرگز نرسید. گزارش‌ها و مانده‌ها بی‌صدا غلط.
- **اصلاح:** type برگشتی `{ok,error}`؛ در 401 force sign-out؛ idempotency key برای retry ها؛ UI موظف به نمایش خطا.

### D2. ماشین‌حالت چک کامنت شده — حرکت غیرمجاز بین وضعیت‌ها آزاد
- **فایل:** `data.routes.ts:249-251` و `:322-324` (تأیید شد؛ جدول‌های allowed در :227-248 و :300-321 محاسبه می‌شوند ولی enforcement کامنت است):
  ```
  // if (!allowed.includes(updatedItem.status)) {
  //    return res.status(400).json(...)
  // }
  ```
- **اثر:** مثلاً چک «وصول‌شده» می‌تواند به «blank» برگردد → گزارش دریافت‌ها/پرداخت‌ها و aging خراب.
- **اصلاح:** فعال‌سازی گارد + تست.

### D3. عدم اعتبارسنجی تراز بدهکار/بستانکار در اسناد حسابداری
- **فایل:** `accountingService.ts:618-650` — فقط تاریخ/شماره سند/ارز بررسی می‌شود و append می‌شود؛ جمع debit == credit هیچ‌جا چک نمی‌شود.
- **اثر:** امکان ثبت سند نامتوازن → تراز آزمایشی و سود/زیان غلط.
- **اصلاح:** validation سمت سرور (نه فقط UI): `abs(sum(debit)-sum(credit)) < ε` قبل از persist.

### D4. تراکنش خیالی جریمه دیرکرد (phantom transaction)
- **فایل:** `installmentPaymentService.ts:211-226` — جریمه با `resourceId: 'penalty-virtual'` ثبت می‌شود که به هیچ قسط/وام واقعی وصله؛ تسویه بعدی نمی‌تواند آن را match کند.
- **مرتبط M8:** نسبت دادن اشتباه رسید به قسط (`:229-240`)؛ کامنت توسعه‌دهنده خودش در خط 232 اذعان دارد راه robust‌تری لازم است.
- **اصلاح:** جریمه به‌صورت line item روی همان قسط یا سند جدا با resourceId واقعی؛ الگوریتم allocation قطعی (قدیمی‌ترین قسط اول).

### D5. تبدیل تاریخ ناموفق → بی‌صدا «امروز»
- **فایل:** `format.ts:151,191,196` — `convertToGregorian` در همه مسیرهای شکست `new Date().toISOString()` برمی‌گرداند.
- **اثر:** سررسید چک/قسط با string خراب → بی‌صدا امروز ثبت می‌شود → هشدارها و گزارش aging غلط.
- **اصلاح:** return `null` + اجبار به validation در caller + لاگ ورودی مشکل‌دار. بلندمدت: مهاجرت به `date-fns-jalali` یکپارچه و حذف تبدیل‌های regex-محور پراکنده.

### D6. نوشته‌های چندجدولی غیراتمیک → داده یتیم
- **فایل:** `data.routes.ts:148-163` (parent invoice upsert، سپس DELETE فرزندان با empty-catch در :155، سپس INSERT اقلام)، `:264-285`، و `setDbData` در `kv-store.ts:190-221` که فرزند را قبل از والد می‌نویسد.
- **اثن:** crash وسط عملیات = فاکتور بدون قلم یا قلم بدون فاکتور.
- **اصلاح:** الگوی موجود در `innerSetDbData` (`kv-store.ts:74-118`: BEGIN/COMMIT/ROLLBACK با release تضمینی) به همه composite write ها تعمیم یابد — یک client، BEGIN، والد+فرزند، COMMIT.

### D7. Lost-update روی append و لاگ‌ها (TRUNCATE+reinsert)
- **فایل:** `kv-store.ts:87-88` — هر save = خواندن کل کالکشن + TRUNCATE + reinsert. دو concurrent `POST /append` → نوشته یکی بی‌صدا حذف می‌شود. لاگ‌ها هم همین‌طور (`data.routes.ts:181-194,340-353,437-441`، `backup.routes.ts:44-59`؛ cap=200 باعث evict تاریخچه واقعی؛ attribution گاهی به `userId:'system'` تنزل می‌یابد :392-404).
- **اصلاح:** log = INSERT تک‌ردیفی append-only؛ برای entity ها version column + optimistic locking یا `SELECT ... FOR UPDATE`.

### D8. Race شماره سند + دو سیستم شماره‌گذاری موازی
- **فایل:** `coreService.ts:258-335` (read-modify-write روی `doc_counters` بدون lock؛ fallback خواندن همه فاکتورها برای max در :282-299) + پیاده‌سازی مجدد سمت کلاینت برای رسیدها (`useAppController.tsx:2640-2673`) + fallback دوم در `accountingService.ts:632-635` (`maxDocNum+1`).
- **اثر:** دو کلاینت همزمان → شماره سند تکراری؛ drift بین دو سیستم.
- **اصلاح:** اندپوینت اتمیک سمت سرور (`UPDATE doc_counters SET val=val+1 WHERE key=$1 RETURNING val`) و حذف منطق‌های کلاینت.

### D9. بلعیده شدن خطاهای سرویس فاکتور
- **فایل:** `invoiceService.ts:409` — `} catch(e) {}` دور تولید سند حسابداری خودکار → فاکتور ثبت می‌شود ولی voucher نه، بی‌任何 خبر. (۵ empty catch در همین فایل؛ مجموعاً ده‌ها مورد در routes/db.)
- **مرتبط H1b:** پرداخت با روش چک در `invoiceService.ts:312-313` early-return می‌کند و `syncInvoiceAllocations` (بعد از try/catch در :411) اجرا نمی‌شود → allocation ها sync نمی‌مانند.
- **اصلاح:** حداقل log + propagate؛ تصمیم محصولی: فاکتور بدون voucher اصلاً commit نشود (تراکنش واحد).

---

## ۵. مشکلات High — P1

### فرانت‌اند

| # | مشکل | محل | شرح/اصلاح |
|---|---|---|---|
| F1 | شکست کامل code-splitting | `App.tsx:228` + `useAppController.tsx` | هوک کنترلری تقریباً همه ۱۰۹ کامپوننت lazy را static import کرده + xlsx(:128), react-barcode(:42), motion(:130), html2pdf(:155), recharts. App.tsx هم جداگانه Barcode(:12), XLSX(:98), recharts(:101-113), html2pdf(:125) را eager import می‌کند → entry chunk = تقریباً کل برنامه. **اصلاح:** حذف import های تکراری از هوک؛ `await import('xlsx')` داخل handler ها |
| F2 | صفر Error Boundary در کل frontend | grep سراسری: هیچ | Sentry بدون `Sentry.ErrorBoundary` init شده (`main.tsx:15-30`)؛ هر exception در render = white screen دائمی. **اصلاح:** wrap `<App/>` و هر route cluster |
| F3 | کرش boot با localStorage خراب | `AuthContext.tsx:50-58` | `JSON.parse(storedUser)` بدون try/catch + ترکیب F2 → app تا پاک‌شدن دستی storage بالا نمی‌آید؛ token هم expiry-check نمی‌شود. |
| F4 | «Refetch the world» + double-fetch در boot | `useAppController.tsx:3722-3789` | هر write → event `app_data_changed` → refetch **۱۶ کالکشن** (debounce 300ms)؛ در boot هم `fetchData()` بعدش `fetchDataSilent()` await می‌شود → هر کالکشن ۲ بار (~۳۲ درخواست). سه event-bus موازی window وجود دارد. **اصلاح:** مهاجرت به React Query invalidateQueries هدفمند (RQ نصب است؛ الگوی درستش در `CheckManagement.tsx:52-77` پیاده شده!) |
| F5 | God hook: ۱۰۲ useState (تأیید شد) | `useAppController.tsx:323+` | هر keystroke = re-render کل tree؛ `<PreviewModals {...appState}/>` کل bag را spread می‌کند (`App.tsx:2577-2578`). **اصلاح:** شکستن به zustand slices + selector ها |
| F6 | محاسبه مانده O(P×D×I) در هر رندر | `useAppController.tsx:6060-6102` + `PersonsManager.tsx:171-196` | useMemo هرگز hit نمی‌شود چون identity تابع و آرایه هر render عوض می‌شود. **اصلاح:** precompute `Map<personId,balance>` یک‌بار به‌ازای تغییر documents |
| F7 | N² اسکن وضعیت انبار در InvoicesList | `InvoicesList.tsx:29-94,116,128,140,672,771` | برای هر tab-count/row/button کل invoices×products فیلتر می‌شود. **اصلاح:** Map یک‌باره |
| F8 | migration سمت کلاینت در هر boot | `main.tsx:85-98` + `backfillInstallmentCodes.ts` | load همه اقساط+وام‌ها و re-save کل کالکشن در هر page load → lost-update بین تب‌های همزمان. **اصلاح:** یک‌بار سمت سرور با version marker |
| F9 | ورودی مبلغ بدون گارد NaN/منفی | `useAppController.tsx:2679` | validation صرفاً truthiness → `-100` رد می‌شود، `amount: Number('')`=null در JSON. (کامپوننت درست `common/CurrencyInput.tsx` وجود دارد ولی twin بدون گارد هم هست.) |

### بک‌اند

| # | مشکل | محل | اصلاح |
|---|---|---|---|
| B1 | نوشتن ungated روی هر کالکشن | `data.routes.ts:364-454` (`:key` generic بدون KNOWN_TABLES) + batch (:65-117) | bypass هش bcrypt (نوشتن users با plaintext/جایگزینی admin). هش فقط روی chain خاص `POST /api/data/users` (:24-39). **اصلاح:** allowlist writable collections per role؛ هش مرکزی در persistence layer |
| B2 | SSRF در connection tester ها | `migration.routes.ts:33-43`، `system.routes.ts:249-263`، `database.routes.ts:134-157` | admin-only + block private ranges + خطای عمومی |
| B3 | Path traversal (پسوند-constrained) | `database.routes.ts:195-226` | id از URL مستقیم در path.join → حذف فایل `<cwd>/../../target.sqlite`. validate: `^[A-Za-z0-9_-]+$` |
| B4 | Cron job به DB اشتباه وصل است | `db/index.ts:7-9` + `checkNotificationsJob.ts:31,53` | pool جدا از DATABASE_URL (یا dummy!) در حالی که runtime data در per-store pools است → نوتیفیکیشن چک‌ها علیه DB خالی/غلط. **اصلاح:** استفاده از active store pools |
| B5 | sync-worker ریسک unhandled rejection | `sync-worker.ts:5-11` | `processQueue` async بدون await/catch در interval callback. **اصلاح:** wrap + log |
| B6 | لاگ شدن پسورد | `auth.routes.ts:75` | `console.log('Login attempt body:', req.body)` — حذف فوری |

---

## ۶. مشکلات Medium و Low — P2/P3

| # | شدت | مشکل | محل | اصلاح |
|---|---|---|---|---|
| M1 | Med | گارد prefix به‌جای path.relative | `backup.routes.ts:280,321,333` | `path.relative(dir,f)` و رد اگر با `..` شروع شود |
| M2 | Med | Body limit 50MB JSON / **500MB text** (که `application/json` را هم می‌گیرد!) | `server.ts:48-49` | کاهش به 1-2MB؛ حذف overlap |
| M3 | Med | افشای err.message داخلی (SQL/path) به کلاینت | ده‌ها handler: `setup.routes.ts:52,96`; `data.routes.ts:61,115,...`; `backup.routes.ts:312,324,...` | log سمت سرور + `{error:'Internal error',correlationId}` |
| M4 | Med | empty catch های مخرب | `database.routes.ts:44,89,116,219,291`; `kv-store.ts:12,62,125`; `schema-sync.ts:37,53-55`; `invoiceService.ts`(۵ مورد) | حداقل log با context؛ بعضی propagate |
| M5 | Med | جعل/evict لاگ audit از endpoint عمومی | `backup.routes.ts:70-78` | internal-only + append-only |
| M6 | Med | GRANT ALL ON SCHEMA public TO PUBLIC | `schema-sync.ts:63` | grant فقط به app role؛ اجرا با least-privilege user (C3/C5 را هم کور می‌کند) |
| M7 | Med | ID های `Math.random().toString(36)` | `setup.routes.ts:82`; `data.routes.ts:92,130,183,342,406`; `kv-store.ts:101,135,...`; `migration.routes.ts:97`; `Date.now()` در `backup.routes.ts:50` | `crypto.randomUUID()` |
| M8 | Med | ناسازگاری prefix هش `$2a$/$2y$` | `auth.routes.ts:88`, `data.routes.ts:29` (فقط `$2b$`) | regex `/^\$2[aby]\$/` |
| M9 | Med | egress داده به AI ثالث + JSON.parse unchecked | `misc.routes.ts:64-94` (`text.pollinations.ai`) | provider config-approved + validate shape |
| M10 | Med | catch-all API → HTML 200 به‌جای 404 | `server.ts:78-80` | روت `/api/*` ناشناس → 404 JSON قبل از SPA fallback |
| M11 | Low-Med | duplicate-check همه نوتیفیکیشن‌ها را load و در JS فیلتر می‌کند؛ fallback email هاردکد `admin@example.com` | `checkNotificationsJob.ts:79-85,103` | فیلتر SQL date + config email |
| L1-L7 | Low | fingerprint سرور (`setup.routes.ts:56-67`)؛ zod v4 `e.errors`→undefined (باید `issues`) در `auth.routes.ts:77`؛ getAllDbData کامل در حافظه per stats/backup (`backup.routes.ts:111,355,373`)؛ race auto-create DB در cold-start (`connection.ts:127-138`)؛ افشای وجود/username ادمین (`setup.routes.ts:42-50`) | — | مطابق شرح |
| L3 | Low | input mutation: `doc.date` caller mutate می‌شود | `accountingService.ts:620` | clone ورودی |
| L4 | Low | triple version drift | `generate-version.js:4` ('1.0.0') vs `version.ts:1` ('0.0.0') vs package.json '0.0.0' | single source of truth |

---

## ۷. بدهی فنی ساختاری و بهداشت ریپو

### 7.1 آشغال‌های ریشه (بحرانی از نظر maintainability)
- **۲۱۶ اسکریپت یک‌بارمصرف** در ریشه: ۴۰× `fix_*`، ۹۷× `patch_*`، ۴۲× `test-*`/`test_*`، ۳۷× `.py` → **~۹۲٪ فایل‌های ریشه** و **~۴۰٪ کل ۵۳۹ فایل tracked**. همچنین `src/App.tsx.cleaned` داخل src.
- **اقدام:** آرشیو کردن همه در branch/تگ جدا و حذف از main؛ روند اصلاحات آینده از طریق PR و git history، نه اسکریپت patch در ریشه.

### 7.2 اسرار و داده حساس در git
- `data.json` (۶۴KB) **tracked** شامل **bcrypt hash پسورد** (خط ۹۷) + config بکاپ + لاگ‌ها.
- `db_config.json` شامل **credential plaintext Postgres** (`postgres:84315308@localhost...`) — الان untracked ولی یک `git add .` از leak فاصله دارد. **پسورد باید rotate شود.**
- `backups/` و `my_backups/` (۱۷ فایل stub) tracked. Firebase config tracked (کم‌خطر ولی شناسایی‌پذیر).
- **اقدام:** پاکسازی تاریخچه (git filter-repo/BFG) برای data.json؛ rotate پسورد PG؛ افزودن به .gitignore: `*.sqlite*`, `db_config.json`, `data.json`, `backups/`, `my_backups/`.

### 7.3 وابستگی‌ها
| مشکل | جزئیات | اقدام |
|---|---|---|
| 🔴 `xlsx@0.18.5` | unmaintained + آسیب‌پذیری‌های شناخته‌شده (CVE-2023-30533 prototype pollution، CVE-2024-22363 ReDoS) — استفاده در `exportUtils.ts:1`, `App.tsx:98`, `useAppController.tsx:128` | جایگزینی با `exceljs` یا `sheetjs` از CDN رسمی |
| 🟠 firebase + firebase-admin همزمان | client SDK در bundle کلاینت + admin SDK سمت سرور (`lib/firebase-admin.ts`, `middleware/auth.ts`) | بررسی ضرورت؛ اگر admin فقط server-side است lazy-load شود؛ در غیر این صورت حذف یکی |
| 🟠 دو lockfile رقیب | `bun.lock` (131KB) + `package-lock.json` (334KB)؛ npm آخرین installer بوده → install غیرقابل‌تکرار | انتخاب یک PM (npm یا bun) و حذف دیگری + CI enforcement |
| 🟡 jest+ts-jest نصب، **صفر تست قابل اجرا** | بدون script `test`، بدون jest.config؛ تنها ۱ تست واقعی (`__tests__/loanStateMachine.test.ts`) که اصلاً run نمی‌شود | بخش ۹-فاز ۳ |
| 🟡 vite/@vitejs-plugin-react/@tailwindcss-vite در dependencies به‌جای devDependencies | package.json:28,31,60 | جابجایی |
| 🟡 node-cron v4 + @types/node-cron v3 | v4 تایپ خودش را دارد | حذف types |
| Info | name=`react-example`, version=0.0.0 | اصلاح هویت پکیج |

### 7.4 پیکربندی build/runtime
- `tsconfig.json` **بدون `strict`** (نه noImplicitAny/noUnusedLocals) + `skipLibCheck` → type-safety اسمی. فعال‌سازی تدریجی strict.
- `PORT` هاردکد 3000 (`server.ts:45,83`)، بدون graceful shutdown (SIGTERM/SIGINT/server.close/pool.end)، `startServer()` floating promise بدون catch (`server.ts:88` — reject در initDB = unhandled rejection و startSyncWorker هرگز اجرا نمی‌شود)، `startSyncWorker()` خارج از جریان async (:89).
- `allowedHosts:'all'` در vite dev (`vite.config.ts:51`).
- drizzle.config fallback credential ساختگی.
- dead-code SQLite: `connection.ts:9,17-26` (throw 'SQLite permanently disabled') + fallback های `database.routes.ts:127,196,221` + `sync_queue.sqlite` یتیم روی disk.

---

## ۸. جدول اولویت‌بندی و نقشه راه

### ترتیب اجرای پیشنهادی (اولویت مطلق)

| اولویت | آیتم‌ها | تلاش تقریبی | اثر |
|---|---|---|---|
| **P0 — همین امروز (امنیت)** | S1 (fail-open auth) + S2 (setup takeover) + S3 (db/execute) + S11 (secret fallbacks → fail-fast) + B6 (log پسورد) + S14 (helmet+rate-limit) | ۱–۲ روز | بسته‌شدن مسیرهای takeover/RCE |
| **P0 — همین هفته (امنیت ادامه)** | S4 (identifier validation مرکزی در schema-sync/kv-store/routes) + S5/S6/S7 (بکاپ: root قفل، حذف restore .sql و explore-folders) + S8 (db/config خارج از public) + S9 (tenant ACL) + S10 (حذف secrets/hash/OTP از پاسخ‌ها) + S12/S13 (ادمین خودکار و 2FA) + S15 (rotation/revoke) | ۱–۲ هفته | سطح حملات web به سیستم بسته می‌شود |
| **P1 — ماه جاری (صحت داده)** | D1 (قرارداد خطای coreService + idempotency) + D2 (فعال‌سازی state machine چک) + D3 (تراز بدهکار/بستانکار) + D6 (تراکنش اتمیک والد/فرزند) + D7 (log append-only + optimistic locking) + D8 (counter اتمیک) + D9/D5/D4 + B1/B4 | ۳–۵ هفته | گزارش‌های مالی قابل اتکا |
| **P1 همزمان** | F2 (Error Boundary) + F3 (parse guard) + F9 (اعتبارسنجی مبالغ) + M2 (body limits) + M3/M4 (خطاها/catch ها) | ۳–۵ روز | پایداری UX |
| **P2 — سه‌ماهه (معماری)** | F1+F5+F4 (تجزیه god hook → zustand slices + React Query همه‌جا + dynamic import کتابخانه‌های سنگین) + F6/F7/F8 + I-section (tsconfig strict تدریجی، حذف dead-code sqlite، PORT/graceful shutdown) | ۶–۱۰ هفته | سرعت توسعه و کارایی |
| **P3 — مستمر** | پاکسازی ۲۱۶ اسکریپت ریشه + git history scrub + deps hygiene + M/L باقی‌مانده + تست‌گذاری (فاز ۳ بخش ۹) | مستمر | maintainability |

### تعریف «Done» برای P0
- تست integration: درخواست بدون توکن/توکن گندیده روی ۱۰ endpoint نمونه (خواندن+نوشتن) → همگی 401.
- `POST /api/setup/admin` وقتی ادمین وجود دارد → 403.
- `POST /api/db/execute` → 404.
- payload با کلید `x"; DROP TABLE users; --` روی `/api/data/:key/append` → 400 و جدول سالم.
- سرور بدون JWT_SECRET قوی → refuse to start.

---

## ۹. پیشنهادات ارتقا و نیازهای سیستم

### 9.1 نیازهای زیرساختی برای production
| نیاز | پیشنهاد |
|---|---|
| Runtime | Node.js 22 LTS (pin با `.nvmrc`/engines)؛ فعال‌سازی `NODE_ENV=production` |
| DB | PostgreSQL 16+؛ کاربر اپ least-privilege (بدون CREATEDB/SUPERUSER)؛ connection pooling (pgBouncer اگر multi-instance) |
| Process manager | Docker + docker-compose (app+pg) یا PM2/systemd؛ healthcheck روی `/api/health` (که الان فقط status ok برمی‌گرداند — بهتر: ping DB هم) |
| Secrets | `.env` فقط local؛ production: secret manager یا حداقل فایل 600-perm خارج ریپو؛ **rotate فوری پسورد PG فعلی** (`84315308` در db_config.json) |
| Reverse proxy | nginx/Caddy با TLS، rate-limit لایه ۷، body-size limit واقعی |
| Backup | نگهداشت `pg_dump` زمان‌بندی‌شده (به‌جای JSON-dump حافظه‌محور فعلی) + تست دوره‌ای restore + رمزنگاری at-rest |
| Monitoring | Sentry (فعلاً فقط init شده — alert اضافه شود) + uptime monitor + log aggregation (pino → file/loki) |

### 9.2 ارتقاهای معماری
1. **مهاجرت از الگوی KV به اسکیمای نرمال Drizzle:** schema.ts (33KB) و drizzle نصب‌اند ولی مسیر اصلی داده از `/api/data/:key` می‌گذرد. برای ۶ کالکشن مدل‌شده (invoices, checks, persons, products, accounting_documents, installments) endpoint های typed با Zod validation بسازید؛ KV فقط برای settings بماند. این یک‌جا S4/D6/D7/B1 را ریشه‌کن می‌کند.
2. **انتقال منطق مالی به سرور:** محاسبه totals/tax/discount فاکتور، مانده اشخاص، شماره‌گذاری اسناد — همگی server-authoritative؛ کلاینت فقط نمایش. (الان دو سیستم شماره‌گذاری موازی دارید.)
3. **یکپارچه‌سازی تاریخ:** کتابخانه واحد `date-fns-jalali` + استاندارد ذخیره UTC ISO + رندر شمسی فقط در UI layer؛ حذف ۴ پیاده‌سازی پراکنده تبدیل (format.ts, CustomDatePicker, test-date*).
4. **Money as integer:** مبالغ به‌صورت ریال/integer یا decimal(19,4) در DB؛ ممنوعیت float arithmetic در محاسبات مالی.
5. **RBAC واقعی:** نقش‌ها الان فقط در JWT هستند؛ middleware سطح route با ماتریس permission (admin/accountant/user) + audit trail append-only.

### 9.3 ارتقاهای محصولی پیشنهادی
- **جدول exchange_rates** مدیریتی (باگ قدیمی REPORT.md هنوز ذاتاً پابرجاست چون نرخ‌ها client-side محاسبه می‌شوند) + تاریخچه نرخ روزانه برای اسناد ارزی.
- **صف اعلان چک/قسط واقعی:** job فعلی روزانه ۸ صبح است و به DB اشتباه وصل است (B4)؛ بعد از اصلاح: SMS/Telegram (env ها آماده‌اند ولی استفاده نشده؟ بررسی شود) به‌جای email-only.
- **Report server-side rendering:** گزارش‌های سنگین (تراز، سود/زیان، kardex) با SQL aggregation به‌جای sweep کلاینت؛ export PDF/Excel سمت سرور (الان xlsx/jspdf در bundle کلاینت‌اند).
- **Multi-store admin panel:** چون S9 را می‌بندید، پنل مدیریت عضویت کاربر-فروشگاه لازم می‌شود.
- **Offline-first بالغ:** صف sync فعلی poison-quarantine ندارد (BackgroundSync.tsx:90 head-of-line consistency break) + idempotency keys.

### 9.4 برنامه تست (پیش‌نیاز همه ارتقاها)
1. **فاز الف (۱ هفته):** فعال‌سازی jest (config + script) → unit tests برای: loanStateMachine (تست موجود را اجرا کنید)، money utils، convertToGregorian (case های fail)، state machine چک.
2. **فاز ب (۱ هفته):** supertest integration برای auth (S1/S2 regression) + data routes (identifier injection، تراز اسناد، append concurrency).
3. **فاز ج:** CI (GitHub Actions): lint(tsc strict) + test + build روی هر PR؛ dependency audit خودکار.
4. Playwright E2E برای ۵ flow حیاتی: login/2FA، صدور فاکتور، ثبت چک، بستن سال مالی، backup/restore.

---

## ۱۰. نقاط قوت فعلی

برای انصاف — این‌ها را حفظ کنید:

- **مقادیر SQL همه parameterized** (سطح حمله به identifier ها محدود است، S4).
- **تراکنش per-table با rollback و release تضمینی** (`kv-store.ts:72-118`) + consistent-snapshot reader با SAVEPOINT (`kv-store.ts:239-296`) — طراحی بلنده.
- **KNOWN_TABLES whitelist** ایده درست است (فقط مسیر generic دورش زده می‌شود - B1).
- **کوکی refresh با flags خوب:** httpOnly, sameSite:strict, path-scoped, secure در production.
- **RTL/فارسی از پایه درست:** `dir="rtl"` در index.html تا input-level `dir="ltr"` عددی، پیام‌های validation فارسی، فرمت fa-IR.
- **`CurrencyInput.tsx`** نرمال‌سازی ارقام فارسی/عربی + گارد isNaN — الگوی درست که باید general شود.
- **React Query در CheckManagement** (queryKey با pagination/sort سمت سرور) دقیقاً معماری هدف برای ۱۵ کالکشن دیگر است.
- **الگوی lazy-loading دفاعی** در `ExtraModals.tsx:1-14` (`lazy().catch(()=>({default:()=>null}))`) آماده تعمیم.
- **Upgrade خودکار هش legacy به bcrypt** هنگام login (`auth.routes.ts:88-96`) — اینستینکت درست (فقط prefix-fix لازم دارد، M8).
- Commit messages منظم و conventional.

---

*این گزارش جایگزین REPORT.md قبلی است که پس از ماژولار شدن server.ts منسوخ شده بود.*
