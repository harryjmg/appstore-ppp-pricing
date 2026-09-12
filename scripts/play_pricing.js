#!/usr/bin/env node
/**
 * Google Play pricing by purchasing power — the Play half of appstore-ppp-pricing.
 *
 * Same index, same reference, same decisions; a different store underneath. It needs no
 * configuration beyond a package name and a service account: the reference price is not
 * something you state, it is read from the App Store price of the SAME productId, so the
 * two stores cannot drift apart by construction. Without an App Store side, it falls back
 * to the product's current Play price in the reference region.
 *
 * Three things differ from Apple and all three are in your favour:
 *
 *   1. `pricing:convertRegionPrices` is the exact analogue of Apple's `equalizations` —
 *      Google converts one price to every region at today's rate, with the local pricing
 *      pattern and tax baked in. So again: no exchange rate is ever handled here.
 *   2. Play has no price tiers. Any amount is writable to the nanosecond, so instead of
 *      picking from a grid we re-shape the scaled price with the same `priceTier` the
 *      App Store half uses — read from its file, never copied.
 *   3. Existing subscribers are grandfathered by default: a price change opens a new price
 *      cohort and leaves the old one alone. `migratePrices` — which this script never calls
 *      — is the only way to move them. Apple's `preserveCurrentPrice` is a flag you can
 *      forget; here safety is the default.
 *
 * THE ONE TRAP, and it cost one app a 20% gap between its two stores for weeks:
 * `regionalConfigs[].price` is what the CUSTOMER PAYS, tax included — but the price you
 * hand to convertRegionPrices is TAX EXCLUSIVE. Feed it 49.99 and France shows 59.99.
 * Nobody notices from their own phone, because nobody carries both.
 *
 * So this script never asks for a tax rate: it SOLVES for the pre-tax figure, asking Google
 * what a candidate converts to and correcting until the reference region lands exactly on
 * the price you want displayed. A VAT change, a country with a different rate, a product
 * taxed differently — all handled, none configured. If it cannot converge it refuses to
 * write, because the failure mode it is guarding against is 173 prices wrong by a VAT with
 * nothing on screen to say so.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PPP_CONFIG = path.join(HERE, 'ppp_config.json');
const PLAY_CONFIG = path.join(HERE, 'play_config.json');
const HOST = 'androidpublisher.googleapis.com';

const args = process.argv.slice(3);
const command = process.argv[2];
const opt = (n, def = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : def; };

// ISO 3166 alpha-2 → alpha-3. Play speaks alpha-2, Apple (and ppp_config.json) alpha-3;
// one index serves both stores only if something bridges them, and that is this table.
const ISO3 = {AE:'ARE',AG:'ATG',AL:'ALB',AM:'ARM',AO:'AGO',AR:'ARG',AT:'AUT',AU:'AUS',AW:'ABW',AZ:'AZE',BA:'BIH',BD:'BGD',BE:'BEL',BF:'BFA',BG:'BGR',BH:'BHR',BJ:'BEN',BM:'BMU',BO:'BOL',BR:'BRA',BS:'BHS',BW:'BWA',BY:'BLR',BZ:'BLZ',CA:'CAN',CD:'COD',CF:'CAF',CG:'COG',CH:'CHE',CI:'CIV',CL:'CHL',CM:'CMR',CO:'COL',CR:'CRI',CV:'CPV',CY:'CYP',CZ:'CZE',DE:'DEU',DJ:'DJI',DK:'DNK',DM:'DMA',DO:'DOM',DZ:'DZA',EC:'ECU',EE:'EST',EG:'EGY',ER:'ERI',ES:'ESP',FI:'FIN',FJ:'FJI',FM:'FSM',FR:'FRA',GA:'GAB',GB:'GBR',GD:'GRD',GE:'GEO',GH:'GHA',GI:'GIB',GM:'GMB',GN:'GIN',GR:'GRC',GT:'GTM',GW:'GNB',HK:'HKG',HN:'HND',HR:'HRV',HT:'HTI',HU:'HUN',ID:'IDN',IE:'IRL',IL:'ISR',IN:'IND',IQ:'IRQ',IS:'ISL',IT:'ITA',JM:'JAM',JO:'JOR',JP:'JPN',KE:'KEN',KG:'KGZ',KH:'KHM',KM:'COM',KN:'KNA',KR:'KOR',KW:'KWT',KY:'CYM',KZ:'KAZ',LA:'LAO',LB:'LBN',LC:'LCA',LI:'LIE',LK:'LKA',LR:'LBR',LT:'LTU',LU:'LUX',LV:'LVA',LY:'LBY',MA:'MAR',MC:'MCO',MD:'MDA',MK:'MKD',ML:'MLI',MM:'MMR',MN:'MNG',MO:'MAC',MT:'MLT',MU:'MUS',MV:'MDV',MX:'MEX',MY:'MYS',MZ:'MOZ',NA:'NAM',NE:'NER',NG:'NGA',NI:'NIC',NL:'NLD',NO:'NOR',NP:'NPL',NZ:'NZL',OM:'OMN',PA:'PAN',PE:'PER',PG:'PNG',PH:'PHL',PK:'PAK',PL:'POL',PT:'PRT',PY:'PRY',QA:'QAT',RO:'ROU',RS:'SRB',RU:'RUS',RW:'RWA',SA:'SAU',SB:'SLB',SC:'SYC',SE:'SWE',SG:'SGP',SI:'SVN',SK:'SVK',SL:'SLE',SM:'SMR',SN:'SEN',SO:'SOM',SR:'SUR',SV:'SLV',TC:'TCA',TD:'TCD',TG:'TGO',TH:'THA',TJ:'TJK',TM:'TKM',TN:'TUN',TO:'TON',TR:'TUR',TT:'TTO',TW:'TWN',TZ:'TZA',UA:'UKR',UG:'UGA',US:'USA',UY:'URY',UZ:'UZB',VA:'VAT',VE:'VEN',VG:'VGB',VN:'VNM',VU:'VUT',WS:'WSM',YE:'YEM',ZA:'ZAF',ZM:'ZMB',ZW:'ZWE'};

// ── plumbing ───────────────────────────────────────────────────────────────────────────

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function readCfg(p, quoi) {
    if (!fs.existsSync(p)) { console.error(`❌ ${path.basename(p)} introuvable — ${quoi}`); process.exit(1); }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function request(method, host, apiPath, body, headers) {
    return new Promise((res, rej) => {
        const h = { ...headers };
        if (body) h['Content-Length'] = Buffer.byteLength(body);
        const r = https.request({ host, path: apiPath, method, headers: h }, x => {
            let d = ''; x.on('data', c => d += c);
            x.on('end', () => res({ code: x.statusCode, body: d }));
        });
        r.on('error', rej);
        if (body) r.write(body);
        r.end();
    });
}

let JETON = null;
async function jeton() {
    if (JETON) return JETON;
    const play = readCfg(PLAY_CONFIG, 'lancer d\'abord: node play_pricing.js init');
    const saPath = path.isAbsolute(play.service_account) ? play.service_account : path.join(HERE, play.service_account);
    if (!fs.existsSync(saPath)) { console.error(`❌ service account not found: ${saPath}`); process.exit(1); }
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    const now = Math.floor(Date.now() / 1e3);
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).end().sign(sa.private_key).toString('base64url');
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }).toString();
    const r = await request('POST', 'oauth2.googleapis.com', '/token', form, { 'Content-Type': 'application/x-www-form-urlencoded' });
    const j = JSON.parse(r.body);
    if (!j.access_token) { console.error('❌ OAuth refused:', r.body); process.exit(1); }
    return (JETON = j.access_token);
}

async function api(method, apiPath, body = null) {
    const t = await jeton();
    const r = await request(method, HOST, apiPath, body ? JSON.stringify(body) : null,
        { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* corps vide */ }
    if (r.code >= 300) {
        const m = j && j.error ? `${j.error.status || r.code}: ${j.error.message}` : r.body.slice(0, 400);
        throw new Error(`${method} ${apiPath.split('?')[0]} → ${r.code} ${m}`);
    }
    return j;
}

