---
name: appstore-ppp-pricing
description: Adjust App Store and Google Play subscription prices to each country's purchasing power. Needs one thing — the reference country — then discovers the products, indexes every territory on World Bank data, keeps both stores on the same price, and writes through each store's API. Use when someone wants regional pricing, PPP pricing, per-country prices, prices that differ between iOS and Android, or says their price is out of reach in some markets.
allowed-tools:
  - Bash(node ppp.js products:*)
  - Bash(node ppp.js run:*)
  - Bash(node ppp.js plan:*)
  - Bash(node ppp.js verify:*)
  - Bash(node ppp_pricing.js products:*)
  - Bash(node ppp_pricing.js init:*)
  - Bash(node ppp_pricing.js bounds:*)
  - Bash(node ppp_pricing.js plan:*)
  - Bash(node ppp_pricing.js verify:*)
  - Bash(node ppp_pricing.js run:*)
  - Bash(node play_pricing.js init:*)
  - Bash(node play_pricing.js products:*)
  - Bash(node play_pricing.js plan:*)
  - Bash(node play_pricing.js verify:*)
---

# Subscription pricing by purchasing power

**Speak the user's language.** This file is in English for maintenance; conduct the
conversation in whatever language the user writes to you in.

Both stores convert your price across ~175 storefronts — at the **exchange rate**. A
€49.99/year subscription therefore stays around €43 in Senegal or India, several times what
a digital subscription actually sells for there. This skill replaces that conversion with a
**purchasing-power multiplier**, country by country, on the App Store and Google Play at
once.

---

## Run it. Don't hold an interview.

The only thing you need from the user is **the reference country** — the market whose price
never moves, normally their main one. Everything else is discovered or defaulted:

```bash
cd scripts && node ppp.js run --ref=FRA
```

That builds the index from the World Bank, finds every approved product on both stores,
takes the reference PRICE from what the App Store already charges there, aligns Play onto
that same figure, and prints both tables. **It writes nothing.**

Then show the tables and ask what the tables raise — nothing else. On a real account the
decision that mattered was three eurozone neighbours landing 13% to 25% above the reference
country in the same currency, directly comparable by anyone who crosses a border. No
questionnaire surfaces that. Row 14 does.

Every default below is a decision with a right answer for almost everyone. Change one with
a flag **when the table tells you to**, and never before:

| Decision | Default | Flag |
|---|---|---|
| how low the index may go | 0.30 | `--floor=0.40` |
| how high | 1.30 | `--cap=1.20`, `--no-increases` |
| territories that never move | none | `--freeze=DEU,IRL` (`--freeze=none` clears) |
| marketing rounding (38.83 → 39.99) | on | `--no-marketing`, `--marketing-pull=8` |
| existing subscribers | untouched | see **Existing subscribers** |
| which products | every approved one | `--products=<id>,<id>` (App Store ids) |

`node ppp_pricing.js bounds --floor=0.40` replays any of them **offline**, in a second, no
network. Revise while reading the table; it costs nothing. **Never re-run `init` to change a
bound** — it rebuilds from the World Bank and silently drops hand-written territories.

Then write, once the user has said so:

```bash
cd scripts && node ppp.js apply
```

---

## The two things that will bite you

Both were found on a live account, and neither is in anyone's documentation.

### 1. The same number means different things in the two stores

`regionalConfigs[].price` on Play is what the **customer pays, tax included**. The price you
hand to `convertRegionPrices` is **tax exclusive**. Apple takes the tax-inclusive figure
directly. Type 49.99 into both and you ship €49.99 on iPhone and **€59.99 on Android** — a
20% gap nobody sees from their own phone, because nobody carries both.

`play_pricing.js` never asks for a tax rate: it **solves** for the pre-tax figure against
Google, and refuses to write if the reference region will not land exactly on the intended
price. Do not "simplify" that into a VAT constant.

### 2. An App Store price is a schedule, not a value

`GET /v1/subscriptions/{id}/prices` returns every record at once, and two attributes sort
them out:

- **`preserved: true`** — a **frozen cohort**: what existing subscribers keep, recorded with
  no `startDate`. **Never what a new buyer pays.** Read it as "the current price" and every
  increase you have ever shipped looks like it silently failed. It didn't.
- **`preserved: false`** — the **sale price**. Undated or past-dated, it is in force; the
  nearest future date replaces it.

So `verify` reports three states — `in force`, `written and waiting`, `still to write` — and
only the last is a problem. For the three days after a rollout the honest answer is "written,
waiting"; a tool that says "still to write" there sends you re-running a rollout you already
did. `plan` also skips anything already scheduled at the right price, so re-running during
the wait cannot stack duplicates.

---

## Is this worth it for them?

**Settle this first, with the numbers in view** — App Store Connect → Sales and Trends, or
the Play Console, country column, 30 days.

- **One country over 90% of installs** → PPP earns them nothing in the short term. It is not
  a revenue optimisation, it is the **precondition for opening a market**: the price has to
  be right *before* they spend on acquisition, or they test a market at an out-of-reach price
  and conclude it doesn't convert.
