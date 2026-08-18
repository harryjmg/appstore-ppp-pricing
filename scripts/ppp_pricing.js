#!/usr/bin/env node
/**
 * App Store subscription prices indexed on local purchasing power.
 *
 *   node ppp_pricing.js products          list the account's subscriptions
 *   node ppp_pricing.js init              build ppp_config.json (World Bank indices)
 *   node ppp_pricing.js plan              dry run: what would change, writing nothing
 *   node ppp_pricing.js apply             write the prices
 *
 * No npm dependencies: the ES256 JWT is signed with Node's built-in crypto module.
 *
 * Requires an App Store Connect API key with the App Manager or Admin role, and an
 * asc_api_config.json sitting next to this script:
 *
 *   { "key_id": "XXXXXXXXXX",
 *     "issuer_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
 *     "key_file": "AuthKey_XXXXXXXXXX.p8",
 *     "app_id": "1234567890" }
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ASC_CONFIG = path.join(HERE, 'asc_api_config.json');
const PPP_CONFIG = path.join(HERE, 'ppp_config.json');
const CACHE = path.join(HERE, '.ppp_grid_cache.json');
const HOST = 'api.appstoreconnect.apple.com';

const args = process.argv.slice(3);
const command = process.argv[2];
const opt = (n, def = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : def; };

// ────────────────────────────────────────────── ES256 JWT, no dependencies

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Node's ECDSA signature comes out DER-encoded; JOSE wants r||s, 32 bytes each. */
function derToJose(der) {
    let i = 2;
    if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
    const readInt = () => {
        if (der[i++] !== 0x02) throw new Error('unexpected DER signature');
        const len = der[i++];
        let v = der.subarray(i, i + len); i += len;
        while (v.length > 32 && v[0] === 0) v = v.subarray(1);
        return Buffer.concat([Buffer.alloc(32 - v.length, 0), v]);
    };
    return Buffer.concat([readInt(), readInt()]);
}

function token() {
    if (!fs.existsSync(ASC_CONFIG)) {
        console.error(`❌ ${path.basename(ASC_CONFIG)} is missing. See the header of this script.`);
        process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(ASC_CONFIG, 'utf8'));
    const key = fs.readFileSync(path.join(HERE, cfg.key_file), 'utf8');
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.key_id, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iss: cfg.issuer_id, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
    const signer = crypto.createSign('SHA256');
    signer.update(`${header}.${payload}`);
    return { jwt: `${header}.${payload}.${b64url(derToJose(signer.sign(key)))}`, cfg };
}

// ──────────────────────────────────────────────────────────────── transport

function rawCall(method, apiPath, jwt, body = null) {
    return new Promise((res, rej) => {
        const p = body ? JSON.stringify(body) : null;
        const h = { Authorization: 'Bearer ' + jwt };
        if (p) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(p); }
        const r = https.request({ hostname: HOST, path: apiPath, method, headers: h }, x => {
            let d = ''; x.on('data', c => d += c);
            x.on('end', () => { try { res({ s: x.statusCode, d: JSON.parse(d) }); } catch (e) { res({ s: x.statusCode, d }); } });
        });
        r.on('error', rej); if (p) r.write(p); r.end();
    });
}

/**
 * The API returns occasional transient 500s, and 429s if pushed too fast. Without a retry,
 * a run of several hundred writes dies on a network hiccup. Only transient statuses are
 * retried — a business 4xx must surface as-is.
 */
async function call(method, apiPath, jwt, body = null, attempts = 3) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const r = await rawCall(method, apiPath, jwt, body);
            if (![429, 500, 502, 503, 504].includes(r.s)) return r;
            last = r;
        } catch (e) {
            last = { s: 0, d: { error: e.message } };
        }
        if (i < attempts - 1) await new Promise(s => setTimeout(s, 1500 * (i + 1)));
    }
    return last;
}

async function getAll(apiPath, jwt, stop = null) {
    let data = [], included = [], next = apiPath, pages = 0;
    while (next && pages < 20) {
        const r = await call('GET', next, jwt);
        if (r.s !== 200) {
            if (pages === 0) throw new Error(`GET ${apiPath} → ${r.s} ${JSON.stringify(r.d).slice(0, 200)}`);
            break;
        }
        pages++;
        data = data.concat(r.d.data || []);
        included = included.concat(r.d.included || []);
        if (stop && stop(data)) break;
        next = r.d.links && r.d.links.next ? r.d.links.next.replace('https://' + HOST, '') : null;
    }
    return { data, included };
}

