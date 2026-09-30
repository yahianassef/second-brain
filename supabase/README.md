# The public edition — accounts and a real database

The personal app you use every day is unchanged: your data lives in your browser,
with your Google Sheets and gist sync. Nothing in this folder touches it.

This folder turns the *same* app into a public one, where anyone can create an
account and their data is stored per user in a database. One codebase, two modes —
the switch is a single file, `cloud-config.js`:

| | `cloud-config.js` says | Data lives in | Sync |
|---|---|---|---|
| **Personal** (what you run now) | `null` | your browser | Google Sheets + gist |
| **Public** | your project URL + anon key | Supabase, one row per item per user | automatic, per account |

---

## What is here

| File | What it is |
|---|---|
| `schema.sql` | The database: tables, indexes, and the isolation rules. Run once. |
| `../cloud.js` | Talks to Supabase — accounts, and syncing items in and out. No SDK, no CDN. |
| `../cloud-ui.js` | What you see: the sign-in gate, the account menu, sign out, delete my data. |
| `test-cloud.html` | 21 checks of the sync logic against a fake server. Open it; everything should pass. |
| `mock-supabase.js` | That fake server. Test-only. |
| `make-ui-test.py` | Builds a throwaway copy of the app wired to the fake server, for clicking through. |
| `make-public.py` | Builds the `public/` folder that gets deployed, with your real keys. |

---

## Your part (about 20 minutes, once)

**1. Create the project.** Go to supabase.com, sign up, and create a project.
Pick a region near your users and save the database password somewhere safe —
you will rarely need it, but it cannot be recovered.

**2. Create the tables.** In the project, open **SQL Editor → New query**, paste
the whole of `schema.sql`, and press Run. It is safe to run more than once.

**3. Send me two values,** from **Project Settings → API**:

- the **Project URL** — `https://something.supabase.co`
- the **anon** / **publishable** key — a long string starting `eyJ…`

Both are meant to be public: the anon key only ever reaches the rows of whoever
is signed in, because the database enforces it (step 2). **Never send the
`service_role` key** — to me or to anyone. It bypasses every rule here. If it is
ever exposed, rotate it in Project Settings → API.

**4. Decide about email confirmation.** Under **Authentication → Providers →
Email**, "Confirm email" is on by default: people must click a link before their
first sign-in. Leave it on for a real launch — it stops strangers signing up with
someone else's address. Turn it off only while testing.

**5. Point a domain at it** (optional). GitHub Pages serves the public build at
`https://<you>.github.io/<repo>/public/`. A custom domain is a CNAME record plus
one field in the repo's Pages settings.

## My part, once you send those two values

- Fill them into the public build and deploy it (`make-public.py`)
- Run the isolation test live: sign in as one account, try to read another's rows,
  and show you the result
- Check sign-up, confirmation email, sign-in, sync between two devices, sign-out,
  and "delete everything"

---

## How a user's data is kept apart

Every row carries the id of the account that owns it, and the database refuses any
read or write where that id is not the signed-in user's — this is Postgres row
level security, not a check in the app, so it holds even if someone edits the
JavaScript in their browser or calls the API directly with their own token.

Tombstones make deletions travel: deleting something on a phone leaves a marker so
a laptop that was offline removes it too, rather than resurrecting it on the next
sync. They are cleared after 120 days by `prune_tombstones()`.

`delete_my_data()` is what the account menu's **Delete everything** calls. It only
ever deletes the caller's own rows.

## Still to port

The **Car Maintenance** pages read a Google Sheet directly, so they are hidden in
the public edition. Making them work for everyone means storing fuel and service
entries in the database like every other collection — a contained piece of work,
worth doing before launch if the car pages matter to your users.
