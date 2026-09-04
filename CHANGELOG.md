# Changelog

All notable changes to the Medical Billing System will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

#### Every dialog is the same black, and `bg-black-900` is a real class

`bg-black-900` had been written onto the three Inventory dialogs and **no token backed it**, so Tailwind emitted no rule and those dialogs fell through to shadcn's `bg-popover`. That happens to be `#0f0f0f` in this theme — the same value `bg-slate-800` gives — so the class looked almost right while doing nothing at all, which is the worst way for a style to fail.

The token exists now (`--color-black-900: #000000`, the same black as `slate-950`, under the name the dialogs use) and all **eleven** dialogs carry it: add and edit medicine, add stock, both supplier forms, both customer dialogs, the POS customer dialog, the invoice detail, and both Settings dialogs. Solid `#000`, no alpha anywhere on the surface.

**On the two supplier forms looking different:** they are not, and the fields were never the difference. Both carry the same fifteen fields in the same order, the same three two-column rows and two three-column rows, the same separators and the same `max-w-md`. The only thing that differed was the background class, one of which was inert — and both now say `bg-black-900`.

#### Scrollbars in the app's own colours

A black track and a gold bar, everywhere. Left to itself Chromium paints a light grey trough, which on a pure black page is the brightest thing on screen and sits at the edge of every table, dialog and card — the default was louder than the content.

Written from the theme tokens rather than the hex values, so the palette stays defined in one place: change `--color-teal-500` and the bar follows, which is the point of the remap the theme was built as. Both engines are addressed and neither covers the other — WebKit and Blink take the `::-webkit-scrollbar` pseudo-elements, Firefox takes `scrollbar-color` and `scrollbar-width` and ignores the pseudo-elements entirely.

It sits in `@layer base` deliberately. The `scrollbar-none` utility hides the Reports tab strip's bar, whose arrows already say what can be scrolled, and Tailwind emits utilities in a later cascade layer — so that still wins and the strip is not handed back a scrollbar this rule would otherwise paint in. Verified in the compiled CSS: the layer order is `properties → theme → base → components → utilities`, with both `scrollbar-width` values present and the utility's in the winning layer.

#### A black and gold theme

The application is now pure black with gold accents, in place of the slate-and-teal it shipped with.

**Done as a palette remap, not a rewrite.** The screens name `bg-slate-800`, `text-white` and `text-teal-400` about 1,100 times across 21 files, and shadcn's token layer underneath them was used by almost nothing outside `components/ui/`. So rather than convert 21 screens to semantic classes, one `@theme` block in `index.css` redefines what those colour names mean. It touches no component logic, no test asserts on a colour, and reverting is deleting the block.

**The part that will surprise a reader: `text-white` is gold.** In this codebase that class marks headings and money figures — the things an owner's eye should land on — while `text-slate-300/400/500` carry body, label and muted text. Mapping `white` to gold therefore puts the accent exactly where it belongs without touching a screen. Two consequences had to be handled by hand: 30 sites where text sits *on* a saturated chip or button, which would have been gold on gold and are now `text-black`; and 47 inputs and secondary buttons, whose contents are body copy rather than headings and are now `text-slate-100` — otherwise every medicine name and phone number a user typed would have been gold.

Pure `#000` is the ground, as asked. Cards lift to `#0f0f0f` and inputs to `#1f1f1f` so surfaces separate without borders doing all the work. Large gold text on pure black haloes slightly on OLED; that is the known cost of `#000`, and the two lines to change for a near-black ground are named in the CSS.

**The text ramp is gold as well, not grey**, so the screen reads yellow throughout rather than gold-on-grey. What keeps it legible is that the four levels — heading, body, label, hint — differ in *brightness within one hue*: four yellows at the same brightness would flatten into one wall of text, and a table would stop separating into columns. Measured against the card ground rather than estimated: 11.8:1 for headings, 12.6 for body, 8.4 for labels and 5.5 for hints, against WCAG AA's 4.5 floor. Desaturating `--color-slate-300/400/500` back toward warm grey returns the accents-only look without touching anything else.

**Three things surfaced only by looking at the running app**, none of which a test would have caught:

- **Every toast rendered twice.** `<Toaster />` was mounted in both `main.tsx` and `App.tsx`, so each message appeared at bottom-right *and* top-right. Two of them fit on screen at once, which is how it went unnoticed — it read as a design choice rather than as the same message twice. There is now exactly one, in `App.tsx`.
- **Toasts, dropdowns and selects were rendering in light mode.** `<html>` carried no `dark` class and nothing mounts a `next-themes` provider, so `useTheme()` resolved from the viewer's OS — white toasts over a black application on any light desktop. The class is now set, the `.dark` tokens carry this palette, and the toaster is told which theme it is rather than asked.
- **The unpriced-lines warning was amber**, which is now the accent hue. It read as another highlighted panel rather than as something wrong, so it moved to orange.

The printed GST invoice is untouched: it paints with `text-black` on default paper and never used `bg-white`, which under this remap would have printed gold.

### Fixed

#### Tall dialogs ran off both edges of the screen

Reported against the supplier form, which grew nine fields the same day. `DialogContent` centres itself with `-translate-y-1/2` and had no height bound at all, so a form taller than the viewport overflowed **upward and downward at once** — the title was clipped off the top while Cancel and Save sat below the bottom, with nothing to scroll to reach them.

Fixed in the primitive rather than at the call site. Six form dialogs have that shape, the two supplier forms are the same form in two places, and pasting the same pair of classes into each is how they drift apart. A short dialog is unaffected: a max-height it never reaches and an `auto` overflow that never triggers.

`dvh` rather than `vh`, because on a phone `vh` counts the space behind the browser's own chrome — and a counter is where this app is used. The invoice dialog's own `max-h-[85vh] overflow-y-auto`, previously the only one in the app, is dropped in favour of the shared default.

*This edits a shadcn-generated file, so `shadcn add dialog` would take it back out. The comment above the change says so.*

#### TypeScript 7 also broke the type generator, silently

Pinning the frontend back to 6.0.3 exposed the same major sitting in the backend, where it fails for a different reason and had gone unnoticed. The backend is JavaScript and uses TypeScript for exactly one thing: `scripts/generate-api-types.js`, which reads the Zod schemas through the compiler API to produce the frontend's request types. **TypeScript 7 is the native rewrite and drops `ts.ModuleResolutionKind`, `ts.ModuleKind` and `ts.ScriptTarget` from the JS API**, so the generator dies with `Cannot read properties of undefined (reading 'Bundler')` and takes `npm run types:check` — a CI gate — with it.

It looked green locally only because the dev container carried a stale install from before the bump. A fresh `npm ci` reproduces it immediately. Backend TypeScript is pinned to `~6.0.3` too, so one version now serves the whole repository, and both directories have `ignore` rules for the major with the lifting condition written beside them: for the frontend, a typescript-eslint peer range that admits 7; for the backend, that generator ported to the 7 API.

#### The Vercel build broke on a TypeScript major the linter cannot accept

`npm install` failed with `ERESOLVE`: `typescript-eslint@8.68.0` declares a peer range of `typescript >=4.8.4 <6.1.0`, and the frontend pin had been bumped to `~7.0.2`. **Pinned back to `~6.0.3`.**

There is no forward fix to take. 8.69.0 is the current latest typescript-eslint, no 9.x is published, and it still caps at `<6.1.0` — so the only alternatives were reverting the major or hiding the conflict behind `--legacy-peer-deps`, which is what let this reach a deploy the first time it happened.

Nothing is wrong with the code: on TypeScript 6.0.3 the app type-checks, lints, builds and passes its 192 tests, exactly as it did on 7. The incompatibility is entirely in a peer declaration.

**This is the second time for TypeScript and the third dependency major to break a deploy this week.** `bb1a6ba` pinned TypeScript back for this precise reason on an earlier occasion, and Dependabot re-raised the bump because nothing told it not to. Both pins now have `ignore` rules for `semver-major` — TypeScript in the frontend, Prisma in the backend — with the condition for lifting each written beside it. For TypeScript that condition is one command: `npm view typescript-eslint peerDependencies.typescript`.

**CI would have caught this.** Verified rather than assumed: the frontend job runs `npm ci`, and `npm ci` on the tree that broke the deploy fails exactly as `npm install` does. So no new CI step was added — the check already exists, and what got past it was the merge, not the pipeline.

#### The deploy broke on an unparseable lockfile, for the second time

`npm ci` failed in the Docker build with *"can only install with an existing package-lock.json … lockfileVersion >= 1"*. The file was there, tracked, 218 KB, in the build context — and **not valid JSON**. A dependabot merge resolution had eaten an entry's closing braces, leaving `@prisma/client-runtime-utils` unterminated with no comma before the next key. No conflict markers survived, so nothing looked wrong in review.

That error message is the trap. It reads as a *missing file* and sent the investigation toward the build context both times this happened; the fix is to check whether the file parses. A `COPY package*.json ./` probe confirmed the lockfile arrived intact, which is what turned the search around.

**Prisma is pinned back to 5.22.** `package.json` had said `^7.10.0` since the merge, and nothing has ever run on it: the container, the suite and production are all 5.22. Prisma 7 drops the datasource `url`, renames the prisma-client-js generator and requires a driver adapter, so it is a migration rather than a bump. The minor bumps that arrived in the same batch — zod 4.5.2, express-rate-limit 8.7.0, eslint 10.9.1, typescript 7.0.2 — are kept.

Verified by building the real image: `docker build -f backend/Dockerfile backend` completes, the client generates at 5.22.0, the prisma CLI survives `npm prune --omit=dev`, and vitest and eslint are absent from the runtime layer.

**This is the second time, so the recurrence is what got fixed rather than only the symptom:**