const decode = id => JSON.parse(Buffer.from(id, 'base64').toString());
/** Apple's price index is global: a price point ID can be forged for any product. */
const forge = (sub, terr, p) => Buffer.from(JSON.stringify({ s: String(sub), t: terr, p: String(p) })).toString('base64').replace(/=+$/, '');

/**
 * The World Bank hands out an HTML error page under load, and https.get follows no
 * redirect and checks no status code. All of it used to surface as "unreadable response",
 * with no URL and no body — which sends you looking in the wrong place entirely.
 * Retry the transient failures, and when the last attempt gives up, say what came back.
 */
const fetchJson = (url, tries = 3) => new Promise((res, rej) => {
    const retry = (left, e) => {
        if (left <= 1) return rej(e);
        setTimeout(() => attempt(left - 1, url, 3), 1500 * (tries - left + 1));
    };
    const attempt = (left, target, hops) => {
        https.get(target, { headers: { 'user-agent': 'appstore-ppp-pricing', accept: 'application/json' } }, r => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops > 0) {
                r.resume();
                return attempt(left, new URL(r.headers.location, target).toString(), hops - 1);
            }
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`HTTP ${r.statusCode}`);
                    res(JSON.parse(d.replace(/^\uFEFF/, '')));   // the API sometimes leads with a BOM
                } catch (e) {
                    retry(left, new Error(`${target.slice(0, 100)}… → ${e.message}; body: ${JSON.stringify(d.slice(0, 200))}`));
                }
            });
        }).on('error', e => retry(left, e));
    };
    attempt(tries, url, 3);
});

// ───────────────────────────────────────────────────────────────── commands

async function cmdProducts() {
    const { jwt, cfg } = token();
    const groups = await getAll(`/v1/apps/${cfg.app_id}/subscriptionGroups?limit=50`, jwt);
    for (const g of groups.data) {
        console.log(`\nGroup ${g.id} — ${g.attributes.referenceName}`);
        const subs = await getAll(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=200`, jwt);
        for (const s of subs.data) {
            console.log(`  ${s.id}  ${(s.attributes.productId || '').padEnd(28)} ${s.attributes.subscriptionPeriod || ''}  ${s.attributes.state}`);
        }
    }
    console.log('\nKeep only the products your paywall actually sells.');
    console.log('Then: node ppp_pricing.js init --products=<id>,<id> --ref=USA');
}

async function cmdInit() {
    const { jwt } = token();
    const products = (opt('products') || '').split(',').filter(Boolean);
    const ref = opt('ref', 'USA');
    if (!products.length) { console.error('❌ --products=<ascId>,<ascId> is required (see: node ppp_pricing.js products)'); process.exit(1); }

    const asked = opt('territories');
    const territories = asked && asked !== 'all'
        ? asked.split(',')
        : (await getAll('/v1/territories?limit=200', jwt)).data.map(t => t.id);

    const countries = [...new Set([ref, ...territories])];

    // The World Bank rejects the entire request when a single code is unknown to it, and
    // Apple sells in territories it doesn't track (Kosovo, Anguilla, the Vatican…). One bad
    // code out of 175 therefore looked exactly like "no data for your reference country".
    // Ask for its own country list first, and only ever query the intersection — the
    // untracked territories fall through to the existing "skipped" count, untouched.
    const known = new Set((((await fetchJson('https://api.worldbank.org/v2/country?format=json&per_page=400'))[1]) || []).map(c => c.id));
    const queryable = countries.filter(c => known.has(c));
    console.log(`World Bank — ${queryable.length} of ${countries.length} territories tracked…`);
    if (!known.has(ref)) { console.error(`❌ the World Bank has no country ${ref} — check the ISO-3 code of your reference territory`); process.exit(1); }

    const indicator = async (code, mrv) => {
        const o = {};
        for (let i = 0; i < queryable.length; i += 60) {   // keep the URL to a sane length
            const batch = queryable.slice(i, i + 60).join('%3B');
            const r = await fetchJson(`https://api.worldbank.org/v2/country/${batch}/indicator/${code}?format=json&mrv=${mrv}&per_page=2000`);
            for (const x of (r[1] || [])) {
                if (x.value == null) continue;
                const c = x.countryiso3code;
                if (!o[c] || x.date > o[c].year) o[c] = { v: x.value, year: x.date, name: x.country.value };
            }
        }
        return o;
    };
    const gni = await indicator('NY.GNP.PCAP.PP.CD', 3);   // GNI per capita, PPP
    const decile = await indicator('SI.DST.10TH.10', 10);  // income share of the top 10%

    if (!gni[ref]) { console.error(`❌ no World Bank data for reference territory ${ref}`); process.exit(1); }
    const fallback = g => (g > 40000 ? 26 : g > 15000 ? 31 : 33);
    const refShare = decile[ref] ? decile[ref].v : fallback(gni[ref].v);
    const baseline = gni[ref].v * refShare;

    const floor = parseFloat(opt('floor', '0.30'));
    const cap = parseFloat(opt('cap', '1.30'));
    const marketing = !args.includes('--no-marketing');

    const out = {};
    let skipped = 0;
    for (const t of territories) {
        if (t === ref) continue;
        if (!gni[t]) { skipped++; continue; }
        const share = decile[t] ? decile[t].v : fallback(gni[t].v);
        const damped = Math.sqrt((gni[t].v * share) / baseline);
        out[t] = {
            index: Number(Math.min(cap, Math.max(floor, damped)).toFixed(3)),
            damped: Number(damped.toFixed(4)),   // unclamped: lets `bounds` replay offline
            gni_ppp: gni[t].v, top_decile_share: share,
            decile_source: decile[t] ? String(decile[t].year) : 'fallback',
            bound: damped < floor ? 'floor' : damped > cap ? 'cap' : null,
        };
    }

    const cfg = {
        reference: { territory: ref },
        bounds: { floor, cap, change_threshold_pct: 5, price_point_window_pct: 8 },
        preserve_current_price: true,
        marketing_rounding: { enabled: marketing, pull_pct: parseFloat(opt('marketing-pull', '8')) },
        effective_date: null,
        plan_types: ['UPFRONT', 'MONTHLY'],
        frozen: [],
        subscriptions: products.map(id => ({ asc_id: id })),
        territories: out,
    };
    fs.writeFileSync(PPP_CONFIG, JSON.stringify(cfg, null, 2));
    console.log(`✅ ppp_config.json — ${Object.keys(out).length} territories indexed, ${skipped} without data (left untouched).`);
    console.log('   Review the indices, then: node ppp_pricing.js plan');
}

