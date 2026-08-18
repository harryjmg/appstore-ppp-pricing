#!/usr/bin/env node
/**
 * Prix App Store indexés sur le pouvoir d'achat local.
 *
 *   node ppp_pricing.js produits          liste les abonnements du compte
 *   node ppp_pricing.js init              construit ppp_config.json (indices Banque mondiale)
 *   node ppp_pricing.js plan              simulation : ce qui changerait, sans rien écrire
 *   node ppp_pricing.js apply             écrit les prix
 *
 * Zéro dépendance npm : le JWT ES256 est signé avec le module crypto de Node.
 *
 * Prérequis : une clé App Store Connect API de rôle App Manager ou Admin, et un fichier
 * asc_api_config.json à côté de ce script :
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

const ICI = __dirname;
const ASC_CONFIG = path.join(ICI, 'asc_api_config.json');
const PPP_CONFIG = path.join(ICI, 'ppp_config.json');
const CACHE = path.join(ICI, '.ppp_grid_cache.json');
const HOST = 'api.appstoreconnect.apple.com';

const args = process.argv.slice(3);
const commande = process.argv[2];
const flag = n => args.includes('--' + n);
const opt = (n, def = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : def; };

// ───────────────────────────────────────────────── JWT ES256 sans dépendance

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** La signature ECDSA de Node sort en DER ; JOSE veut r||s sur 32 octets chacun. */
function derVersJose(der) {
    let i = 2;
    if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
    const lireEntier = () => {
        if (der[i++] !== 0x02) throw new Error('signature DER inattendue');
        const len = der[i++];
        let v = der.subarray(i, i + len); i += len;
        while (v.length > 32 && v[0] === 0) v = v.subarray(1);
        return Buffer.concat([Buffer.alloc(32 - v.length, 0), v]);
    };
    return Buffer.concat([lireEntier(), lireEntier()]);
}

function jeton() {
    if (!fs.existsSync(ASC_CONFIG)) {
        console.error(`❌ ${path.basename(ASC_CONFIG)} manquant. Voir l'en-tête de ce script.`);
        process.exit(1);
    }
    const cfg = JSON.parse(fs.readFileSync(ASC_CONFIG, 'utf8'));
    const cle = fs.readFileSync(path.join(ICI, cfg.key_file), 'utf8');
    const maintenant = Math.floor(Date.now() / 1000);
    const entete = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.key_id, typ: 'JWT' }));
    const corps = b64url(JSON.stringify({ iss: cfg.issuer_id, iat: maintenant, exp: maintenant + 1200, aud: 'appstoreconnect-v1' }));
    const signeur = crypto.createSign('SHA256');
    signeur.update(`${entete}.${corps}`);
    const sig = b64url(derVersJose(signeur.sign(cle)));
    return { jwt: `${entete}.${corps}.${sig}`, cfg };
}

// ───────────────────────────────────────────────────────────────── transport

function appelBrut(methode, chemin, jwt, corps = null) {
    return new Promise((res, rej) => {
        const p = corps ? JSON.stringify(corps) : null;
        const h = { Authorization: 'Bearer ' + jwt };
        if (p) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(p); }
        const r = https.request({ hostname: HOST, path: chemin, method: methode, headers: h }, x => {
            let d = ''; x.on('data', c => d += c);
            x.on('end', () => { try { res({ s: x.statusCode, d: JSON.parse(d) }); } catch (e) { res({ s: x.statusCode, d }); } });
        });
        r.on('error', rej); if (p) r.write(p); r.end();
    });
}

/**
 * L'API renvoie régulièrement des 500 passagers, et des 429 si on va trop vite.
 * Sans reprise, un run de plusieurs centaines d'écritures s'arrête sur un aléa réseau.
 * On ne réessaie que ce qui est transitoire : un 4xx métier doit remonter tel quel.
 */
async function appel(methode, chemin, jwt, corps = null, essais = 3) {
    let derniere = null;
    for (let i = 0; i < essais; i++) {
        try {
            const r = await appelBrut(methode, chemin, jwt, corps);
            if (![429, 500, 502, 503, 504].includes(r.s)) return r;
            derniere = r;
        } catch (e) {
            derniere = { s: 0, d: { erreur: e.message } };
        }
        if (i < essais - 1) await new Promise(s => setTimeout(s, 1500 * (i + 1)));
    }
    return derniere;
}