- **Meaningful international traffic already** → direct optimisation, visible in weeks.

Worth doing either way; not worth expecting the same thing from. Decide now what will be
measured, or they will judge it by the wrong number.

**Don't judge by trial conversion rate** afterwards — in a country with no prior volume it
stays noisy for weeks. Look at **revenue per install** per country against local acquisition
cost. A price cut in half where CPI is five times lower is still far more profitable.

---

## The floor is the one number worth arguing about

The raw calculation is correct and **unusable**: at a constant share of income, a €49.99
subscription is worth about €5 in Nigeria. Nobody prices there, for three reasons — owning an
iPhone already places someone high in the local distribution; below a point you invite VPN
arbitrage; and the real market sits above PPP.

**Calibrate against a real comparable before committing.** Check what Spotify charges in two
or three target countries (`spotify.com/<code>/premium/`). Well above it and they're out of
market; well below and they're leaving money behind. On one account, floor 0.40 put the
annual plan 21% above Spotify's local monthly anchor in West Africa — right for a niche
product. Go to 0.20 if marginal cost is nil and the goal is volume; 0.40 for a premium brand.

---

## Raising prices where purchasing power is higher

The maths is symmetrical, and **many developers apply only the decreases out of caution and
leave money on the table.** Make it an explicit decision, with two guardrails: above 1.0 the
binding constraint is no longer purchasing power but **what competitors charge there**, and
the 1.30 cap exists because beyond it you leave usual price points and invite comparison
between neighbouring markets.

One case the index cannot see: a territory whose purchasing power matches the reference but
whose **store conversion pays you less** — Apple's equalization of €49.99 into Canada returned
90% of the French net. The index said 1.005 and was right; the base was short. That is a
hand-written index (delete `damped`, set `index`, set `bound: 'manuel'`), and `bounds` leaves
it alone afterwards. Write the reason in the file — `init` would erase it.

---

## Existing subscribers

- **App Store** — `preserveCurrentPrice`, `true` by default here: existing subscribers stay
  put, increases and decreases alike. **Don't create new products for this**; it's the common
  reflex and it halves your per-product analytics. The one real trade-off: on *decreases*,
  `true` leaves existing subscribers paying more than new ones.
- **Play** — grandfathered **by default**. A change opens a new price cohort; `migratePrices`
  is the only way to move anyone, and this skill never calls it.

---

## Maintenance

Once a price is set manually, **the store stops adjusting that territory**. On volatile
currencies, net revenue erodes with nothing to raise the alarm. Re-run `init` then `plan`
once a quarter — `verify` exits non-zero while anything is off target, so a cron can fail on
it.

**And after every new product**: a product created for a price test starts on the store's
automatic conversion. Re-run, or regional pricing quietly vanishes from the paywall with no
signal at all. This is the single most common way a correctly-priced app goes wrong.

---

## How the index is computed

```
index = √( (GNI per capita PPP × income share of the top 10%) / same for the reference country )
```

World Bank, public API, no key. GNI per capita at PPP measures real purchasing power; the
top-decile share corrects for the fact that the buyer is not the average resident; the square
root damps what remains, since that population consumes largely imported goods at world
prices. Clamped between floor and cap.

**No exchange rate is ever handled.** The target starts from what the store itself would
charge in that territory — Apple's `equalizations`, Google's `convertRegionPrices`, taxes and
local rounding included — and the index is applied on top.

---

## Prerequisites

- **App Store** — an App Store Connect API key with **App Manager** or **Admin**. A reporting
  key reads prices fine, then takes a 403 on write. `scripts/asc_api_config.json` +
  the `.p8`.
- **Play** — a service account with the Play Developer API enabled and linked in the Play
  Console. `node play_pricing.js init`, then fill in `package` and `service_account`.

Either store alone works; `ppp.js` runs whichever is configured.

---

## API notes

Undocumented, already handled, worth knowing if you write your own:

- `SubscriptionPriceCreateRequest` has three attributes and all three matter: `planType`
  (without it, a product with several payment plans gets its price on the wrong one),
  `preserveCurrentPrice`, and `startDate` — **required, and at least three days out**. At
  `null`, Apple reads it as "initial price" and rejects any already-approved product; at
  tomorrow it answers 409 `ENTITY_ERROR.RELATIONSHIP.INVALID`, "Invalid startDate", which
  reads like a malformed date and is really a deadline.
- Apple's price index is **global**: the `p` field in a price point's base64 id doesn't depend
  on the subscription, so one territory grid serves every product.
- A product offering an annual plan **and** an annual-billed-monthly plan enforces consistency
  between the two: Apple rejects any write leaving it in an intermediate state
  (`INVALID_PRICE_TOO_HIGH` / `TOO_LOW`), in either order. They must be written together via
  `PATCH /v1/subscriptions/{id}`.
- Play's `subscriptions.patch` **replaces the whole `regionalConfigs` array**. Send only the
  regions you changed and you erase the rest. `regionsVersion` is required.
- Play needs one PATCH per product; Apple needs one POST per territory × plan type. The same
  grid is 4 requests on one store and 439 on the other, which is why one finishes instantly
  and the other takes minutes.
