# Comprehensive Guides (Bilingual: Arabic & English)
# الأدلة الشاملة للتشغيل والنشر والنسخ الاحتياطي والاستخدام (عربي / إنجليزي)

---

## PART 1: ARABIC GUIDES (الأدلة باللغة العربية)

### 1. دليل المستخدم (User Guide — كيف تكمل سيرتك الذاتية خطوة بخطوة)
1. **فتح مساحة العمل:** من الصفحة الرئيسية يمكنك فتح مساحة العمل المجهزة مسبقًا (`Abdel Ghaffar Adel Abdel Ghaffar Tiba — Existing Answers Imported`) أو إنشاء حساب مستقل جديد.
2. **التنقل بين الـ 13 مرحلة:** كل مرحلة لها صفحة مستقلة في القائمة الجانبية. لست مضطرًا لإكمال كل الحقول قبل الانتقال للمرحلة التالية أو معاينة السيرة أو تصدير مسودة.
3. **الحفظ التلقائي والاستكمال:** يتم حفظ أي تعديل تلقائيًا خلال أجزاء من الثانية على الخادم، مع حفظ نسخة محلية مؤقتة (`IndexedDB`) في حال انقطاع الإنترنت.
4. **مراجعة الصياغات المقترحة:** عند الضغط على زر `ساعدني في صياغة المهام الوظيفية`، يعرض النظام مقارنة من عمودين: (ما أخبرتنا به) مقابل (الصياغة المهنية المقترحة). لا تُضاف أي نقطة للسيرة النهائية إلا بعد ضغطك على `اعتماد وإضافة للسيرة ✓`.
5. **تصدير السيرة وكراسة الإجابات:** من المرحلة 13 أو من `مركز التصدير والمشاركة (PDF)`، يمكنك تنزيل:
   - **السيرة الذاتية بالإنجليزية (LTR) أو العربية (RTL)** بصيغة PDF قابلة للبحث والتحديد.
   - **مسودة المراجعة (DRAFT PDF)** في أي وقت حتى قبل اكتمال جميع التواريخ.
   - **كراسة الإجابات الكاملة (Answer Workbook PDF)** وهي وثيقة خاصة بك وحدك تحفظ كل سؤال وإجابته وملاحظاتك الخاصة.

### 2. دليل إعداد المشرف والتكاملات الخارجية (Admin & Integrations Setup Guide)
- **مشرف النظام:** `Abd-el-Rahman Adel Teba` (`frp.nasr@gmail.com` | `01091874291`).
- **الخصوصية الافتراضية:** جميع حسابات المستخدمين وملفات السيرة الذاتية (بما فيها ملف عبدالغفار) تكون **خاصة تمامًا افتراضيًا**. لا يظهر محتوى أي ملف في لوحة المشرف إلا إذا قام صاحب الملف بتفعيل خيار المشاركة من صفحة `الحساب والخصوصية والموافقات`.
- **تفعيل تسجيل الدخول عبر Google (OAuth 2.0):**
  1. افتح Google Cloud Console وأنشئ OAuth 2.0 Client ID.
  2. أضف رابط إعادة التوجيه: `https://YOUR-DOMAIN/api/auth/google/callback`.
  3. ضع `AUTH_GOOGLE_ENABLED=true` و `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET` في إعدادات الخادم السرية (لا تضعها أبدًا في كود الواجهة).
- **تفعيل رسائل الهاتف النصية (SMS OTP):**
  1. اشترك في مزود رسائل يدعم مصر والسعودية (مثل Twilio أو Vonage).
  2. أضف `AUTH_PHONE_OTP_ENABLED=true` و `SMS_API_KEY` في متغيرات البيئة على الخادم.
- **تفعيل إشعارات البريد الإلكتروني للمشرف (`frp.nasr@gmail.com`):**
  1. اضبط `ADMIN_EMAIL_NOTIFICATIONS_ENABLED=true` مع بيانات `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` أو `RESEND_API_KEY`.
  2. اختبر الإرسال من زر `إرسال بريد اختبار` داخل لوحة المشرف.
- **تفعيل إشعارات واتساب (WhatsApp Business Cloud API):**
  1. رقم الهاتف العادي وحده لا يرسل رسائل آلية من الخادم.
  2. قم بإعداد حساب Meta WhatsApp Business Platform، وأضف `ADMIN_WHATSAPP_ENABLED=true` و `WHATSAPP_CLOUD_API_TOKEN` و `WHATSAPP_PHONE_NUMBER_ID`.

### 3. دليل قاعدة البيانات والترحيل والنسخ الاحتياطي والاسترجاع (Migrations & Backup/Restore Guide)
- **تشغيل الترحيل (Migrations):**
  ```bash
  npm run migrate
  ```
- **إنشاء نسخة احتياطية فورية (Backup):**
  ```bash
  npm run backup
  ```
  يتم حفظ ملف قاعدة البيانات الكامل في `runtime-data/backups/` مع طابع زمني دقيق.
- **اختبار استرجاع النسخة الاحتياطية (Restore):**
  ```bash
  npm run restore
  ```
- **أمان Git:** مجلد `runtime-data/` وجميع ملفات `.sqlite` و `.env` مضافة في `.gitignore` لمنع تسرب أي بيانات شخصية أو ملفات مرفوعة إلى المستودع.

---

## PART 2: ENGLISH GUIDES

### 1. Deployment & Production Environment Guide
1. Copy `.env.example` to `.env` on your secure server or configure secrets in your hosting platform's secret manager.
2. Set a strong 64-byte random hex `SESSION_SECRET`.
3. Enforce HTTPS at the reverse proxy / load balancer level.
4. For serverless platforms (such as Vercel), note that local filesystem SQLite (`runtime-data/*.sqlite`) and headless LibreOffice binaries require either a persistent container/VM host (e.g., Railway, Render, Fly.io, DigitalOcean App Platform, AWS ECS) or connecting `DATABASE_URL` to managed PostgreSQL/Supabase and a remote PDF worker.

### 2. Database Schema & Access-Control Policies
- The schema defines **25 normalized tables** (`users`, `user_preferences`, `sessions`, `profiles`, `stages`, `question_definitions`, `answers`, `employment_entries`, `education_entries`, `training_entries`, `modality_competencies`, `license_entries`, `achievement_entries`, `reference_entries`, `uploaded_files`, `profile_versions`, `export_jobs`, `share_links`, `access_grants`, `consent_records`, `audit_events`, `support_tickets`, `error_logs`, `notification_logs`, `platform_settings`).
- Every API route calls `checkProfileAccess(user, profileId, requiredPermission)` on the server:
  - Cross-user reads/writes/uploads/exports return `403 Forbidden`.
  - Client-supplied `role` or `isAdmin` fields during registration are ignored.
  - Platform administrators cannot view private CV profiles unless `share_with_admin_enabled = 1` is explicitly granted by the profile owner, and every admin inspection records an immutable `admin.shared_profile_viewed` audit event.