/**
 * How strong a price point reads on a paywall, 0 being strongest.
 *
 * Tier 0 is the familiar anchor — 9.99, 19.99, 39.99, or ₦20,900 — the shape people have
 * seen a thousand times. Tier 1 is a .99 that isn't an anchor (38.99): tidy, but visibly
 * the output of a calculation. Then the softer endings, then everything else.
 */
function priceTier(price) {
    // Currencies without decimals (JPY, IDR, NGN, VND…): trailing zeros are just scale,
    // so strip them before judging. 299,000 reads as "299" and anchors like 2.99 does;
    // 295,000 doesn't. Apple's own local grids also lean on the X900 / X990 shapes.
    if (Number.isInteger(price) && price >= 100) {
        const raw = String(price);
        const trimmed = raw.replace(/0+$/, '');
        if (/99$/.test(trimmed) || /(900|990)$/.test(raw)) return 0;
        if (/9$/.test(trimmed)) return 1;
        if (/5$/.test(trimmed) || /(00|50)$/.test(raw)) return 2;
        return 3;
    }
    const whole = Math.floor(price);
    const cents = Math.round((price - whole) * 100);
    if (cents === 99) return whole % 10 === 9 ? 0 : 1;   // 39.99 anchors harder than 38.99
    if (cents === 90 || cents === 95 || cents === 49 || cents === 50) return 2;
    if (cents === 0) return whole % 10 === 0 ? 2 : 3;
    return 3;
}

/**
 * Pick the price point to write.
 *
 * With marketing rounding on, any point within `pull_pct` of the target is fair game and
 * the strongest tier wins — so a target of 38.83 lands on 39.99 rather than 38.99. The
 * few percent of drift are well inside the noise of the index itself, and the price reads
 * like a price instead of like a conversion.
 *
 * With it off, the closest point wins, with only a light preference for tidy endings.
 */
