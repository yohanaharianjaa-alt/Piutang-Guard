# PiutangGuard

PiutangGuard adalah sistem pengelolaan piutang berbasis web untuk mencatat
pelanggan, invoice, pembayaran, aging piutang, cadangan kerugian kredit
(ECL), jurnal, serta laporan keuangan.

## Identitas Tugas

| Keterangan | Informasi |
|---|---|
| Nama | Yohana Harianja |
| NIM | 12030124140228 |
| Mata Kuliah | Pemrograman dan Pengkodean - D |
| Dosen Pengampu | Aulizza Abdul Fanni, S.Ak., M.Sc., CertDA |

## Link Demo

- Demo web: https://yohanaharianjaa-alt.github.io/Piutang-Guard/
- Aplikasi akan otomatis membuka halaman [frontend/index.html](frontend/index.html)
  melalui file [index.html](index.html) di folder akar.

> Demo membutuhkan akun yang dibuat oleh administrator Supabase. Pengguna
> demo tidak dapat mendaftar sendiri karena autentikasi publik dimatikan
> pada konfigurasi backend.

## Fitur Utama

- Autentikasi pengguna melalui Supabase Auth.
- Dashboard risiko dan ringkasan posisi piutang.
- Manajemen data pelanggan.
- Pembuatan dan posting invoice.
- Pencatatan, posting, dan pembatalan pembayaran.
- Analisis aging piutang berdasarkan tanggal laporan.
- Perhitungan estimasi cadangan kerugian kredit (ECL).
- Pencatatan dan penelusuran jurnal serta reversal.
- Laporan laba rugi dan laporan posisi keuangan.
- Pencarian data pada tabel dan tampilan responsif.

## Teknologi yang Digunakan

- HTML5
- CSS3
- JavaScript
- Supabase Auth
- Supabase PostgreSQL
- Supabase Row Level Security (RLS)
- GitHub Pages
- Font Awesome dan Supabase JavaScript library melalui CDN

## Struktur Folder

```text
Piutang-Guard/
├── index.html          # Halaman masuk GitHub Pages yang menuju frontend
├── README.md           # Dokumentasi proyek
├── .gitignore
├── backend/
│   ├── app.js          # Konfigurasi URL dan publishable key Supabase
│   └── schema.sql      # Tabel, fungsi, trigger, dan kebijakan RLS
└── frontend/
    ├── index.html      # Struktur halaman dan antarmuka aplikasi
    ├── script.js       # Logika aplikasi dan integrasi Supabase
    └── style.css       # Tampilan dan responsivitas aplikasi
```

## Setup Supabase

1. Buat project baru di [Supabase](https://supabase.com/).
2. Buka **SQL Editor**, lalu jalankan seluruh isi
   [backend/schema.sql](backend/schema.sql).
3. Pastikan tabel, function, dan Row Level Security berhasil dibuat.
4. Pada **Authentication → Providers**, gunakan Email provider.
5. Matikan **Allow new users to sign up** atau pembuatan akun publik agar
   hanya akun yang dibuat administrator yang dapat masuk.
6. Buat akun pengguna melalui **Authentication → Users → Add user**.
7. Pada **Authentication → URL Configuration**, tambahkan:

   ```text
   https://yohananharianjaa-alt.github.io
   ```

8. Tambahkan juga domain GitHub Pages pada **Redirect URLs** jika diperlukan.
9. Buka **Project Settings → API** dan salin Project URL serta publishable
   key.
10. Masukkan konfigurasi tersebut pada
    [backend/app.js](backend/app.js):

```javascript
window.PiutangGuardBackend = Object.freeze({
  configured: true,
  config: Object.freeze({
    url: 'SUPABASE_PROJECT_URL',
    key: 'SUPABASE_PUBLISHABLE_KEY'
  })
});
```

Gunakan hanya URL dan publishable key pada frontend. Jangan memasukkan
`service_role key`, secret key, atau credential lain dengan hak administratif
ke file JavaScript browser.

## Menjalankan Secara Lokal

Tidak diperlukan Node.js atau proses build. Karena aplikasi menggunakan
ES JavaScript dan permintaan Supabase, jalankan melalui server HTTP lokal:

```powershell
cd D:\PiutangGuard
python -m http.server 5500
```

Buka:

```text
http://localhost:5500/
```

Masuk menggunakan akun yang sudah dibuat oleh administrator pada Supabase.

## Deploy melalui GitHub Pages

1. Pastikan folder dan file proyek sudah dipush ke branch `main`.
2. Buka repository di GitHub.
3. Masuk ke **Settings → Pages**.
4. Pada **Build and deployment**, pilih **Deploy from a branch**.
5. Pilih branch `main` dan folder `/(root)`.
6. Klik **Save** dan tunggu GitHub Actions menyelesaikan deployment.
7. Buka halaman **Actions** untuk memeriksa hasil build.
8. Setelah status deployment hijau, buka link demo pada bagian atas README.

## Batasan

Sistem ini merupakan prototipe akademik dan bukan aplikasi akuntansi
produksi. Batasannya meliputi:

- Data dan akun pengguna bergantung pada layanan Supabase.
- Pengujian dan penambahan data perlu dilakukan pada akun terautentikasi.
- GitHub Pages hanya menampilkan frontend statis; autentikasi dan database
  dijalankan oleh Supabase.
- Peraturan akuntansi perlu disesuaikan kembali apabila digunakan untuk
  perusahaan atau periode pelaporan yang kompleks.