- **Dependabot no longer raises Prisma majors.** An `ignore` rule on `prisma` and `@prisma/client` for `semver-major` only — 5.x patches and minors, security patches included, still arrive.
- **CI checks both lockfiles parse before it installs anything.** It names the file and the position, which is the difference between a five-minute fix and an afternoon. Proven against the commit that broke this deploy: the step fails on it and passes on the repair.

The earlier occurrence was fixed and never written down anywhere, which is a fair part of why it came back.

#### Exports produce the whole report, not the part that fit

The Schedule H register exported its **first 100 rows** and said nothing about the rest. `MAX_LIMIT` is the cap that stops a client asking a list endpoint for `?limit=999999` (threat T-10); applying it to a compliance document nobody asked to paginate turned Rule 65(11)'s "produce the particulars" into "produce some of them". A register that ends early is not a short download — and a truncated CSV that terminates cleanly is indistinguishable from a complete one.

**The five exports that are one row per record now stream** — daily summary, GST, the Schedule H register, expiring and low stock. The header goes out, then the query is paged and rows are written as they come, so memory stays flat whatever the period holds.

**The other four do not, and that is the answer rather than an omission.** Monthly and margin are one row per day of a month, so at most 31. Yearly is twelve. Top sellers is the `limit` the caller chose, where "the top ten" *is* the report. Their row count is set by the shape of the report and not by how much the shop traded, so paging them would add a loop around a single query and buy nothing.

Three things were needed beyond the loop:

- **`toCsv` and the new `streamCsv` share `csvRow`.** A second implementation of the escaping and the formula guard is G-21's exact shape — an export growing its own idea of what a column contains — so a unit test asserts the streamed bytes are **identical** to what `toCsv` would have built, across two full pages and a partial one.
- **Every streamed query orders by `id` last.** `date DESC` is not a total order: two sales in the same second tie, and a paged read over a partial order repeats one row and drops another while the row *count* stays right. A test counts distinct keys rather than lines for exactly that reason.
- **A failure mid-file destroys the connection** instead of ending it. The first page is fetched before any header is sent, so an ordinary failure — a bad query, a database that is down — is still a clean error response; only a failure after bytes are on the wire falls to the destroy path, where an aborted transfer is the honest outcome.

Nineteen tests: 120 rows exported where the ceiling was 100, on the register and the GST return; distinct keys across the page boundary; the CSV agreeing with the JSON report on its row count; tenant scoping surviving the paged query; and the bounded four still bounded.

#### The API refused to start without a mail server, and production spent two days down

The boot guard added with self-service password reset (FR-AUTH-11) exited the process in production when `SMTP_HOST/PORT/USER/PASS/FROM` or `APP_URL` was unset. On Render those were never set, so from 2026-08-31 every deploy built its image, ran its migrations, printed `Refusing to start` and exited 1.

**The damage was not the downtime; it was the disguise.** Render kept serving the last image that had booted, so the API stayed up on a build from before the guard existed. Four features shipped in that window were live in the browser and absent from the API, and every symptom was a `404` — which is indistinguishable from a route nobody wrote. `GET /api/medicines/units` answered `{"message":"Medicine not found"}`, because the request fell through to `/:id`. Establishing that production was merely *behind* took probing an unrelated public endpoint and arguing from its absence.

The guard was the wrong layer. `JWT_SECRET` earns one because nothing works without it; mail does not, because everything else does — billing, inventory, the GST return and the till send no email and were down anyway. The requirement it was defending is real and unchanged: never accept a reset this deployment cannot deliver. That belongs at the endpoint, so `POST /api/auth/forgot-password` now answers **503** and issues no token while mail is unconfigured, and the process starts and logs loudly instead of exiting.

The refusal turns on the deployment's configuration, not on the address, so every caller gets the same answer and it is not the account-enumeration oracle the identical-response rule exists to prevent. `POST /api/auth/reset-password` is deliberately unguarded: a link already delivered has to keep working, and consuming a token needs no mail server.

`render.yaml` now declares the six variables it never mentioned.

#### `/health` says which build is answering

The corollary. There was no way to ask a running API which commit it was, so "the deploy did not happen" and "the code is wrong" — the two explanations for a `404` in production, with nothing in common — could not be told apart from outside.

```json
{ "success": true, "version": "2.0.0", "commit": "3904fcd", … }
```

`commit` comes from `RENDER_GIT_COMMIT`, or `GIT_COMMIT` anywhere else, and reads `unknown` in development. One `curl` against `git rev-parse --short HEAD` now answers a question that took an afternoon.

#### The collapsed sidebar had a scrollbar lying across it

Reported from a screenshot: a horizontal scrollbar sat over the bottom of the 64px rail, pushing Logout below it.

Setting only `overflow-y` to `auto` leaves the other axis computing to `auto` as well — and the rail's hover labels are positioned at `left-full`, outside the rail. So the nav scrolled sideways to reveal labels that were never meant to be inside it.

The axis is clipped now, which means an absolutely-positioned label can no longer escape: the collapsed rail uses the browser's own `title` tooltip instead. Fewer moving parts, and it cannot come back.

#### Tab strips ran off the edge of the screen

Reports reached ten tabs and the last two — Sales Trend and Stock Alerts — ran off the right of a laptop screen with nothing on screen to say they existed. That is the same defect the phone dropdown was built to fix, returning at a wider breakpoint as the strip grew.

The desktop strip scrolls now, with arrows on whichever side has something to reach, and the selected tab is scrolled into view when it changes from elsewhere. A strip that fits draws no arrows and looks exactly as it did.

#### Gold text on gold grounds

Eight places the theme change missed, where text that the palette remap turned gold sits on a saturated gold ground: the selected sidebar item, the sidebar logo, the sign-in and sign-up logos, the batch filter's active button, the void dialog's confirm button, the POS's "Default" batch badge, and a cashier's avatar in User Management. All black on gold now, like the thirty sites the retheme did catch. The two avatars beside that last one stay white, because red and blue are not the accent.

#### A printed invoice left a third of a page blank before its totals

Reported from a real bill: a three-line invoice printed five empty ruled rows between the last medicine and the totals block, which reads as though the till failed to print the rest of the order.

The table padded its body out to eight rows whatever it held, so the box kept one height. The reasoning was that the totals should not ride up under the header — but for a short bill riding up is exactly what it should do. The padding is gone; the table now ends where the items end, everything below follows it up the page, and a longer bill grows on its own.

#### Every tick on three chart axes read ₹0k

Reported against the September margin chart: the axis showed **₹0k** at every gridline while the bars above them had obvious height. The three sales charts — the margin report, the sales trend and the dashboard — each carried their own copy of `` (v) => `₹${(v / 1000).toFixed(0)}k` ``, and `245 / 1000` is `0.245`, which `.toFixed(0)` renders as `"0"`. Any period whose takings ran to hundreds rather than thousands showed an axis of zeroes.

It survived because the fixtures and the busier months all reach thousands, so nothing in the suite or in a casual look at a live chart exercised the case. A single shop's quiet month is exactly where it bites.

The same formatter also mangled negatives, which the margin report genuinely produces — a month whose only activity is credit notes against earlier sales runs at a loss, and `-245` rendered as `₹-0k`.

**One function now, in `lib/currency.ts`, not three fixed copies.** The three were identical, so the defect was identical in all three and fixing the reported one would have left two — the shape `utils/trend.js` exists to close on the server. Below ₹1,000 it prints exact rupees; above, it steps through **k, L and cr**, following the lakh/crore grouping `amount-in-words.ts` already uses on the printed invoice, because an axis reading `₹1.2M` next to "one lakh twenty thousand" would be the same number in two counting systems.

Six tests, the first of which is the reported case.

### Added

#### The supplier record is a distributor master, not a contact card

Checked against a real supplier master for a Patna pharmacy: of everything in it, `Supplier` could store the name, contact, phone, email, GSTIN and one line of address. It could not store the shop's own code for the distributor, their drug licence, the payment terms, the delivery days, the credit limit, or the city, state and PIN as anything but more of the address string. Nine columns, all nullable, nothing backfilled — an existing supplier row is valid and simply unfilled, and there is no default that would be true of a distributor nobody has entered details for.

Three of them are decisions rather than columns:

- **`code` is unique per shop, and an empty string is a value.** Two suppliers saved with a blank code collide on the index, and the second is refused over a field nobody filled in — so both forms omit an untouched field rather than sending `""`. Postgres treats NULLs as distinct, which is what lets any number of suppliers have no code.
- **`deliveryDays` and `paymentTerms` are free text**, and the sample data is the argument: "On order (2-4 hrs)" is a real delivery arrangement and it is not a set of weekdays.
- **`state` is stored and not acted on.** It decides the place of supply, an inter-state purchase attracts IGST, and this billing pipeline only ever computes the intra-state CGST + SGST pair. Recording it makes the question visible; it does not answer it, and the docs say so rather than implying the tax treatment follows.

#### The HSN code is a list with descriptions, not an eight-digit box

HSN is the classification a GST return is filed against, so unlike a category or a unit it is not the shop's to invent — the code either is the government's code for what is being sold or it is wrong. What the operator had was an empty box and their memory, and `30049099` against `30049011` decided at the counter is how a return comes back wrong.

The medicine form now offers the twelve codes a general pharmacy uses, each with what it covers — *Insulin*, *Ayurvedic / Unani / Siddha medicaments*, *Medicated shampoo (18%)*. The three rate hints are the government's and are there because those three are the surprises; nothing sets `gstPercent` from the code, because a wrong rate applied silently is a filing error nobody sees.

**It is a list and not a cage**, for the reason the `unit` enum was removed nine days after it shipped: twelve codes are nowhere near the whole schedule, and a shop that starts selling a device or a supplement outside them would file under something it knows is wrong. There is an "Other HSN code…" box beside the list.

Two things this deliberately does *not* do:

