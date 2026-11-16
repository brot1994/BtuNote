# BtuNote

Catatan ala Google Keep yang tersinkron lewat OneDrive (folder `BtuNote`).

- **Web / PC:** https://brot1994.github.io/BtuNote/ — di Edge: menu ⋯ → Aplikasi → *Instal BtuNote* supaya jadi program Windows.
- **Android:** unduh `BtuNote.zip` dari [rilis terbaru](../../releases/latest), ekstrak, pasang APK.

Fitur: kartu berwarna, sematkan, label, daftar centang, gambar & lampiran, arsip, sampah (7 hari), pencarian,
impor & ekspor Evernote (`.enex`), sinkron otomatis antar perangkat (±20 detik).

Struktur:
- `web/` — aplikasi (HTML/JS tanpa framework). Dipakai langsung oleh GitHub Pages dan dibungkus ke APK.
- `android/` — pembungkus WebView + login OneDrive pakai kode (device code).
- Setiap push ke `main` membangun ulang web dan APK (GitHub Actions).
