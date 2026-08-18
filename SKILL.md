---
name: appstore-ppp-pricing
description: Adjust App Store subscription prices to each country's purchasing power. Walks the user through the decisions that actually determine the outcome (how low to go, whether to raise prices, who gets affected), then writes the prices through the App Store Connect API. Use when someone wants regional pricing, PPP pricing, per-country prices, or says their price is out of reach in some markets.
---

# App Store pricing by purchasing power

**Speak the user's language.** This file is in English for maintenance; conduct the
conversation in whatever language the user writes to you in.

Apple already converts your price across all 175 storefronts — but at the **exchange rate**.
A $39.99/year subscription therefore stays around $36 in Nigeria or the Philippines, several
times what a digital subscription actually sells for there. This skill replaces that
conversion with a **purchasing-power multiplier**, country by country.

The tool is `scripts/ppp_pricing.js` (no npm dependencies). What follows are the
**decisions** — that's where the outcome is decided, not in the plumbing.

---

## Decision 0 — Is this worth it for them?

**Settle this first, with the numbers in view.** Pull their install split by country over
30 days (App Store Connect → Sales and Trends, or the API's SALES report, `Country Code`
column).

- If one country is more than 90% of installs, PPP pricing will earn them **nothing** in
  the short term. It isn't a revenue optimisation — it's the **precondition for opening a
  market**. The price has to be right before they spend anything on acquisition there,
  otherwise they'll test a market at an out-of-reach price and wrongly conclude it doesn't
  convert.
- If they already have meaningful international traffic, it's a direct optimisation and the
  effect shows within weeks.

Worth doing either way — but not worth expecting the same thing from. Decide now what will
be measured, or they'll judge it by the wrong number.

---

## Decision 1 — The reference territory

The country whose price never moves, and against which every other is indexed. Usually their
main market. Everything follows from it, including the increases.

Flag this if their main market is in the eurozone: neighbours share the currency and often
the ad language. A Belgian or Irish user can compare directly.

---

## Decision 2 — Which products

**The most common trap.** Prices attach to products, not to the app. Anyone who runs price
tests has a dozen products on file, of which two or three are actually served by the paywall.

- **Only touch products that are actually sold.** `node ppp_pricing.js products` lists them;
  cross-check against what the paywall really serves (RevenueCat / Adapty / Superwall
  offerings, or their StoreKit code).
- **Then do all of them, not just the main one.** If they have a retention offer, a winback
  offer or a discounted tier, and only the main offer is lowered, the secondary offers end up
  **more expensive** than the one the user just declined. That kind of inconsistency is
  invisible from their own country.
- **Write it down somewhere**: every new product created for a price test starts on Apple's
  automatic conversion. The script must be re-run after each one, or regional pricing quietly
  vanishes from the paywall with no signal at all.

---

## Decision 3 — How low to go (the floor)

The raw purchasing-power calculation gives numbers that are correct and **unusable**: at a
constant share of income, a $39.99 subscription is worth about $5 in Nigeria. Nobody prices
there, for three reasons:

1. their buyer is not the average resident — owning an iPhone already places someone high in
   the local distribution;
2. below a certain point they invite VPN arbitrage and damage their positioning;
3. the real market sits above PPP: Spotify charges around $3.29/month across West Africa,
   well above what average purchasing power would justify.

**The default floor is 0.30** (30% of the reference price). That's a choice, not a law. Go to
0.20 if marginal cost is nil and the goal is volume; raise it to 0.40 for a premium brand.

**Calibrate against a real comparable** before committing: check the local price of Spotify
or Netflix in two or three target countries (`spotify.com/<country code>/premium/`). Well
above it and they're out of market; well below and they're leaving money behind.

---

## Decision 4 — Calculated price, or marketing price

The index lands on a target, and the tool then picks the nearest available price point. On
a target of 38.83 that gives **38.99** — a fine number that nonetheless reads like the
output of a spreadsheet. **39.99** sits 3% away and is an anchor every buyer has seen a
thousand times.

Marketing rounding is **on by default** (`--no-marketing` to disable): within a tolerance,
the tool prefers the strongest-reading price point over the strictly closest one.

- **Leave it on** in most cases. The few percent of drift are well inside the margin of
  error of the index itself — which rests on national statistics and a damping exponent,
  not on a precise measurement of your buyers. Trading that for a price that reads properly
  is a good deal.
- **Turn it off** if you're deliberately positioning below a competitor's threshold, or if
  you plan to compare markets precisely and want the drift out of the way.
- **`--marketing-pull=8`** sets how far, in percent, snapping may drift. Raising it to 12
  catches more anchors and costs more precision; lowering it to 4 keeps things tight.

Note this pulls in both directions — it will round a target of 38.83 up to 39.99, and one
of 41.20 down to 39.99. It doesn't systematically raise prices.