- **No server-side format validation.** The catalogue already holds 5-, 6- and 8-digit codes and one non-numeric value. A `^\d{4,8}$` rule would be correct in the abstract and would make those rows uneditable — which is exactly what the nine-value `unit` enum did to a shop that sells vials.
- **No silent normalisation.** A code the list does not recognise is shown on the trigger and survives a save. Without that, opening a medicine filed under a six-digit code and correcting its spelling would quietly rewrite what it is filed under.

#### A medicine records which distributor it is usually bought from

The master names a primary supplier per item and the schema had nowhere to put it: supplier existed only on `Batch`. `Medicine.defaultSupplierId` is that place, and it is deliberately **not** derived from the most recent batch — the two are different facts. A batch's supplier is history, is what a recall follows, and is never wrong; a primary supplier is a preference that can be wrong without making any past purchase wrong. Reading one off the other would let a one-off purchase from whoever had stock that week silently become the answer to "who do we buy this from".

`SetNull` on delete, for the same reason: dropping a distributor should forget where the shop reordered from, while a batch reference still blocks the deletion.

### Fixed

#### A reference in a request body was never checked against the caller's shop

Adding a third foreign key to the medicine form is what surfaced it. Multi-tenancy here works by putting `shopId` in the same `where` as `id` on every scoped read and write — which covers the row being written and says nothing about the rows it points at. `POST /api/medicines` passed `categoryId` and `manufacturerId` straight into `create`, and a foreign key only asks whether a row exists, never whose it is. So a medicine could be filed under another shop's category, and the `include` on the response would read that shop's category name back to the caller. `POST /api/inventory/batches` checked its `medicineId` and not its `supplierId` — the same shape, half-closed.

One guard in `utils/owned-refs.js` now covers all four. A foreign id answers **404**, never 403, because the alternative confirms the row exists to somebody who cannot see it.

### Added

#### Units are the shop's own vocabulary, not a list of nine

`unit` on a medicine was a Zod enum of nine values, so a pharmacy selling vials, sachets, strips or tubes had to file them under **other** — and `other` is what the customer then read in the PACK column of their printed invoice. The requirement that named those nine (FR-MED-07) was making the invoice less true, so it is marked superseded rather than met.

The server stopped policing membership and kept policing shape: 1–20 characters, starting with a letter, lower-cased on the way in so `Tablet` and `tablet` cannot become two entries. `GET /api/medicines/units` reports the distinct units a shop actually uses, and the medicine form offers those alongside the original nine — which is what makes a unit typed once stick rather than vanishing after the save. A retired medicine's unit drops off the list.

No `Unit` table: a unit is one short string on a medicine, and a master table would have been a migration, a CRUD screen and a referential-integrity question in exchange for nothing the catalogue does not already know.

#### Delete, where only Edit existed

`DELETE /api/suppliers/:id` has existed since the resource did and nothing called it, so a distributor entered by mistake stayed in the dropdown of every batch form for good. Both supplier screens — the Inventory tab and the Suppliers page — now offer it, behind a confirm.

The failure message is **the server's own sentence**, not a guess. A supplier with stock against it comes back `409` saying exactly that, and a non-admin `403`; the previous convention here was a hard-coded "cannot delete — medicines exist", which is one of those two dressed as the other.

Customers get the same treatment with different wording, because the endpoint does something different: it **erases the personal details and keeps the invoices**, which are tax records. The confirm says so and the icon is a struck-through person rather than a bin — calling it "delete customer" would promise something the server deliberately does not do.

#### The Schedule H register can be produced (FR-MED-12)

`GET /api/reports/prescriptions` and its CSV export, a **Prescriptions** tab on the Reports page, the prescriber's particulars on the invoice detail dialog, and a prescription band on the printed invoice.

**The register has been recorded since 2026-08-24 and could not be read.** `Prescription` was created that day with indexes on `prescriberRegNo` and `prescribedOn`, and a comment in the schema naming the query an inspection asks — and nothing asked it. Rule 65(11) permits a register in lieu of retaining the paper on the condition that the pharmacy can *produce* the particulars; for eight days producing them meant somebody with a `psql` prompt, which is not that.

This is the fourth time this repository has shipped a capability nothing could reach, after `POST /api/auth/logout`, the void endpoint, and the two report endpoints in the entry below. The FR-MED-12 row now carries both dates rather than one ✅.

- **The date filter reads `prescribedOn`, not the date of supply.** Those differ whenever a customer fills a prescription later than it was written, which is most of them, and an inspection asks about the former. The invoice's own date is on every row for anyone who wants the latter.
- **One search box across prescriber, registration number and patient.** An inspector arrives holding one of the three and should not have to know which field it was filed under.
- **ADMIN and PHARMACIST**, matching the GST return rather than the trading reports: every row names a patient and what they were dispensed, which is the most sensitive join in this database, and a pharmacist needs it because dispensing Schedule H is their job. The tab is filtered out for a cashier rather than rendered disabled, so the page never fires a request the server would refuse.
- **Scoped through `invoice.shopId`.** `Prescription` carries no `shopId` of its own, so the tenant boundary is a relation filter in the same `where` rather than a check afterwards — and it is tested against a real second shop rather than asserted in a comment.
- The export starts from the first row whatever page is on screen, because a compliance document is not a page of a table. It still takes `MAX_LIMIT`: a range holding more than 100 entries exports its first 100, which the API reference states plainly rather than leaving to be discovered.

21 backend tests and 8 frontend.

#### The margin and top-seller reports are reachable from the app (FR-RPT-07, FR-RPT-08)

Two tabs on the Reports page: **Top Sellers** (period, a Top 10/20/50 selector, ranked table, CSV export) and **Profit & Margin** (revenue, cost of goods, profit, margin %, a daily bar chart, CSV export).

**Both endpoints shipped on 2026-08-31 with no screen calling them, and that was not recorded at the time.** It is the third time this repository has done it — `POST /api/auth/logout` was live for three days before the Sign out button called it, and the void endpoint for five before a dialog existed — and docs/07 P1-7 already states the lesson: *"An endpoint nothing invokes revokes nothing, and every document here described the endpoint's behaviour as though it were the product's."* The two `FR-` rows now carry both dates, the way FR-BILL-17's does, rather than a single ✅ that implies the feature was in the product.

- **Margin is ADMIN only, and the gate is narrower than the GST tab's.** Takings are the shop's own trading record; what the stock cost is not. The tab is filtered out rather than rendered disabled, matching the GST treatment, and the page does not request the report for a role the server would refuse — a hidden control that still fires a request produces an error toast and no explanation.
- **The unpriced-lines warning is rendered only when there is one.** A permanent banner reading "0 lines" trains the reader to stop seeing it; when it appears it says the profit above is an upper bound and what to do about it.
- **A month that sold nothing shows `—`, not `0%`**, carrying the server's `null` through rather than formatting it into a claim about a period that traded.
- Neither tab re-sorts, re-derives or re-formats a figure the server sent. The ranking, the margin and the money are the API's, so the screen and the CSV of the same period cannot disagree ([G-21](./docs/08-gap-analysis.md#g-21)).

Fifteen tests, the first of which is the one that would have caught the original omission: a tab exists, and opening it calls the endpoint.

#### Self-service password reset, and the stack's first outbound dependency (FR-AUTH-11)

`POST /api/auth/forgot-password` and `POST /api/auth/reset-password`, both public because the caller cannot sign in — which is the whole problem. Migration `20260901104630_add_password_reset_tokens`.

**Why the outbound dependency is not a reversal.** `docs/07` §10 P1-6 turned down HaveIBeenPwned as this stack's first egress, partly because **it would have had to fail open**: when the lookup could not run the password still changed, and the protection quietly evaporated while every screen reported it enforced. Mail is not inside a control. It is the *delivery* of something the user asked for, so a failure weakens nothing — no token is honoured, no password changes, no session ends. That entry also said to revisit once self-service signup landed; it did on 2026-08-29, and it changed the stakes rather than the argument: **a shopkeeper who opened their own shop has no administrator to ask**, so an emailed reset is the only way back into the account.

**What happens when the mail server is unreachable** — decided rather than discovered, because "reset silently did nothing" is the failure that will actually occur:

- **Misconfiguration cannot survive a boot.** `SMTP_HOST/PORT/USER/PASS/FROM` and `APP_URL` are required in production; `src/index.js` refuses to start without them, as it does for `JWT_SECRET`. Nobody requests a reset on a good day, so this is the case that would otherwise sit undiscovered for weeks.
- **A send failure does not change the response**, because it cannot: the endpoint answers identically for a known and an unknown address, and a `503` for one against a `200` for the other is an oracle for which addresses have accounts. The failure is logged at `error` with the request id and the recipient — never the link.
- **The residual is written down** in SECURITY.md rather than left for somebody to learn from a user who never got their email: a reset that could not be sent looks exactly like one that was.

**The token** is 32 random bytes, stored **only as a SHA-256** — a dump of the table cannot be turned into a reset. SHA-256 and not bcrypt deliberately: the input is random, not chosen, so there is no dictionary to slow down. Single use is recorded as `usedAt` rather than a delete, so "already used" and "never existed" stay distinguishable *in the table* even though the caller is told the same thing either way. Asking again spends the older link, and completing a reset spends every other pending one — the mailbox holding them may be the reason for the reset.

**Completing a reset bumps `tokenVersion` and revokes every refresh token**, the same two halves as a password change, and **issues no session**: possession of a mailbox is not what knowing the current password is, and handing back a token would make a compromised inbox a one-step takeover.

**The rate limiter is a new one, not the login limiter**, and that is the part most likely to have been got wrong quietly. `loginLimiter` is built with `skipSuccessfulRequests` — right for login, where only failures are worth counting. But this endpoint answers `200` to everything by design, so every request would have been skipped and the budget never spent, while the mounting looked correct in the route table and in review.

