-- 0055: حسابات الموظفين + الأدوار والصلاحيات (المرحلة 1).
-- app_roles: دور = مجموعة صلاحيات (مفاتيح نصية) والأدمن بيعدّلها من لوحة التحكم.
-- staff_accounts: موظف واحد وليه دور أو أكتر. الصلاحية الفعلية = اتحاد صلاحيات أدواره.
-- المناديب الحاليين (جدول reps) فضلوا زي ما هم؛ دور «مندوب / بائع» موجود هنا عشان تتحدد صلاحياته وهيتربط بالمناديب في مرحلة المبيعات.
-- حسابات المشاهدين القديمة (viewers) بتتنسخ هنا (محاسب → محاسب، مشاهد → شريك) بنفس كلمة المرور؛ الجدول القديم متحسّش.
-- RLS شغال من غير policies = service-role بس (زي باقي جداول المالية).

create table if not exists public.app_roles (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name_ar     text not null check (length(btrim(name_ar)) > 0),
  description text,
  permissions text[] not null default '{}',
  is_system   boolean not null default false,
  sort        int not null default 100,
  created_at  timestamptz not null default now()
);
create table if not exists public.staff_accounts (
  id              bigint generated always as identity primary key,
  username        text not null unique check (username ~ '^[A-Za-z0-9_.-]{3,30}$'),
  password_hash   text not null,
  display_name    text not null check (length(btrim(display_name)) > 0),
  active          boolean not null default true,
  session_version int not null default 1,
  roles           text[] not null default '{}',
  created_at      timestamptz not null default now()
);
alter table public.app_roles enable row level security;
alter table public.staff_accounts enable row level security;
revoke all on public.app_roles, public.staff_accounts from anon, authenticated;

insert into public.app_roles (key, name_ar, description, permissions, is_system, sort) values
 ('rep',             'مندوب / بائع',  'يتابع عملاءه ويشوف أسعار البيع فقط',                         '{sales.prices.view,sales.customers.own}', true, 10),
 ('sales_manager',   'مدير المبيعات', 'يتابع المناديب وأدائهم وينقل العملاء بينهم',                '{sales.prices.view,sales.customers.own,sales.team.view,sales.reassign}', true, 20),
 ('purchasing',      'المشتريات',     'يشوف تكاليف المنتجات ويضيف منتجات ويدير الموردين',         '{products.cost.view,products.edit,purchasing.manage,suppliers.view}', true, 30),
 ('accountant',      'محاسب',         'يراجع الأداء المحاسبي للمشاريع والمشتريات والمبيعات',       '{projects.view,profit.view,suppliers.view,customers.fin.view,treasury.view,accounting.review}', true, 40),
 ('accounts_manager','مدير حسابات',   'نفس المحاسب + اعتماد توزيع الأرباح والتقفيلات',             '{projects.view,profit.view,suppliers.view,customers.fin.view,treasury.view,accounting.review,accounting.approve}', true, 50),
 ('partner',         'شريك',          'قراءة فقط: الربح العام ونسبته وقيمته وأداء المشاريع',       '{projects.view,profit.view,suppliers.view,customers.fin.view,treasury.view}', true, 60),
 ('warehouse',       'المخزن',        'المخزون والأرقام التسلسلية والصرف والاستلام',               '{stock.view,stock.serials}', true, 70),
 ('site_engineer',   'مهندس موقع',    'يستلم المكونات ويطابقها مع المخزن ويوقّع العميل على السند', '{delivery.receive,project.progress}', true, 80),
 ('project_manager', 'مدير مشروع',    'يتابع سير المشروع والمعاملات المالية مع العميل والموردين',  '{projects.view,suppliers.view,customers.fin.view,project.progress}', true, 90)
on conflict (key) do nothing;

-- نقل حسابات المشاهدين القديمة (نفس كلمة المرور)
insert into public.staff_accounts (username, password_hash, display_name, active, session_version, roles)
select v.username, v.password_hash, v.display_name, v.active, v.session_version,
       case when v.role = 'accountant' then array['accountant'] else array['partner'] end
from public.viewers v
on conflict (username) do nothing;
