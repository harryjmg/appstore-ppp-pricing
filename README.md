# App Store pricing by purchasing power

A [Claude Code](https://claude.com/claude-code) skill and standalone CLI that adapts iOS
subscription prices to the real purchasing power of each country.

## The problem

Apple already converts your price across all 175 storefronts — but at the **exchange rate**.
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

**2. A conversion base signed by Apple.** Rather than juggling 40-odd currencies and their
rates, the tool asks Apple for the `equalization` of your reference price: the equivalent
price Apple itself would set in each territory, local taxes and psychological rounding
included. The index is applied on top of that.

**3. A real price point — one that reads like a price.** Apple only accepts about 800 values
per territory. A target of 38.83 has 38.99 sitting right next to it, but 39.99 is 3% away and
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

Then, in Claude Code: `/appstore-ppp-pricing`, or just "adjust my App Store prices to each
country's purchasing power". Claude walks you through the decisions that matter before
anything is written — in your own language.

### As a CLI

```bash
cd scripts
node ppp_pricing.js products                              # list your subscriptions
node ppp_pricing.js init --products=<id>,<id> --ref=USA   # build the config
node ppp_pricing.js init --products=<id> --ref=USA --no-marketing   # ... in strict PPP
node ppp_pricing.js plan                                  # dry run — writes nothing
node ppp_pricing.js apply                                 # write
```

## Requirements

- **Node.js.** No npm dependencies: the ES256 JWT is signed with the built-in `crypto`
  module.
- **An App Store Connect API key with the App Manager or Admin role**
  (App Store Connect → Users and Access → Integrations). A reporting key reads prices fine,
  then takes a 403 on write.

Create `scripts/asc_api_config.json`, with the `.p8` in the same folder:

```json
{
  "key_id": "XXXXXXXXXX",
  "issuer_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "key_file": "AuthKey_XXXXXXXXXX.p8",
  "app_id": "1234567890"
}
```

The bundled `.gitignore` keeps the key and config out of git. Check it before you push.

## The decisions that determine the outcome

The code is the easy part. [`SKILL.md`](SKILL.md) covers the seven trade-offs:

1. **Whether it's worth it for you.** If one country is 90% of your installs, this is the
   precondition for opening a market, not an immediate gain. Knowing that keeps you from
   judging it by the wrong metric.
2. **Which products to touch.** Prices attach to products, not to your app. Lowering only
   the main offer makes your retention offer more expensive than the one the user just
   declined.
3. **How low to go.** Where to set the floor, and how to calibrate it against a real
   comparable rather than theory.
4. **Calculated price or marketing price.** Whether to snap to familiar anchors, and how far
   you'll let that drift from the computed target.
5. **Whether to raise prices** where purchasing power exceeds your reference market. Most
   people don't dare.
6. **Your existing subscribers.** One API boolean protects them completely — no need to
   create new products, which is the common and costly reflex.
7. **Maintenance.** Once a price is set manually, Apple stops adjusting that territory.

## Three App Store Connect API gotchas

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

## Data sources

World Bank ([GNI per capita PPP](https://data.worldbank.org/indicator/NY.GNP.PCAP.PP.CD),
[income share of the top 10%](https://data.worldbank.org/indicator/SI.DST.10TH.10)), public
API, no key. Apple's own price equalizations for currency conversion.

## License

MIT. No warranty: run `plan` before `apply`, and read the table.