Twenty tests. One of them found that the first version of the mail spy was patching an object the controller never read — the same ESM/CJS split that left the login-timing guards inert for weeks (docs/09 §1a) — so the controller now calls `mailer.sendMail(...)` through the module object and the test reaches it with `createRequire`. Until that was fixed, `expect(sent).not.toHaveBeenCalled()` was passing vacuously.

**FR-NOTIF-06 is no longer blocked.** Email alerts now need a consumer of `config/mailer.js`, not a dependency; what remains is the product question of which alerts are worth sending. SMS remains a separate provider.

### Documentation

#### Key rotation is a procedure now, not a warning (P2-16)

The last open item in the security backlog. `docs/07 §7` had the sharp edge written down — Postgres applies `POSTGRES_PASSWORD` only when it initialises an empty data directory — but a warning is not something an operator can follow at 2am, and it only described one of the two secrets.

Two runbooks in [`docs/06`](./docs/06-development-guide.md#rotating-a-secret), because the two fail in opposite directions:

- **`JWT_SECRET` does exactly what it is told, and signs every user out doing it.** It signs both halves of a session — the 30-minute access token and the 7-day refresh cookie — so changing it invalidates every token in existence. The runbook says that first, in those words, because it is the mechanism rather than a side effect. It also states what does *not* break: password-reset links are random values stored as hashes and never signed, and reuse detection cannot fire, because verification fails before a token's `jti` is ever read. Backing out costs a second sign-out; there is no dual-key verification, since `jwt.verify` is handed exactly one secret.
- **The database password appears to change and does not.** Editing `.env.prod` leaves the role untouched while the backend starts presenting the new value, and Prisma fails `P1000` — after the fact, which is the whole problem. Two paths: `ALTER ROLE` for a scheduled rotation, a suspected leak, or a password you have lost; dump-recreate-restore when the volume is being rebuilt anyway or `POSTGRES_USER` itself has to change.

**Rehearsed against the development stack rather than reasoned about**, which is the only reason two of these notes exist:

- The `ALTER ROLE` command as first drafted read `psql -U "$POSTGRES_USER"`, which is **empty in the operator's shell** — `.env.prod` is passed to compose, not sourced into a session. It now reads the role out of the running container, the way `scripts/backup.sh` already does.
- The image grants `trust` to loopback as well as to the unix socket, so `PGPASSWORD=anything psql -h 127.0.0.1` succeeds from inside the Postgres container **whatever you type**. A rotation verified that way looks like it failed. The runbook says not to, and verifies through `/health/ready` instead, which runs `SELECT 1` over the application's own connection.

Also corrects a comment in `docker-compose.prod.yml` that still claimed `src/index.js` refuses to start without the SMTP variables. It stopped doing that on 2026-09-01. The compose guard stays — a production stack should not launch half-configured — but it is now labelled as the deployment policy it is rather than as a second copy of an application guard that no longer exists.

#### The docs set reconciled against the code, and eight figures were wrong

A sweep for stale numbers, dates and status markers, prompted by an audit that read the documents and then checked them.

- **`docs/05`'s health snapshot** quoted 701 backend tests across 28 files and 165 frontend across 20, and dated its honest read to 2026-08-20 — describing Phase 8 as the work still ahead, three weeks after Phase 8 landed. Now 741 across 30 and 181 across 22, measured, with the read rewritten: nothing between here and a running shop is code any more, it is the four operator tasks.
- **`docs/08`'s G-13** was headed “🟡 three decisions outstanding” and listed as partly fixed in the summary table, while its own table below showed all three struck through and decided by 2026-08-24. The rows had been kept current and the heading over them had not — the same failure the document exists to catch, one level up.
- **`docs/09`'s coverage section** read “Measured 2026-08-22: about 85% of statements” and “the two files” above a table of four. Now 91.53%, with the four gated files' current figures and the thin spots named.
- **`docs/01`'s NFR-23**, and the directory trees in **`docs/02`** and **`docs/06`**, still carried 604- and 701-test counts from three separate weeks.
- **`docs/02` and `docs/04`** both said nine routers are mounted; there are ten. The shop router landed with multi-tenancy on 2026-08-29 and was never added to either table, and `docs/02`'s reports row still listed five of the ten reports.
- **`docs/README.md`** introduced the whole set as describing version 1.0.0 as of 17 August — two weeks and a major version out of date, on the front page of the set that exists to prevent this.
- **`render.yaml`** said it applies 19 migrations. There are 20.

Both per-file test tables in `docs/09` now sum exactly to what a run reports — 741 and 181 — which is how the one genuinely missing count turned up: a test added to the prescription-register suite after its row was written.

Every number here came from a run: `npm test`, `npm run test:coverage`, and the frontend suite on Node 22. None was carried over from a previous document.

#### FR-BILL-18 is superseded, not planned

The server-generated PDF invoice was specified when the printed bill was a receipt, and a PDF meant leaving the browser to get a document worth handing over. **FR-BILL-20 now prints a full GST tax invoice, and the browser saves it as a PDF named after the invoice number** — so what that requirement was reaching for exists, without either of the dependencies its backlog note proposed. Puppeteer in particular would have pulled a Chromium into a backend image whose entire deployment story is one small container.

What a server renderer would still add is **emailing a bill with no browser open**. Nobody has asked for it in the four months since 1.0.0, and it needs the same SMTP decision FR-AUTH-11 and FR-NOTIF-06 are waiting on — so it is one question to answer once, not three.

**The row is kept in both documents rather than deleted.** A requirement recorded as superseded tells the next reader why not to build it; one that quietly vanished tells them nothing, and invites somebody to re-derive the argument from scratch. `docs/01` §6.8 carries the reasoning and `docs/05`'s backlog points at it.

### Added

#### Top-selling medicines (FR-RPT-07)

`GET /api/reports/top-sellers?month=&year=&limit=`, plus `/export`. Ranked by units sold, with the value of what sold. Claimed in the old `backend/README.md` and never built, which is how it came to be catalogued as documentation drift (D-1) rather than as a feature.

**Grouped by `Batch.medicineId`, never by `InvoiceItem.medicineName`.** That column is a snapshot taken at sale time so a later rename cannot rewrite what a customer was handed (BR-12) — group by it and one medicine becomes two rows the day somebody fixes a spelling, with each half ranking lower than the whole, so a shop's best seller can drop off its own top-ten. The name shown is the medicine's current one. A test renames a medicine mid-month and asserts one row under the new name, while the invoice line still carries the old one.

**Returns come off the units, in the month the credit note was issued** — the sale's own month is left as it was (BR-14), matching the GST and margin reports. This counts credit-note lines rather than subtracting `InvoiceItem.returnedQty`, and the distinction matters: that column is the cumulative concurrency guard on the sale's line, so subtracting it would make a report of March change every time somebody returns a March purchase, quietly rewriting a closed period.

**Watch the asymmetry if you touch the aggregation.** A credit note's lines carry a *positive* `quantity` and an *already-negated* `totalPrice`, so the money nets itself out of a plain `SUM` and the units do not. Only the quantity takes its sign from the invoice type; summing both the same way is wrong whichever way you pick.

Two smaller calls, both stated in the code: a medicine whose net units fall to zero or below does not appear — a list of best sellers reading "0 units" is noise, and something sold then entirely returned did not sell — while soft-deleted medicines are *not* excluded, because a product withdrawn in April was still what sold in March.

`limit` is the shared validated one: optional, defaults to 20, capped at 100, and a `400` on `0`, a negative or a typo, so a new query surface does not reintroduce threat T-10. Open to every role, like the other period reports and unlike the margin report beside it — this says what the shop sold, not what any of it cost.

Nineteen tests, including the rename, the partial return, the full return, the period attribution and the shop scoping.

#### Profit and margin report (FR-RPT-08)

`GET /api/reports/margin?month=&year=`, plus `/export`. A month's revenue against what the stock cost, broken down by day and zero-filled, built on the period reports' shape rather than a new one — `summaryForPeriod` unchanged, so the trading figures at the top of this report are produced by the *same function* as the monthly report's and cannot drift from them. No schema change: the data has been there since 1.0.0.

**The two definitions are the whole report, and both are decisions rather than arithmetic:**

- **Revenue is `subtotal − discountAmt`** — what the shop keeps, before tax. Not `totalAmount`, which carries GST the shop collects and remits and never owns; counting it would overstate every month's profit by its tax. Both columns are stored, so nothing is re-derived ([G-21](./docs/08-gap-analysis.md#g-21)), and a credit note already holds both negated — which is what makes a reversal net itself out without a special case.
- **Cost is the batch's `purchasePrice` at the quantity sold**, negated for a credit note: returned stock is back on the shelf, so its cost comes off the period that took it back. The sign has to come from the invoice's type, because credit-note lines carry a positive `quantity` and a negative `totalPrice`.

**ADMIN only, and the contrast is the point.** The monthly and yearly reports are open to every role because a shop's takings are its own trading record, which a cashier reconciling a till has reason to see. What a batch cost is not, so this sits with the GST return instead. A test asserts a `CASHIER` gets `200` on `/monthly` and `403` on `/margin`, because that contrast is the design and not an accident of route ordering.

**A batch with no recorded cost is counted, not treated as free.** `purchasePrice` is validated positive, so a zero is a cost nobody entered — and in the arithmetic that is indistinguishable from stock that cost nothing, which reads as a flawless 100% margin with nothing on the screen to say why. `unpricedLines` surfaces the count, and while it is non-zero `profit` is documented as an upper bound rather than a figure.

**`marginPercent` is `null` on a month that sold nothing**, not `0`. Zero percent is a claim about a period that traded.

**A reversed sale stays in the month it was raised** and its credit note lands in the month it was issued, the same rule the GST report follows (BR-14). Asserted in both directions: March keeps its margin when the return happens in April, and April carries the negative.

Twenty tests, including the reconciliation of the day rows to the headline, both sides of the month boundary, the shop scoping — a leak here would put one pharmacy's cost prices on another's screen — and the CSV's money as the stored 2 dp string.

*Also corrected while counting:* the raw-SQL statement count in SECURITY.md, docs/01 and CONTRIBUTING said six. It was five, and the six came from a grep that also matched the phrase `` `$queryRaw` `` inside a comment. It is seven now, with this report's two aggregations, and CONTRIBUTING no longer keeps a second copy of the number — which is what let the first one rot.

#### The audit log's 24-month retention is enforced, not just decided (NFR-17)

`npm run purge:audit` — reports what it would delete and how old the oldest row is; `-- --apply` commits. The policy was decided when the log shipped on 2026-08-22, and until now nothing applied it: the table only grew while four documents described a rule that was not in force.

- **Dry by default**, like the customer purge. Deleting an audit trail cannot be undone, and a tool that does it because somebody was exploring is a bad tool.
- **Operator-scheduled, not self-running.** No background worker exists in this stack by design, and `scripts/backup.sh` set the precedent. `docs/06` carries a cron line, half an hour after the customer sweep so a failure says plainly which one.
- **Not scoped by shop** — the one deliberate exception to a codebase where everything filters on `shopId`. Retention belongs to the installation, on one clock for every tenant; a per-shop sweep would let one operator keep what another had purged.
- **It writes no audit rows of its own.** `AuditLog` is absent from the audited model set, so the sweep passes through the extension untouched. A purge that audited itself could never shrink the table.

**On the interaction with customer erasure**, since `erase-customer.js` redacts an erased customer's audit payloads in place and both therefore act on the same rows: the sweep cannot undermine it, because **deleting a row is strictly stronger than redacting one**. Redaction exists so an audit row stops holding a copy of data erased everywhere else; removing the row achieves that and more. And nothing depends on a row still being there — `redactAuditTrail` is an `updateMany`, so matching zero rows is a no-op, and an erasure whose audit history has already aged out still completes and still leaves nothing personal behind. Asserted rather than assumed: three tests drive erasure *after* a purge has taken its rows.

**The row recording an erasure gets no carve-out**, and that is a decision rather than an oversight. docs/03 said audit retention must outlive the 36-month customer window; it was written while PRD Q6 was open and the number unknown. The two clocks measure different things from different origins — 36 months from a customer's last purchase, 24 from an individual write — so the comparison was never the right one. What the constraint asks is that an erasure stay auditable well after it happens, and two years is that.

Eight tests, including both sides of the window boundary.

### Fixed

#### The frontend suite was flaky on a loaded machine, and said so misleadingly

`Inventory.batches.test.tsx` failed intermittently — on one machine at 62s and not at 31s, on the same commit, and passing 6/6 whenever that file was run on its own. Two timeouts were too tight for what these tests actually do, and both are now raised: `testTimeout` to 15s in `vitest.config.ts` (Vitest defaults to 5s) and `asyncUtilTimeout` to 5s in `src/test/setup.ts` (Testing Library defaults to 1s).

Neither weakens an assertion. They change how long a test waits before concluding that something never happened.

- **Why the defaults do not fit.** The component tests drive the UI through `userEvent`, which types one keystroke at a time, and the batch form's medicine lookup debounces 300ms before it queries and renders. A `findByRole` for a search result therefore has to cover a debounce, a request and a paint inside one second — comfortable on an idle machine, not on a busy one.
- **The second failure mode is the instructive one**, because it does not look like timing at all: `Unable to find role="button" and name "Amoxicillin 500mg"` reads as a missing element and sends whoever hits it to the component, when the element was simply still on its way.
- **Measured with the machine deliberately loaded:** five failures at the old settings, none at these. Verified in both directions rather than assumed — the failure was reproduced first, then fixed.

This was a latent CI failure, not only a local annoyance: the browser-smoke job runs only if the frontend job passes, so a flake here silently skips the layer below it — the same shape as the skipped-not-passing smoke job recorded under 2026-08-27.

#### The audit trail joins the transaction it describes

`config/audit.js` ran as a Prisma middleware (`prisma.$use`). A middleware cannot see the transaction its caller is in, so its before/after reads and its `AuditLog` insert went out on the *global* client while the caller's transaction still held a pooled connection. Moved to a Prisma **client extension**, with `config/db.js` wrapping `$transaction` so the callback runs inside an `AsyncLocalStorage` holding the transaction client — an extension alone gets no handle on one either, so that wrapper is the half that actually closes this.

**Two defects, and the one that was never written down is the worse of them.**

- **A rolled-back write left an audit row behind**, because the insert committed on its own connection. A record of something that never happened is worse than no record. Confirmed against this database before the change: one surviving row per rolled-back transaction.
- **A concurrency ceiling.** Every audited write inside a transaction needed two connections at once, so N concurrent voids deadlocked once N passed half the pool. `tests/billing/invoice-void.test.js` had capped its own concurrency at four to stay underneath — a test written around a defect rather than against it — and its cap is now **12**.
- A third fell out with them: the `before` read could not see the transaction's own uncommitted writes, so a second edit to the same row in one transaction recorded the state from before the *first*.

**Measured by disabling only the `$transaction` wrapper and re-running:** twelve concurrent partial returns produced **zero** successes, every one dying on pool exhaustion and the 5s transaction timeout. With it, twelve of twelve pass in about 300 ms. Both new audit guards fail the same way, which is what makes them guards.

**One behaviour deliberately changed.** An audit insert that fails *inside* a transaction now propagates instead of being swallowed. The old swallow was right when the write had its own connection; inside a transaction the failed statement has already aborted it at the database, so swallowing would hide the cause and resurface it as an unrelated "current transaction is aborted" on the caller's next statement. Outside a transaction it is still swallowed and logged — a lost audit row is a gap in a record, a rejected write is a pharmacist who cannot work.

**Unchanged:** the array form `$transaction([...])` still writes its audit rows outside the transaction, because Prisma exposes no client for that form. It is used only for a few uncontended account writes. Also unchanged, and asserted: the audited model set, the exclusions, the `password`/`tokenVersion` stripping, and the unconditional auditing of bulk writes on master data that `3911ba6` restored after multi-tenancy silently broke it.

Backend suite: **634 tests across 24 files**, 91.8% statements.

### Security

#### The refresh route has an explicit CSRF guard, and the cross-site question is settled

`VITE_API_URL` **is** set in the Vercel project, so the built SPA calls the API host directly rather than through the `vercel.json` rewrite. The deployment really is cross-site, which makes the refresh cookie's `SameSite=None` **required** rather than the over-correction `README.md` had been flagging since 2026-08-29: with `Strict` the cookie is set once at login and never sent again, so every silent refresh fails and a 30-minute access token expires into a full logout.

`None` is what makes `POST /api/auth/refresh` — the only endpoint authenticated by a cookie rather than a Bearer token, and therefore the only one another site can drive — reachable cross-site. It now carries an `Origin` allowlist check, `requireKnownOrigin`.

- **This was not an open hole in the interim, and saying otherwise would overstate the fix.** `app.js` rejects an unlisted origin by calling the CORS origin callback with an `Error`, which `cors` turns into `next(err)`, so a cross-site request was already dying before the router saw it. What was wrong is that the protection was *incidental*: nothing named it, no test asserted it, and the documented way to stop it returning a `500` — `callback(null, false)` — passes the request through to the route and only withholds the response header. Somebody tidying a noisy 500 would have opened the hole with no reason to suspect it.
- **Mounted ahead of CORS**, so the guard is genuinely first and the answer is a `403` about the caller rather than a `500` about the server.
- **It does not clear the cookie when it refuses.** `refresh` clears on every denial, which is right when the credential is bad — but doing it here would hand an attacker the exact outcome the guard exists to prevent: signing a victim out by being refused. A test asserts the session survives a rejection.
- **A missing `Origin` is allowed through, deliberately.** No browser sends a cookie-bearing cross-site POST without one, so a request arriving without it had its cookie set by hand and whoever set it already held the credential. Refusing those would break curl and the test suite while blocking nothing.
- **An `Origin` check rather than the usual double-submit token**, because double-submit cannot work here: the SPA is on a different site from the API, so its script cannot read a cookie scoped to the API's host. Returning the token in the login body instead would put a session-renewing credential in `localStorage` — precisely what the `HttpOnly` refresh cookie exists to deny an XSS (threat T-13).
- The CORS allowlist moved to `config/origins.js` so the two consumers cannot drift apart, which is the defect `utils/trend.js` was written to close.

Five tests, and the backend suite is **631 across 24 files** — the 604 previously recorded dated from 2026-08-27.

### Added

#### The printed bill is a GST tax invoice (FR-BILL-20)

The print view was reworked to the layout an Indian pharmacy invoice actually uses: seller and buyer side by side, a **GST INVOICE** band carrying the number and date, then a line table of SN, product, PACK, HSN, batch, expiry, MRP, qty, rate, discount, GST %, net rate and amount, with the tax summary and totals below it, terms, the total in words and an authorised-signatory block.

- **It surfaced a live defect, and that is the part worth reading.** The till printed from the *create* response, which returned `items: true` — plain `InvoiceItem` rows with no batch relation — while the view read `item.batchNumber` and `item.unit`, which only the *detail* endpoint supplies. **Every receipt handed over the counter read "Batch: undefined"**, and a reprint of the same sale from history showed it correctly. That asymmetry is why it survived: the path anyone would check by hand was the working one. Both paths now share `PRINTABLE_ITEM_INCLUDE`, so they cannot drift again.
- **`amountInWords` is its own module**, not a helper in the view. It works in paise throughout, because rounding to rupees first drops a paisa often enough to contradict the figure printed beside it, and it groups in lakhs and crores rather than thousands.
- **Saving as PDF names the file after the invoice.** It produced `frontend.pdf` every time, because browsers take the filename from `document.title`. `printAs()` sets the title for the duration of the print and restores it on `afterprint` — no timer fallback, since restoring on a guess races the preview.
- **Roundoff and the distributor's 5+1 free-goods notation are deliberately absent.** Roundoff changes what the customer is charged and would break `subtotal + cgst + sgst − discountAmt = totalAmount`; free goods have no column to compute from.

#### Pack size, batch MRP and the shop's drug licence number (FR-MED-13, FR-BATCH-12, FR-SHOP-09)

Migration `20260831123451_add_pack_mrp_and_drug_licence` adds three nullable columns the printed invoice needs and had nowhere to read. All three are enterable from the medicine, batch and shop forms.

- **`Medicine.packSize`** — the PACK label off the carton (`1*10`, `1*15ML`). Free text, because it is a label rather than a quantity to compute with and every distributor writes it differently. Distinct from `unit`, which is the *dispensing* unit: a strip of ten tablets is unit `tablet`, packSize `1*10`.
- **`Batch.mrp`** — per batch, not per medicine, because the same product is repriced between print runs. **Nullable and never defaulted from `sellingPrice`**: printing the two as equal would assert on a tax document that no discount was given, so an unrecorded MRP prints as blank instead.
- **`Shop.drugLicenceNo`** — a retail pharmacy dispenses under a licence and is expected to show it on the bill. Nullable, so a shop that has not entered one can still trade.

### Fixed

#### Only one shop could trade — the multi-tenant migration half-applied

`20260828120000_add_shops_multi_tenant` re-keyed `Category.name`, `Manufacturer.name`, `Customer.phone` and `Invoice.invoiceNumber` from global to per-shop, and dropped the old keys with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`. Prisma writes `@unique` as a bare `CREATE UNIQUE INDEX`, so that statement matched nothing, and `IF EXISTS` made the miss silent. The migration reported applied with every global key still in place.

**Invoice serials restart at `-0001` per shop per day, so the second shop to sell on any given day could not sell at all** — `409 A record with this value already exists`, on a sale the customer had already paid for. The `P2002` retry in `createInvoice` was no help: every attempt re-derives the same per-shop serial. A new shop also could not create a category or manufacturer any other shop had named, and two shops could not hold a customer with the same phone number.

Found while investigating a report that the new monthly report showed no invoices. It showed none because the shop had none: its sales were being refused. Fixed by `20260830190000_drop_stale_global_unique_indexes`, using `DROP INDEX`. The guard asserts the behaviour rather than the index list, so it fails the same way if the keys return by another route.

### Added

#### Monthly and yearly reports (FR-RPT-10, FR-RPT-11)

`GET /api/reports/monthly?month=&year=` and `GET /api/reports/yearly?year=`, each with an `/export`, and two new tabs beside the daily report. A month broken into its days, a year into its months, with the same headline figures the daily summary has always printed.

- **The summary is now computed in one place for all three periods.** `summaryForPeriod` takes a date range and nothing else, so the day, the month and the year cannot disagree about what a period took. Copying it per period is exactly how the daily summary and the trend chart came to disagree about the same sale.
- **The breakdown sums to the headline, and there is a test that says so.** It deliberately does *not* reuse the trend aggregation, which filters to `paymentStatus = 'PAID'` because it charts takings rather than billings. Reusing it would have drawn bars falling short of the total printed above them by exactly the credit sales — two figures on one screen, each correct by its own definition, which is the defect `utils/trend.js` was written to close.
- **Zero-filled across the period**, so a day with no trade is a flat bar rather than a missing one. A gap shifts every later point left and reads as a trend rather than a closed shop.
- **The invoice register is paged from the server, not bundled into the report.** Both responses publish their `start`/`end` bounds, and the screen pages `GET /api/billing/invoices` through them — ten rows a request against an endpoint that is already capped, shop-scoped and tested. Measured on real data: 2,383 documents in the month and 20,204 in the year, with ten in the browser at a time. Bundling them into the report response would have been one line and a performance incident. The CSV still exports the breakdown, one row per bucket, because that is what the report is.
- **Open to every role.** This is the shop's own trading record, not its filing position; the GST return stays ADMIN and PHARMACIST only, and a test asserts the contrast.

Eleven tests, covering the day/month boundaries, the reconciliation with an unpaid invoice in the period, the zero-fill, both CSV shapes and the role split.

### Changed — BREAKING

#### The system holds many pharmacies, not one (2026-08-29)

Every row of shop-specific data now carries a `shopId`, and a shop's data is visible only to its own accounts. Until this landed, "multi-store" was listed in the roadmap as a **non-goal for 1.x**, with a note that it "would restructure every stock query." That estimate was accurate: `shopId` reaches ten tables and the `where` clause of every read and write across eleven controllers.

**`POST /api/auth/signup` is open registration now**, and this is the reversal worth reading twice. It shipped a day earlier as a one-shot bootstrap that sealed itself after the first account, and the entry below argues at length that a signup which worked twice "would be a data breach with a form in front of it" — because any authenticated role can read customer records, and pharmacy purchase history reveals health conditions (threat T-9). That argument was correct for a single-tenant system and has not been rebutted. It has been made inapplicable: a second signup no longer produces a second person inside *your* pharmacy, it produces an empty pharmacy of their own. `SECURITY.md` sets out what the boundary now rests on instead, and what open signup still costs.

- **`Shop`** holds the business details — name, address, phone, GST number — and every other shop-specific table foreign-keys to it. There is deliberately **no cross-shop relation anywhere in the schema**.
- **Categories and manufacturers became per-shop.** They were global lookup tables, which under tenancy is an isolation break rather than a saving: one shop renaming "Analgesic" would rename it for everyone, and the list itself discloses what other pharmacies stock. The cost is that each shop types "Tablet" into its own list once.
- **Invoice serials are per-shop**, so two pharmacies both start at `-0001`. `InvoiceCounter` is keyed on `(shopId, day)` and `Invoice` on `(shopId, invoiceNumber)`.
- **`shopId` is a JWT claim.** No endpoint accepts one in a body or query string, so there is nothing for a caller to target — the only shop a request can reach is the one its token names.
- **Scoped writes are `updateMany`/`deleteMany`, not `update`/`delete`.** Prisma's singular forms take only a unique selector, so `shopId` could not sit in the same `where` as `id`; it would have to be a separate check afterwards, which makes the boundary a property of control flow rather than of the query. A count of zero **is** the 404 — and 404 rather than 403 is deliberate, because a 403 confirms the row exists and turns a guessed id into a probe for another shop's catalogue.
- **`User.email` stays globally unique.** Login takes an email and a password with no shop selector, so a shared address would be ambiguous at the one lookup that matters. Somebody running two shops holds two accounts.
- **An admin-editable shop profile** (`GET`/`PUT /api/shop`, and a Shop tab in Settings) replaces the hardcoded placeholder in the printed invoice header. `GET` is open to every signed-in role, because printing a bill is a cashier's job and the contents are already on every invoice the shop hands out; `PUT` is ADMIN only and audited.
- **`GET /api/auth/setup-status` is gone.** It answered "does this installation still need its first account", which is no longer a question that has an answer.
- **The refresh cookie relaxed to `SameSite=None`** in production, paired with `Secure`, on the theory that a Vercel-hosted SPA calling a Render-hosted API is cross-site. **Confirmed necessary on 2026-08-31** and now guarded — see the entry below.

**What it cost, recorded rather than smoothed over.** Auditing broke for master data and stayed broken for a day: moving edits onto `updateMany` took them out of the audit middleware's single-record path, so category renames, supplier retirements and user deactivations wrote no audit row at all. Signup deadlocked the connection pool, because `Shop` and `User` are both audited and the audit write takes a second connection while the caller's transaction still holds the first — eight concurrent signups returned eight `500`s and created nothing, while the log kept five shop creations that had rolled back. Both are fixed. **The same hazard remains on the void path**, where `tx.batch.update` audits inside a transaction and five concurrent voids is the measured ceiling; `backend/tests/billing/invoice-void.test.js` documents the arithmetic and caps its own concurrency at four to stay under it.

### The 2026-08-27 audit

A full-surface audit on 2026-08-27 — code, tests, documentation and deployment — and the fixes for what it found. Three of the defects were the same shape: a date boundary drawn differently from the one drawn beside it.

### Fixed

- **A password change no longer signs out the device that made it.** `changePassword` bumped `tokenVersion` and reissued the *access* token, but not the refresh cookie — which still carried the old counter, so `POST /api/auth/refresh` correctly rejected it and the SPA cleared the session. The caller stayed signed in for one token lifetime and was then dropped to `/login`, up to 30 minutes later. Worst on the path nobody can skip: the seeded admin and every administrator-reset account are *forced* through that screen. Both halves of the session are now reissued, and the account's other refresh rows are revoked rather than merely out-versioned.
- **The GST report no longer drops the last millisecond of the month.** `endDate` was built without a milliseconds argument, closing the period at `23:59:59.000` while the next opens at `00:00:00.000`. A sale committed in that 999 ms window appeared in the daily summary and in **no GST return at all** — too late for its own month, too early for the next. Guarded now by a month-boundary test, and by one asserting consecutive months partition the timeline.
- **The expiring-stock report shows batches that expire today.** It filtered from `new Date()`, the current instant, while expiry dates are stored at midnight — so a batch expiring today was already behind the cursor. `createInvoice` sells such a batch all day (FR-BATCH-09), which meant the till traded stock the report built to flag it stayed silent about, along with the topbar notification that reads the same endpoint. Both now derive local midnight from one shared helper.
- **The day's first sale is numbered `-0001` again after a morning credit note.** The counter row was seeded from a `COUNT(*)` over every invoice for the day, credit notes included — though those allocate from their own `CRN` row. Voiding yesterday's sale before today's first opened the sale series at `-0002`, leaving a gap in a book of account.
- **A rejected password is reported once, not twice.** Zod 4 does not abort on a `superRefine` issue, so the field-level and object-level checks both reported the same problem and the Settings form rendered it twice.

### Fixed — tests and CI

- **CI is green again.** The four login-timing guards had been failing since bcryptjs 3.x began dual-publishing ESM and CommonJS: the test `import`ed one build while the controller `require`s the other, so `vi.spyOn` patched a module instance the controller never called. The control itself was never affected — measured at 386 / 386 / 380 ms across the three miss paths — but its guard measured nothing.
- **A timezone-fragile test no longer passes only in UTC.** `reports.test.js` built its `?date=` with `toISOString().slice(0, 10)` on a local-midnight instant, naming the previous day in every zone east of Greenwich. It was green on CI and red on any machine in IST.
- **Node 22 is declared** as `engines` in both manifests. Below it the frontend suite fails to start its workers with a jsdom error that says nothing about the cause.

### Fixed

- **Autofilled inputs keep the form's colours.** Chrome paints `input:-webkit-autofill` with its own pale background and dark text, and it overrides `background-color` from any class — so once the login fields gained `autoComplete` and the browser began filling them, two white boxes appeared on a dark card. Overridden with the inset `box-shadow` trick, which is the one thing that reaches it, plus `-webkit-text-fill-color` for the text. Scoped to the `bg-slate-700` inputs the app uses, so it covers every autofillable form — Settings, Customers, Suppliers — not just the login page.
- **The request log names the endpoint again.** Express rewrites `req.url` when it dispatches into a mounted router, and pino's message builders run on response finish — after the rewrite. So `/api/auth/setup-status` was logged as `GET /setup-status`, and a route at a router's own root as plain `GET /`: `GET / 401` was the entire record of a rejected request to `/api/medicines`. Unfindable by grep, and meaningless to read. The structured `req.url` field was correct throughout, which made it worse rather than better — one line carried two different paths for one request, and the half a person reads was the wrong one. Now built from `originalUrl`, so the query string survives too.

### Added

#### First-run signup (FR-AUTH-12)

`GET /api/auth/setup-status` and `POST /api/auth/signup`, plus a `/signup` page and a "Don't have an account?" link that appears on the login screen **only while the installation is unclaimed**.

Signup creates the first administrator and then closes permanently. It is deliberately not open registration: every authenticated role can read customer records, and purchase history in a pharmacy reveals health conditions (threat T-9), so a signup that worked twice would be a data breach with a form in front of it.

- **It replaces a published credential with a chosen one.** The seeded `admin@medstore.com` / `admin123` has been SECURITY.md's first known issue since the beginning; the mitigation was `mustChangePassword`, which lets that account do exactly one thing. This moves the fix earlier — on a fresh install there is no published credential at all. `npm run seed` stays for development.
- **The account it creates is always `ADMIN`**, because a shop with no administrator cannot create one. `role` is *rejected* rather than ignored — the schema is `.strict()`, so sending one is a `400`. Accepting and silently dropping it would read like a privilege-escalation hole.
- **`mustChangePassword` is not set**, unlike the seeded admin and unlike an administrator's reset. Both of those hand someone a credential they did not choose; this one they chose a request ago.
- **Concurrency is guarded by a Postgres advisory lock** inside the insert's transaction. `count() === 0` then `create()` is a read-then-write race of the same shape as G-01, and a burst would leave two administrators nobody chose. `LOCK TABLE` was tried first and is worse: a queued transaction holds its pooled connection, so eight concurrent signups jammed the pool and every one died on the transaction timeout — never creating a second admin, but answering `500` to all of them. `pg_try_advisory_xact_lock` returns false instead of waiting, so a loser costs one round trip and is told `SETUP_IN_PROGRESS`, which is retryable.
- **Verified against a real fresh install**, not only in tests: 16 migrations applied, `needsSetup: true`, a weak password refused with the specific rule, signup `201` with an ADMIN and a working refresh cookie, then `needsSetup: false`, a second attempt `409`, and exactly one row in `User`.

33 new tests — 23 backend including the eight-way concurrent burst, 10 frontend across both states of the page.

### Fixed — found by covering the dashboard

`dashboard.controller.js` sat at **21.73%** statements, the lowest in the codebase, while serving every panel on the screen the owner reads. Twenty-six tests took it to **97.37%** and turned up two defects on the way — which is the argument for writing them.

- **The trend chart filed early-morning sales under the previous day.** `Invoice.date` is a naked timestamp holding a UTC instant, so `date_trunc('day', …)` bucketed in UTC while the zero-fill loop built its keys from local components. East of Greenwich the two disagreed for the first hours of every day: measured in IST, a ₹777 sale at 02:00 was charted on yesterday's bar and today read ₹0 — while the daily summary, which draws its boundaries in JS, insisted the sale was today. Two screens, one sale, two different days, neither obviously wrong on its own. The query now converts to the store's zone before truncating, by IANA name so a DST zone stays correct across the transition.
- **The dashboard's expiry panel hid batches expiring today** — the third site of the boundary bug fixed in `batch.controller.js`, missed in that pass because the same rule was written out by hand in three places.

### Changed

- **The trend query lives in `utils/trend.js`.** `GET /api/reports/trend` and the dashboard held identical copies of the SQL under a comment saying the two "must agree" — true only while nobody edited one of them, and it meant fixing the timezone defect twice. They now call one function, and a test asserts the two endpoints return the same array.
- **Coverage gates on `dashboard.controller.js` (90%) and `utils/trend.js` (100%).** Not because the numbers are now high, but on the rule the existing two gates use: a regression there misreports takings.

### Fixed — the chain behind the red CI

Repairing the backend suite let the browser smoke job run instead of being skipped, and three defects were waiting behind it, each hiding the next. **The middle one broke the documented setup for every fresh clone.**

- **The development stack applies its migrations.** Neither `docker-compose.yml` nor `Dockerfile.dev` ran them, and the only `prisma migrate deploy` in CI belongs to the backend job against its own service container — so `docker compose up -d` followed by `npm run seed`, exactly as the README prints it, produced a database with **no schema** and an API that failed every request against tables that were never created. It worked only on machines whose `pgdata` volume predated the problem, which is why it lasted. The backend now runs `migrate deploy` before nodemon: it applies committed migrations, never generates or resets one, and is idempotent across restarts.
- **`npm run seed` exits non-zero when it fails.** `main().catch(console.error)` printed the error and exited 0, so CI's "Seed the bootstrap admin" step showed a green tick against an empty database and the real failure surfaced two steps later as a browser test that could not sign in. This is what hid the item above.
- **The browser smoke job installs before it starts the stack.** The frontend dev service bind-mounts `./frontend` and layers an anonymous volume at `/app/node_modules`; Docker creates that mountpoint inside the bind mount, on the host, as root, and `npm ci` then ran as an unprivileged user and died with `EACCES`.
- **Removed the duplicate CodeQL workflow.** `codeql.yml` was an unmodified template analysing the same two languages as the repository's default setup, and every run failed with "CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled". The default setup, which passes, is unaffected.

A job that is skipped reports nothing and reads much like one that passes. The smoke suite had been skipped, not passing, on every run since the backend suite went red.

### Changed

- `render.yaml` states `TRUST_PROXY` explicitly rather than relying on the default. If the platform's edge falls outside the trusted ranges, the rate limiter silently keys every request to one bucket and the per-client budget becomes a shop-wide one.
- `.env` and `.env.*` are excluded from both Docker build contexts. The backend never copied them; the frontend does `COPY . .`, and Vite inlines every `VITE_` value into the bundle at build time.

### Documentation

- Corrected the session description in four places — `SECURITY.md`, `docs/02`, `docs/README`, `docs/10` — which still described the pre-2026-08-22 token: *"7-day expiry, carrying only a user id"*. It is a 30-minute access token carrying `{ id, tokenVersion }`, with the week in a rotating `HttpOnly` cookie. SECURITY.md's own design table contradicted SECURITY.md sixty lines above it, and the glossary's `payload { id } only` denied the existence of the counter the whole revocation model rests on.
- `Prescription.patientName` in the schema claimed it was anonymised alongside the customer. It is not, deliberately — `erase-customer.js` argues the case from Rule 65(11) at length. The schema now records the limit rather than promising the opposite, since it is what a reader consults when deciding whether an erasure was complete.
- CONTRIBUTING said there was exactly one raw SQL statement; there are five. It now points at SECURITY.md's list rather than keeping a second count.
- `docs/02` no longer says there is no production image or multi-stage build — both Dockerfiles are two-stage production images — and no longer lists `generatePurchaseNumber()`, removed with the purchases table.

---

## [2.0.0] - 2026-08-24

The first release since 1.0.0. Versions 1.1.0 through 1.3.0 appear in the roadmap but were never tagged, so everything that accumulated on `main` since 1.0.0 is recorded here rather than back-dated into releases that did not ship.

The major bump is for one change: **the API is now grouped by resource**. Everything else below is additive or a fix.

### Changed — BREAKING

#### Routes are grouped by resource, not by module

Customers were reachable only at `/api/billing/customers`, medicines and suppliers only under `/api/inventory/`, and the five reports were filed under whichever table each one happened to read. It was the single most common source of client confusion, and every document under `docs/` carried a warning about it.

| Was                                            | Now                                 |
| ------------------------------------------------ | ------------------------------------- |
| `/api/billing/customers`                       | `/api/customers`                    |
| `/api/inventory/medicines`                     | `/api/medicines`                    |
| `/api/inventory/suppliers`                     | `/api/suppliers`                    |
| `/api/billing/invoices/daily-summary`          | `/api/reports/daily-summary`        |
| `/api/billing/invoices/gst-report`             | `/api/reports/gst`                  |
| `/api/billing/invoices/trend`                  | `/api/reports/trend`                |
| `/api/inventory/batches/expiring`              | `/api/reports/expiring`             |
| `/api/inventory/batches/low-stock`             | `/api/reports/low-stock`            |

Each report's `/export` moved with it. Report names drop the qualifier the path now supplies — `gst-report` under `/api/reports` was saying it twice.

**Every old path still works.** They are deprecated for one minor version and removed in **2.1.0**. Each responds with `Deprecation: true`, a `Sunset` date and `Link: <successor>; rel="successor-version"`, and logs a warning carrying the request id and the calling user — so 2.1.0 can be scheduled on evidence about who is still calling, rather than on a guess.

An alias and its successor run the **same controller function**, not a copy, so the two cannot answer differently; `backend/tests/api/route-layout.test.js` asserts that on the response body of all nine pairs.

**What did not move:** batches, categories and manufacturers stay under `/api/inventory` — they are stock-keeping concerns reached through the medicine they belong to. Invoices stay under `/api/billing`, because billing is what they are.

`customer.routes.js`, `medicine.routes.js`, `report.routes.js` and `supplier.routes.js` now exist. Four zero-byte placeholders with exactly those names were deleted in 2026-08 ([G-13](./docs/08-gap-analysis.md#g-13)) for implying routers that did not exist.

### Everything below shipped on `main` between 1.0.0 and this release

[SECURITY.md](./SECURITY.md) recommended deploying `main` in preference to 1.0.0 throughout that period — several of these are correctness and security fixes rather than features.

Each item links to its entry in [`docs/08-gap-analysis.md`](./docs/08-gap-analysis.md), where the diagnosis and the verification are recorded.

### Fixed

#### Correctness under concurrency

- **Invoice numbers no longer collide under concurrent checkout** (G-01). Serials came from counting the day's invoices and adding one, executed outside the inserting transaction — two simultaneous sales derived the same number and the second failed with a 409 after the customer had paid. Replaced with an atomic per-day `InvoiceCounter` upsert **inside** the invoice transaction, so concurrent transactions queue on one row and each receives a distinct value. A rolled-back sale returns its number rather than leaving a gap in a tax document. A retry-only fix was tried first and failed: a count-based allocation livelocks, because every retry re-reads the same count.
- **Stock can no longer go negative through concurrent sales** (G-09). The availability check ran before the transaction that deducted stock, so two sales of the last unit both passed and both committed. Deduction is now its own guard — a conditional `updateMany` inside the transaction that matches zero rows when another sale took the units, rolling the whole invoice back.
- **Added a database `CHECK (quantity >= 0)` on `Batch`.** The guarded decrement remains the mechanism; the constraint is a backstop for write paths that do not exist yet.

#### Money

- **All currency moved from `Float` to `DECIMAL(12,2)`** (G-07), with `Prisma.Decimal` arithmetic throughout and a JSON replacer keeping the wire format numeric. Float drift previously left invoice headers a paisa away from the sum of their own lines, so tax totals could not be reconciled. Every invoice now satisfies `subtotal + cgst + sgst − discountAmt = totalAmount` exactly.
- **The POS cart now rounds the way the server does** (G-17). The cart summed unrounded floats while the server rounds CGST and SGST separately and builds totals from the rounded halves — the two disagreed on roughly 40% of realistic inputs. The smallest case: ₹1.00 at 5% GST showed ₹1.05 in the cart and stored ₹1.06 on the invoice. Cart arithmetic now runs in integer paise, mirroring the server statement for statement.

#### Security and validation

- **Every mutating route validates its request body** with Zod (G-05, G-11). `PUT /batches/:id` previously accepted arbitrary fields; its schema is now deliberately narrow and **excludes `quantity`**, because rewriting stock silently bypasses every accounting path.
- **Every query string is now validated** (P1-10, threat T-10). `?limit=999999` was honoured on all three paginated endpoints, a garbage `month` produced an empty GST report indistinguishable from a quiet month, and `Number(x) || 30` turned a typo into a plausible-looking default window. `limit` is capped at 100; absent means use the default, present but unparseable is a 400.
- **Rate limiting is per-client, with a dedicated failed-login budget** (G-06). Behind the proxy every request appeared to come from one address, so the limiter was effectively global — one busy client could lock out the shop.
- **A database failure during authentication no longer reads as an invalid token** (G-18). `protect` caught token verification and the user reload together and answered 401 for both. Since the SPA clears its session on any 401, a few seconds of database trouble signed out every active user and told them their session was invalid.
- **`mfgDate` can be saved** (G-04). Both the column and the controller supported it, but it was missing from the validator, so Zod stripped it silently on every request for months.

#### Correctness of reported data

- **`totalStock` sums every batch** (G-10), rather than reporting the nearest-expiry batch's quantity as the whole stock level.
- **Foreign-key violations return 409, not 500** (G-12). Deleting a category, manufacturer or supplier still referenced by other records now explains itself.

#### Deployment

- **The nginx entry point works** (G-02). Its origin was missing from the CORS allowlist, so `http://localhost` served the app but every API call failed. Both entry points now serve the SPA and proxy `/api` on the **same origin**, so CORS no longer applies to the browser at all.

### Added

- **A backend test suite and CI** (G-14) — 368 tests across 14 files, Vitest and Supertest against a real PostgreSQL database, with a coverage gate on `billing.controller.js` and `auth.middleware.js`, the two files where a regression is a financial or security incident. GitHub Actions runs it on every push and pull request.
- **Frontend unit testing** — Vitest and Testing Library, currently covering the cart arithmetic against the same GST fixtures the backend asserts.

### Removed

- Four zero-byte route files (`customer`, `medicine`, `report`, `supplier`), an empty `frontend/nginx.conf`, and a stray literal `frontend/@/` directory left by a `shadcn add` run (G-13). The route files implied routers that never existed.

### Documentation

- Added [`docs/`](./docs/), a ten-document reference set written by reading the source rather than the previous READMEs, which described intent rather than behaviour. The four component READMEs are now short pointers into it.

---

## [1.0.0] - 2026-04-28

### Initial Release

The first production release of the Medical Billing System, a comprehensive full-stack application for managing medical inventories, billing, customer records, and suppliers.

### Added

#### Backend Features

- **Authentication & Authorization**
  - JWT-based user authentication system
  - Role-based access control middleware
  - Secure session management

- **Inventory Management**
  - Medicine catalog with manufacturing and expiry date tracking
  - Batch tracking and management
  - Category classification for medicines
  - Real-time inventory updates

- **Billing System**
  - Digital invoice generation and management
  - Automated billing calculations
  - Invoice utilities for document generation
  - Billing history and tracking

- **Customer Management**
  - Complete customer records and profiles
  - Customer history tracking
  - Customer data persistence

- **Supplier Management**
  - Supplier database and information management
  - Supplier contact and transaction tracking

- **User Management**
  - User account creation and management
  - User profile management
  - Role assignment and permissions

- **Reporting**
  - Sales and billing reports
  - Inventory reports
  - Transaction history reports

- **Database**
  - Prisma ORM integration with relational database
  - Database migrations system
  - Automated schema versioning

- **Caching**
  - Redis integration for performance optimization
  - Session caching

#### Frontend Features

- **Modern UI Components**
  - Responsive card, button, and input components
  - Dialog and sheet modals
  - Data table with sorting and filtering
  - Select dropdowns and form controls
  - Alert and notification systems
  - Badge and avatar components
  - Skeleton loaders for better UX

- **Core Pages & Features**
  - Dashboard with overview metrics and analytics
  - Inventory management interface
  - Billing and invoice management page
  - Customer management interface
  - Supplier management interface
  - Reports and analytics page
  - Settings configuration page
  - User authentication with login page

- **Authentication**
  - Login/logout functionality
  - Protected routes and role-based access control
  - JWT token management

- **State Management**
  - Zustand store for authentication state
  - Notification store for user feedback
  - Global state management

- **API Integration**
  - Centralized API client for backend communication
  - Request/response interceptors
  - Error handling utilities

- **Notifications**
  - Toast notifications via Sonner
  - Custom notification hooks
  - Real-time user feedback

- **Development Setup**
  - Vite for fast build and development
  - TypeScript for type safety
  - ESLint configuration for code quality
  - Responsive design with Tailwind CSS

### Technical Stack

#### Backend

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache**: Redis
- **Authentication**: JWT (JSON Web Tokens)
- **API**: RESTful API

#### Frontend

- **Framework**: React 18+ with TypeScript
- **Build Tool**: Vite
- **Styling**: CSS + Tailwind CSS (via shadcn/ui components)
- **State Management**: Zustand
- **HTTP Client**: Axios
- **UI Components**: Shadcn/ui component library

#### DevOps

- **Containerization**: Docker
- **Container Orchestration**: Docker Compose
- **Web Server**: Nginx

### Project Structure

```
medical-billing/
├── backend/           # Node.js/Express API server
├── frontend/          # React/TypeScript web application
├── nginx/             # Nginx configuration for reverse proxy
└── docker-compose.yml # Multi-container orchestration
```

### Getting Started

For detailed setup instructions, please refer to:

- [Backend README](backend/README.md)
- [Frontend README](frontend/README.md)
- [Architecture Documentation](Architecture.txt)

### Known Limitations

- Initial release - production usage should be monitored
- Consider implementing additional security measures for sensitive medical data
- Backup and disaster recovery procedures should be implemented before production deployment

---

[1.0.0]: https://github.com/adarsh0707-kumar/medical-billing/releases/tag/v1.0.0
