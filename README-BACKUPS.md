# النسخ الاحتياطي اليومي لقاعدة البيانات

هذا الريبو فيه GitHub Action (`.github/workflows/daily-db-backup.yml`) بتاخد نسخة
كاملة من قاعدة بيانات Supabase كل يوم وتحفظها كـ commit في فرع `backups`.
كل نسخة = commit منفصل، يعني عندك تاريخ كامل تقدر ترجع لأي نقطة فيه.

## إعداد لازم تعمله مرة واحدة بس

1. من Supabase Dashboard → **Project Settings → Database → Connection string**
   → اختار **URI** تحت تبويب **Session pooler** (مش Direct connection، عشان
   GitHub Actions بتشتغل على IPv4 والـ pooler هو اللي بيدعمه).
2. انسخ الـ connection string وحط فيه الباسورد الحقيقي بتاع الداتابيز
   (مختلف عن باسورد الأدمن بتاع الموقع — ده باسورد قاعدة البيانات نفسها).
3. في الريبو على GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**
   - Name: `SUPABASE_DB_URL`
   - Value: الـ connection string اللي نسخته في خطوة 2
4. من تبويب **Actions** في الريبو، افتح "Daily database backup" واضغط
   **Run workflow** مرة واحدة يدويًا للتأكد إنها شغالة، بعدها هتشتغل
   تلقائيًا كل يوم.

⚠️ الباسورد ده سري جدًا — متحطهوش في أي مكان تاني غير GitHub Secrets
(مش في كود، مش في شات، مش في ملف عادي بالريبو).

## إزاي ترجع (Restore) نسخة قديمة

```bash
git fetch origin backups
git checkout origin/backups -- backups/2026-09-19_2300.sql.gz
gunzip backups/2026-09-19_2300.sql.gz
psql "<connection-string>" < backups/2026-09-19_2300.sql
```

**تحذير:** الاستعادة بتكتب فوق البيانات الحالية. لو مش متأكد، جرّبها الأول
على مشروع Supabase تجريبي (branch) مش على الإنتاج مباشرة.

## لو عايز نسخ احتياطي أقوى (Point-in-Time Recovery)

الحل ده (git-based) بيديك snapshot يومي، لكن لو حبيت ترجع لأي لحظة بالدقيقة
(مش بس آخر نسخة يومية)، الخيار الرسمي هو ترقية مشروع Supabase لخطة **Pro**
($25/شهر) اللي بتفعّل PITR (Point-in-Time Recovery) تلقائيًا من الداشبورد.
