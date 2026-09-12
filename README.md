# Subscription pricing by purchasing power

A [Claude Code](https://claude.com/claude-code) skill and standalone CLI that adapts
**App Store and Google Play** subscription prices to the real purchasing power of each
country — and keeps the two stores on the same price.

## The problem

Both stores convert your price across ~175 storefronts — but at the **exchange rate**.
A $39.99/year subscription therefore lands around $36 in Nigeria, India or the Philippines:
several times what a digital subscription actually sells for in those markets. Spotify
Premium is $3.29/month across West Africa while the US pays $11.99.

You never see it from your own country. Your campaigns in those markets convert badly, and
you conclude the market is worthless — when it's the price that's out of reach.

The reverse is true too: Switzerland, Singapore or the US can support a higher price than
many reference markets, and Apple's automatic conversion leaves that money on the table.

## How it works

Four steps, no exchange rate ever entered by hand.

**1. A purchasing-power index per country**, built from the World Bank's public API (free,
no key):

```
index = √( (GNI per capita PPP × income share of the top 10%) / same for the reference country )
```

- **GNI per capita at PPP** measures real purchasing power rather than exchange rates.
- **The top-decile share** corrects the central bias: your buyer is not the average
  resident. Owning an iPhone already places someone high in the local distribution.
- **The square root** damps what remains. That population consumes largely imported goods,
  priced at world rates.

Without those two corrections the raw figure is exact and commercially unusable — a constant
share of income puts a $39.99 subscription at roughly $5 in Nigeria.

**2. A conversion base signed by the store itself.** Rather than juggling 40-odd currencies
and their rates, the tool asks Apple for the `equalization` of your reference price — and
Google for its `convertRegionPrices` — the equivalent price each store would set in every
territory, local taxes and psychological rounding included. The index is applied on top.

**3. A real price point — one that reads like a price.** Apple only accepts about 800 values
per territory; Play accepts anything, so the tool builds the equivalent ladder itself and
scores it with the same function. A target of 38.83 has 38.99 sitting right next to it, but 39.99 is 3% away and
is an anchor every buyer has seen a thousand times. By default the tool snaps to the
strongest-reading point within tolerance rather than the strictly closest one — in both
directions, so 41.20 also lands on 39.99. `--no-marketing` keeps strict PPP,
`--marketing-pull=8` sets the tolerance.

**4. Writing, after simulation.** `plan` never writes anything and prints the full
before/after table. `apply` pushes the prices, retrying transient API errors.

Worked example, reference United States at $39.99/year — indices are real World Bank figures,
"Apple default" is Apple's own conversion, and marketing rounding is on:

| Territory | Apple default | PPP-adjusted | Index |
|---|---|---|---|
| United States (reference) | 39.99 USD | — | 1.00 |
| Germany | 44.99 EUR | **39.99 EUR** | 0.86 |
| United Kingdom | 39.99 GBP | **29.99 GBP** | 0.76 |
| Türkiye | 1999.99 TRY | **1499.99 TRY** | 0.75 |
| Japan | 6000 JPY | **3990 JPY** | 0.72 |
| Poland | 199.99 PLN | **129.99 PLN** | 0.66 |
| Brazil | 249.90 BRL | **139 BRL** | 0.57 |
| Mexico | 899 MXN | **499 MXN** | 0.55 |
| South Africa | 799.99 ZAR | **389.99 ZAR** | 0.49 |
| Indonesia | 699000 IDR | **299000 IDR** | 0.42 |
| Vietnam | 1199000 VND | **499000 VND** | 0.42 |
| Philippines | 2490 PHP | **999 PHP** | 0.41 |
| India | 3999 INR | **1199 INR** | 0.31 |
| Nigeria | 69900 NGN | **20900 NGN** | 0.30 (floor) |

## Install

### As a Claude Code skill

```bash
git clone https://github.com/harryjmg/appstore-ppp-pricing.git \
  ~/.claude/skills/appstore-ppp-pricing
```

Then, in Claude Code: `/appstore-ppp-pricing`, or just "adapt my prices to each country's
purchasing power". Claude asks for one thing — your reference country — then shows you both
stores' tables before anything is written, in your own language. The questions worth asking
are the ones the table raises; it doesn't hold an interview first.

### As a CLI

One reference country is the whole interface. Products, reference price and tax are all
discovered:

```bash
cd scripts
node ppp.js run --ref=FRA      # index + both stores, simulated. Writes nothing.
node ppp.js apply              # writes to both stores
node ppp.js verify             # reads the prices back
```

Each half also runs alone — `ppp_pricing.js` (App Store) and `play_pricing.js` (Play) — with
`products` / `plan` / `apply` / `verify`, plus `rollout --canary=<territory>` on the App Store
side to write one territory before the rest.

Revise a decision **offline**, without touching the network:

```bash
node ppp_pricing.js bounds --floor=0.40 --freeze=DEU
```

The unclamped index is stored at build time precisely so a bound can be replayed in a second,
and territories you write into the config by hand survive every replay. Each decision is a
flag: `--floor`, `--cap`, `--no-increases`, `--freeze=A,B`, `--no-marketing`,
`--marketing-pull`. Only `apply` and `rollout` write.