function pickPricePoint(grid, target, cfg) {
    const mk = cfg.marketing_rounding || {};
    if (mk.enabled) {
        const pull = (mk.pull_pct != null ? mk.pull_pct : 8) / 100;
        let best = null;
        for (const p of grid) {
            const gap = Math.abs(p.px - target) / target;
            if (gap > pull) continue;
            const tier = priceTier(p.px);
            if (!best || tier < best.tier || (tier === best.tier && gap < best.gap)) best = { p, tier, gap };
        }
        if (best) return best.p;   // sinon : rien d'assez proche, on retombe sur le plus proche
    }
    let pick = null, best = Infinity;
    for (const p of grid) {
        const gap = Math.abs(p.px - target) / target;
        const penalty = gap <= (cfg.bounds.price_point_window_pct / 100) ? priceTier(p.px) * 0.006 : 0;
        const score = gap + penalty;
        if (score < best) { best = score; pick = p; }
    }
    return pick;
}

async function buildPlan(jwt, cfg, restrict = null) {
    const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
    const ref = cfg.reference.territory;
    const only = restrict || (opt('territory') ? opt('territory').split(',') : null);
    const rows = [];
    const unpriced = new Set();

    for (const sub of cfg.subscriptions) {
        if (sub.skip) { console.log(`⏭️  ${sub.asc_id} skipped — ${sub.skip}`); continue; }

        const { data, included } = await getAll(
            `/v1/subscriptions/${sub.asc_id}/prices?limit=200&include=subscriptionPricePoint,territory`, jwt);
        const points = {};
        for (const i of included) if (i.type === 'subscriptionPricePoints') points[i.id] = i.attributes;
        const current = {};
        for (const p of data) {
            const t = p.relationships.territory.data.id;
            const pp = points[p.relationships.subscriptionPricePoint.data.id] || {};
            (current[t] = current[t] || {})[p.attributes.planType] = {
                price: parseFloat(pp.customerPrice),
                pricePointId: p.relationships.subscriptionPricePoint.data.id,
            };
        }
        if (!current[ref]) throw new Error(`${sub.asc_id}: no price on reference territory ${ref}`);

        for (const planType of cfg.plan_types) {
            const refPrice = current[ref][planType];
            if (!refPrice) continue;

            // Apple's own equalization of the reference price: what it would charge in each
            // territory, taxes and local rounding included. No exchange rate to handle.
            const eq = await getAll(`/v1/subscriptionPricePoints/${refPrice.pricePointId}/equalizations?limit=200`, jwt);
            const base = {};
            for (const e of eq.data) base[decode(e.id).t] = parseFloat(e.attributes.customerPrice);

            for (const [terr, conf] of Object.entries(cfg.territories)) {
                // Apple returns no equalization for a territory it cannot sell this product
                // in. Silently skipping it is how you end up believing a country is covered.
                if (base[terr] == null) { unpriced.add(terr); continue; }
                if (only && !only.includes(terr)) continue;
                const target = base[terr] * conf.index;

                let grid = cache[terr] && cache[terr].max >= target * 1.2 ? cache[terr].points : null;
                if (!grid) {
                    const g = await getAll(
                        `/v1/subscriptions/${sub.asc_id}/pricePoints?filter[territory]=${terr}&limit=200`, jwt,
                        acc => acc.length && parseFloat(acc[acc.length - 1].attributes.customerPrice) > target * 1.2);
                    grid = g.data.map(p => ({ p: decode(p.id).p, px: parseFloat(p.attributes.customerPrice) }));
                    cache[terr] = { points: grid, max: grid.length ? grid[grid.length - 1].px : 0 };
                }
                if (!grid.length) continue;

                const pick = pickPricePoint(grid, target, cfg);

                const now = (current[terr] || {})[planType];
                const delta = now ? (pick.px - now.price) / now.price * 100 : null;
                rows.push({
                    subId: sub.asc_id, planType, territory: terr, index: conf.index, bound: conf.bound,
                    currentPrice: now ? now.price : null, newPrice: pick.px, target, delta,
                    pricePointId: forge(sub.asc_id, terr, pick.p),
                    change: delta != null && Math.abs(delta) >= cfg.bounds.change_threshold_pct,
                });
            }
        }
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    return { rows, unpriced: [...unpriced] };
}

async function cmdPlan(write, restrict = null) {
    const cfg = readCfg();
    const { jwt } = token();

    console.log(write ? '🔴 WRITING' : '🔵 Dry run — nothing will be written');
    console.log(`   reference ${cfg.reference.territory} · existing subscribers: ${cfg.preserve_current_price ? 'price preserved' : '⚠️ NOT preserved'}\n`);

    const { rows, unpriced } = await buildPlan(jwt, cfg, restrict);
    const todo = rows.filter(r => r.change).sort((a, b) => b.delta - a.delta);

    for (const r of todo) {
        const d = (r.delta > 0 ? '+' : '') + Math.round(r.delta) + '%';
        console.log(`   ${r.territory.padEnd(5)} ${r.planType.toLowerCase().padEnd(8)} ${String(r.currentPrice).padStart(10)} → ${String(r.newPrice).padStart(10)} ${d.padStart(7)}   ×${r.index}${r.bound ? ' (' + r.bound + ')' : ''}`);
    }
    console.log(`\n${todo.length} price(s) to write · ${todo.filter(r => r.delta > 0).length} increase(s) · ${todo.filter(r => r.delta < 0).length} decrease(s)`);
    if (unpriced.length) {
        console.log(`\n⚠️  ${unpriced.length} territory(ies) in your config have no Apple price equalization`);
        console.log(`   and can never be written — Apple doesn't sell this product there: ${unpriced.join(', ')}`);
    }

    if (!write) { console.log('\nNothing was changed. Re-run with "apply" once the plan looks right.'); return; }

    // Three attributes, and all three matter — see SKILL.md.
    // "At least one day in the future" is what the error message implies, and it is wrong:
    // tomorrow is rejected with 409 ENTITY_ERROR.RELATIONSHIP.INVALID, "Invalid startDate".
    // Three days out is accepted. The old default therefore failed every single write.
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const startDate = cfg.effective_date || soon;
    let ok = 0, failed = 0;
    for (const r of todo) {
        const res = await call('POST', '/v1/subscriptionPrices', jwt, {
            data: {
                type: 'subscriptionPrices',
                attributes: { planType: r.planType, startDate, preserveCurrentPrice: cfg.preserve_current_price },
                relationships: {
                    subscription: { data: { type: 'subscriptions', id: r.subId } },
                    subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: r.pricePointId } },
                },
            },
        });
        if (res.s === 200 || res.s === 201) { ok++; process.stdout.write('.'); }
        else {
            failed++;
            console.log(`\n❌ ${r.subId} ${r.territory} ${r.planType} → ${res.s} ${JSON.stringify(res.d).slice(0, 600)}`);
            if (res.s === 403) { console.error('\nThis key cannot write prices: App Manager or Admin role required.'); break; }
        }
        await new Promise(s => setTimeout(s, 250));
    }
    console.log(`\n\n✅ ${ok} written${failed ? ` · ❌ ${failed} failed` : ''} — effective ${startDate}`);
}