async function tout(chemin, jwt, stop = null) {
    let data = [], included = [], next = chemin, pages = 0;
    while (next && pages < 20) {
        const r = await appel('GET', next, jwt);
        if (r.s !== 200) {
            if (pages === 0) throw new Error(`GET ${chemin} → ${r.s} ${JSON.stringify(r.d).slice(0, 200)}`);
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
/** L'index de prix Apple est global : un ID de price point se forge pour tout produit. */
const forge = (sub, terr, p) => Buffer.from(JSON.stringify({ s: String(sub), t: terr, p: String(p) })).toString('base64').replace(/=+$/, '');

const fetchJson = url => new Promise((res, rej) => {
    https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('réponse illisible')); } }); }).on('error', rej);
});

// ─────────────────────────────────────────────────────────────── commandes

async function cmdProduits() {
    const { jwt, cfg } = jeton();
    const groupes = await tout(`/v1/apps/${cfg.app_id}/subscriptionGroups?limit=50`, jwt);
    for (const g of groupes.data) {
        console.log(`\nGroupe ${g.id} — ${g.attributes.referenceName}`);
        const subs = await tout(`/v1/subscriptionGroups/${g.id}/subscriptions?limit=200`, jwt);
        for (const s of subs.data) {
            console.log(`  ${s.id}  ${(s.attributes.productId || '').padEnd(28)} ${s.attributes.subscriptionPeriod || ''}  ${s.attributes.state}`);
        }
    }
    console.log('\nNe retenez que les produits réellement vendus par votre paywall.');
    console.log('Puis : node ppp_pricing.js init --produits=<id>,<id> --ref=FRA');
}

async function cmdInit() {
    const { jwt } = jeton();
    const produits = (opt('produits') || '').split(',').filter(Boolean);
    const ref = opt('ref', 'USA');
    if (!produits.length) { console.error('❌ --produits=<ascId>,<ascId> requis (voir : node ppp_pricing.js produits)'); process.exit(1); }

    const terrDemandes = opt('territoires');
    const territoires = terrDemandes && terrDemandes !== 'all'
        ? terrDemandes.split(',')
        : (await tout('/v1/territories?limit=200', jwt)).data.map(t => t.id);

    const pays = [...new Set([ref, ...territoires])].filter(c => c !== ref || true);
    console.log(`Banque mondiale — ${pays.length} territoires…`);

    const indicateur = async (code, mrv) => {
        const r = await fetchJson(`https://api.worldbank.org/v2/country/${pays.join('%3B')}/indicator/${code}?format=json&mrv=${mrv}&per_page=2000`);
        const o = {};
        for (const x of (r[1] || [])) {
            if (x.value == null) continue;
            const c = x.countryiso3code;
            if (!o[c] || x.date > o[c].annee) o[c] = { v: x.value, annee: x.date, nom: x.country.value };
        }
        return o;
    };
    const rnb = await indicateur('NY.GNP.PCAP.PP.CD', 3);      // RNB/hab PPP
    const decile = await indicateur('SI.DST.10TH.10', 10);      // part des 10 % les plus riches

    if (!rnb[ref]) { console.error(`❌ pas de donnée Banque mondiale pour la référence ${ref}`); process.exit(1); }
    const defaut = r => (r > 40000 ? 26 : r > 15000 ? 31 : 33);
    const partRef = decile[ref] ? decile[ref].v : defaut(rnb[ref].v);
    const socle = rnb[ref].v * partRef;

    const plancher = parseFloat(opt('plancher', '0.30'));
    const plafond = parseFloat(opt('plafond', '1.30'));

    const sortie = {};
    let ignores = 0;
    for (const t of territoires) {
        if (t === ref) continue;
        if (!rnb[t]) { ignores++; continue; }
        const part = decile[t] ? decile[t].v : defaut(rnb[t].v);
        const amorti = Math.sqrt((rnb[t].v * part) / socle);
        sortie[t] = {
            index: Number(Math.min(plafond, Math.max(plancher, amorti)).toFixed(3)),
            rnb_ppp: rnb[t].v, part_decile_sup: part,
            source_decile: decile[t] ? String(decile[t].annee) : 'défaut',
            borne: amorti < plancher ? 'plancher' : amorti > plafond ? 'plafond' : null,
        };
    }

    const cfg = {
        reference: { territoire: ref },
        bornes: { plancher, plafond, seuil_modification_pct: 5, fenetre_price_point_pct: 8 },
        preserve_current_price: true,
        date_effet: null,
        plan_types: ['UPFRONT', 'MONTHLY'],
        subscriptions: produits.map(id => ({ asc_id: id })),
        territoires: sortie,
    };
    fs.writeFileSync(PPP_CONFIG, JSON.stringify(cfg, null, 2));
    console.log(`✅ ppp_config.json — ${Object.keys(sortie).length} territoires indexés, ${ignores} sans donnée (non touchés).`);
    console.log('   Relisez les indices, puis : node ppp_pricing.js plan');
}