---

## Decision 5 — Raising prices where purchasing power is higher

The maths is symmetrical: Switzerland, the US, Luxembourg, Ireland or Singapore come out
above most reference markets. **Many developers apply only the decreases, out of caution, and
leave money on the table.**

Make it an explicit decision. Two guardrails:

- **Local competition outranks the calculation.** Above 1.0 the binding constraint is no
  longer purchasing power but what competitors charge in that market. Check before applying
  +30% somewhere contested.
- **The default cap is 1.30.** Beyond that they leave usual psychological price points and
  invite comparison between neighbouring markets.

And above all: an increase touches **none** of their current subscribers — see decision 6.

---

## Decision 6 — Their current subscribers

The question everyone worries about, and it has a clean answer: the API's
`preserveCurrentPrice` attribute.

- **`true`** (the script's default) — existing subscribers stay on their current price, for
  increases and decreases alike. Only new purchases get the new price.
- **`false`** — a decrease reaches everyone at their next renewal; an increase requires each
  subscriber's explicit consent, and their subscription lapses if they don't respond.

**Don't create new products for this.** It's the common reflex and a costly one: one product
per offer, all to be re-wired into their paywall tool, and their per-product analytics get
cut in half. The boolean does the job.

The one real trade-off: on **decreases**, `true` leaves existing subscribers paying more than
new ones in the same country. Few people, but it's a refund-request and dispute magnet.
`false` on decreases only is defensible if they already have subscribers in those countries.

---

## Decision 7 — The maintenance rhythm

Once a price is set manually, **Apple stops adjusting that territory**. On volatile
currencies, net revenue erodes with nothing to raise the alarm.

Decide now: either re-run `init` then `plan` once a quarter (ten minutes), or restrict the
scope to territories with stable currencies or billed in dollars. Don't let them assume it's
a set-and-forget setting.

---

## How the index is computed

```
index = √( (GNI per capita PPP × income share of the top 10%) / same for the reference country )
```

World Bank data, public API, no key required. GNI per capita at PPP measures real purchasing
power; the top-decile share corrects for the fact that their buyer is not the average
resident; the square root damps what remains, since that population consumes largely imported
goods at world prices. The result is then clamped between floor and cap.

The target price is never converted by hand: the tool starts from what Apple would set on its
own in that territory (its `equalization` of the reference price, local taxes and rounding
included) and applies the index to it. No exchange rate is ever handled.

---

## Procedure

```bash
node ppp_pricing.js products                              # 1. list subscriptions
node ppp_pricing.js init --products=<id>,<id> --ref=USA   # 2. build the config
                                                          #    (+ --no-marketing for strict PPP)
node ppp_pricing.js plan                                  # 3. simulate — READ the table
node ppp_pricing.js apply --territory=<one test country>  # 4. one canary territory
node ppp_pricing.js apply                                 # 5. roll out
```

Read the step-3 table line by line before applying — it's the only moment an index mistake is
visible. Then write **one** low-stakes territory, read the price back from the API, and only
then roll out.

Prerequisite: an App Store Connect API key with the **App Manager** or **Admin** role (Users
and Access → Integrations). A reporting key is not enough — it reads prices fine, then takes
a 403 on write.

---

## Afterwards

Prices take effect the next day, not immediately.

Don't judge by trial conversion rate: in a country with no prior volume it stays noisy for
weeks. Look at **revenue per install** per country, against local acquisition cost. A price
cut in half in a market where CPI is five times lower is still far more profitable — that's
the whole point of the exercise.

---

## API notes

Three things Apple doesn't document, already handled by the script, worth knowing for anyone
writing their own:

- `SubscriptionPriceCreateRequest` has three attributes and all three matter: `planType`
  (without it, a product with several payment plans gets its price on the wrong one),
  `preserveCurrentPrice`, and `startDate` — **required, and at least three days out**. At
  `null`, Apple reads it as "initial price" and rejects any already-approved product; at
  tomorrow it answers 409 `ENTITY_ERROR.RELATIONSHIP.INVALID`, "Invalid startDate", which
  reads like a malformed date and is really a deadline. Three days is verified to work.
- Apple's price index is **global**: the `p` field in a price point's base64 ID doesn't
  depend on the subscription, so an ID can be forged for any product. One territory grid,
  loaded once, serves every product.
- A product offering both an annual plan **and** an annual-billed-monthly plan enforces
  consistency between the two: Apple rejects any write that would leave it in an intermediate
  state (`INVALID_PRICE_TOO_HIGH` / `TOO_LOW`), in either order. They must be written together
  via `PATCH /v1/subscriptions/{id}` — and check first, on a product that isn't sold, that
  this PATCH adds prices rather than replacing the whole grid.