## Requirements

- **Node.js.** No npm dependencies: both JWTs are signed with the built-in `crypto` module.
- **App Store** — an App Store Connect API key with the **App Manager or Admin** role
  (Users and Access → Integrations). A reporting key reads prices fine, then takes a 403 on
  write. Create `scripts/asc_api_config.json`, `.p8` alongside:

```json
{
  "key_id": "XXXXXXXXXX",
  "issuer_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "key_file": "AuthKey_XXXXXXXXXX.p8",
  "app_id": "1234567890"
}
```

- **Play** — a service account with the Play Developer API enabled and linked in the Play
  Console. `node play_pricing.js init`, then fill in `package` and `service_account`.

Either store alone works. The bundled `.gitignore` keeps keys and configs out of git — check
it before you push.

## Two traps that cost real money

Both found on a live account, neither documented anywhere.

**The same number means different things in the two stores.** Play's
`regionalConfigs[].price` is what the customer pays, **tax included**; the price you hand to
`convertRegionPrices` is **tax exclusive**. Apple takes the tax-inclusive figure directly.
Type 49.99 into both and you ship €49.99 on iPhone and **€59.99 on Android** — a 20% gap
nobody sees from their own phone, because nobody carries both. So `play_pricing.js` never
asks for a tax rate: it solves for the pre-tax figure against Google, and refuses to write if
the reference region will not land exactly on the intended price.

**An App Store price is a schedule, not a value.** `/prices` returns every record at once.
`preserved: true` is a **frozen cohort** — what existing subscribers keep — and is never what
a new buyer pays; read it as the current price and every increase you ever shipped looks like
it silently failed. `preserved: false` is the sale price. `verify` therefore reports three
states, `in force` / `written and waiting` / `still to write`, and only the last is a problem.

## The decisions that determine the outcome

The code is the easy part, and the tool defaults every one of these sensibly — change one
when the table tells you to, not before. [`SKILL.md`](SKILL.md) covers them:

1. **Whether it's worth it for you.** If one country is 90% of your installs, this is the
   precondition for opening a market, not an immediate gain. Knowing that keeps you from
   judging it by the wrong metric.
2. **Which products to touch.** Prices attach to products, not to your app — so the tool
   prices every approved subscription by default. Lowering only the main offer makes your
   retention offer more expensive than the one the user just declined, and **a product
   created after a run starts on the store's automatic conversion**: re-run after every new
   one, or regional pricing quietly vanishes from your paywall with no signal at all.
3. **How low to go.** Where to set the floor, and how to calibrate it against a real
   comparable rather than theory.
4. **Calculated price or marketing price.** Whether to snap to familiar anchors, and how far
   you'll let that drift from the computed target.
5. **Whether to raise prices** where purchasing power exceeds your reference market. Most
   people don't dare.
6. **Your existing subscribers.** One API boolean protects them completely — no need to
   create new products, which is the common and costly reflex.
7. **Maintenance.** Once a price is set manually, the store stops adjusting that territory.

## Store API gotchas

Undocumented, already handled — useful if you write your own version.

- **`SubscriptionPriceCreateRequest` has three attributes and all three matter.** `planType`
  (without it, a product with several payment plans gets its price on the wrong one),
  `preserveCurrentPrice`, and `startDate` — required, and **at least three days out**: at
  `null` Apple reads it as "initial price" and rejects any approved product (`STATE_ERROR`);
  same day and tomorrow are both rejected with 409 `ENTITY_ERROR.RELATIONSHIP.INVALID`.
- **Apple's price index is global.** The `p` field in a price point's base64 ID doesn't
  depend on the subscription, so the ID can be forged for any product. One territory grid,
  loaded once, serves all your products — instead of 800 points × 175 territories × N
  products.
- **A product with two payment plans enforces consistency between them.** Annual upfront plus
  annual-billed-monthly: Apple rejects any write leaving the product in an intermediate state
  (`INVALID_PRICE_TOO_HIGH` / `TOO_LOW`), in either order. They have to be written together
  via `PATCH /v1/subscriptions/{id}` — and verify first, on a product you don't sell, that
  this PATCH adds prices rather than replacing the entire grid.
- **Play's `subscriptions.patch` replaces the whole `regionalConfigs` array.** Send only the
  regions you changed and you erase every other one. `regionsVersion` is required.
- **The two APIs are shaped opposite ways.** A price is a resource on the App Store (one POST
  per territory × plan type) and a field on Play (one PATCH per product). The same grid is
  4 requests on one store and 439 on the other — which is why one finishes instantly and the
  other takes minutes, and why only the App Store side can die half-written.

## Data sources

World Bank ([GNI per capita PPP](https://data.worldbank.org/indicator/NY.GNP.PCAP.PP.CD),
[income share of the top 10%](https://data.worldbank.org/indicator/SI.DST.10TH.10)), public
API, no key. Each store's own conversion for the currency base — Apple's `equalizations`,
Google's `convertRegionPrices`. No exchange rate is ever handled by this tool.

## License

MIT. No warranty: run `plan` before `apply`, and read the table.
