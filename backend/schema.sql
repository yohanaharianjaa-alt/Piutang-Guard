-- PiutangGuard: empat tabel operasional, untuk aplikasi browser + Supabase Auth.
-- Jalankan di Supabase SQL Editor. Publishable key hanya aman digunakan bersama RLS.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_code text NOT NULL DEFAULT ('CUS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
    name varchar(255) NOT NULL,
    address text,
    phone varchar(40),
    email varchar(255),
    status varchar(20) NOT NULL DEFAULT 'ACTIVE',
    credit_limit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    invoice_number varchar(50) NOT NULL UNIQUE,
    invoice_date date NOT NULL,
    delivery_date date,
    due_date date NOT NULL,
    amount numeric(18,2) NOT NULL CHECK (amount > 0),
    discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    cost_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
    description text,
    status varchar(20) NOT NULL DEFAULT 'DRAFT',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    payment_number varchar(50) NOT NULL DEFAULT ('PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
    payment_date date NOT NULL,
    amount numeric(18,2) NOT NULL CHECK (amount > 0),
    payment_method varchar(30) NOT NULL DEFAULT 'TRANSFER',
    reference_number varchar(100),
    description text,
    status varchar(20) NOT NULL DEFAULT 'DRAFT',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.journal_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_group_id uuid NOT NULL,
    line_number integer NOT NULL DEFAULT 1,
    entry_date date NOT NULL DEFAULT current_date,
    entry_type varchar(30) NOT NULL DEFAULT 'OPENING',
    description text,
    account_code varchar(20) NOT NULL,
    account_name varchar(100) NOT NULL,
    debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
    payment_id uuid REFERENCES public.payments(id) ON DELETE RESTRICT,
    reversal_of_group_id uuid,
    status varchar(20) NOT NULL DEFAULT 'POSTED' CHECK (status = 'POSTED'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT journal_lines_one_side CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    )
);

-- Nomor jurnal resmi (nomor bukti) yang dibagikan oleh seluruh baris dalam satu jurnal.
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS journal_number varchar(30);

-- Upgrade in place from the earlier four-table schema without deleting user data.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS customer_code text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS phone varchar(40);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS email varchar(255);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.customers ALTER COLUMN credit_limit DROP DEFAULT;
UPDATE public.customers SET customer_code = 'CUS-' || upper(substr(replace(id::text, '-', ''), 1, 8))
WHERE customer_code IS NULL;
ALTER TABLE public.customers ALTER COLUMN customer_code SET DEFAULT
    ('CUS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
ALTER TABLE public.customers ALTER COLUMN customer_code SET NOT NULL;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS delivery_date date;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS discount_amount numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS cost_amount numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_valid;
UPDATE public.invoices SET status = 'UNPAID' WHERE status = 'POSTED';

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_number varchar(50);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_method varchar(30) NOT NULL DEFAULT 'TRANSFER';
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS reference_number varchar(100);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_status_check;
UPDATE public.payments SET payment_number = 'PAY-' || upper(substr(replace(id::text, '-', ''), 1, 10))
WHERE payment_number IS NULL;
ALTER TABLE public.payments ALTER COLUMN payment_number SET DEFAULT
    ('PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));
ALTER TABLE public.payments ALTER COLUMN payment_number SET NOT NULL;

ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS line_number integer NOT NULL DEFAULT 1;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS entry_date date NOT NULL DEFAULT current_date;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS entry_type varchar(30) NOT NULL DEFAULT 'OPENING';
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS reversal_of_group_id uuid;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'POSTED';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_dates_valid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_status_valid') THEN
        ALTER TABLE public.customers ADD CONSTRAINT customers_status_valid
            CHECK (status IN ('ACTIVE', 'INACTIVE'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_active_positive_limit') THEN
        ALTER TABLE public.customers ADD CONSTRAINT customers_active_positive_limit
            CHECK (status <> 'ACTIVE' OR credit_limit > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_dates_valid') THEN
        ALTER TABLE public.invoices ADD CONSTRAINT invoices_dates_valid
            CHECK (
                due_date >= invoice_date
                AND (delivery_date IS NULL OR (delivery_date >= invoice_date AND due_date >= delivery_date))
            ) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_valid') THEN
        ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_valid
            CHECK (status IN ('DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'REVERSED'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_valid') THEN
        ALTER TABLE public.payments ADD CONSTRAINT payments_status_valid
            CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_group_source_valid') THEN
        ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_group_source_valid
            CHECK (invoice_id IS NULL OR payment_id IS NULL OR entry_type IN ('PAYMENT', 'REVERSAL')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_one_side') THEN
        ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_one_side
            CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_discount_valid') THEN
        ALTER TABLE public.invoices ADD CONSTRAINT invoices_discount_valid
            CHECK (discount_amount >= 0 AND cost_amount >= 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_discount_not_greater_than_amount') THEN
        ALTER TABLE public.invoices ADD CONSTRAINT invoices_discount_not_greater_than_amount
            CHECK (discount_amount < amount) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_status_valid') THEN
        ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_status_valid
            CHECK (status = 'POSTED') NOT VALID;
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS customers_customer_code_uidx ON public.customers(customer_code);
CREATE UNIQUE INDEX IF NOT EXISTS payments_payment_number_uidx ON public.payments(payment_number);
CREATE INDEX IF NOT EXISTS invoices_customer_status_idx ON public.invoices(customer_id, status);
CREATE INDEX IF NOT EXISTS invoices_due_date_idx ON public.invoices(due_date);
CREATE INDEX IF NOT EXISTS payments_invoice_status_idx ON public.payments(invoice_id, status);
CREATE INDEX IF NOT EXISTS journal_lines_group_idx ON public.journal_lines(entry_group_id, line_number);
CREATE INDEX IF NOT EXISTS journal_lines_account_date_idx ON public.journal_lines(account_code, entry_date);
CREATE INDEX IF NOT EXISTS journal_lines_reversal_idx ON public.journal_lines(reversal_of_group_id)
    WHERE reversal_of_group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_set_updated_at ON public.customers;
CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS invoices_set_updated_at ON public.invoices;
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS payments_set_updated_at ON public.payments;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.set_created_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' AND auth.uid() IS NOT NULL THEN
        NEW.created_by := auth.uid();
    ELSIF TG_OP = 'UPDATE' THEN
        NEW.created_by := OLD.created_by;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_set_created_by ON public.customers;
CREATE TRIGGER customers_set_created_by BEFORE INSERT OR UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.set_created_by();
DROP TRIGGER IF EXISTS invoices_set_created_by ON public.invoices;
CREATE TRIGGER invoices_set_created_by BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.set_created_by();
DROP TRIGGER IF EXISTS payments_set_created_by ON public.payments;
CREATE TRIGGER payments_set_created_by BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.set_created_by();
DROP TRIGGER IF EXISTS journal_lines_set_created_by ON public.journal_lines;
CREATE TRIGGER journal_lines_set_created_by BEFORE INSERT ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

CREATE OR REPLACE FUNCTION public.prevent_posted_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Satu-satunya pengecualian: pemberian nomor jurnal pada data lama (NULL -> nomor),
    -- selama seluruh kolom lain tidak berubah sama sekali.
    IF TG_OP = 'UPDATE'
       AND OLD.journal_number IS NULL
       AND NEW.journal_number IS NOT NULL
       AND (to_jsonb(NEW) - 'journal_number') = (to_jsonb(OLD) - 'journal_number') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Jurnal yang telah diposting tidak dapat diubah atau dihapus. Gunakan jurnal reversal.';
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_immutable ON public.journal_lines;
CREATE TRIGGER journal_lines_immutable
BEFORE UPDATE OR DELETE ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_mutation();

DROP VIEW IF EXISTS public.v_aging_schedule;
CREATE VIEW public.v_aging_schedule
WITH (security_invoker = true)
AS
SELECT
    i.id AS invoice_id,
    c.id AS customer_id,
    c.name AS customer_name,
    i.invoice_number,
    i.invoice_date,
    i.due_date,
    (i.amount - i.discount_amount) AS total_amount,
    COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'POSTED'), 0) AS total_paid,
    (i.amount - i.discount_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'POSTED'), 0)) AS outstanding_amount,
    (current_date - i.due_date) AS days_overdue,
    CASE
        WHEN current_date <= i.due_date THEN 'Current'
        WHEN current_date - i.due_date BETWEEN 1 AND 30 THEN '1-30 Days'
        WHEN current_date - i.due_date BETWEEN 31 AND 60 THEN '31-60 Days'
        WHEN current_date - i.due_date BETWEEN 61 AND 90 THEN '61-90 Days'
        ELSE '> 90 Days'
    END AS aging_category
FROM public.invoices i
JOIN public.customers c ON c.id = i.customer_id
LEFT JOIN public.payments p ON p.invoice_id = i.id
WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID')
GROUP BY i.id, c.id, c.name
HAVING i.amount - i.discount_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'POSTED'), 0) > 0;

CREATE OR REPLACE VIEW public.v_account_balances
WITH (security_invoker = true)
AS
SELECT account_code, account_name,
       SUM(debit) AS total_debit,
       SUM(credit) AS total_credit,
       SUM(debit) - SUM(credit) AS balance
FROM public.journal_lines
WHERE status = 'POSTED'
GROUP BY account_code, account_name;

CREATE OR REPLACE FUNCTION public.check_journal_group_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_group_id uuid;
    v_debits numeric(18,2);
    v_credits numeric(18,2);
    v_lines integer;
    v_metadata_versions integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_group_id := OLD.entry_group_id;
    ELSE
        v_group_id := NEW.entry_group_id;
    END IF;
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), count(*),
           count(DISTINCT (entry_date, entry_type, description, invoice_id, payment_id, reversal_of_group_id, journal_number))
    INTO v_debits, v_credits, v_lines, v_metadata_versions
    FROM public.journal_lines
    WHERE entry_group_id = v_group_id;
    IF v_lines < 2 OR v_debits <> v_credits OR v_metadata_versions > 1 THEN
        RAISE EXCEPTION 'Jurnal % tidak seimbang atau metadata kelompoknya tidak konsisten (debit %, kredit %).',
            v_group_id, v_debits, v_credits;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_group_balance ON public.journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_group_balance
AFTER INSERT OR UPDATE OR DELETE ON public.journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_journal_group_balance();

-- Penomoran jurnal: PREFIX-TAHUN-URUTAN, urut tanpa lompatan per jenis dan tahun.
-- JPB = Jurnal Pembukaan, JPJ = Jurnal Penjualan, JKM = Jurnal Kas Masuk,
-- JPY = Jurnal Penyesuaian, JBL = Jurnal Pembalik, JU = Jurnal Umum.
CREATE OR REPLACE FUNCTION public.generate_journal_number(p_entry_type text, p_entry_date date)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prefix text;
    v_year text := to_char(p_entry_date, 'YYYY');
    v_next integer;
BEGIN
    v_prefix := CASE p_entry_type
        WHEN 'OPENING' THEN 'JPB'
        WHEN 'INVOICE' THEN 'JPJ'
        WHEN 'PAYMENT' THEN 'JKM'
        WHEN 'ECL' THEN 'JPY'
        WHEN 'REVERSAL' THEN 'JBL'
        ELSE 'JU'
    END;
    PERFORM pg_advisory_xact_lock(hashtext('piutangguard:journal-number'));
    SELECT COALESCE(MAX(substring(journal_number FROM '[0-9]+$')::integer), 0) + 1
    INTO v_next
    FROM public.journal_lines
    WHERE journal_number LIKE v_prefix || '-' || v_year || '-%';
    RETURN v_prefix || '-' || v_year || '-' ||
           CASE WHEN v_next < 10000 THEN lpad(v_next::text, 4, '0') ELSE v_next::text END;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_journal_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_number text;
BEGIN
    SELECT journal_number INTO v_number
    FROM public.journal_lines
    WHERE entry_group_id = NEW.entry_group_id AND journal_number IS NOT NULL
    LIMIT 1;
    NEW.journal_number := COALESCE(v_number, public.generate_journal_number(NEW.entry_type, NEW.entry_date));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_assign_number ON public.journal_lines;
CREATE TRIGGER journal_lines_assign_number BEFORE INSERT ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.assign_journal_number();

-- Beri nomor pada jurnal lama (jika ada) menurut urutan waktu pencatatan.
DO $$
DECLARE
    r record;
    v_number text;
BEGIN
    FOR r IN
        SELECT entry_group_id, min(entry_type) AS entry_type, min(entry_date) AS entry_date
        FROM public.journal_lines
        WHERE journal_number IS NULL
        GROUP BY entry_group_id
        ORDER BY min(created_at), entry_group_id
    LOOP
        v_number := public.generate_journal_number(r.entry_type, r.entry_date);
        UPDATE public.journal_lines
        SET journal_number = v_number
        WHERE entry_group_id = r.entry_group_id AND journal_number IS NULL;
    END LOOP;
END;
$$;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.journal_lines ALTER COLUMN journal_number SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal_number ON public.journal_lines (journal_number);

DROP FUNCTION IF EXISTS public.post_invoice(uuid);
CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_invoice public.invoices%ROWTYPE;
    v_customer public.customers%ROWTYPE;
    v_outstanding numeric(18,2);
    v_group_id uuid := gen_random_uuid();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk memposting transaksi.'; END IF;
    SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice tidak ditemukan.'; END IF;
    IF v_invoice.status <> 'DRAFT' THEN RAISE EXCEPTION 'Hanya invoice draft yang dapat diposting.'; END IF;

    SELECT * INTO v_customer FROM public.customers WHERE id = v_invoice.customer_id FOR UPDATE;
    IF NOT FOUND OR v_customer.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Pelanggan tidak ditemukan atau tidak aktif.';
    END IF;
    IF v_invoice.delivery_date IS NULL OR v_invoice.delivery_date > current_date THEN
        RAISE EXCEPTION 'Tanggal penyerahan harus diisi dan kewajiban pelaksanaan harus telah dipenuhi sebelum pendapatan diakui.';
    END IF;
    IF v_invoice.invoice_date > current_date OR v_invoice.delivery_date < v_invoice.invoice_date THEN
        RAISE EXCEPTION 'Tanggal invoice dan penyerahan tidak valid untuk pengakuan pendapatan.';
    END IF;
    IF v_invoice.discount_amount < 0 OR v_invoice.discount_amount >= v_invoice.amount OR v_invoice.cost_amount < 0 THEN
        RAISE EXCEPTION 'Nilai diskon atau harga pokok transaksi tidak valid.';
    END IF;

    SELECT COALESCE(SUM(i.amount - i.discount_amount), 0) - COALESCE((
        SELECT SUM(p.amount) FROM public.payments p
        JOIN public.invoices pi ON pi.id = p.invoice_id
        WHERE pi.customer_id = v_invoice.customer_id AND p.status = 'POSTED'
    ), 0)
    INTO v_outstanding
    FROM public.invoices i
    WHERE i.customer_id = v_invoice.customer_id
      AND i.status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID');
    IF v_outstanding + v_invoice.amount - v_invoice.discount_amount > v_customer.credit_limit THEN
        RAISE EXCEPTION 'Batas kredit pelanggan terlampaui.';
    END IF;

    UPDATE public.invoices SET status = 'UNPAID' WHERE id = p_invoice_id;
    INSERT INTO public.journal_lines
        (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit, invoice_id)
    VALUES
        (v_group_id, 1, v_invoice.delivery_date, 'INVOICE', 'Penjualan kredit ' || v_invoice.invoice_number, '1120', 'Piutang Usaha', v_invoice.amount - v_invoice.discount_amount, 0, p_invoice_id),
        (v_group_id, 2, v_invoice.delivery_date, 'INVOICE', 'Penjualan kredit ' || v_invoice.invoice_number, '4110', 'Pendapatan Penjualan', 0, v_invoice.amount - v_invoice.discount_amount, p_invoice_id);
    IF v_invoice.cost_amount > 0 THEN
        INSERT INTO public.journal_lines
            (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit, invoice_id)
        VALUES
            (v_group_id, 3, v_invoice.delivery_date, 'INVOICE', 'Penjualan kredit ' || v_invoice.invoice_number, '5100', 'Beban Pokok Penjualan', v_invoice.cost_amount, 0, p_invoice_id),
            (v_group_id, 4, v_invoice.delivery_date, 'INVOICE', 'Penjualan kredit ' || v_invoice.invoice_number, '1130', 'Persediaan', 0, v_invoice.cost_amount, p_invoice_id);
    END IF;
    RETURN v_group_id;
END;
$$;

DROP FUNCTION IF EXISTS public.post_payment(uuid);
CREATE OR REPLACE FUNCTION public.post_payment(p_payment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payment public.payments%ROWTYPE;
    v_invoice public.invoices%ROWTYPE;
    v_outstanding numeric(18,2);
    v_group_id uuid := gen_random_uuid();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk memposting transaksi.'; END IF;
    SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pembayaran tidak ditemukan.'; END IF;
    IF v_payment.status <> 'DRAFT' THEN RAISE EXCEPTION 'Hanya pembayaran draft yang dapat diposting.'; END IF;

    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id FOR UPDATE;
    IF NOT FOUND OR v_invoice.status NOT IN ('UNPAID', 'PARTIALLY_PAID') THEN
        RAISE EXCEPTION 'Invoice tidak memiliki saldo yang dapat dibayar.';
    END IF;
    IF v_invoice.delivery_date IS NULL
       OR v_payment.payment_date < v_invoice.delivery_date
       OR v_payment.payment_date > current_date THEN
        RAISE EXCEPTION 'Tanggal pembayaran piutang harus pada/setelah tanggal penyerahan dan tidak boleh di masa depan.';
    END IF;
    SELECT v_invoice.amount - v_invoice.discount_amount - COALESCE(SUM(amount), 0)
    INTO v_outstanding
    FROM public.payments
    WHERE invoice_id = v_invoice.id AND status = 'POSTED';
    IF v_payment.amount > v_outstanding THEN RAISE EXCEPTION 'Pembayaran melebihi sisa piutang invoice.'; END IF;

    UPDATE public.payments SET status = 'POSTED' WHERE id = p_payment_id;
    UPDATE public.invoices
    SET status = CASE WHEN v_payment.amount = v_outstanding THEN 'PAID' ELSE 'PARTIALLY_PAID' END
    WHERE id = v_invoice.id;
    INSERT INTO public.journal_lines
        (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit, invoice_id, payment_id)
    VALUES
        (v_group_id, 1, v_payment.payment_date, 'PAYMENT', 'Penerimaan ' || v_payment.payment_number, '1110', 'Kas/Bank', v_payment.amount, 0, v_invoice.id, p_payment_id),
        (v_group_id, 2, v_payment.payment_date, 'PAYMENT', 'Penerimaan ' || v_payment.payment_number, '1120', 'Piutang Usaha', 0, v_payment.amount, v_invoice.id, p_payment_id);
    RETURN v_group_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_aging_schedule(p_as_of_date date DEFAULT current_date)
RETURNS TABLE (
    invoice_id uuid,
    customer_id uuid,
    customer_name varchar,
    invoice_number varchar,
    invoice_date date,
    due_date date,
    total_amount numeric,
    total_paid numeric,
    outstanding_amount numeric,
    days_overdue integer,
    aging_category text,
    aging_bucket text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT i.id, c.id, c.name::varchar, i.invoice_number::varchar, i.invoice_date, i.due_date,
           i.amount - i.discount_amount, COALESCE(pay.paid, 0),
           i.amount - i.discount_amount - COALESCE(pay.paid, 0),
           GREATEST(p_as_of_date - i.due_date, 0),
           CASE
             WHEN p_as_of_date <= i.due_date THEN 'Current'
             WHEN p_as_of_date - i.due_date <= 30 THEN '1-30 Days'
             WHEN p_as_of_date - i.due_date <= 60 THEN '31-60 Days'
             WHEN p_as_of_date - i.due_date <= 90 THEN '61-90 Days'
             ELSE '> 90 Days'
           END,
           CASE
             WHEN p_as_of_date <= i.due_date THEN 'not_due'
             WHEN p_as_of_date - i.due_date <= 30 THEN '1_30'
             WHEN p_as_of_date - i.due_date <= 60 THEN '31_60'
             WHEN p_as_of_date - i.due_date <= 90 THEN '61_90'
             ELSE 'over_90'
           END
    FROM public.invoices i
    JOIN public.customers c ON c.id = i.customer_id
    LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount), 0) AS paid
        FROM public.payments p
        WHERE p.invoice_id = i.id
          AND p.payment_date <= p_as_of_date
          AND EXISTS (
              SELECT 1 FROM public.journal_lines paid_entry
              WHERE paid_entry.payment_id = p.id
                AND paid_entry.entry_type = 'PAYMENT'
                AND paid_entry.entry_date <= p_as_of_date
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.journal_lines paid_entry
              JOIN public.journal_lines reversal
                ON reversal.reversal_of_group_id = paid_entry.entry_group_id
              WHERE paid_entry.payment_id = p.id
                AND paid_entry.entry_type = 'PAYMENT'
                AND reversal.entry_type = 'REVERSAL'
                AND reversal.entry_date <= p_as_of_date
          )
    ) pay ON true
    WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REVERSED')
      AND i.invoice_date <= p_as_of_date
      AND EXISTS (
          SELECT 1 FROM public.journal_lines invoice_entry
          WHERE invoice_entry.invoice_id = i.id
            AND invoice_entry.entry_type = 'INVOICE'
            AND invoice_entry.entry_date <= p_as_of_date
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.journal_lines invoice_entry
          JOIN public.journal_lines reversal
            ON reversal.reversal_of_group_id = invoice_entry.entry_group_id
          WHERE invoice_entry.invoice_id = i.id
            AND invoice_entry.entry_type = 'INVOICE'
            AND reversal.entry_type = 'REVERSAL'
            AND reversal.entry_date <= p_as_of_date
      )
      AND i.amount - i.discount_amount - COALESCE(pay.paid, 0) > 0
    ORDER BY i.due_date, i.invoice_number;
$$;

DROP VIEW IF EXISTS public.v_aging_schedule;
CREATE VIEW public.v_aging_schedule
WITH (security_invoker = true)
AS
SELECT invoice_id, customer_id, customer_name, invoice_number, invoice_date, due_date,
       total_amount, total_paid, outstanding_amount, days_overdue, aging_category, aging_bucket
FROM public.get_aging_schedule(current_date);

CREATE OR REPLACE FUNCTION public.calculate_ecl(
    p_as_of_date date DEFAULT current_date,
    p_rates jsonb DEFAULT '{"not_due":0.01,"1_30":0.02,"31_60":0.05,"61_90":0.25,"over_90":0.50}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rates jsonb;
    v_details jsonb;
    v_buckets jsonb;
    v_target numeric(18,2);
    v_current numeric(18,2);
    v_delta numeric(18,2);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk melihat estimasi.'; END IF;
    IF p_as_of_date IS NULL
       OR p_rates IS NULL
       OR jsonb_typeof(p_rates) <> 'object'
       OR NOT (p_rates ?& ARRAY['not_due', '1_30', '31_60', '61_90', 'over_90'])
       OR EXISTS (
           SELECT 1
           FROM unnest(ARRAY['not_due', '1_30', '31_60', '61_90', 'over_90']) AS required_rates(rate_key)
           WHERE jsonb_typeof(p_rates->required_rates.rate_key) IS DISTINCT FROM 'number'
       ) THEN
        RAISE EXCEPTION 'Tanggal laporan dan matriks tarif wajib diisi.';
    END IF;
    v_rates := jsonb_build_object(
        'not_due', COALESCE((p_rates->>'not_due')::numeric, 0.01),
        '1_30', COALESCE((p_rates->>'1_30')::numeric, 0.02),
        '31_60', COALESCE((p_rates->>'31_60')::numeric, 0.05),
        '61_90', COALESCE((p_rates->>'61_90')::numeric, 0.25),
        'over_90', COALESCE((p_rates->>'over_90')::numeric, 0.50)
    );
    IF EXISTS (
        SELECT 1 FROM jsonb_each_text(v_rates) r
        WHERE r.value::numeric < 0 OR r.value::numeric > 1
    ) THEN RAISE EXCEPTION 'Tarif estimasi harus berada antara 0%% dan 100%%.'; END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb), COALESCE(round(sum(d.estimated_loss), 2), 0)
    INTO v_details, v_target
    FROM (
        SELECT a.*, (a.outstanding_amount * (v_rates->>a.aging_bucket)::numeric)::numeric(18,2) AS estimated_loss
        FROM public.get_aging_schedule(p_as_of_date) a
    ) d;
    SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
    INTO v_buckets
    FROM (
        SELECT d.aging_bucket,
               min(d.aging_category) AS aging_category,
               COALESCE(sum(d.outstanding_amount), 0)::numeric(18,2) AS exposure,
               (v_rates->>d.aging_bucket)::numeric AS rate,
               COALESCE(sum(d.estimated_loss), 0)::numeric(18,2) AS estimated_loss
        FROM (
            SELECT a.aging_bucket, a.aging_category, a.outstanding_amount,
                   (a.outstanding_amount * (v_rates->>a.aging_bucket)::numeric)::numeric(18,2) AS estimated_loss
            FROM public.get_aging_schedule(p_as_of_date) a
        ) d
        GROUP BY d.aging_bucket
    ) b;
    SELECT COALESCE(sum(credit - debit), 0)::numeric(18,2)
    INTO v_current
    FROM public.journal_lines
    WHERE account_code = '1121' AND status = 'POSTED' AND entry_date <= p_as_of_date;
    v_delta := round(v_target - v_current, 2);
    RETURN jsonb_build_object(
        'as_of_date', p_as_of_date,
        'rates', v_rates,
        'details', v_details,
        'buckets', v_buckets,
        'target_allowance', v_target,
        'recorded_allowance', v_current,
        'adjustment', v_delta,
        'illustrative_assumption', true
    );
END;
$$;

DROP FUNCTION IF EXISTS public.post_ecl_adjustment(uuid, numeric);
CREATE OR REPLACE FUNCTION public.post_ecl_adjustment(
    p_as_of_date date,
    p_rates jsonb DEFAULT '{"not_due":0.01,"1_30":0.02,"31_60":0.05,"61_90":0.25,"over_90":0.50}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_estimate jsonb;
    v_delta numeric(18,2);
    v_group_id uuid := gen_random_uuid();
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk memposting transaksi.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('piutangguard:ecl-allowance'));
    v_estimate := public.calculate_ecl(p_as_of_date, p_rates);
    v_delta := (v_estimate->>'adjustment')::numeric;
    IF v_delta = 0 THEN RETURN NULL; END IF;
    IF v_delta > 0 THEN
        INSERT INTO public.journal_lines
            (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit)
        VALUES
            (v_group_id, 1, p_as_of_date, 'ECL', 'Penyesuaian cadangan kerugian kredit per ' || to_char(p_as_of_date, 'DD/MM/YYYY'), '5110', 'Beban Kerugian Kredit', v_delta, 0),
            (v_group_id, 2, p_as_of_date, 'ECL', 'Penyesuaian cadangan kerugian kredit per ' || to_char(p_as_of_date, 'DD/MM/YYYY'), '1121', 'Cadangan Kerugian Kredit', 0, v_delta);
    ELSE
        INSERT INTO public.journal_lines
            (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit)
        VALUES
            (v_group_id, 1, p_as_of_date, 'ECL', 'Pembalikan cadangan kerugian kredit per ' || to_char(p_as_of_date, 'DD/MM/YYYY'), '1121', 'Cadangan Kerugian Kredit', -v_delta, 0),
            (v_group_id, 2, p_as_of_date, 'ECL', 'Pembalikan cadangan kerugian kredit per ' || to_char(p_as_of_date, 'DD/MM/YYYY'), '5110', 'Beban Kerugian Kredit', 0, -v_delta);
    END IF;
    RETURN v_group_id;
END;
$$;

DROP FUNCTION IF EXISTS public.reverse_journal(uuid);
CREATE OR REPLACE FUNCTION public.reverse_journal(p_entry_group_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reverse_group_id uuid := gen_random_uuid();
    v_invoice_id uuid;
    v_payment_id uuid;
    v_entry_type text;
    v_invoice public.invoices%ROWTYPE;
    v_paid numeric(18,2);
    v_original_number text;
    v_original_description text;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk membalik jurnal.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('piutangguard:reverse:' || p_entry_group_id::text));
    IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_group_id = p_entry_group_id) THEN
        RAISE EXCEPTION 'Kelompok jurnal tidak ditemukan.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_group_id = p_entry_group_id AND reversal_of_group_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Jurnal reversal tidak dapat dibalik kembali.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.journal_lines WHERE reversal_of_group_id = p_entry_group_id) THEN
        RAISE EXCEPTION 'Jurnal ini sudah pernah dibalik.';
    END IF;
    SELECT invoice_id, payment_id, entry_type
    INTO v_invoice_id, v_payment_id, v_entry_type
    FROM public.journal_lines
    WHERE entry_group_id = p_entry_group_id
    ORDER BY line_number
    LIMIT 1;
    IF v_entry_type = 'REVERSAL' THEN RAISE EXCEPTION 'Jurnal reversal tidak dapat dibalik kembali.'; END IF;
    SELECT journal_number, description INTO v_original_number, v_original_description
    FROM public.journal_lines
    WHERE entry_group_id = p_entry_group_id
    ORDER BY line_number
    LIMIT 1;

    IF v_payment_id IS NOT NULL THEN
        PERFORM 1 FROM public.payments WHERE id = v_payment_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Pembayaran sumber tidak ditemukan.'; END IF;
        SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Invoice sumber tidak ditemukan.'; END IF;
        UPDATE public.payments SET status = 'REVERSED' WHERE id = v_payment_id AND status = 'POSTED';
        IF NOT FOUND THEN RAISE EXCEPTION 'Pembayaran sumber tidak berstatus posted.'; END IF;
        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM public.payments WHERE invoice_id = v_invoice_id AND status = 'POSTED';
        UPDATE public.invoices
        SET status = CASE
            WHEN status = 'REVERSED' THEN 'REVERSED'
            WHEN v_paid >= amount - discount_amount THEN 'PAID'
            WHEN v_paid > 0 THEN 'PARTIALLY_PAID'
            ELSE 'UNPAID'
        END
        WHERE id = v_invoice_id;
    ELSIF v_invoice_id IS NOT NULL AND v_entry_type = 'INVOICE' THEN
        SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Invoice sumber tidak ditemukan.'; END IF;
        IF EXISTS (SELECT 1 FROM public.payments WHERE invoice_id = v_invoice_id AND status = 'POSTED') THEN
            RAISE EXCEPTION 'Balik jurnal pembayaran terlebih dahulu sebelum membalik invoice.';
        END IF;
        UPDATE public.invoices SET status = 'REVERSED' WHERE id = v_invoice_id AND status <> 'REVERSED';
        IF NOT FOUND THEN RAISE EXCEPTION 'Invoice sumber sudah dibalik atau tidak dapat dibalik.'; END IF;
    ELSIF v_entry_type = 'ECL' THEN
        PERFORM pg_advisory_xact_lock(hashtext('piutangguard:ecl-allowance'));
    END IF;

    INSERT INTO public.journal_lines
        (entry_group_id, line_number, entry_date, entry_type, description, account_code, account_name, debit, credit, invoice_id, payment_id, reversal_of_group_id)
    SELECT v_reverse_group_id, row_number() OVER (ORDER BY line_number)::integer, current_date,
           'REVERSAL', 'Pembalikan ' || v_original_number || COALESCE(' - ' || NULLIF(v_original_description, ''), ''),
           account_code, account_name, credit, debit, invoice_id, payment_id, p_entry_group_id
    FROM public.journal_lines
    WHERE entry_group_id = p_entry_group_id;
    RETURN v_reverse_group_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_opening_journal(
    p_entry_date date,
    p_description text,
    p_lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_group_id uuid := gen_random_uuid();
    v_line_count integer;
    v_debits numeric(18,2);
    v_credits numeric(18,2);
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Silakan masuk untuk mencatat jurnal pembukaan.'; END IF;
    IF p_entry_date IS NULL OR NULLIF(trim(p_description), '') IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'Tanggal, deskripsi, dan daftar baris jurnal wajib diisi.';
    END IF;

    SELECT count(*), COALESCE(sum(line.debit), 0), COALESCE(sum(line.credit), 0)
    INTO v_line_count, v_debits, v_credits
    FROM jsonb_to_recordset(p_lines) AS line(
        account_code text,
        account_name text,
        debit numeric,
        credit numeric
    );
    IF v_line_count < 2 OR v_debits <= 0 OR v_debits <> v_credits THEN
        RAISE EXCEPTION 'Jurnal pembukaan minimal dua baris dan total debit harus sama dengan kredit.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_lines) AS line(
            account_code text,
            account_name text,
            debit numeric,
            credit numeric
        )
        WHERE NULLIF(trim(account_code), '') IS NULL
           OR NULLIF(trim(account_name), '') IS NULL
           OR debit IS NULL OR credit IS NULL
           OR COALESCE(debit, 0) < 0 OR COALESCE(credit, 0) < 0
           OR NOT ((COALESCE(debit, 0) > 0 AND COALESCE(credit, 0) = 0)
                OR (COALESCE(credit, 0) > 0 AND COALESCE(debit, 0) = 0))
           OR NOT EXISTS (
               SELECT 1
               FROM (VALUES
                   ('1110', 'Kas/Bank'),
                   ('1120', 'Piutang Usaha'),
                   ('1121', 'Cadangan Kerugian Kredit'),
                   ('1130', 'Persediaan'),
                   ('2100', 'Utang Usaha'),
                   ('2110', 'Liabilitas Lain'),
                   ('3100', 'Modal Pemilik'),
                   ('3200', 'Saldo Laba')
               ) AS account(account_code, account_name)
               WHERE account.account_code = trim(line.account_code)
                 AND account.account_name = trim(line.account_name)
           )
    ) THEN
        RAISE EXCEPTION 'Setiap baris harus memakai akun terdaftar, nama akun yang sesuai, dan hanya berisi debit atau kredit positif.';
    END IF;

    INSERT INTO public.journal_lines
        (entry_group_id, line_number, entry_date, entry_type, description,
         account_code, account_name, debit, credit)
    SELECT v_group_id, row_number() OVER ()::integer, p_entry_date, 'OPENING',
           trim(p_description), account.account_code, account.account_name,
           line.debit, line.credit
    FROM jsonb_to_recordset(p_lines) AS line(
        account_code text,
        account_name text,
        debit numeric,
        credit numeric
    )
    JOIN (VALUES
        ('1110', 'Kas/Bank'),
        ('1120', 'Piutang Usaha'),
        ('1121', 'Cadangan Kerugian Kredit'),
        ('1130', 'Persediaan'),
        ('2100', 'Utang Usaha'),
        ('2110', 'Liabilitas Lain'),
        ('3100', 'Modal Pemilik'),
        ('3200', 'Saldo Laba')
    ) AS account(account_code, account_name)
      ON account.account_code = trim(line.account_code)
     AND account.account_name = trim(line.account_name);
    RETURN v_group_id;