function malusEsthetique(prix) {
    const s = prix.toFixed(2);
    if (Number.isInteger(prix) && prix >= 100) {
        const e = String(prix);
        if (e.endsWith('999') || e.endsWith('900')) return 0;
        if (e.endsWith('99') || e.endsWith('90') || e.endsWith('000')) return 0.005;
        if (e.endsWith('9') || e.endsWith('0')) return 0.015;
        return 0.05;
    }
    if (s.endsWith('.99')) return 0;
    if (s.endsWith('.90') || s.endsWith('.95')) return 0.005;
    if (s.endsWith('.49')) return 0.012;
    if (s.endsWith('.00')) return 0.018;
    return 0.05;
}

async function construirePlan(jwt, cfg) {
    const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
    const ref = cfg.reference.territoire;
    const lignes = [];

    for (const sub of cfg.subscriptions) {
        if (sub.exclu) { console.log(`⏭️  ${sub.asc_id} ignoré — ${sub.exclu}`); continue; }

        const { data, included } = await tout(
            `/v1/subscriptions/${sub.asc_id}/prices?limit=200&include=subscriptionPricePoint,territory`, jwt);
        const pts = {};
        for (const i of included) if (i.type === 'subscriptionPricePoints') pts[i.id] = i.attributes;
        const actuels = {};
        for (const p of data) {
            const t = p.relationships.territory.data.id;
            const pp = pts[p.relationships.subscriptionPricePoint.data.id] || {};
            (actuels[t] = actuels[t] || {})[p.attributes.planType] = {
                prix: parseFloat(pp.customerPrice),
                pricePointId: p.relationships.subscriptionPricePoint.data.id,
            };
        }
        if (!actuels[ref]) throw new Error(`${sub.asc_id} : aucun prix sur le territoire de référence ${ref}`);

        for (const planType of cfg.plan_types) {
            const prixRef = actuels[ref][planType];
            if (!prixRef) continue;

            // Base Apple : l'équivalent du prix de référence dans chaque territoire,
            // change + taxes + arrondi local déjà intégrés. Aucun taux à manipuler.
            const eq = await tout(`/v1/subscriptionPricePoints/${prixRef.pricePointId}/equalizations?limit=200`, jwt);
            const base = {};
            for (const e of eq.data) base[decode(e.id).t] = parseFloat(e.attributes.customerPrice);

            for (const [terr, conf] of Object.entries(cfg.territoires)) {
                if (base[terr] == null) continue;
                const cible = base[terr] * conf.index;

                let grille = cache[terr] && cache[terr].max >= cible * 1.2 ? cache[terr].points : null;
                if (!grille) {
                    const g = await tout(
                        `/v1/subscriptions/${sub.asc_id}/pricePoints?filter[territory]=${terr}&limit=200`, jwt,
                        acc => acc.length && parseFloat(acc[acc.length - 1].attributes.customerPrice) > cible * 1.2);
                    grille = g.data.map(p => ({ p: decode(p.id).p, px: parseFloat(p.attributes.customerPrice) }));
                    cache[terr] = { points: grille, max: grille.length ? grille[grille.length - 1].px : 0 };
                }
                if (!grille.length) continue;

                let choisi = null, score = Infinity;
                for (const p of grille) {
                    const ecart = Math.abs(p.px - cible) / cible;
                    const s = ecart + (ecart <= cfg.bornes.fenetre_price_point_pct / 100 ? malusEsthetique(p.px) : 0);
                    if (s < score) { score = s; choisi = p; }
                }

                const actuel = (actuels[terr] || {})[planType];
                const delta = actuel ? (choisi.px - actuel.prix) / actuel.prix * 100 : null;
                lignes.push({
                    subId: sub.asc_id, planType, territoire: terr, index: conf.index, borne: conf.borne,
                    prixActuel: actuel ? actuel.prix : null, prixRetenu: choisi.px, cible, delta,
                    pricePointId: forge(sub.asc_id, terr, choisi.p),
                    aModifier: delta != null && Math.abs(delta) >= cfg.bornes.seuil_modification_pct,
                });
            }
        }
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    return lignes;
}

async function cmdPlan(appliquer) {
    if (!fs.existsSync(PPP_CONFIG)) { console.error('❌ ppp_config.json manquant. Lancez d\'abord : node ppp_pricing.js init'); process.exit(1); }
    const cfg = JSON.parse(fs.readFileSync(PPP_CONFIG, 'utf8'));
    const { jwt } = jeton();

    console.log(appliquer ? '🔴 ÉCRITURE' : '🔵 Simulation — rien ne sera écrit');
    console.log(`   référence ${cfg.reference.territoire} · abonnés existants : ${cfg.preserve_current_price ? 'prix préservé' : '⚠️ NON préservé'}\n`);

    const lignes = await construirePlan(jwt, cfg);
    const aFaire = lignes.filter(l => l.aModifier).sort((a, b) => b.delta - a.delta);

    for (const l of aFaire) {
        const d = (l.delta > 0 ? '+' : '') + Math.round(l.delta) + '%';
        console.log(`   ${l.territoire.padEnd(5)} ${l.planType.toLowerCase().padEnd(8)} ${String(l.prixActuel).padStart(10)} → ${String(l.prixRetenu).padStart(10)} ${d.padStart(7)}   ×${l.index}${l.borne ? ' (' + l.borne + ')' : ''}`);
    }
    console.log(`\n${aFaire.length} prix à écrire · ${aFaire.filter(l => l.delta > 0).length} hausse(s) · ${aFaire.filter(l => l.delta < 0).length} baisse(s)`);

    if (!appliquer) { console.log('\nRien n\'a été modifié. Relancez avec « apply » quand le plan vous convient.'); return; }

    // Trois attributs, et les trois comptent — voir SKILL.md.
    const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const startDate = cfg.date_effet || demain;
    let ok = 0, ko = 0;
    for (const l of aFaire) {
        const r = await appel('POST', '/v1/subscriptionPrices', jwt, {
            data: {
                type: 'subscriptionPrices',
                attributes: { planType: l.planType, startDate, preserveCurrentPrice: cfg.preserve_current_price },
                relationships: {
                    subscription: { data: { type: 'subscriptions', id: l.subId } },
                    subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: l.pricePointId } },
                },
            },
        });
        if (r.s === 200 || r.s === 201) { ok++; process.stdout.write('.'); }
        else {
            ko++;
            console.log(`\n❌ ${l.subId} ${l.territoire} ${l.planType} → ${r.s} ${JSON.stringify(r.d).slice(0, 240)}`);
            if (r.s === 403) { console.error('\nLa clé n\'a pas le droit d\'écrire les prix : rôle App Manager ou Admin requis.'); break; }
        }
        await new Promise(s => setTimeout(s, 250));
    }
    console.log(`\n\n✅ ${ok} écrit(s)${ko ? ` · ❌ ${ko} échec(s)` : ''} — effet au ${startDate}`);
}

const commandes = {
    produits: cmdProduits,
    init: cmdInit,
    plan: () => cmdPlan(false),
    apply: () => cmdPlan(true),
};

if (!commandes[commande]) {
    console.log('Usage : node ppp_pricing.js <produits|init|plan|apply> [options]');
    console.log('  produits                        liste les abonnements du compte');
    console.log('  init --produits=id,id --ref=FRA construit ppp_config.json');
    console.log('       [--territoires=all|A,B]    par défaut : tous les territoires App Store');
    console.log('       [--plancher=0.30 --plafond=1.30]');
    console.log('  plan                            simulation');
    console.log('  apply                           écriture');
    process.exit(commande ? 1 : 0);
}
commandes[commande]().catch(e => { console.error('❌', e.message); process.exit(1); });
