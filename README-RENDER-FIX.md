# Choco Campus: persistent settings and admin access fix

## What changed

- Settings now support `DB_PATH`, so Render can store SQLite data on persistent storage instead of the temporary app filesystem.
- `SELLER_WHATSAPP` and `ADMIN_PASSWORD` can seed a new/blank database. An existing non-empty value remains in place.
- Student checkout no longer redirects public visitors into the seller/admin tab when WhatsApp is not configured. It shows a clear message instead.
- The initial settings load is awaited before checkout checks WhatsApp, reducing a first-load race.
- Admin login now creates an HTTP-only session cookie. Settings changes, password changes, loyalty/customer changes, order deletion, and updates to existing orders require an admin session.
- The public state endpoint no longer returns order/customer records to unauthenticated visitors.
- Only the HTML, CSS, and `resource/` files are served. The project root (including database/source files) is no longer exposed through static serving.
- The background image URL uses an explicit encoded filename.

## Render configuration (SQLite + persistent disk)

Render's default filesystem is ephemeral. A persistent disk is available for paid Render web services. In the Render Dashboard:

1. Open your web service and its **Disks** section; add a disk mounted at `/var/data`.
2. Under **Environment**, add:
   - `DB_PATH` = `/var/data/choco_campus.db`
   - `SELLER_WHATSAPP` = the seller's WhatsApp number including country code, digits only (for example, Cameroon numbers start with `237`)
   - `ADMIN_PASSWORD` = a unique password of at least 10 characters
3. Save and deploy.
4. Open `/api/health` on your site and confirm it returns `{"ok":true,"service":"choco-campus"}`.
5. Open the seller/admin tab and log in. For a newly initialized database the configured `ADMIN_PASSWORD` is the initial password. If an existing database already has a custom password, that saved password remains valid unless the stored password was still the default `admin123`.

**Important:** A brand-new persistent disk starts with a brand-new database. Before switching an existing live site to `/var/data`, back up any current orders/customer data. This archive intentionally does not include `choco_campus.db`, because database files can contain private customer information and password/configuration data. Use your environment variables to seed the essential WhatsApp/admin configuration on first startup.

If your Render plan does not support persistent disks, SQLite on the app filesystem cannot reliably preserve settings through restarts/redeploys. You would need to migrate the data layer to a managed PostgreSQL database (for example, Render Postgres or another PostgreSQL provider) and configure the connection string as a secret. This project has not been migrated to PostgreSQL by this patch.

## Deployment commands

- Build command: `npm ci --build-from-source=sqlite3` (requires `package-lock.json`)
- Start command: `npm start`
- Optional health-check path: `/api/health`

## API / feature ideas

- **WhatsApp Cloud API**: automate order notifications and status updates; requires Meta business setup and API credentials, and is different from simply opening a `wa.me` link.
- **Cloudinary**: upload and optimize real food photos instead of keeping large images in the repository.
- **Supabase or PostgreSQL**: persistent relational database, especially if moving off SQLite; do not publish database keys.
- **Paystack or Flutterwave**: payment links/checkout in supported countries; verify merchant availability and fees before integration.
- **Google Maps links**: let customers share a pickup point or open directions. A plain maps link is easier than a full API integration.
- **EmailJS or a transactional email provider**: order confirmations for customers who provide email, with server-side secret handling where required.
- **Analytics**: track popular products, conversion, peak order times, and repeat customers, while minimizing collection of personal data.

Before adding new APIs, I recommend prioritizing persistent storage, secure admin access, order status tracking, validation, backups, and a clear privacy notice.
