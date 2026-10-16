# ISS Laboratory — Lab Book

The take-in, testing and reporting app for **ISS Laboratory** (Infinity Sparkle Studios).
It runs in any browser on a phone, tablet or computer, and stores everything in the
**InfinityCRM** Supabase project, so lab clients sit in the same client list as the rest of the business.

| Page | Who uses it |
| --- | --- |
| `index.html` — the lab book | Martha (and anyone with the Owner or Supervisor role in the CRM) |
| `verify.html` — public report check | Anyone holding a report number and verification code |

## What it does

- **Take-in:** finds or creates the client in the CRM, gives them a **LAB-0001**-style reference, takes photos with the camera, records condition and services, and captures the client's signature on the permission-to-test waiver.
- **Report numbers:** every stone gets the next **ISSL-2026-0001** number from the CRM's numbering system. Numbers can only be changed with a Supervisor override, which is logged.
- **Job file:** take-in photos, signature, micrographs, test results, conclusion and valuation in one place.
- **Branded PDFs:** take-in receipt and consent (signed) and the one-page identification report with a QR code for public verification. On Android the PDF button opens the share menu, so it attaches straight to Gmail or WhatsApp.
- **Payment:** Pay Now link and QR, payment message, mark as paid, receipt (RCPT-2026-0001) by email or WhatsApp.
- **Ledger:** payments received and outstanding, with an `ISS_Ledger.csv` export for LibreOffice.
- **Reminders:** when a report is issued, a re-test / re-valuation date is set (24 months by default). Clients appear under Reminders 60 days ahead, with WhatsApp and email messages ready to send.
- **Public verification:** `verify.html` shows the stone's details and results only, never the client's name, contact details or valuation amount.

## One-time setup

### 1. Add the lab to the database (once)

1. Open [Supabase](https://supabase.com/dashboard) → project **InfinityCRM** → **SQL Editor** → **New query**.
2. Paste the whole of [`supabase/01_iss_lab_module.sql`](supabase/01_iss_lab_module.sql) and press **Run**.
3. It should finish with "Success. No rows returned". Running it again is safe.

This only adds things: the `lab_jobs` and `lab_settings` tables, a `lab_ref` column on clients,
the ISSL- and LAB- number sequences, the public verification function and two storage folders
(`lab-private` for photos and signatures, `lab-public` for issued-report photos and the logo).

### 2. Publish the app with GitHub Pages

1. Put these files in the repository **ISS-Lab** (keep the folder layout).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
3. After a minute the app is live at `https://<your-github-name>.github.io/ISS-Lab/`.
   The public check page is the same address with `verify.html` on the end.

### 3. Let Supabase send you back to the app after a password reset

Supabase → **Authentication → URL Configuration**: add `https://<your-github-name>.github.io/ISS-Lab/`
under **Redirect URLs**.

### 4. Install it on the tablet

Open the app address in Chrome → sign in with your Infinity CRM email and password →
⋮ menu → **Add to Home screen** (or **Install app**).

## Who can sign in

Only accounts with the **owner** or **supervisor** role in the CRM's `user_roles` table can open the lab book.
Designers and other staff cannot see lab jobs or client details.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `app.js`, `styles.css` | The lab book app |
| `verify.html` | Public report verification page |
| `config.js` | Supabase address and publishable key (safe to publish; access is enforced by the database) |
| `manifest.webmanifest`, `icon-*.png` | Lets the app install to the home screen |
| `supabase/01_iss_lab_module.sql` | Database setup, run once |

## Changing prices, details and logo

Everything on the reports (business name, credentials, phone, email, prices, Pay Now link,
banking details, reminder interval and logo) is edited in the app under **Settings**. No code changes needed.