function readCfg() {
    if (!fs.existsSync(PPP_CONFIG)) { console.error('❌ ppp_config.json is missing. Run: node ppp_pricing.js init'); process.exit(1); }
    return JSON.parse(fs.readFileSync(PPP_CONFIG, 'utf8'));
}

/**
 * Re-clamp every index from the unclamped value stored at init.
 *
 * A floor, a cap and a freeze are decisions, not measurements. Replaying one shouldn't
 * mean asking the World Bank again — and above all shouldn't drop the territories someone
 * added by hand, which is precisely what re-running `init` does.
 */
function reindex(cfg) {
    const { floor, cap } = cfg.bounds;
    const frozen = new Set(cfg.frozen || []);
    let manual = 0;
    for (const [t, v] of Object.entries(cfg.territories)) {
        if (frozen.has(t)) { v.index = 1; v.bound = 'frozen'; continue; }
        if (v.damped == null) { manual++; continue; }   // hand-written: left exactly as found
        v.index = Number(Math.min(cap, Math.max(floor, v.damped)).toFixed(3));
        v.bound = v.damped < floor ? 'floor' : v.damped > cap ? 'cap' : null;
    }
    return { manual, frozen: frozen.size };
}

/**
 * Move the bounds without touching the network. The decisions that actually shape the
 * outcome — how low, how high, which territories never move — are the ones you revise
 * three times while reading the table, so they must cost a second, not a re-index.
 */
function cmdBounds() {
    const cfg = readCfg();
    if (opt('floor') != null) cfg.bounds.floor = parseFloat(opt('floor'));
    if (opt('cap') != null) cfg.bounds.cap = parseFloat(opt('cap'));
    if (args.includes('--no-increases')) cfg.bounds.cap = 1;
    const freeze = opt('freeze');
    if (freeze != null) {
        cfg.frozen = freeze === 'none' ? []
            : [...new Set([...(cfg.frozen || []), ...freeze.split(',').filter(Boolean)])];
    }
    const { manual, frozen } = reindex(cfg);
    fs.writeFileSync(PPP_CONFIG, JSON.stringify(cfg, null, 2));

    const v = Object.values(cfg.territories);
    console.log(`✅ floor ${cfg.bounds.floor} · cap ${cfg.bounds.cap} · ${v.filter(x => x.bound === 'floor').length} at the floor · `
        + `${v.filter(x => x.bound === 'cap').length} at the cap · ${frozen} frozen`
        + (manual ? ` · ${manual} hand-written, left as is` : ''));
    console.log('   Then: node ppp_pricing.js plan');
}

