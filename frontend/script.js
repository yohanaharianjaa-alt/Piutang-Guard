'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const cache = { customers: [], invoices: [], payments: [], aging: [], allowance: null, journals: [] };
  const pageTitles = {
    dashboard: ['Dashboard', 'Ikhtisar risiko dan posisi piutang perusahaan.'],
    customers: ['Pelanggan', 'Kelola data pelanggan, batas kredit, dan saldo piutang.'],
    invoices: ['Invoice', 'Buat draft invoice dan akui pendapatan hanya setelah penyerahan.'],
    payments: ['Pembayaran', 'Catat dan posting pembayaran sebagian maupun penuh.'],
    aging: ['Aging Piutang', 'Analisis umur piutang pada tanggal laporan yang dipilih.'],
    allowance: ['Cadangan ECL', 'Estimasi dan penyesuaian cadangan kerugian kredit berbasis umur piutang (aging).'],
    journals: ['Jurnal', 'Telusuri jurnal posting dan lakukan reversal yang terlacak.'],
    income: ['Laporan Laba Rugi', 'Rincian kinerja berdasarkan jurnal yang diposting dalam periode laporan.'],
    position: ['Posisi Keuangan', 'Laporan posisi keuangan dari saldo akun dan jurnal aktual.']
  };
  const defaultRates = { not_due: 0.01, '1_30': 0.02, '31_60': 0.05, '61_90': 0.25, over_90: 0.50 };
  const accountMap = {
    '1110': { name: 'Kas/Bank', classification: 'asset' },
    '1120': { name: 'Piutang Usaha', classification: 'asset' },
    '1121': { name: 'Cadangan Kerugian Kredit', classification: 'contra_asset' },
    '1130': { name: 'Persediaan', classification: 'asset' },
    '2100': { name: 'Utang Usaha', classification: 'liability' },
    '2110': { name: 'Liabilitas Lain', classification: 'liability' },
    '3100': { name: 'Modal Pemilik', classification: 'equity' },
    '3200': { name: 'Saldo Laba', classification: 'equity' },
    '4110': { name: 'Pendapatan Penjualan', classification: 'revenue' },
    '5100': { name: 'Beban Pokok Penjualan', classification: 'expense' },
    '5110': { name: 'Beban Kerugian Kredit', classification: 'expense' }
  };
  const entryTypeLabels = { OPENING: 'Pembukaan', INVOICE: 'Penjualan', PAYMENT: 'Kas Masuk', ECL: 'Penyesuaian', REVERSAL: 'Pembalik' };
  const typeLabel = type => entryTypeLabels[type] || type;
  const journalNumber = group => group.journal_number || String(group.id).slice(0, 8);
  const rateLabels = {
    not_due: 'Belum jatuh tempo',
    '1_30': '1–30 hari',
    '31_60': '31–60 hari',
    '61_90': '61–90 hari',
    over_90: '>90 hari'
  };
  const tableState = {};
  let supabaseClient = null;
  let session = null;
  let page = 'dashboard';
  let editorContext = null;
  let tableSearchTimer = null;
  let agingFilter = { date: today(), customer: '', bucket: '' };
  let reportDate = today();
  let incomeStart = `${today().slice(0, 4)}-01-01`;
  let incomeEnd = today();
  let journalStart = '';
  let journalEnd = '';
  let latestPaymentTrend = [];
  let openingLineCount = 0;

  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function money(value) {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', maximumFractionDigits: 0
    }).format(Number(value) || 0);
  }

  function reportMoney(value, parenthesize = false) {
    const amount = Number(value) || 0;
    const formatted = money(Math.abs(amount));
    return parenthesize || amount < 0 ? `(${formatted})` : formatted;
  }

  function number(value) {
    return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function dateLabel(value) {
    if (!value) return '—';
    const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? '—'
      : new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
  }

  function addDays(value, days) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  }

  function priorYearDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
    return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  }

  function statementLine(label, current, comparative, options = {}) {
    const { type = 'normal', currentExpense = false, comparativeExpense = currentExpense } = options;
    const comparativeText = comparative === null ? '—' : reportMoney(comparative, comparativeExpense);
    return `<div class="report-line ${type}"><span class="report-account">${escapeHtml(label)}</span><div class="report-values"><strong>${reportMoney(current, currentExpense)}</strong><strong class="comparative-value">${comparativeText}</strong></div></div>`;
  }

  function statementColumns(currentLabel, comparativeLabel) {
    return `<div class="report-columns"><span>Keterangan</span><strong>${escapeHtml(currentLabel)}</strong><strong>${escapeHtml(comparativeLabel)}</strong></div>`;
  }

  function statusBadge(value) {
    const map = {
      ACTIVE: ['Aktif', 'success'], INACTIVE: ['Nonaktif', 'neutral'],
      DRAFT: ['Draft', 'neutral'], UNPAID: ['Belum dibayar', 'info'], POSTED: ['Terposting', 'info'],
      PARTIALLY_PAID: ['Sebagian', 'warning'], PAID: ['Lunas', 'success'],
      REVERSED: ['Direversal', 'danger']
    };
    const [label, style] = map[value] || [value || '—', 'neutral'];
    return `<span class="badge ${style}">${escapeHtml(label)}</span>`;
  }

  function safeMarkup(value) {
    return { markup: value };
  }

  function showNotice(message, type = 'info') {
    const icon = type === 'error' ? 'fa-circle-exclamation' : type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info';
    $('#notice-region').innerHTML = `<div class="notice ${type}"><i class="fa-solid ${icon}"></i><span>${escapeHtml(message)}</span></div>`;
  }

  function clearNotice() {
    $('#notice-region').innerHTML = '';
  }

  function setConnection(state, label) {
    const element = $('#connection-status');
    element.className = `connection-status ${state}`;
    $('#connection-label').textContent = label;
  }

  function setBusy(element, busy, label) {
    if (!element) return;
    if (busy) {
      element.dataset.originalText = element.innerHTML;
      element.disabled = true;
      element.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(label || 'Memproses')}`;
    } else {
      element.disabled = false;
      if (element.dataset.originalText) element.innerHTML = element.dataset.originalText;
    }
  }

  async function api(path, options = {}) {
    if (!session || !supabaseClient) throw new Error('Sesi Supabase tidak aktif. Silakan masuk kembali.');
    const method = options.method || 'GET';
    const recordRoute = path.match(/^\/records\/([a-z_]+)(?:\?(.*))?$/);
    if (recordRoute) {
      const table = recordRoute[1];
      const params = new URLSearchParams(recordRoute[2] || '');
      let query;
      if (method === 'GET') {
        query = supabaseClient.from(table).select(params.get('select') || '*');
      } else if (method === 'POST') {
        query = supabaseClient.from(table).insert(options.body);
        if ((options.headers?.prefer || '').includes('return=representation')) query = query.select();
      } else if (method === 'PATCH') {
        query = supabaseClient.from(table).update(options.body);
      } else if (method === 'DELETE') {
        query = supabaseClient.from(table).delete();
      } else {
        throw new Error(`Metode ${method} tidak didukung.`);
      }

      for (const [key, expression] of params.entries()) {
        if (key === 'select') continue;
        if (key === 'order') {
          for (const order of expression.split(',')) {
            const [column, direction] = order.split('.');
            if (column) query = query.order(column, { ascending: direction !== 'desc' });
          }
          continue;
        }
        const separator = expression.indexOf('.');
        if (separator < 1) throw new Error(`Filter ${key} tidak valid.`);
        const operator = expression.slice(0, separator);
        const rawValue = expression.slice(separator + 1);
        const supportedOperators = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);
        if (!supportedOperators.has(operator) || typeof query[operator] !== 'function') {
          throw new Error(`Operator filter ${operator} tidak didukung.`);
        }
        let value = rawValue;
        if (operator === 'in') {
          if (!rawValue.startsWith('(') || !rawValue.endsWith(')')) throw new Error(`Filter ${key} tidak valid.`);
          value = rawValue.slice(1, -1).split(',');
        }
        query = query[operator](key, value);
      }

      if (method === 'PATCH' && (options.headers?.prefer || '').includes('return=representation')) query = query.select();
      const { data, error } = await query;
      if (error) throw error;
      return data;
    }

    const rpcRoutes = {
      '/posting/invoice': 'post_invoice',
      '/posting/payment': 'post_payment',
      '/ecl/estimate': 'calculate_ecl',
      '/ecl/post': 'post_ecl_adjustment',
      '/aging': 'get_aging_schedule',
      '/journals/reverse': 'reverse_journal',
      '/journals/opening': 'post_opening_journal'
    };
    const functionName = rpcRoutes[path];
    if (!functionName || method !== 'POST') throw new Error(`Operasi Supabase ${path} tidak didukung.`);
    const { data, error } = await supabaseClient.rpc(functionName, options.body);
    if (error) throw error;
    return data;
  }

  async function records(table, query = '') {
    const suffix = query ? `?${query}` : '';
    return api(`/records/${table}${suffix}`);
  }

  async function postRpc(path, body) {
    return api(path, { method: 'POST', body });
  }

  async function initialize() {
    setConnection('', 'Memeriksa koneksi');
    try {
      const config = window.PiutangGuardBackend?.config;
      if (!config?.url || !config?.key) throw new Error('Konfigurasi Supabase belum diisi di backend/app.js.');
      if (!window.supabase?.createClient) throw new Error('Library Supabase Auth gagal dimuat. Periksa koneksi internet atau CDN.');
      supabaseClient = window.supabase.createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      session = data.session;
      supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
        session = nextSession;
        if (session) {
          closeAuthDialog();
          updateUser(session.user);
          setConnection('connected', 'Supabase terhubung');
          renderPage();
        } else {
          updateUser(null);
          setConnection('disconnected', 'Belum masuk');
          openAuthDialog();
        }
      });
      if (session) {
        updateUser(session.user);
        setConnection('connected', 'Supabase terhubung');
        await renderPage();
      } else {
        setConnection('disconnected', 'Belum masuk');
        openAuthDialog();
      }
    } catch (error) {
      setConnection('disconnected', 'Koneksi gagal');
      showNotice(error.message, 'error');
      openAuthDialog();
    }
  }

  function updateUser(user) {
    $('#user-name').textContent = user?.user_metadata?.full_name || user?.email || 'Belum masuk';
    $('#user-email').textContent = user?.email || 'Sesi Supabase';
    $('#user-avatar').textContent = (user?.email || 'PG').slice(0, 2).toUpperCase();
  }

  function openAuthDialog(message = '') {
    const dialog = $('#auth-dialog');
    if (!dialog.open) dialog.showModal();
    $('#auth-message').textContent = message;
  }

  function closeAuthDialog() {
    const dialog = $('#auth-dialog');
    if (dialog.open) dialog.close();
    $('#auth-message').textContent = '';
  }

  async function signIn(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    const values = new FormData(form);
    setBusy(button, true, 'Memverifikasi');
    $('#auth-message').textContent = '';
    try {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email: values.get('email'),
        password: values.get('password')
      });
      if (error) throw error;
      form.reset();
    } catch (error) {
      $('#auth-message').textContent = error.message || 'Login gagal.';
    } finally {
      setBusy(button, false);
    }
  }

  async function signOut() {
    if (!supabaseClient || !session) return;
    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;
    } catch (error) {
      showNotice(`Tidak dapat keluar dengan aman: ${error.message}`, 'error');
    }
  }

  function pageHeader(title, subtitle, actions = '') {
    return `<div class="page-heading"><div><p class="eyebrow">PIUTANGGUARD</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
  }

  function loading() {
    $('#page-content').innerHTML = '<div class="loading"><div><div class="spinner"></div>Memuat data dari Supabase...</div></div>';
  }

  async function renderPage() {
    if (!session) return;
    const meta = pageTitles[page] || pageTitles.dashboard;
    $('#page-title').textContent = meta[0];
    $$('.navigation a').forEach(link => link.classList.toggle('active', link.dataset.page === page));
    closeMobileNav();
    clearNotice();
    loading();
    try {
      switch (page) {
        case 'customers': await renderCustomers(); break;
        case 'invoices': await renderInvoices(); break;
        case 'payments': await renderPayments(); break;
        case 'aging': await renderAging(); break;
        case 'allowance': await renderAllowance(); break;
        case 'journals': await renderJournals(); break;
        case 'income': await renderIncomeStatement(); break;
        case 'position': await renderPosition(); break;
        default: page = 'dashboard'; await renderDashboard();
      }
    } catch (error) {
      $('#page-content').innerHTML = `<section class="panel"><div class="notice error"><i class="fa-solid fa-circle-exclamation"></i><span>${escapeHtml(error.message)}</span></div><button class="button button-secondary" data-action="refresh"><i class="fa-solid fa-rotate"></i> Coba lagi</button></section>`;
      setConnection('disconnected', 'Gagal memuat data');
    }
  }

  function setPage(nextPage) {
    if (!pageTitles[nextPage]) nextPage = 'dashboard';
    page = nextPage;
    if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    renderPage();
  }

  function getPageState(key) {
    if (!tableState[key]) tableState[key] = { search: '', page: 1, filter: '' };
    return tableState[key];
  }

  function filterRows(rows, key, getSearchText, getFilterValue) {
    const state = getPageState(key);
    let filtered = rows;
    if (state.search.trim()) {
      const term = state.search.trim().toLocaleLowerCase('id');
      filtered = filtered.filter(row => getSearchText(row).toLocaleLowerCase('id').includes(term));
    }
    if (state.filter && getFilterValue) filtered = filtered.filter(row => getFilterValue(row) === state.filter);
    return filtered;
  }

  function tableSection({ key, title, rows, columns, searchText, filterValue, filterOptions = [], actions, emptyText = 'Belum ada data.', filterLabel = 'Semua status' }) {
    const state = getPageState(key);
    const filtered = filterRows(rows, key, searchText, filterValue);
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    state.page = Math.min(state.page, pageCount);
    const start = (state.page - 1) * pageSize;
    const shown = filtered.slice(start, start + pageSize);
    const headings = columns.map(column => `<th class="${column.numeric ? 'numeric' : ''}">${escapeHtml(column.label)}</th>`).join('');
    const body = shown.length
      ? shown.map(row => `<tr data-row-id="${escapeHtml(row.id || '')}">${columns.map(column => `<td class="${column.numeric ? 'numeric' : ''}">${column.render ? column.render(row) : escapeHtml(row[column.key])}</td>`).join('')}${actions ? `<td><div class="row-actions">${actions(row)}</div></td>` : ''}</tr>`).join('')
      : `<tr><td class="empty-row" colspan="${columns.length + (actions ? 1 : 0)}">${escapeHtml(emptyText)}</td></tr>`;
    const filters = filterOptions.length
      ? `<select class="field" data-table-filter="${escapeHtml(key)}" aria-label="${escapeHtml(filterLabel)}"><option value="">${escapeHtml(filterLabel)}</option>${filterOptions.map(option => `<option value="${escapeHtml(option.value)}"${state.filter === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
      : '';
    return `<section class="panel table-panel"><div class="table-toolbar"><h2>${escapeHtml(title)} <span class="muted">(${filtered.length})</span></h2><div class="table-tools">${filters}<label class="search-box"><i class="fa-solid fa-magnifying-glass"></i><input type="search" value="${escapeHtml(state.search)}" placeholder="Cari data..." data-table-search="${escapeHtml(key)}"></label></div></div><div class="table-scroll"><table><thead><tr>${headings}${actions ? '<th class="numeric">Aksi</th>' : ''}</tr></thead><tbody>${body}</tbody></table></div><div class="table-footer"><span>Menampilkan ${filtered.length ? start + 1 : 0}–${Math.min(start + pageSize, filtered.length)} dari ${filtered.length} data</span><div class="pagination"><button data-page-action="-1" data-table-key="${escapeHtml(key)}" aria-label="Sebelumnya" ${state.page <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button><span>${state.page} / ${pageCount}</span><button data-page-action="1" data-table-key="${escapeHtml(key)}" aria-label="Berikutnya" ${state.page >= pageCount ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div></div></section>`;
  }

  function kpi(label, value, icon, tone, foot) {
    return `<div class="kpi-card"><div class="kpi-top"><span>${escapeHtml(label)}</span><span class="kpi-icon ${tone}"><i class="fa-solid ${icon}"></i></span></div><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-foot">${escapeHtml(foot)}</div></div>`;
  }

  async function getAging(asOfDate = today()) {
    const result = await postRpc('/aging', { p_as_of_date: asOfDate });
    cache.aging = Array.isArray(result) ? result : [];
    return cache.aging;
  }

  async function getEcl(asOfDate = today(), rates = defaultRates) {
    const result = await postRpc('/ecl/estimate', { p_as_of_date: asOfDate, p_rates: rates });
    cache.allowance = result;
    return result;
  }

  async function renderDashboard() {
    const [customers, invoices, payments, cashLines, aging, allowance] = await Promise.all([
      records('customers', 'select=id,customer_code,name,credit_limit,status&order=name.asc'),
      records('invoices', 'select=id,customer_id,invoice_number,invoice_date,due_date,amount,discount_amount,status&order=invoice_date.desc'),
      records('payments', `select=id,invoice_id,payment_number,payment_date,amount,status&payment_date=gte.${lastMonths(6)[0].value}-01&payment_date=lte.${today()}&order=payment_date.asc`),
      records('journal_lines', `select=entry_date,debit,credit,entry_type&account_code=eq.1110&entry_type=in.(PAYMENT,REVERSAL)&entry_date=gte.${lastMonths(6)[0].value}-01&entry_date=lte.${today()}&order=entry_date.asc`),
      getAging(today()),
      getEcl(today())
    ]);
    cache.customers = customers;
    cache.invoices = invoices;
    cache.payments = payments;
    const outstanding = aging.reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
    const paidMonth = cashLines.filter(row => String(row.entry_date).startsWith(today().slice(0, 7)))
      .reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0);
    const overdue = aging.filter(row => Number(row.days_overdue) > 0);
    const overdueAmount = overdue.reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
    const allowanceAmount = Number(allowance.target_allowance || 0);
    const net = outstanding - allowanceAmount;
    const buckets = Object.fromEntries(Object.keys(rateLabels).map(key => [key, { amount: 0, count: 0 }]));
    aging.forEach(row => {
      if (buckets[row.aging_bucket]) {
        buckets[row.aging_bucket].amount += Number(row.outstanding_amount);
        buckets[row.aging_bucket].count += 1;
      }
    });
    const months = lastMonths(6);
    const paymentTrend = months.map(month => ({
      label: month.label,
      amount: cashLines.filter(line => line.entry_date.startsWith(month.value))
        .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0)
    }));
    latestPaymentTrend = paymentTrend;
    const bucketData = Object.entries(rateLabels).map(([key, label]) => ({ label, amount: buckets[key]?.amount || 0 }));
    $('#page-content').innerHTML = `${pageHeader('Dashboard', 'Ringkasan risiko piutang dan kinerja penagihan.', '')}
      <div class="kpi-grid">
        ${kpi('Piutang outstanding', money(outstanding), 'fa-file-invoice-dollar', '', 'Saldo piutang bruto sebelum cadangan')}
        ${kpi('Piutang jatuh tempo', money(overdueAmount), 'fa-clock', 'red', `${overdue.length} invoice terlambat`)}
        ${kpi('Rasio jatuh tempo', `${outstanding > 0 ? (overdueAmount / outstanding * 100).toFixed(1).replace('.', ',') : '0'}%`, 'fa-percent', 'red', 'Porsi piutang jatuh tempo dari outstanding')}
        ${kpi('Estimasi cadangan', money(allowanceAmount), 'fa-scale-balanced', 'amber', 'Estimasi kerugian kredit berbasis aging')}
        ${kpi('Piutang bersih', money(net), 'fa-shield-halved', 'green', 'Outstanding dikurangi cadangan estimasi')}
        ${kpi('Pembayaran bulan ini', money(paidMonth), 'fa-money-bill-transfer', 'teal', 'Bersih bulan ini, termasuk reversal jurnal')}
      </div>
      <div class="content-grid">
        <section class="panel"><div class="panel-heading"><div><h2>Komposisi aging</h2><p>Saldo terbuka menurut umur piutang</p></div></div><div class="bar-list">${bucketData.map(item => renderBar(item.label, item.amount, outstanding, '#3589c7')).join('') || '<div class="chart-empty">Belum ada saldo piutang.</div>'}</div></section>
        <section class="panel"><div class="panel-heading"><div><h2>Tren pembayaran</h2><p>Enam bulan terakhir, berdasarkan pembayaran terposting</p></div></div><div class="chart-wrap"><canvas id="payment-chart" role="img" aria-label="Grafik tren pembayaran enam bulan"></canvas></div></section>
      </div>`;
    drawPaymentChart(paymentTrend);
  }

  function lastMonths(count) {
    const result = [];
    const current = new Date();
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(current.getFullYear(), current.getMonth() - offset, 1);
      const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      result.push({ value, label: new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(date) });
    }
    return result;
  }

  function renderBar(label, value, maximum, color) {
    const width = maximum > 0 ? Math.max(2, Number(value) / maximum * 100) : 0;
    const tone = color === '#15958a' ? 'bar-teal' : '';
    return `<div class="bar-row"><span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="bar-track"><progress class="bar-fill ${tone}" max="100" value="${width}" aria-label="${escapeHtml(label)}">${width.toFixed(1)}%</progress></span><span class="bar-value">${money(value)}</span></div>`;
  }

  function drawPaymentChart(data) {
    const canvas = $('#payment-chart');
    if (!canvas) return;
    const width = canvas.clientWidth || 500;
    const height = 210;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    const pad = { top: 12, right: 12, bottom: 34, left: 10 };
    const chartWidth = width - pad.left - pad.right;
    const chartHeight = height - pad.top - pad.bottom;
    const max = Math.max(...data.map(row => Math.abs(row.amount)), 1);
    ctx.strokeStyle = '#e9eef3';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i += 1) {
      const y = pad.top + chartHeight * i / 2;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    }
    const baseline = pad.top + chartHeight / 2;
    ctx.strokeStyle = '#cbd5df';
    ctx.beginPath(); ctx.moveTo(pad.left, baseline); ctx.lineTo(width - pad.right, baseline); ctx.stroke();
    const slot = chartWidth / data.length;
    data.forEach((item, index) => {
      const barWidth = Math.min(28, slot * .46);
      const barHeight = Math.abs(item.amount) > 0 ? (chartHeight / 2 - 4) * Math.abs(item.amount) / max : 2;
      const x = pad.left + slot * index + (slot - barWidth) / 2;
      const y = item.amount >= 0 ? baseline - barHeight : baseline;
      ctx.fillStyle = item.amount < 0 ? '#c75a5a' : item.amount > 0 ? '#3d92cb' : '#e5ebf1';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, 4);
      else ctx.rect(x, y, barWidth, barHeight);
      ctx.fill();
      ctx.fillStyle = '#8190a0';
      ctx.font = '10px DM Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.label, x + barWidth / 2, height - 12);
    });
  }


  function outstandingByInvoice() {
    return new Map(cache.aging.map(row => [row.invoice_id, Number(row.outstanding_amount)]));
  }

  async function renderCustomers() {
    const [customers, aging] = await Promise.all([
      records('customers', 'select=*&order=name.asc'),
      getAging()
    ]);
    cache.customers = customers;
    const balances = new Map();
    aging.forEach(row => balances.set(row.customer_id, (balances.get(row.customer_id) || 0) + Number(row.outstanding_amount)));
    const rows = customers.map(customer => {
      const outstanding = balances.get(customer.id) || 0;
      return { ...customer, outstanding, availableLimit: Number(customer.credit_limit) - outstanding };
    });
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.customers, '<button class="button button-primary" data-action="new-customer"><i class="fa-solid fa-plus"></i> Tambah pelanggan</button>')}
      ${tableSection({
        key: 'customers', title: 'Daftar pelanggan', rows,
        columns: [
          { label: 'Kode', key: 'customer_code', render: row => `<span class="cell-primary">${escapeHtml(row.customer_code)}</span>` },
          { label: 'Pelanggan', key: 'name', render: row => `<span class="cell-primary">${escapeHtml(row.name)}</span>` },
          { label: 'Kontak', key: 'phone', render: row => `${escapeHtml(row.phone || '—')}<span class="cell-sub">${escapeHtml(row.email || '')}</span>` },
          { label: 'Batas kredit', key: 'credit_limit', numeric: true, render: row => money(row.credit_limit) },
          { label: 'Outstanding', key: 'outstanding', numeric: true, render: row => money(row.outstanding) },
          { label: 'Sisa limit', key: 'availableLimit', numeric: true, render: row => `<span class="badge ${row.availableLimit < 0 ? 'danger' : 'success'}">${money(row.availableLimit)}</span>` },
          { label: 'Status', key: 'status', render: row => statusBadge(row.status) }
        ],
        searchText: row => `${row.customer_code} ${row.name} ${row.phone || ''} ${row.email || ''}`,
        filterOptions: [{ value: 'ACTIVE', label: 'Aktif' }, { value: 'INACTIVE', label: 'Nonaktif' }],
        filterValue: row => row.status,
        actions: row => `<button class="row-action" title="Detail" data-action="detail-customer" data-id="${row.id}"><i class="fa-regular fa-eye"></i></button><button class="row-action" title="Edit" data-action="edit-customer" data-id="${row.id}"><i class="fa-solid fa-pen"></i></button><button class="row-action danger" title="Hapus" data-action="delete-customer" data-id="${row.id}"><i class="fa-regular fa-trash-can"></i></button>`
      })}`;
  }

  async function renderInvoices() {
    const [invoices, customers, aging] = await Promise.all([
      records('invoices', 'select=*&order=invoice_date.desc'),
      records('customers', 'select=id,name,customer_code,credit_limit,status&order=name.asc'),
      getAging()
    ]);
    cache.invoices = invoices;
    cache.customers = customers;
    const customerMap = new Map(customers.map(customer => [customer.id, customer]));
    const balances = outstandingByInvoice();
    const rows = invoices.map(invoice => ({
      ...invoice,
      customer: customerMap.get(invoice.customer_id),
      outstanding: balances.get(invoice.id) || 0
    }));
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.invoices, '<button class="button button-primary" data-action="new-invoice"><i class="fa-solid fa-plus"></i> Buat invoice</button>')}
      <div class="notice"><i class="fa-solid fa-circle-info"></i><span>Posting mensyaratkan tanggal penyerahan barang/jasa yang telah terjadi. Pendapatan dihitung setelah diskon; harga pokok membentuk jurnal beban dan persediaan.</span></div>
      ${tableSection({
        key: 'invoices', title: 'Daftar invoice', rows,
        columns: [
          { label: 'Invoice', key: 'invoice_number', render: row => `<span class="cell-primary">${escapeHtml(row.invoice_number)}</span><span class="cell-sub">${dateLabel(row.invoice_date)}</span>` },
          { label: 'Pelanggan', key: 'customer', render: row => escapeHtml(row.customer?.name || 'Pelanggan tidak ditemukan') },
          { label: 'Jatuh tempo', key: 'due_date', render: row => dateLabel(row.due_date) },
          { label: 'Nilai bersih', key: 'amount', numeric: true, render: row => money(Number(row.amount) - Number(row.discount_amount || 0)) },
          { label: 'Outstanding', key: 'outstanding', numeric: true, render: row => money(row.outstanding) },
          { label: 'Status', key: 'status', render: row => statusBadge(row.status) }
        ],
        searchText: row => `${row.invoice_number} ${row.customer?.name || ''} ${row.status}`,
        filterOptions: ['DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'REVERSED'].map(status => ({ value: status, label: statusBadgeText(status) })),
        filterValue: row => row.status,
        actions: row => `<button class="row-action" title="Detail" data-action="detail-invoice" data-id="${row.id}"><i class="fa-regular fa-eye"></i></button>${row.status === 'DRAFT' ? `<button class="row-action" title="Edit draft" data-action="edit-invoice" data-id="${row.id}"><i class="fa-solid fa-pen"></i></button><button class="row-action" title="Posting" data-action="post-invoice" data-id="${row.id}"><i class="fa-solid fa-check"></i></button><button class="row-action danger" title="Hapus draft" data-action="delete-invoice" data-id="${row.id}"><i class="fa-regular fa-trash-can"></i></button>` : ''}`
      })}`;
  }

  function statusBadgeText(status) {
    const labels = { DRAFT: 'Draft', UNPAID: 'Belum dibayar', POSTED: 'Terposting', PARTIALLY_PAID: 'Sebagian', PAID: 'Lunas', REVERSED: 'Direversal' };
    return labels[status] || status;
  }

  async function renderPayments() {
    const [payments, invoices, customers, aging] = await Promise.all([
      records('payments', 'select=*&order=payment_date.desc'),
      records('invoices', 'select=id,invoice_number,customer_id,amount,discount_amount,status&order=invoice_date.desc'),
      records('customers', 'select=id,name&order=name.asc'),
      getAging()
    ]);
    cache.payments = payments;
    cache.invoices = invoices;
    cache.customers = customers;
    const invoiceMap = new Map(invoices.map(invoice => [invoice.id, invoice]));
    const customerMap = new Map(customers.map(customer => [customer.id, customer]));
    const balances = outstandingByInvoice();
    const rows = payments.map(payment => {
      const invoice = invoiceMap.get(payment.invoice_id);
      return {
        ...payment,
        invoice,
        customer: customerMap.get(invoice?.customer_id),
        invoiceOutstanding: balances.get(payment.invoice_id) || 0
      };
    });
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.payments, '<button class="button button-primary" data-action="new-payment"><i class="fa-solid fa-plus"></i> Catat pembayaran</button>')}
      <div class="notice"><i class="fa-solid fa-circle-info"></i><span>Pembayaran hanya dapat diposting terhadap invoice terposting dan tidak boleh melebihi saldo outstanding.</span></div>
      ${tableSection({
        key: 'payments', title: 'Daftar pembayaran', rows,
        columns: [
          { label: 'Pembayaran', key: 'payment_number', render: row => `<span class="cell-primary">${escapeHtml(row.payment_number)}</span><span class="cell-sub">${dateLabel(row.payment_date)}</span>` },
          { label: 'Invoice', key: 'invoice', render: row => escapeHtml(row.invoice?.invoice_number || 'Invoice tidak ditemukan') },
          { label: 'Pelanggan', key: 'customer', render: row => escapeHtml(row.customer?.name || '—') },
          { label: 'Metode', key: 'payment_method', render: row => escapeHtml(row.payment_method || '—') },
          { label: 'Jumlah', key: 'amount', numeric: true, render: row => money(row.amount) },
          { label: 'Sisa invoice', key: 'invoiceOutstanding', numeric: true, render: row => money(row.invoiceOutstanding) },
          { label: 'Status', key: 'status', render: row => statusBadge(row.status) }
        ],
        searchText: row => `${row.payment_number} ${row.invoice?.invoice_number || ''} ${row.customer?.name || ''} ${row.reference_number || ''}`,
        filterOptions: ['DRAFT', 'POSTED', 'REVERSED'].map(status => ({ value: status, label: statusBadgeText(status) })),
        filterValue: row => row.status,
        actions: row => `<button class="row-action" title="Detail" data-action="detail-payment" data-id="${row.id}"><i class="fa-regular fa-eye"></i></button>${row.status === 'DRAFT' ? `<button class="row-action" title="Edit draft" data-action="edit-payment" data-id="${row.id}"><i class="fa-solid fa-pen"></i></button><button class="row-action" title="Posting" data-action="post-payment" data-id="${row.id}"><i class="fa-solid fa-check"></i></button><button class="row-action danger" title="Hapus draft" data-action="delete-payment" data-id="${row.id}"><i class="fa-regular fa-trash-can"></i></button>` : ''}`
      })}`;
  }

  async function renderAging() {
    const [aging, customers] = await Promise.all([
      getAging(agingFilter.date),
      records('customers', 'select=id,name,customer_code&order=name.asc')
    ]);
    cache.customers = customers;
    const visible = aging.filter(row => (!agingFilter.customer || row.customer_id === agingFilter.customer)
      && (!agingFilter.bucket || row.aging_bucket === agingFilter.bucket));
    const total = visible.reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
    const customerOptions = customers.map(customer => `<option value="${customer.id}"${agingFilter.customer === customer.id ? ' selected' : ''}>${escapeHtml(customer.customer_code)} — ${escapeHtml(customer.name)}</option>`).join('');
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.aging, '')}
      <section class="panel">
        <div class="filter-row">
          <label class="date-field">Tanggal laporan<input type="date" id="aging-date" value="${escapeHtml(agingFilter.date)}"></label>
          <label>Pelanggan<select id="aging-customer"><option value="">Semua pelanggan</option>${customerOptions}</select></label>
          <label>Kategori umur<select id="aging-bucket"><option value="">Semua kategori</option>${Object.entries(rateLabels).map(([key, label]) => `<option value="${key}"${agingFilter.bucket === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
          <div class="heading-actions"><span class="badge info">Saldo: ${money(total)}</span></div>
        </div>
        ${tableSection({
          key: 'aging', title: `Saldo piutang per ${dateLabel(agingFilter.date)}`, rows: visible,
          columns: [
            { label: 'Invoice', key: 'invoice_number', render: row => `<span class="cell-primary">${escapeHtml(row.invoice_number)}</span><span class="cell-sub">${dateLabel(row.invoice_date)}</span>` },
            { label: 'Pelanggan', key: 'customer_name' },
            { label: 'Jatuh tempo', key: 'due_date', render: row => dateLabel(row.due_date) },
            { label: 'Hari lewat', key: 'days_overdue', numeric: true, render: row => Number(row.days_overdue) > 0 ? `<span class="badge danger">${number(row.days_overdue)} hari</span>` : '<span class="badge success">Belum jatuh tempo</span>' },
            { label: 'Kategori', key: 'aging_category', render: row => `<span class="badge ${row.aging_bucket === 'not_due' ? 'success' : row.aging_bucket === 'over_90' ? 'danger' : 'warning'}">${escapeHtml(rateLabels[row.aging_bucket] || row.aging_category)}</span>` },
            { label: 'Outstanding', key: 'outstanding_amount', numeric: true, render: row => money(row.outstanding_amount) }
          ],
          searchText: row => `${row.invoice_number} ${row.customer_name} ${row.aging_category}`,
          emptyText: 'Tidak ada saldo outstanding untuk filter ini.'
        })}
      </section>`;
  }

  async function renderAllowance(asOfDate = today(), rates = defaultRates) {
    const [estimate, aging] = await Promise.all([getEcl(asOfDate, rates), getAging(asOfDate)]);
    const buckets = Array.isArray(estimate.buckets) ? estimate.buckets : [];
    const selectedRates = estimate.rates || defaultRates;
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.allowance, `<button class="button button-secondary" data-action="recalculate-ecl"><i class="fa-solid fa-rotate"></i> Hitung ulang</button><button class="button button-primary" data-action="post-ecl"><i class="fa-solid fa-scale-balanced"></i> Posting penyesuaian</button>`)}
      <div class="notice"><i class="fa-solid fa-circle-info"></i><span>Tarif pada matriks adalah estimasi manajemen berdasarkan umur piutang dan perlu dikalibrasi dengan pengalaman kerugian historis perusahaan. Estimasi final dihitung ulang di database saat posting dan hanya selisih terhadap saldo cadangan tercatat yang dijurnal.</span></div>
      <section class="panel"><div class="panel-heading"><div><h2>Matriks tarif dan ringkasan</h2><p>Ubah tarif untuk simulasi per tanggal laporan.</p></div><label class="date-field">Tanggal laporan<input type="date" id="ecl-date" value="${escapeHtml(asOfDate)}"></label></div>
        <div class="filter-row">${Object.entries(rateLabels).map(([key, label]) => `<label>${escapeHtml(label)} (%)<input class="rate-input" type="number" min="0" max="100" step="0.01" value="${(Number(selectedRates[key] || 0) * 100).toFixed(2)}" data-rate="${key}"></label>`).join('')}</div>
        <div class="kpi-grid">${kpi('Estimasi cadangan', money(estimate.target_allowance), 'fa-scale-balanced', 'amber', 'Saldo target berdasarkan aging')}${kpi('Saldo tercatat', money(estimate.recorded_allowance), 'fa-book', '', 'Saldo akun cadangan per tanggal laporan')}${kpi('Penyesuaian', money(Math.abs(Number(estimate.adjustment))), 'fa-arrows-rotate', Number(estimate.adjustment) < 0 ? 'teal' : 'red', Number(estimate.adjustment) < 0 ? 'Pembalikan cadangan berlebih' : Number(estimate.adjustment) > 0 ? 'Tambahan beban estimasi' : 'Tidak ada selisih')}</div>
        ${tableSection({
          key: 'ecl-buckets', title: 'Rincian menurut kategori aging', rows: buckets,
          columns: [
            { label: 'Kategori', key: 'aging_bucket', render: row => escapeHtml(rateLabels[row.aging_bucket] || row.aging_category) },
            { label: 'Eksposur', key: 'exposure', numeric: true, render: row => money(row.exposure) },
            { label: 'Tarif estimasi', key: 'rate', numeric: true, render: row => `${(Number(row.rate) * 100).toFixed(2)}%` },
            { label: 'Estimasi kerugian', key: 'estimated_loss', numeric: true, render: row => money(row.estimated_loss) }
          ],
          searchText: row => `${row.aging_bucket} ${row.aging_category}`,
          emptyText: 'Belum ada saldo outstanding.'
        })}
      </section>`;
    cache.allowance = estimate;
    cache.aging = aging;
  }

  async function renderJournals() {
    if (journalStart && journalEnd && journalStart > journalEnd) {
      throw new Error('Tanggal awal jurnal tidak boleh melebihi tanggal akhir.');
    }
    let journalQuery = 'select=*&order=entry_date.desc,line_number.asc';
    if (journalStart) journalQuery += `&entry_date=gte.${journalStart}`;
    if (journalEnd) journalQuery += `&entry_date=lte.${journalEnd}`;
    const lines = await records('journal_lines', journalQuery);
    const groups = new Map();
    lines.forEach(line => {
      if (!groups.has(line.entry_group_id)) groups.set(line.entry_group_id, []);
      groups.get(line.entry_group_id).push(line);
    });
    const numberById = new Map([...groups.entries()].map(([id, groupLines]) => [id, groupLines[0].journal_number]));
    cache.journals = [...groups.entries()].map(([id, groupLines]) => {
      const first = groupLines[0];
      const originalId = first.reversal_of_group_id;
      const originalNumber = originalId ? (numberById.get(originalId) || null) : null;
      const reversedBy = lines.find(line => line.reversal_of_group_id === id);
      const legacyReversal = first.entry_type === 'REVERSAL' && /^Pembalikan jurnal [0-9a-f-]{36}$/i.test(first.description || '');
      return {
        id,
        journal_number: first.journal_number,
        created_at: first.created_at,
        reversal_of_number: originalNumber,
        reversed_by_number: reversedBy ? reversedBy.journal_number : null,
        entry_date: first.entry_date,
        entry_type: first.entry_type,
        description: legacyReversal ? `Pembalikan ${originalNumber || 'jurnal terkait'}` : first.description,
        lines: groupLines,
        debit: groupLines.reduce((sum, line) => sum + Number(line.debit), 0),
        credit: groupLines.reduce((sum, line) => sum + Number(line.credit), 0),
        reversed: groupLines.some(line => line.reversal_of_group_id) || lines.some(line => line.reversal_of_group_id === id)
      };
    }).sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)) || String(b.created_at).localeCompare(String(a.created_at)));
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.journals, `<button class="button button-primary" data-action="opening-journal"><i class="fa-solid fa-plus"></i> Jurnal pembukaan</button>`)}
      <div class="notice"><i class="fa-solid fa-lock"></i><span>Baris jurnal yang telah diposting bersifat immutable. Kesalahan diperbaiki dengan reversal, bukan mengubah atau menghapus jurnal.</span></div>
      <div class="filter-row"><label>Tanggal awal<input type="date" id="journal-start" value="${escapeHtml(journalStart)}"></label><label>Tanggal akhir<input type="date" id="journal-end" value="${escapeHtml(journalEnd)}"></label></div>
      ${tableSection({
        key: 'journals', title: 'Kelompok jurnal', rows: cache.journals,
        columns: [
          { label: 'No. Jurnal', key: 'journal_number', render: row => `<span class="cell-primary">${escapeHtml(journalNumber(row))}</span>${row.reversed_by_number ? `<span class="cell-sub">Dibalik oleh ${escapeHtml(row.reversed_by_number)}</span>` : (row.reversal_of_number ? `<span class="cell-sub">Membalik ${escapeHtml(row.reversal_of_number)}</span>` : '')}` },
          { label: 'Tanggal', key: 'entry_date', render: row => dateLabel(row.entry_date) },
          { label: 'Tipe', key: 'entry_type', render: row => `<span class="badge info">${escapeHtml(typeLabel(row.entry_type))}</span>` },
          { label: 'Deskripsi', key: 'description', render: row => `<span class="cell-primary">${escapeHtml(row.description || '—')}</span><span class="cell-sub">${row.lines.length} baris</span>` },
          { label: 'Total debit', key: 'debit', numeric: true, render: row => money(row.debit) },
          { label: 'Total kredit', key: 'credit', numeric: true, render: row => money(row.credit) }
        ],
        searchText: row => `${journalNumber(row)} ${typeLabel(row.entry_type)} ${row.entry_type} ${row.description || ''} ${row.lines.map(line => `${line.account_code} ${line.account_name}`).join(' ')}`,
        filterLabel: 'Semua tipe',
        filterOptions: [...new Set(cache.journals.map(row => row.entry_type))].map(type => ({ value: type, label: typeLabel(type) })),
        filterValue: row => row.entry_type,
        actions: row => `<button class="row-action" title="Detail jurnal" data-action="detail-journal" data-id="${row.id}"><i class="fa-regular fa-eye"></i></button>${row.reversed || row.entry_type === 'REVERSAL' ? '' : `<button class="row-action danger" title="Reversal" data-action="reverse-journal" data-id="${row.id}"><i class="fa-solid fa-rotate-left"></i></button>`}`
      })}`;
  }

  async function renderIncomeStatement() {
    if (incomeStart > incomeEnd) throw new Error('Tanggal awal periode tidak boleh melebihi tanggal akhir.');
    const periodLength = Math.round((Date.parse(`${incomeEnd}T00:00:00Z`) - Date.parse(`${incomeStart}T00:00:00Z`)) / 86400000);
    const comparativeEnd = addDays(incomeStart, -1);
    const comparativeStart = addDays(comparativeEnd, -periodLength);
    const allLines = await records(
      'journal_lines',
      `select=account_code,account_name,debit,credit,entry_date,entry_type,description&status=eq.POSTED&entry_date=gte.${comparativeStart}&entry_date=lte.${incomeEnd}&order=account_code.asc,entry_date.asc`
    );
    const currentLines = allLines.filter(line => line.entry_type !== 'OPENING' && line.entry_date >= incomeStart && line.entry_date <= incomeEnd);
    const comparativeLines = allLines.filter(line => line.entry_type !== 'OPENING' && line.entry_date >= comparativeStart && line.entry_date <= comparativeEnd);
    const summarize = periodLines => {
      const accounts = new Map();
      periodLines.forEach(line => {
        const code = String(line.account_code);
        const definition = accountMap[code];
        if (!accounts.has(code)) accounts.set(code, {
          code,
          name: line.account_name,
          classification: definition?.classification || 'unclassified',
          expectedName: definition?.name || null,
          names: new Set(),
          debit: 0,
          credit: 0
        });
        const account = accounts.get(code);
        account.names.add(line.account_name);
        account.debit += Number(line.debit);
        account.credit += Number(line.credit);
      });
      for (const account of accounts.values()) {
        account.balance = ['revenue', 'other_revenue'].includes(account.classification)
          ? account.credit - account.debit
          : account.debit - account.credit;
      }
      const values = [...accounts.values()];
      const total = predicate => values.filter(predicate).reduce((sum, account) => sum + account.balance, 0);
      const sales = total(account => account.classification === 'revenue');
      const cost = total(account => account.code === '5100');
      const creditLoss = total(account => account.code === '5110');
      const operating = total(account => account.classification === 'expense' && !['5100', '5110'].includes(account.code));
      const otherIncome = total(account => account.classification === 'other_revenue');
      const otherExpense = total(account => account.classification === 'other_expense');
      const tax = total(account => account.classification === 'tax_expense');
      const grossProfit = sales - cost;
      const beforeTax = grossProfit + otherIncome - creditLoss - operating - otherExpense;
      return {
        accounts: values,
        sales,
        cost,
        grossProfit,
        creditLoss,
        operating,
        otherIncome,
        otherExpense,
        beforeTax,
        tax,
        netIncome: beforeTax - tax,
        unknown: values.filter(account => account.classification === 'unclassified'),
        mismatches: values.filter(account => account.expectedName
          && (account.names.size > 1 || !account.names.has(account.expectedName)))
      };
    };
    const current = summarize(currentLines);
    const comparative = comparativeLines.length ? summarize(comparativeLines) : null;
    const allAccounts = new Map([...current.accounts, ...(comparative?.accounts || [])].map(account => [account.code, account]));
    const groupedRows = predicate => [...allAccounts.values()].filter(predicate).map(account => {
      const currentAccount = current.accounts.find(row => row.code === account.code);
      const comparativeAccount = comparative?.accounts.find(row => row.code === account.code);
      const classification = account.classification;
      const currentValue = currentAccount?.balance || 0;
      const comparativeValue = comparative ? (comparativeAccount?.balance || 0) : null;
      const expense = classification === 'expense' || classification === 'other_expense' || classification === 'tax_expense';
      return statementLine(`${account.code} — ${account.expectedName || account.name}`, currentValue, comparativeValue, { currentExpense: expense });
    }).join('');
    const currentLabel = `${dateLabel(incomeStart)} – ${dateLabel(incomeEnd)}`;
    const comparativeLabel = comparative ? `${dateLabel(comparativeStart)} – ${dateLabel(comparativeEnd)}` : 'Tidak tersedia';
    const incompleteAccounts = [...new Map([...current.unknown, ...(comparative?.unknown || [])]
      .map(account => [account.code, account])).values()];
    const nameMismatches = [...new Map([...current.mismatches, ...(comparative?.mismatches || [])]
      .map(account => [account.code, account])).values()];
    const totalsLine = (label, currentValue, comparativeValue, options = {}) =>
      statementLine(label, currentValue, comparative ? comparativeValue : null, { type: options.type || 'total', currentExpense: options.expense });
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.income, `<button class="button button-secondary" data-action="print-report"><i class="fa-solid fa-print"></i> Cetak laporan</button>`)}
      <section class="panel report-filters-panel">
        <div class="report-filters">
          <label>Periode awal<input type="date" id="income-start" value="${escapeHtml(incomeStart)}"></label>
          <label>Periode akhir<input type="date" id="income-end" value="${escapeHtml(incomeEnd)}"></label>
          <button class="button button-primary" data-action="apply-income-period"><i class="fa-solid fa-filter"></i> Tampilkan</button>
        </div>
      </section>
      <div class="notice"><i class="fa-solid fa-circle-info"></i><span>Laporan dihitung dari jurnal aktual berdasarkan tanggal jurnal. Pembayaran piutang bukan pendapatan; reversal diperhitungkan pada tanggal reversal. Perbandingan menggunakan periode sebelumnya dengan durasi yang sama${comparative ? '.' : '; data pembanding belum tersedia.'}</span></div>
      ${incompleteAccounts.length ? `<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Laporan belum lengkap: akun berikut belum terpetakan dan berpotensi memengaruhi laba rugi: ${incompleteAccounts.map(account => `${escapeHtml(account.code)} — ${escapeHtml(account.name)}`).join(', ')}.</span></div>` : ''}
      ${nameMismatches.length ? `<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Laporan perlu ditinjau: kode akun memiliki nama yang tidak konsisten dengan pemetaan: ${nameMismatches.map(account => `${escapeHtml(account.code)} (nama baku: ${escapeHtml(account.expectedName)})`).join(', ')}.</span></div>` : ''}
      <section class="panel financial-statement">
        <header class="statement-heading"><p class="eyebrow">PT ARTA NIAGA ELEKTRONIK</p><h2>LAPORAN LABA RUGI</h2><p>Untuk periode yang berakhir pada ${dateLabel(incomeEnd)}</p><small>(Dalam Rupiah)</small></header>
        ${statementColumns(currentLabel, comparativeLabel)}
        <div class="report-section"><h3>PENDAPATAN</h3>${groupedRows(account => account.classification === 'revenue')}${totalsLine('Total Pendapatan Penjualan', current.sales, comparative?.sales)}</div>
        <div class="report-section"><h3>HARGA POKOK PENJUALAN</h3>${groupedRows(account => account.code === '5100')}${totalsLine('Total Harga Pokok Penjualan', current.cost, comparative?.cost, { type: 'subtotal', expense: true })}${totalsLine('LABA KOTOR', current.grossProfit, comparative?.grossProfit, { type: 'total' })}</div>
        ${current.otherIncome || comparative?.otherIncome ? `<div class="report-section"><h3>PENDAPATAN LAIN</h3>${groupedRows(account => account.classification === 'other_revenue')}${totalsLine('Total Pendapatan Lain', current.otherIncome, comparative?.otherIncome)}</div>` : ''}
        ${(current.creditLoss || comparative?.creditLoss || current.accounts.some(account => account.code === '5110') || comparative?.accounts.some(account => account.code === '5110')) ? `<div class="report-section"><h3>BEBAN KERUGIAN KREDIT / ECL</h3>${groupedRows(account => account.code === '5110')}${totalsLine('Total Beban Kerugian Kredit / ECL', current.creditLoss, comparative?.creditLoss, { type: 'subtotal', expense: true })}</div>` : ''}
        ${current.otherExpense || comparative?.otherExpense ? `<div class="report-section"><h3>BEBAN LAIN</h3>${groupedRows(account => account.classification === 'other_expense')}${totalsLine('Total Beban Lain', current.otherExpense, comparative?.otherExpense, { type: 'subtotal', expense: true })}</div>` : ''}
        ${current.accounts.some(account => account.classification === 'tax_expense') || comparative?.accounts.some(account => account.classification === 'tax_expense') ? `<div class="report-section"><h3>BEBAN PAJAK PENGHASILAN</h3>${groupedRows(account => account.classification === 'tax_expense')}${totalsLine('Total Beban Pajak Penghasilan', current.tax, comparative?.tax, { type: 'subtotal', expense: true })}</div>` : ''}
        ${totalsLine('TOTAL BEBAN USAHA', current.operating + current.creditLoss + current.otherExpense, comparative ? comparative.operating + comparative.creditLoss + comparative.otherExpense : null, { type: 'subtotal', expense: true })}
        ${(current.accounts.some(account => account.classification === 'tax_expense') || comparative?.accounts.some(account => account.classification === 'tax_expense')) ? totalsLine(current.beforeTax < 0 ? 'RUGI SEBELUM PAJAK' : 'LABA SEBELUM PAJAK', current.beforeTax, comparative?.beforeTax, { type: 'subtotal' }) : ''}
        ${totalsLine(current.netIncome < 0 ? 'RUGI BERSIH' : 'LABA BERSIH', current.netIncome, comparative?.netIncome, { type: 'grand-total' })}
      </section>`;
  }

  function accountClassification(code) {
    return accountMap[String(code)]?.classification || 'unclassified';
  }

  async function renderPosition() {
    const lines = await records('journal_lines', `select=*&status=eq.POSTED&entry_date=lte.${reportDate}&order=account_code.asc`);
    const comparativeDate = priorYearDate(reportDate);
    const comparativeLines = lines.filter(line => line.entry_date <= comparativeDate);
    const reversedGroups = new Set(lines.filter(line => line.reversal_of_group_id).map(line => line.reversal_of_group_id));
    const openingExists = lines.some(line => line.entry_type === 'OPENING' && !reversedGroups.has(line.entry_group_id));
    const aggregate = sourceLines => {
      const byCode = new Map();
      sourceLines.forEach(line => {
        const code = String(line.account_code);
        const definition = accountMap[code];
        if (!byCode.has(code)) byCode.set(code, {
          code,
          name: line.account_name,
          names: new Set(),
          expectedName: definition?.name || null,
          classification: definition?.classification || 'unclassified',
          debit: 0,
          credit: 0
        });
        const account = byCode.get(code);
        account.names.add(line.account_name);
        account.debit += Number(line.debit);
        account.credit += Number(line.credit);
      });
      for (const account of byCode.values()) {
        account.balance = ['asset', 'expense', 'unclassified'].includes(account.classification)
          ? account.debit - account.credit
          : account.credit - account.debit;
        account.displayBalance = account.balance;
      }
      return [...byCode.values()];
    };
    const accounts = aggregate(lines);
    const priorAccounts = aggregate(comparativeLines);
    const accountBalance = (list, code) => list.find(account => account.code === code)?.balance ?? null;
    const accountTotal = (list, classification) => list
      .filter(account => account.classification === classification)
      .reduce((total, account) => total + account.balance, 0);
    const fiscalYearStart = `${reportDate.slice(0, 4)}-01-01`;
    const currentEarnings = lines
      .filter(line => line.entry_date >= fiscalYearStart && line.entry_type !== 'OPENING')
      .reduce((total, line) => {
        const classification = accountClassification(line.account_code);
        if (classification === 'revenue') return total + Number(line.credit) - Number(line.debit);
        if (classification === 'expense') return total - Number(line.debit) + Number(line.credit);
        return total;
      }, 0);
    const priorFiscalYearStart = `${comparativeDate.slice(0, 4)}-01-01`;
    const priorCurrentEarnings = comparativeLines
      .filter(line => line.entry_date >= priorFiscalYearStart && line.entry_type !== 'OPENING')
      .reduce((total, line) => {
        const classification = accountClassification(line.account_code);
        if (classification === 'revenue') return total + Number(line.credit) - Number(line.debit);
        if (classification === 'expense') return total - Number(line.debit) + Number(line.credit);
        return total;
      }, 0);
    const grossReceivable = accountBalance(accounts, '1120') || 0;
    const priorGrossReceivable = accountBalance(priorAccounts, '1120') || 0;
    const allowance = accountBalance(accounts, '1121') || 0;
    const priorAllowance = accountBalance(priorAccounts, '1121') || 0;
    const grossAssets = accountTotal(accounts, 'asset');
    const priorGrossAssets = accountTotal(priorAccounts, 'asset');
    const assets = grossAssets - allowance;
    const priorAssets = priorGrossAssets - priorAllowance;
    const liabilities = accountTotal(accounts, 'liability');
    const priorLiabilities = accountTotal(priorAccounts, 'liability');
    const equityCapital = accountTotal(accounts, 'equity');
    const priorEquityCapital = accountTotal(priorAccounts, 'equity');
    const equity = equityCapital + currentEarnings;
    const priorEquity = priorEquityCapital + priorCurrentEarnings;
    const difference = assets - liabilities - equity;
    const unclassified = accounts.filter(account => account.classification === 'unclassified' && Math.abs(account.balance) > 0.005);
    const nameMismatches = accounts.filter(account => account.expectedName
      && (account.name !== account.expectedName || account.names.size > 1));
    const historicalProfitLoss = lines.filter(line => line.entry_date < fiscalYearStart && line.entry_type !== 'OPENING')
      .reduce((total, line) => {
        const classification = accountClassification(line.account_code);
        if (classification === 'revenue') return total + Number(line.credit) - Number(line.debit);
        if (classification === 'expense') return total - Number(line.debit) + Number(line.credit);
        return total;
      }, 0);
    const accountsByCode = new Map([...accounts, ...priorAccounts].map(account => [account.code, account]));
    const statementAccounts = predicate => [...accountsByCode.values()].filter(predicate).map(account => {
      const currentBalance = accountBalance(accounts, account.code);
      const priorBalance = comparativeLines.length ? accountBalance(priorAccounts, account.code) || 0 : null;
      const isContra = account.classification === 'contra_asset';
      return statementLine(
        `${account.expectedName || account.name}`,
        currentBalance || 0,
        priorBalance,
        { currentExpense: isContra }
      );
    }).join('');
    const statementTotal = (label, currentValue, priorValue, options = {}) =>
      statementLine(label, currentValue, comparativeLines.length ? priorValue : null, {
        type: options.type || 'total',
        currentExpense: options.expense
      });
    const comparativeLabel = comparativeLines.length ? dateLabel(comparativeDate) : 'Tidak tersedia';
    const currentLabel = dateLabel(reportDate);
    const unclassifiedList = unclassified.length
      ? `<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Laporan belum lengkap. Saldo akun tidak terpetakan tidak dimasukkan ke total: ${unclassified.map(account => `${escapeHtml(account.code)} — ${escapeHtml(account.name)}`).join(', ')}.</span></div>`
      : '';
    $('#page-content').innerHTML = `${pageHeader(...pageTitles.position, `<label class="date-field">Tanggal laporan<input type="date" id="position-date" value="${escapeHtml(reportDate)}"></label>`)}
      ${openingExists ? '' : '<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Jurnal pembukaan belum ditemukan. Laporan ini hanya mencerminkan jurnal yang tercatat dan mungkin belum lengkap; input saldo pembukaan bila diperlukan.</span></div>'}
      ${unclassifiedList}
      ${nameMismatches.length ? `<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Nama akun tidak sesuai pemetaan resmi: ${nameMismatches.map(account => `${escapeHtml(account.code)} seharusnya ${escapeHtml(account.expectedName)}`).join(', ')}.</span></div>` : ''}
      ${historicalProfitLoss ? '<div class="notice warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Terdapat hasil usaha sebelum tahun berjalan yang belum nol. Karena sistem belum memiliki proses penutupan buku, hasil tersebut tidak ditambahkan kembali ke laba tahun berjalan; pastikan saldo laba pembukaan mencakup hasil periode terdahulu.</span></div>' : ''}
      <section class="panel financial-statement">
        <header class="statement-heading"><p class="eyebrow">PT ARTA NIAGA ELEKTRONIK</p><h2>LAPORAN POSISI KEUANGAN</h2><p>Per ${dateLabel(reportDate)}</p><small>(Dalam Rupiah)</small></header>
        ${statementColumns(currentLabel, comparativeLabel)}
        <div class="report-section"><h3>ASET</h3>
          <h4 class="report-subheading">Aset Lancar</h4>
          ${statementAccounts(account => ['1110', '1120', '1130'].includes(account.code))}
          ${accountBalance(accounts, '1121') !== null || accountBalance(priorAccounts, '1121') !== null ? statementLine('Dikurangi: Cadangan Kerugian Kredit', allowance, comparativeLines.length ? priorAllowance : null, { currentExpense: true }) : ''}
          ${statementTotal('Total Aset Lancar', assets, priorAssets, { type: 'subtotal' })}
          ${accounts.some(account => account.classification === 'asset' && !['1110', '1120', '1130'].includes(account.code))
            ? `<h4 class="report-subheading">Aset Lainnya</h4>${statementAccounts(account => account.classification === 'asset' && !['1110', '1120', '1130'].includes(account.code))}`
            : ''}
          ${statementTotal('TOTAL ASET', assets, priorAssets, { type: 'grand-total' })}
        </div>
        <div class="report-section"><h3>LIABILITAS</h3><h4 class="report-subheading">Liabilitas Jangka Pendek</h4>
          ${statementAccounts(account => account.classification === 'liability')}
          ${statementTotal('Total Liabilitas Jangka Pendek', liabilities, priorLiabilities, { type: 'subtotal' })}
          ${statementTotal('TOTAL LIABILITAS', liabilities, priorLiabilities, { type: 'grand-total' })}
        </div>
        <div class="report-section"><h3>EKUITAS</h3>
          ${statementAccounts(account => account.classification === 'equity')}
          ${statementLine('Laba Tahun Berjalan', currentEarnings, comparativeLines.length ? priorCurrentEarnings : null)}
          ${statementTotal('TOTAL EKUITAS', equity, priorEquity, { type: 'grand-total' })}
        </div>
        ${statementTotal('TOTAL LIABILITAS DAN EKUITAS', liabilities + equity, priorLiabilities + priorEquity, { type: 'grand-total' })}
      </section>
      <div class="report-analysis">
      <section class="panel"><div class="panel-heading"><div><h2>Persamaan akuntansi</h2><p>Selisih dihitung dari buku besar, tidak dibuat sebagai angka penyeimbang</p></div></div><div class="equation"><div class="equation-item"><small>Aset</small><strong>${money(assets)}</strong></div><span class="equation-sign">=</span><div class="equation-item"><small>Liabilitas + ekuitas</small><strong>${money(liabilities + equity)}</strong></div></div><div class="form-message ${Math.abs(difference) < 0.01 ? 'success' : ''}">${Math.abs(difference) < 0.01 ? 'Persamaan seimbang berdasarkan jurnal yang tersedia.' : `Selisih belum terjelaskan: ${money(difference)}. Periksa saldo pembukaan dan jurnal.`}</div></section>
      </div>`;
  }


  function openEditor(kind, item = null) {
    editorContext = { kind, item };
    const dialog = $('#editor-dialog');
    const labels = {
      customer: ['PELANGGAN', item ? 'Edit pelanggan' : 'Tambah pelanggan'],
      invoice: ['INVOICE', item ? 'Edit draft invoice' : 'Buat draft invoice'],
      payment: ['PEMBAYARAN', 'Catat pembayaran']
    };
    const [eyebrow, title] = labels[kind];
    $('#editor-eyebrow').textContent = eyebrow;
    $('#editor-title').textContent = title;
    $('#editor-submit').disabled = false;
    $('#editor-submit').textContent = 'Simpan';
    $('#editor-message').textContent = '';
    $('#editor-fields').innerHTML = editorFields(kind, item);
    dialog.showModal();
  }

  function editorFields(kind, item) {
    if (kind === 'customer') return `
      ${field('Kode pelanggan', 'customer_code', item?.customer_code || '', 'text', 'Kosongkan untuk dibuat otomatis')}
      ${field('Nama pelanggan', 'name', item?.name || '', 'text', 'Nama badan/orang', true)}
      ${field('Email', 'email', item?.email || '', 'email', 'finance@pelanggan.co.id')}
      ${field('Telepon', 'phone', item?.phone || '', 'tel', 'Nomor kontak')}
      ${field('Batas kredit (Rp)', 'credit_limit', item?.credit_limit ?? '', 'number', 'Wajib diisi, harus lebih dari Rp0', true, 'min="0.01" step="0.01"')}
      <small class="muted span-2">Batas kredit ditentukan perusahaan; sistem tidak memberikan limit otomatis. Sisa limit = batas kredit dikurangi outstanding.</small>
      <label>Status<select name="status"><option value="ACTIVE"${item?.status !== 'INACTIVE' ? ' selected' : ''}>Aktif</option><option value="INACTIVE"${item?.status === 'INACTIVE' ? ' selected' : ''}>Nonaktif</option></select></label>
      <label class="span-2">Alamat<textarea name="address" placeholder="Alamat pelanggan">${escapeHtml(item?.address || '')}</textarea></label>`;
    if (kind === 'invoice') {
      const customerOptions = cache.customers.filter(customer => customer.status === 'ACTIVE').map(customer => {
        const outstanding = cache.aging.filter(row => row.customer_id === customer.id)
          .reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
        const remaining = Number(customer.credit_limit) - outstanding;
        return `<option value="${customer.id}"${item?.customer_id === customer.id ? ' selected' : ''}>${escapeHtml(customer.customer_code)} — ${escapeHtml(customer.name)} | outstanding ${money(outstanding)} | sisa limit ${money(remaining)}</option>`;
      }).join('');
      return `<label class="span-2">Pelanggan<select name="customer_id" required><option value="">Pilih pelanggan aktif</option>${customerOptions}</select></label>
        ${field('Nomor invoice', 'invoice_number', item?.invoice_number || '', 'text', 'INV-2025-001', true)}
        ${field('Tanggal invoice', 'invoice_date', item?.invoice_date || today(), 'date', '', true)}
        ${field('Tanggal penyerahan', 'delivery_date', item?.delivery_date || '', 'date')}
        ${field('Jatuh tempo', 'due_date', item?.due_date || today(), 'date', '', true)}
        ${field('Nilai bruto (Rp)', 'amount', item?.amount ?? '', 'number', '0', true, 'min="0.01" step="0.01"')}
        ${field('Diskon (Rp)', 'discount_amount', item?.discount_amount ?? 0, 'number', '0', false, 'min="0" step="0.01"')}
        ${field('Harga pokok penjualan (Rp)', 'cost_amount', item?.cost_amount ?? 0, 'number', '0', false, 'min="0" step="0.01"')}
        <label class="span-2">Deskripsi<textarea name="description" placeholder="Uraian barang atau jasa">${escapeHtml(item?.description || '')}</textarea></label>
        <small class="span-2 muted">Posting hanya tersedia setelah barang diserahkan/jasa dipenuhi (tanggal penyerahan tidak boleh di masa depan). Nilai invoice adalah bruto sebelum diskon.</small>`;
    }
    const balances = outstandingByInvoice();
    const openInvoices = cache.invoices.filter(invoice => ['UNPAID', 'PARTIALLY_PAID'].includes(invoice.status)
      && Number(balances.get(invoice.id) || 0) > 0);
    const options = openInvoices.map(invoice => {
      const customer = cache.customers.find(row => row.id === invoice.customer_id);
      return `<option value="${invoice.id}"${item?.invoice_id === invoice.id ? ' selected' : ''}>${escapeHtml(invoice.invoice_number)} — ${escapeHtml(customer?.name || '')} — sisa ${money(balances.get(invoice.id))}</option>`;
    }).join('');
    return `<label class="span-2">Invoice<select name="invoice_id" required><option value="">Pilih invoice outstanding</option>${options}</select></label>
      ${field('Nomor pembayaran', 'payment_number', item?.payment_number || '', 'text', 'Otomatis jika kosong')}
      ${field('Tanggal pembayaran', 'payment_date', item?.payment_date || today(), 'date', '', true)}
      ${field('Jumlah (Rp)', 'amount', item?.amount ?? '', 'number', '0', true, 'min="0.01" step="0.01"')}
      <label>Metode<select name="payment_method">${[['TRANSFER', 'Transfer'], ['CASH', 'Tunai'], ['CARD', 'Kartu'], ['OTHER', 'Lainnya']].map(([value, label]) => `<option value="${value}"${(item?.payment_method || 'TRANSFER') === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      ${field('Nomor referensi', 'reference_number', item?.reference_number || '', 'text', 'Nomor bukti transfer')}
      <label class="span-2">Deskripsi<textarea name="description" placeholder="Catatan pembayaran">${escapeHtml(item?.description || '')}</textarea></label>`;
  }

  function field(label, name, value, type = 'text', placeholder = '', required = false, extra = '') {
    return `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${required ? ' required' : ''} ${extra}></label>`;
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!editorContext) return;
    const { kind, item } = editorContext;
    const formData = new FormData(event.currentTarget);
    const data = Object.fromEntries(formData.entries());
    const button = $('#editor-submit');
    setBusy(button, true, 'Menyimpan');
    $('#editor-message').textContent = '';
    try {
      let table;
      if (kind === 'customer') {
        table = 'customers';
        data.credit_limit = Number(data.credit_limit);
        if (!data.customer_code) delete data.customer_code;
      } else if (kind === 'invoice') {
        table = 'invoices';
        ['amount', 'discount_amount', 'cost_amount'].forEach(key => { data[key] = Number(data[key] || 0); });
        data.delivery_date = data.delivery_date || null;
        if (data.invoice_date > today()
          || data.due_date < data.invoice_date
          || (data.delivery_date && (data.delivery_date < data.invoice_date
            || data.delivery_date > today() || data.due_date < data.delivery_date))) {
          throw new Error('Tanggal invoice tidak boleh di masa depan; jatuh tempo harus pada/setelah tanggal invoice dan tanggal penyerahan.');
        }
      } else {
        table = 'payments';
        data.amount = Number(data.amount);
        if (!data.payment_number) delete data.payment_number;
      }
      let path = `/records/${table}`;
      let method = 'POST';
      if (item) {
        path += `?id=eq.${encodeURIComponent(item.id)}`;
        method = 'PATCH';
      }
      const result = await api(path, { method, body: data, headers: { prefer: 'return=representation' } });
      $('#editor-dialog').close();
      showNotice(item ? 'Perubahan berhasil disimpan.' : 'Data berhasil dibuat.', 'info');
      await renderPage();
      return result;
    } catch (error) {
      $('#editor-message').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  }

  async function detail(kind, id) {
    try {
      let title = '';
      let content = '';
      if (kind === 'customer') {
        const [customer] = await records('customers', `select=*&id=eq.${encodeURIComponent(id)}`);
        const [aging, invoices] = await Promise.all([
          getAging(),
          records('invoices', `select=*&customer_id=eq.${encodeURIComponent(id)}&order=invoice_date.desc`)
        ]);
        if (!customer) throw new Error('Pelanggan tidak ditemukan.');
        title = customer.name;
        const balance = aging.filter(row => row.customer_id === id).reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
        content = detailGrid([
          ['Kode pelanggan', customer.customer_code], ['Status', safeMarkup(statusBadge(customer.status))],
          ['Email', customer.email || '—'], ['Telepon', customer.phone || '—'],
          ['Batas kredit', money(customer.credit_limit)], ['Outstanding', money(balance)],
          ['Sisa limit', money(Number(customer.credit_limit) - balance)],
          ['Alamat', customer.address || '—']
        ]) + detailTable('Invoice pelanggan', ['Nomor', 'Tanggal', 'Nilai bersih', 'Status'], invoices.map(invoice => `<tr><td>${escapeHtml(invoice.invoice_number)}</td><td>${dateLabel(invoice.invoice_date)}</td><td class="numeric">${money(Number(invoice.amount) - Number(invoice.discount_amount || 0))}</td><td>${statusBadge(invoice.status)}</td></tr>`));
      } else if (kind === 'invoice') {
        const [invoice] = await records('invoices', `select=*&id=eq.${encodeURIComponent(id)}`);
        if (!invoice) throw new Error('Invoice tidak ditemukan.');
        const customer = cache.customers.find(row => row.id === invoice.customer_id) || (await records('customers', `select=id,name,customer_code&id=eq.${encodeURIComponent(invoice.customer_id)}`))[0];
        const [payments, aging] = await Promise.all([
          records('payments', `select=*&invoice_id=eq.${encodeURIComponent(id)}&order=payment_date.asc`),
          getAging()
        ]);
        title = invoice.invoice_number;
        const balance = aging.find(row => row.invoice_id === id)?.outstanding_amount || 0;
        content = detailGrid([
          ['Pelanggan', customer?.name || '—'], ['Status', safeMarkup(statusBadge(invoice.status))],
          ['Tanggal invoice', dateLabel(invoice.invoice_date)], ['Tanggal penyerahan', dateLabel(invoice.delivery_date)],
          ['Jatuh tempo', dateLabel(invoice.due_date)], ['Nilai bruto', money(invoice.amount)],
          ['Diskon', money(invoice.discount_amount)], ['Nilai bersih', money(Number(invoice.amount) - Number(invoice.discount_amount || 0))],
          ['Harga pokok', money(invoice.cost_amount)], ['Outstanding', money(balance)],
          ['Deskripsi', invoice.description || '—']
        ]) + detailTable('Pembayaran terkait', ['Tanggal', 'Nomor', 'Jumlah', 'Status'], payments.map(payment => `<tr><td>${dateLabel(payment.payment_date)}</td><td>${escapeHtml(payment.payment_number)}</td><td class="numeric">${money(payment.amount)}</td><td>${statusBadge(payment.status)}</td></tr>`));
      } else if (kind === 'payment') {
        const [payment] = await records('payments', `select=*&id=eq.${encodeURIComponent(id)}`);
        if (!payment) throw new Error('Pembayaran tidak ditemukan.');
        const [invoice] = await records('invoices', `select=*&id=eq.${encodeURIComponent(payment.invoice_id)}`);
        const customer = invoice ? cache.customers.find(row => row.id === invoice.customer_id) : null;
        title = payment.payment_number;
        content = detailGrid([
          ['Status', safeMarkup(statusBadge(payment.status))], ['Tanggal', dateLabel(payment.payment_date)],
          ['Invoice', invoice?.invoice_number || '—'], ['Pelanggan', customer?.name || '—'],
          ['Metode', payment.payment_method], ['Jumlah', money(payment.amount)],
          ['Referensi', payment.reference_number || '—'], ['Deskripsi', payment.description || '—']
        ]);
      } else if (kind === 'journal') {
        const group = cache.journals.find(row => row.id === id);
        if (!group) throw new Error('Jurnal tidak ditemukan.');
        title = `Jurnal ${journalNumber(group)}`;
        content = detailGrid([['No. Jurnal', journalNumber(group)], ['Tanggal', dateLabel(group.entry_date)], ['Tipe', typeLabel(group.entry_type)], ['Status', group.reversed_by_number ? `Dibalik oleh ${group.reversed_by_number}` : (group.reversal_of_number ? `Membalik ${group.reversal_of_number}` : 'Posted')], ['Deskripsi', group.description || '—']])
          + detailTable('Baris debit dan kredit', ['Kode akun', 'Nama akun', 'Debit', 'Kredit'], group.lines.map(line => `<tr><td>${escapeHtml(line.account_code)}</td><td>${escapeHtml(line.account_name)}</td><td class="numeric">${money(line.debit)}</td><td class="numeric">${money(line.credit)}</td></tr>`))
          + `<div class="report-summary"><div class="equation"><div class="equation-item"><small>Total debit</small><strong>${money(group.debit)}</strong></div><span class="equation-sign">=</span><div class="equation-item"><small>Total kredit</small><strong>${money(group.credit)}</strong></div></div></div>`;
      }
      $('#detail-title').textContent = title;
      $('#detail-content').innerHTML = content;
      $('#detail-dialog').showModal();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  function detailGrid(items) {
    return `<div class="detail-grid">${items.map(([label, value]) => `<div class="detail-item"><small>${escapeHtml(label)}</small><strong>${value && typeof value === 'object' && typeof value.markup === 'string' ? value.markup : escapeHtml(value)}</strong></div>`).join('')}</div>`;
  }

  function detailTable(title, headers, rows) {
    return `<div class="detail-section"><h3>${escapeHtml(title)}</h3><div class="table-scroll"><table><thead><tr>${headers.map((header, index) => `<th${index > 1 ? ' class="numeric"' : ''}>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td class="empty-row" colspan="${headers.length}">Tidak ada transaksi terkait.</td></tr>`}</tbody></table></div></div>`;
  }

  async function deleteDraft(table, id, label) {
    if (!confirm(`Hapus ${label} ini? Penghapusan hanya diizinkan jika tidak ada transaksi terkait.`)) return;
    try {
      await api(`/records/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      showNotice(`${label} draft berhasil dihapus.`);
      await renderPage();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  async function postInvoice(id) {
    const invoice = cache.invoices.find(row => row.id === id);
    if (!invoice) return showNotice('Invoice tidak ditemukan.', 'error');
    const customer = cache.customers.find(row => row.id === invoice.customer_id);
    if (!customer || customer.status !== 'ACTIVE') return showNotice('Pelanggan tidak tersedia atau berstatus nonaktif.', 'error');
    if (!invoice.delivery_date || invoice.delivery_date < invoice.invoice_date
      || invoice.delivery_date > today() || invoice.due_date < invoice.delivery_date) {
      return showNotice('Isi tanggal penyerahan yang valid. Penyerahan harus pada/setelah tanggal invoice dan jatuh tempo tidak boleh mendahuluinya.', 'error');
    }
    if (Number(invoice.amount) <= 0 || Number(invoice.discount_amount || 0) < 0
      || Number(invoice.discount_amount || 0) >= Number(invoice.amount) || Number(invoice.cost_amount || 0) < 0) {
      return showNotice('Nilai bruto, diskon, atau harga pokok invoice tidak valid.', 'error');
    }
    const outstanding = cache.aging.filter(row => row.customer_id === customer.id)
      .reduce((sum, row) => sum + Number(row.outstanding_amount), 0);
    const netAmount = Number(invoice.amount) - Number(invoice.discount_amount || 0);
    if (outstanding + netAmount > Number(customer.credit_limit)) {
      return showNotice(`Batas kredit tidak mencukupi. Limit ${money(customer.credit_limit)}, outstanding ${money(outstanding)}, nilai invoice bersih ${money(netAmount)}.`, 'error');
    }
    if (!confirm(`Posting ${invoice.invoice_number}? Pendapatan hanya diakui jika barang/jasa telah diserahkan dan batas kredit tersedia.`)) return;
    try {
      await postRpc('/posting/invoice', { p_invoice_id: id });
      showNotice('Invoice dan jurnal penjualan berhasil diposting.');
      await renderPage();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  async function postPayment(id) {
    const payment = cache.payments.find(row => row.id === id);
    if (!payment || !confirm(`Posting pembayaran ${payment.payment_number}?`)) return;
    try {
      await postRpc('/posting/payment', { p_payment_id: id });
      showNotice('Pembayaran berhasil diposting ke jurnal.');
      await renderPage();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  function readRates() {
    const rates = {};
    $$('.rate-input').forEach(input => {
      const percent = Number(input.value);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Tarif ECL harus antara 0% dan 100%.');
      rates[input.dataset.rate] = percent / 100;
    });
    return rates;
  }

  async function recalculateEcl() {
    try {
      const reportDateValue = $('#ecl-date')?.value || today();
      await renderAllowance(reportDateValue, readRates());
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  async function postEcl() {
    try {
      const date = $('#ecl-date')?.value || today();
      const rates = readRates();
      const fresh = await getEcl(date, rates);
      const delta = Number(fresh.adjustment || 0);
      if (delta === 0) return showNotice('Saldo cadangan sudah sesuai estimasi; tidak ada jurnal tambahan yang diperlukan.');
      const msg = delta > 0
        ? `Posting beban penyesuaian ${money(delta)} berdasarkan estimasi database?`
        : `Posting pembalikan cadangan berlebih ${money(Math.abs(delta))}?`;
      if (!confirm(msg)) return;
      await postRpc('/ecl/post', { p_as_of_date: date, p_rates: rates });
      showNotice('Penyesuaian cadangan berhasil diposting berdasarkan perhitungan database.');
      await renderPage();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  async function reverseJournal(id) {
    const group = cache.journals.find(row => row.id === id);
    if (!group || !confirm(`Balik jurnal ${journalNumber(group)} (${group.description || typeLabel(group.entry_type)})?\n\nPERHATIAN: reversal TIDAK dapat dibatalkan. Jika salah, Anda harus mencatat jurnal baru. Jurnal asli tetap tersimpan.`)) return;
    try {
      await postRpc('/journals/reverse', { p_entry_group_id: id });
      showNotice('Jurnal reversal berhasil dibuat.');
      await renderPage();
    } catch (error) {
      showNotice(error.message, 'error');
    }
  }

  function openOpeningJournal() {
    $('#editor-eyebrow').textContent = 'JURNAL PEMBUKAAN';
    $('#editor-title').textContent = 'Catat saldo pembukaan';
    $('#editor-submit').disabled = false;
    $('#editor-submit').textContent = 'Posting jurnal';
    $('#editor-message').textContent = '';
    openingLineCount = 0;
    $('#editor-fields').innerHTML = `<label>Tanggal<input name="entry_date" type="date" value="${today()}" required></label><label>Deskripsi<input name="description" required value="Saldo pembukaan"></label><div class="opening-lines span-2"><div id="opening-line-list"></div><button class="button button-secondary" type="button" data-action="add-opening-line"><i class="fa-solid fa-plus"></i> Tambah baris akun</button><div class="opening-totals" id="opening-totals"></div><small class="muted">Pilih akun terdaftar. Masukkan saldo aktual; jurnal hanya dapat diposting jika debit dan kredit seimbang.</small></div>`;
    addOpeningLine();
    addOpeningLine();
    editorContext = { kind: 'opening' };
    $('#editor-dialog').showModal();
  }

  function addOpeningLine() {
    const index = openingLineCount++;
    const accountOptions = Object.entries(accountMap)
      .filter(([, account]) => ['asset', 'contra_asset', 'liability', 'equity'].includes(account.classification))
      .map(([code, account]) =>
      `<option value="${code}">${escapeHtml(code)} — ${escapeHtml(account.name)}</option>`
    ).join('');
    $('#opening-line-list').insertAdjacentHTML('beforeend', `<div class="opening-line" data-opening-row>
      <label>Akun<select name="account_code" required><option value="">Pilih akun terdaftar</option>${accountOptions}</select></label>
      <label>Debit<input name="debit" type="number" min="0" step="0.01" value="0" data-opening-debit></label>
      <label>Kredit<input name="credit" type="number" min="0" step="0.01" value="0" data-opening-credit></label>
      <button class="row-action danger" type="button" data-action="remove-opening-line" title="Hapus baris" aria-label="Hapus baris"><i class="fa-regular fa-trash-can"></i></button>
      <input type="hidden" name="opening_line_id" value="${index}">
    </div>`);
    updateOpeningTotals();
  }

  function updateOpeningTotals() {
    if (!$('#opening-totals')) return;
    const debit = $$('[data-opening-debit]').reduce((total, input) => total + (Number(input.value) || 0), 0);
    const credit = $$('[data-opening-credit]').reduce((total, input) => total + (Number(input.value) || 0), 0);
    const difference = debit - credit;
    const balanced = Math.abs(difference) < 0.01 && debit > 0;
    $('#opening-totals').innerHTML = `<span>Total debit: <strong>${money(debit)}</strong></span><span>Total kredit: <strong>${money(credit)}</strong></span><span class="${balanced ? '' : 'unbalanced'}">Selisih: <strong>${money(Math.abs(difference))}${balanced ? ' — Seimbang' : ''}</strong></span>`;
    $('#editor-submit').disabled = !balanced;
  }

  async function saveOpeningJournal(formData) {
    const lines = $$('[data-opening-row]').map(row => {
      const account_code = $('select[name="account_code"]', row).value;
      const definition = accountMap[account_code];
      return {
        account_code,
        account_name: definition?.name || '',
        debit: Number($('input[name="debit"]', row).value || 0),
        credit: Number($('input[name="credit"]', row).value || 0)
      };
    });
    if (lines.length < 2 || lines.some(line => !line.account_code || !line.account_name
      || !Number.isFinite(line.debit) || !Number.isFinite(line.credit)
      || line.debit < 0 || line.credit < 0
      || (line.debit > 0) === (line.credit > 0))) {
      throw new Error('Setiap baris harus memilih akun dan berisi hanya satu nilai debit atau kredit positif.');
    }
    const totalDebit = lines.reduce((total, line) => total + line.debit, 0);
    const totalCredit = lines.reduce((total, line) => total + line.credit, 0);
    if (totalDebit <= 0 || Math.abs(totalDebit - totalCredit) >= 0.01) {
      throw new Error('Jurnal pembukaan belum seimbang. Periksa total debit dan kredit.');
    }
    return postRpc('/journals/opening', {
      p_entry_date: formData.get('entry_date'),
      p_description: formData.get('description'),
      p_lines: lines
    });
  }

  async function submitEditor(event) {
    if (editorContext?.kind !== 'opening') return saveEditor(event);
    event.preventDefault();
    const button = $('#editor-submit');
    const values = new FormData(event.currentTarget);
    setBusy(button, true, 'Memposting');
    try {
      await saveOpeningJournal(values);
      $('#editor-dialog').close();
      showNotice('Jurnal pembukaan berhasil disimpan.');
      await renderPage();
    } catch (error) {
      $('#editor-message').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  }

  function toggleMobileNav(open) {
    $('#sidebar').classList.toggle('open', open);
    $('#sidebar-backdrop').classList.toggle('visible', open);
    $('#mobile-menu').setAttribute('aria-expanded', String(open));
  }

  function closeMobileNav() {
    toggleMobileNav(false);
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    switch (action) {
      case 'refresh': await renderPage(); break;
      case 'new-customer': openEditor('customer'); break;
      case 'new-invoice':
        [cache.customers, cache.aging] = await Promise.all([
          records('customers', 'select=id,name,customer_code,credit_limit,status&order=name.asc'),
          getAging()
        ]);
        openEditor('invoice');
        break;
      case 'new-payment':
        [cache.invoices, cache.customers, cache.aging] = await Promise.all([
          records('invoices', 'select=id,invoice_number,customer_id,amount,discount_amount,status'),
          records('customers', 'select=id,name,customer_code,status&order=name.asc'),
          getAging()
        ]);
        openEditor('payment');
        break;
      case 'edit-customer': {
        const [row] = await records('customers', `select=*&id=eq.${encodeURIComponent(id)}`);
        openEditor('customer', row);
        break;
      }
      case 'edit-invoice': {
        const [row] = await records('invoices', `select=*&id=eq.${encodeURIComponent(id)}`);
        openEditor('invoice', row);
        break;
      }
      case 'edit-payment': {
        const [row] = await records('payments', `select=*&id=eq.${encodeURIComponent(id)}`);
        openEditor('payment', row);
        break;
      }
      case 'detail-customer': await detail('customer', id); break;
      case 'detail-invoice': await detail('invoice', id); break;
      case 'detail-payment': await detail('payment', id); break;
      case 'detail-journal': await detail('journal', id); break;
      case 'delete-customer': await deleteDraft('customers', id, 'Pelanggan'); break;
      case 'delete-invoice': await deleteDraft('invoices', id, 'Invoice'); break;
      case 'delete-payment': await deleteDraft('payments', id, 'Pembayaran'); break;
      case 'post-invoice': await postInvoice(id); break;
      case 'post-payment': await postPayment(id); break;
      case 'recalculate-ecl': await recalculateEcl(); break;
      case 'post-ecl': await postEcl(); break;
      case 'reverse-journal': await reverseJournal(id); break;
      case 'opening-journal': openOpeningJournal(); break;
      case 'add-opening-line': addOpeningLine(); break;
      case 'remove-opening-line': {
        const row = button.closest('[data-opening-row]');
        if ($$('[data-opening-row]').length <= 2) {
          $('#editor-message').textContent = 'Jurnal pembukaan minimal harus memiliki dua baris.';
          return;
        }
        row.remove();
        $('#editor-message').textContent = '';
        updateOpeningTotals();
        break;
      }
      case 'apply-income-period':
        incomeStart = $('#income-start').value;
        incomeEnd = $('#income-end').value;
        await renderPage();
        break;
      case 'print-report': window.print(); break;
      default: break;
    }
  }

  document.addEventListener('click', async event => {
    const nav = event.target.closest('.navigation a, .brand');
    if (nav) {
      const destination = nav.dataset.page || nav.getAttribute('href')?.slice(1) || 'dashboard';
      event.preventDefault();
      setPage(destination);
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      try { await handleAction(actionButton); } catch (error) { showNotice(error.message, 'error'); }
      return;
    }
    const pageButton = event.target.closest('[data-page-action]');
    if (pageButton) {
      const state = getPageState(pageButton.dataset.tableKey);
      state.page += Number(pageButton.dataset.pageAction);
      await renderPage();
      return;
    }
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) closeButton.closest('dialog')?.close();
  });

  document.addEventListener('input', event => {
    if (event.target.matches('[data-opening-debit], [data-opening-credit]')) {
      updateOpeningTotals();
      return;
    }
    const input = event.target.closest('[data-table-search]');
    if (!input) return;
    const state = getPageState(input.dataset.tableSearch);
    state.search = input.value;
    state.page = 1;
    clearTimeout(tableSearchTimer);
    tableSearchTimer = setTimeout(async () => {
      const key = input.dataset.tableSearch;
      await renderPage();
      const newInput = $(`[data-table-search="${key}"]`);
      newInput?.focus();
      if (newInput) newInput.setSelectionRange(newInput.value.length, newInput.value.length);
    }, 250);
  });

  document.addEventListener('change', async event => {
    if (event.target.matches('[data-table-filter]')) {
      const state = getPageState(event.target.dataset.tableFilter);
      state.filter = event.target.value;
      state.page = 1;
      await renderPage();
    }
    if (event.target.id === 'aging-date') {
      agingFilter.date = event.target.value || today();
      await renderPage();
    }
    if (event.target.id === 'aging-customer') {
      agingFilter.customer = event.target.value;
      await renderPage();
    }
    if (event.target.id === 'aging-bucket') {
      agingFilter.bucket = event.target.value;
      await renderPage();
    }
    if (event.target.id === 'position-date') {
      reportDate = event.target.value || today();
      await renderPage();
    }
    if (event.target.id === 'income-start') incomeStart = event.target.value;
    if (event.target.id === 'income-end') incomeEnd = event.target.value;
    if (event.target.id === 'journal-start') {
      journalStart = event.target.value;
      await renderPage();
    }
    if (event.target.id === 'journal-end') {
      journalEnd = event.target.value;
      await renderPage();
    }
  });

  $('#auth-form').addEventListener('submit', signIn);
  $('#editor-form').addEventListener('submit', submitEditor);
  $('#sidebar-user').addEventListener('click', signOut);
  $('#mobile-menu').addEventListener('click', () => toggleMobileNav(!$('#sidebar').classList.contains('open')));
  $('#sidebar-backdrop').addEventListener('click', closeMobileNav);
  $('#refresh-button').addEventListener('click', () => renderPage());
  window.addEventListener('hashchange', () => setPage(location.hash.slice(1) || 'dashboard'));
  window.addEventListener('resize', () => { if (page === 'dashboard') drawPaymentChart(latestPaymentTrend); });

  const initialPage = location.hash.slice(1);
  if (pageTitles[initialPage]) page = initialPage;
  initialize();
})();