END;
$$;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

-- Single-company internal workspace: disable public sign-ups in Supabase Auth.
-- All admin-provisioned authenticated users share this company's records.
DROP POLICY IF EXISTS customers_authenticated_access ON public.customers;
CREATE POLICY customers_authenticated_access ON public.customers
FOR ALL TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS invoices_authenticated_read ON public.invoices;
CREATE POLICY invoices_authenticated_read ON public.invoices
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS invoices_authenticated_insert ON public.invoices;
CREATE POLICY invoices_authenticated_insert ON public.invoices
FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS invoices_authenticated_update_draft ON public.invoices;
CREATE POLICY invoices_authenticated_update_draft ON public.invoices
FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL AND status = 'DRAFT')
WITH CHECK (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS invoices_authenticated_delete_draft ON public.invoices;
CREATE POLICY invoices_authenticated_delete_draft ON public.invoices
FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS payments_authenticated_read ON public.payments;
CREATE POLICY payments_authenticated_read ON public.payments
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS payments_authenticated_insert ON public.payments;
CREATE POLICY payments_authenticated_insert ON public.payments
FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS payments_authenticated_update_draft ON public.payments;
CREATE POLICY payments_authenticated_update_draft ON public.payments
FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL AND status = 'DRAFT')
WITH CHECK (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS payments_authenticated_delete_draft ON public.payments;
CREATE POLICY payments_authenticated_delete_draft ON public.payments
FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL AND status = 'DRAFT');
DROP POLICY IF EXISTS journal_lines_authenticated_read ON public.journal_lines;
CREATE POLICY journal_lines_authenticated_read ON public.journal_lines
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

REVOKE ALL ON public.customers, public.invoices, public.payments, public.journal_lines FROM PUBLIC, anon;
REVOKE ALL ON public.v_aging_schedule, public.v_account_balances FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.journal_lines FROM authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices, public.payments TO authenticated;
GRANT SELECT ON public.journal_lines, public.v_aging_schedule, public.v_account_balances TO authenticated;
REVOKE ALL ON FUNCTION public.get_aging_schedule(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calculate_ecl(date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_aging_schedule(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_ecl(date, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.post_invoice(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_payment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_ecl_adjustment(date, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_journal(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_opening_journal(date, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_ecl_adjustment(date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_opening_journal(date, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.generate_journal_number(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_journal_number() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