/**
 * Read the prices back. A dot on stdout is not proof that Apple stored anything —
 * this is. Exits non-zero while anything is still off target, so the quarterly cron
 * the skill asks for can actually fail.
 */
async function cmdVerify() {
    const cfg = readCfg();
    const { jwt } = token();
    const { rows, unpriced } = await buildPlan(jwt, cfg);
    const pending = rows.filter(r => r.change);
    console.log(`${rows.length - pending.length} of ${rows.length} price(s) on target.`);
    for (const r of pending) {
        console.log(`   ${r.territory.padEnd(5)} ${r.planType.toLowerCase().padEnd(8)} ${String(r.currentPrice).padStart(10)} → ${String(r.newPrice).padStart(10)}  still to write`);
    }
    if (unpriced.length) console.log(`\n⚠️  ${unpriced.length} territory(ies) Apple cannot price: ${unpriced.join(', ')}`);
    if (pending.length) process.exitCode = 1;
}

/**
 * Build, bound and simulate in one call. Every decision is a flag, so nothing stops
 * halfway to ask a question — this is the form an agent can drive end to end instead
 * of handing you five commands to type.
 *
 * `run` never writes, and that is the point: a command that cannot write can be granted
 * once and for all, while `rollout` stays a deliberate act. Splitting them is what makes
 * "hands-off up to the plan, hands-on to write" expressible as a permission rule.
 */
async function cmdRun() {
    if (!fs.existsSync(PPP_CONFIG) || args.includes('--fresh')) await cmdInit();
    else console.log('ppp_config.json already exists — reusing it (--fresh rebuilds it).');

    if (['floor', 'cap', 'freeze'].some(f => opt(f) != null) || args.includes('--no-increases')) cmdBounds();

    await cmdPlan(false);
    console.log('\nRead the table. Then: node ppp_pricing.js rollout --canary=<territory>');
}

/** Write: one canary territory, then the rest, then read the prices back. */
async function cmdRollout() {
    const canary = opt('canary');
    if (canary) {
        console.log(`── canary: ${canary} ──`);
        await cmdPlan(true, [canary]);
        console.log('\n── rolling out ──');
    }
    await cmdPlan(true);
    await cmdVerify();
}

const commands = {
    products: cmdProducts,
    init: cmdInit,
    bounds: cmdBounds,
    plan: () => cmdPlan(false),
    apply: () => cmdPlan(true),
    verify: cmdVerify,
    run: cmdRun,
    rollout: cmdRollout,
};

if (!commands[command]) {
    console.log('Usage: node ppp_pricing.js <run|rollout|products|init|bounds|plan|apply|verify> [options]');
    console.log('  run   --products=id,id --ref=USA   build + bound + simulate. Never writes.');
    console.log('        [--floor= --cap= --freeze=]  decisions, applied before the plan');
    console.log('        [--fresh]                    rebuild the config from scratch');
    console.log('  rollout [--canary=XXX]          write: one territory first, then the rest,');
    console.log('                                  then read the prices back');
    console.log('  products                        list the account\'s subscriptions');
    console.log('  init --products=id,id --ref=USA build ppp_config.json');
    console.log('       [--territories=all|A,B]    default: every App Store territory');
    console.log('       [--floor=0.30 --cap=1.30]');
    console.log('       [--no-marketing]           keep the closest price point instead of');
    console.log('                                  snapping to a familiar anchor (39.99 vs 38.99)');
    console.log('       [--marketing-pull=8]       how far, in %, snapping may drift');
    console.log('  bounds [--floor= --cap=]        replay the bounds offline, keeping');
    console.log('         [--freeze=A,B|none]      hand-written territories intact');
    console.log('         [--no-increases]         cap at 1.0: nothing goes up');
    console.log('  plan  [--territory=A,B]         dry run');
    console.log('  apply [--territory=A,B]         write prices');
    console.log('  verify                          read the prices back; non-zero if off target');
    process.exit(command ? 1 : 0);
}
// bounds is synchronous; wrap so the dispatch doesn't depend on which ones are async.
Promise.resolve(commands[command]()).catch(e => { console.error('❌', e.message); process.exit(1); });