// ── the reference price, read off the App Store ─────────────────────────────────────────
//
// Deliberately duplicated rather than shared: every script here must stay runnable on its
// own, and this is thirty read-only lines. What must NEVER be duplicated is a RULE — the
// index and the rounding are read out of the other half's files, never copied.

const ASC_CONFIG = path.join(HERE, 'asc_api_config.json');

function jwtApple() {
    if (!fs.existsSync(ASC_CONFIG)) return null;
    const cfg = JSON.parse(fs.readFileSync(ASC_CONFIG, 'utf8'));
    const key = path.join(HERE, cfg.key_file);
    if (!fs.existsSync(key)) return null;
    const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const der = crypto.createSign('SHA256');
    const head = b64u(JSON.stringify({ alg: 'ES256', kid: cfg.key_id, typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1e3);
    const body = b64u(JSON.stringify({ iss: cfg.issuer_id, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
    const sig = der.update(`${head}.${body}`).end().sign(fs.readFileSync(key, 'utf8'));
    // DER → JOSE: ES256 wants two 32-byte integers; OpenSSL hands back an ASN.1 sequence.
    let o = 2, l = sig[1]; if (l & 0x80) o += l & 0x7f;
    const rl = sig[o + 1], r = sig.slice(o + 2, o + 2 + rl), so = o + 2 + rl, sl = sig[so + 1], sv = sig.slice(so + 2, so + 2 + sl);
    const pad = x => { x = Buffer.from(x); while (x.length > 32 && x[0] === 0) x = x.slice(1); while (x.length < 32) x = Buffer.concat([Buffer.from([0]), x]); return x; };
    return { jwt: `${head}.${body}.${b64u(Buffer.concat([pad(r), pad(sv)]))}`, appId: cfg.app_id };
}

async function prixApple(region) {
    const a = jwtApple();
    if (!a) return {};
    const get = p => new Promise(res => {
        https.request({ host: 'api.appstoreconnect.apple.com', path: p, method: 'GET', headers: { Authorization: `Bearer ${a.jwt}` } },
            x => { let d = ''; x.on('data', c => d += c); x.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } }); }).on('error', () => res({})).end();
    });
    const iso3 = ISO3[region];
    const out = {};
    const groups = await get(`/v1/apps/${a.appId}/subscriptionGroups?limit=50`);
    for (const g of (groups.data || [])) {
        const subs = await get(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=200`);
        for (const sub of (subs.data || [])) {
            const pid = sub.attributes.productId;
            if (!pid) continue;
            const pr = await get(`/v1/subscriptions/${sub.id}/prices?limit=200&include=subscriptionPricePoint,territory`);
            const pts = {};
            for (const i of (pr.included || [])) if (i.type === 'subscriptionPricePoints') pts[i.id] = i.attributes;
            // The SALE price: `preserved` marks a frozen cohort, not what a new buyer
            // pays — the same distinction the App Store half makes.
            let best = null;
            const today = new Date().toISOString().slice(0, 10);
            for (const x of (pr.data || [])) {
                if (x.relationships.territory.data.id !== iso3) continue;
                if (x.attributes.preserved) continue;
                const st = x.attributes.startDate;
                if (st && st > today) continue;
                if (!best || (st || '') > (best.st || '')) best = { st, px: parseFloat(pts[x.relationships.subscriptionPricePoint.data.id].customerPrice) };
            }
            if (best) out[pid] = best.px;
        }
    }
    return out;
}

// ── money ──────────────────────────────────────────────────────────────────────────────

const versNombre = m => m ? +m.units + (m.nanos || 0) / 1e9 : null;
function versMoney(devise, v) {
    const units = Math.floor(v + 1e-9);
    const nanos = Math.round((v - units) * 1e9 / 1e4) * 1e4;   // Play stores no finer than 1/10,000
    return nanos ? { currencyCode: devise, units: String(units), nanos } : { currencyCode: devise, units: String(units) };
}
const affiche = m => m ? `${versNombre(m).toFixed(versNombre(m) % 1 ? 2 : 0)} ${m.currencyCode}` : '—';

/**
 * Give the indexed price back the SHAPE Google chose for it.
 *
 * Google never returns 47.3172: it returns 59.99, or 38,700, or 6,500 — the shape prices
 * have in that country. Multiplying by the index destroys that shape, and writing the
 * result raw gives a price that reads like an exchange rate.
 *
 * Play has NO price tiers, so there is no grid to snap to: we build one. The candidates are
 * the plausible prices around the target (the usual endings for a decimal currency, the
 * multiples of Google's own granularity otherwise), and `priceTier` — the App Store half's
 * function, read out of its file and never copied — says which reads best. Both stores
 * therefore round by one rule, which is the only way €49.99 on one and €49.99 on the other
 * is not a coincidence.
 */
const { priceTier } = (() => {
    const src = fs.readFileSync(path.join(HERE, 'ppp_pricing.js'), 'utf8');
    const debut = src.indexOf('function priceTier');
    const fin = src.indexOf('/**', debut);
    if (debut < 0 || fin < 0) throw new Error('priceTier introuvable dans ppp_pricing.js');
    const box = {};
    new Function('exports', src.slice(debut, fin) + '\nexports.priceTier = priceTier;')(box);
    return box;
})();

function grilleLocale(converti, cible) {
    const out = [];
    if (!Number.isInteger(converti)) {
        const bas = Math.max(0, Math.floor(cible * 0.85));
        const haut = Math.ceil(cible * 1.15) + 1;
        for (let n = bas; n <= haut; n++)
            for (const c of [0.99, 0.95, 0.90, 0.50, 0.49, 0]) { const v = Math.round((n + c) * 100) / 100; if (v > 0) out.push(v); }
    } else {
        // Google's granularity: the largest power of ten dividing its price, never going
        // below two significant digits (38,700 → 100; 1,490 → 10).
        let g = 1;
        while (converti % (g * 10) === 0 && g * 10 <= converti / 10) g *= 10;
        const bas = Math.max(g, Math.floor(cible * 0.85 / g) * g);
        const haut = Math.ceil(cible * 1.15 / g) * g;
        for (let v = bas; v <= haut; v += g) out.push(v);
    }
    return out;
}

/** Strongest tier within 8% of the target; failing that, the closest. */
function arrondiLocal(converti, cible) {
    if (!(cible > 0)) return converti;
    const grille = grilleLocale(converti, cible);
    let best = null;
    for (const v of grille) {
        const ecart = Math.abs(v - cible) / cible;
        if (ecart > 0.08) continue;
        const tier = priceTier(v);
        if (!best || tier < best.tier || (tier === best.tier && ecart < best.ecart)) best = { v, tier, ecart };
    }
    if (best) return best.v;
    let proche = null, min = Infinity;
    for (const v of grille) { const e = Math.abs(v - cible); if (e < min) { min = e; proche = v; } }
    return proche != null ? proche : converti;
}

// ── commands ───────────────────────────────────────────────────────────────────────────

async function lireAbonnements(pkg) {
    const j = await api('GET', `/androidpublisher/v3/applications/${pkg}/subscriptions?pageSize=50`);
    return j.subscriptions || [];
}

async function cmdProducts() {
    const play = readCfg(PLAY_CONFIG, 'lancer d\'abord: node play_pricing.js init');
    for (const s of await lireAbonnements(play.package)) {
        for (const bp of s.basePlans || []) {
            const fr = (bp.regionalConfigs || []).find(c => c.regionCode === play.reference_region);
            console.log(`  ${s.productId.padEnd(18)} ${bp.basePlanId.padEnd(16)} ${(bp.state || '?').padEnd(8)} `
                + `${String((bp.regionalConfigs || []).length).padStart(3)} regions · ${play.reference_region} ${affiche(fr && fr.price)}`);
        }
    }
    console.log('\nEvery active subscription is priced by default ("produits" in play_config.json to narrow).');
}

/** What Google would do on its own: convert one TAX-EXCLUSIVE price into every region. */
async function convertir(pkg, devise, horsTaxe) {
    return api('POST', `/androidpublisher/v3/applications/${pkg}/pricing:convertRegionPrices`,
        { price: versMoney(devise, horsTaxe) });
}

/**
 * Find the tax-exclusive price that makes the reference region DISPLAY exactly `ttcVoulu` —
 * instead of asking for a VAT rate nobody should have to know.
 *
 * Google's conversion is monotonic and stepped, so a rule of three converges in two or three
 * calls and the steps do the rest. If it doesn't converge we REFUSE, because the failure
 * being guarded against is 173 prices off by a VAT with nothing on screen to say so.
 */
async function resoudreBase(pkg, devise, region, ttcVoulu) {
    let x = ttcVoulu, dernier = null;
    for (let i = 0; i < 6; i++) {
        const conv = await convertir(pkg, devise, x);
        const y = versNombre((conv.convertedRegionPrices[region] || {}).price);
        if (y == null) throw new Error(`Google will not convert into ${region} — invalid reference region`);
        if (Math.abs(y - ttcVoulu) < 0.011) return { conv, horsTaxe: x };
        dernier = y;
        x = x * ttcVoulu / y;
    }
    throw new Error(`cannot land ${region} on ${ttcVoulu} ${devise} (closest: ${dernier}). `
        + `Nothing was written — an unreachable reference price would skew the whole grid.`);
}

async function construirePlan() {
    const play = readCfg(PLAY_CONFIG, "run this first: node play_pricing.js init");
    const ppp = readCfg(PPP_CONFIG, 'the config shared with the App Store half');
    const region = play.reference_region || 'USA';
    const abos = await lireAbonnements(play.package);

    // THE REFERENCE IS NOT A SETTING. The price Play should display is the one the App
    // Store already displays for the same productId: the only way the two stores cannot
    // drift, and it spares retyping a number that already exists. With no App Store facing
    // it, take the product's current Play price in the reference region — which amounts to
    // "keep your price, index the rest".
    const surApple = await prixApple(region);
    const nApple = Object.keys(surApple).length;
    console.log(nApple ? `Reference: the App Store price in ${region} (${nApple} product(s) matched by productId).`
                       : `Reference: the current Play price in ${region} — no App Store facing it.`);

    const choisis = (play.produits && play.produits.length ? play.produits : abos.map(a => ({ product_id: a.productId })));
    const lignes = [];
    let regionVersion = null;

    for (const p of choisis) {
        const sub = abos.find(s => s.productId === p.product_id);
        if (!sub) { console.log(`⏭️  ${p.product_id} not on the Play Store — skipped`); continue; }

        const bpRef = (sub.basePlans || []).find(bp => !p.base_plan_id || bp.basePlanId === p.base_plan_id);
        const actuelRef = bpRef && (bpRef.regionalConfigs || []).find(c => c.regionCode === region);
        const devise = (actuelRef && actuelRef.price.currencyCode) || p.devise_reference;
        const ttc = p.prix_reference_ttc != null ? p.prix_reference_ttc
                  : (surApple[p.product_id] != null ? surApple[p.product_id] : versNombre(actuelRef && actuelRef.price));
        if (ttc == null || !devise) { console.log(`⏭️  ${p.product_id} — no reference price in ${region}, skipped`); continue; }

        const { conv } = await resoudreBase(play.package, devise, region, ttc);
        regionVersion = conv.regionVersion;
        console.log(`   ${p.product_id.padEnd(18)} reference ${ttc} ${devise}`);

        for (const bp of sub.basePlans || []) {
            if (p.base_plan_id && bp.basePlanId !== p.base_plan_id) continue;
            for (const rc of bp.regionalConfigs || []) {
                const c = conv.convertedRegionPrices[rc.regionCode];
                if (!c || !c.price) continue;                       // Google won't convert this region
                const iso3 = ISO3[rc.regionCode];
                const conf = iso3 && ppp.territories[iso3];
                const index = conf ? conf.index : 1;                // no index known → bare conversion
                const converti = versNombre(c.price);
                const neuf = arrondiLocal(converti, converti * index);
                const actuel = versNombre(rc.price);
                lignes.push({
                    produit: p.product_id, basePlan: bp.basePlanId, region: rc.regionCode,
                    devise: c.price.currencyCode, actuel, converti, neuf, index,
                    bound: conf ? conf.bound : 'hors index',
                    delta: actuel ? (neuf - actuel) / actuel * 100 : null,
                });
            }
        }
    }
    if (!lignes.length) throw new Error('nothing to price — check the package name and the products');
    return { lignes, play, regionVersion };
}

function afficherPlan(lignes) {
    const bouge = lignes.filter(l => l.delta == null || Math.abs(l.delta) >= 0.5);
    bouge.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
    for (const l of bouge) {
        const d = l.delta == null ? '  neuf' : `${l.delta >= 0 ? '+' : ''}${l.delta.toFixed(0)}%`;
        console.log(`   ${l.region.padEnd(3)} ${l.produit.padEnd(16)} ${String(l.actuel).padStart(11)} → ${String(l.neuf).padStart(11)} `
            + `${l.devise.padEnd(4)} ${d.padStart(6)}   ×${l.index}${l.bound && l.bound !== 'hors index' ? ` (${l.bound})` : ''}`);
    }
    const h = bouge.filter(l => l.delta > 0).length, b = bouge.filter(l => l.delta < 0).length;
    console.log(`\n${bouge.length} price(s) to write · ${h} increase(s) · ${b} decrease(s) · ${lignes.length - bouge.length} already in place`);
}

async function cmdPlan(ecrire) {
    const { lignes, play, regionVersion } = await construirePlan();
    console.log(ecrire ? '✍️  Writing' : '🔵 Dry run — nothing will be written');
    console.log(`   reference ${play.reference_region} · existing subscribers: price preserved (Play cohorts)\n`);
    afficherPlan(lignes);
    if (!ecrire) { console.log('\nNothing was changed. Re-run with "apply" once the plan looks right.'); return; }

    // One write per product: Play REPLACES the base plan's entire regionalConfigs array, so
    // every region must be in it, including the ones we are not moving.
    const parProduit = {};
    for (const l of lignes) (parProduit[l.produit] = parProduit[l.produit] || []).push(l);

    const abos = await lireAbonnements(play.package);
    let ok = 0, ko = 0;
    for (const [productId, ls] of Object.entries(parProduit)) {
        const sub = abos.find(s => s.productId === productId);
        const basePlans = sub.basePlans.map(bp => {
            const miennes = ls.filter(l => l.basePlan === bp.basePlanId);
            if (!miennes.length) return bp;
            const parRegion = Object.fromEntries(miennes.map(l => [l.region, l]));
            return {
                ...bp,
                regionalConfigs: bp.regionalConfigs.map(rc => {
                    const l = parRegion[rc.regionCode];
                    return l ? { ...rc, price: versMoney(l.devise, l.neuf) } : rc;
                }),
            };
        });
        const q = `updateMask=basePlans&regionsVersion.version=${encodeURIComponent(regionVersion.version)}`
            + `&latencyTolerance=PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_TOLERANT`;
        try {
            await api('PATCH', `/androidpublisher/v3/applications/${play.package}/subscriptions/${productId}?${q}`,
                { packageName: play.package, productId, basePlans });
            console.log(`   ✅ ${productId} — ${ls.length} regions`);
            ok += ls.length;
        } catch (e) {
            console.log(`   ❌ ${productId} — ${e.message}`);
            ko += ls.length;
        }
    }
    console.log(`\n✅ ${ok} price(s) written${ko ? ` · ❌ ${ko} failed` : ''}`);
    console.log('   Existing subscribers keep their price: migratePrices was never called.');
}

async function cmdVerify() {
    const { lignes } = await construirePlan();
    const off = lignes.filter(l => l.delta != null && Math.abs(l.delta) >= 0.5);
    if (!off.length) { console.log(`${lignes.length} price(s) on target.`); return; }
    console.log(`❌ ${off.length} price(s) off target out of ${lignes.length} :`);
    for (const l of off.slice(0, 40)) console.log(`   ${l.region} ${l.produit} ${l.actuel} ≠ ${l.neuf} ${l.devise}`);
    process.exitCode = 1;
}

function cmdInit() {
    if (fs.existsSync(PLAY_CONFIG)) { console.log('play_config.json already exists.'); return; }
    // Two required fields and that is all; the rest is derived. Empty `produits` = every
    // subscription on the account; no `prix_reference_ttc` = the App Store price of the same
    // productId. Only what no API can guess is written here.
    fs.writeFileSync(PLAY_CONFIG, JSON.stringify({
        package: 'com.exemple.app',
        service_account: '../../../play-service-account.json',
        reference_region: 'FR',
        produits: [],
    }, null, 2));
    console.log('✅ play_config.json created — fill in "package" and "service_account", then: node play_pricing.js plan');
}

const commandes = { init: cmdInit, products: cmdProducts, plan: () => cmdPlan(false), apply: () => cmdPlan(true), verify: cmdVerify };

if (!commandes[command]) {
    console.log('Usage: node play_pricing.js <init|products|plan|apply|verify>');
    console.log('  init      writes a play_config.json to fill in');
    console.log('  products  lists the subscriptions and their base plans');
    console.log('  plan      simulates. Writes nothing.');
    console.log('  apply     writes the prices to the Play Store');
    console.log('  verify    reads the prices back; exits non-zero while anything is off target');
    console.log('\nThe index comes from ppp_config.json — the same one the App Store half uses.');
    process.exit(1);
}
Promise.resolve(commandes[command]()).catch(e => { console.error('❌', e.message); process.exit(1); });
