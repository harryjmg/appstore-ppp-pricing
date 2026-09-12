#!/usr/bin/env node
/**
 * One reference, both stores.
 *
 * The two halves of this skill each do one store, and each is usable alone. This drives
 * them together, because the question a user actually asks is never "price my App Store
 * subscriptions" — it is "make my prices make sense everywhere", and they own two stores.
 *
 * Everything is derived. The products are whatever the stores have approved; the reference
 * PRICE is whatever the App Store already charges in the reference territory — it is
 * already decided, there is no reason to make someone retype it — and Play is aligned onto
 * that same figure, tax solved rather than configured. What is left to say is one country:
 *
 *     node ppp.js run --ref=FRA
 *
 * That is the whole interface. The defaults behind it (floor 0.30, cap 1.30, marketing
 * rounding on, existing subscribers untouched) are decisions, and they are documented in
 * SKILL.md — but they are decisions with right answers for almost everyone, so they are
 * defaults and not questions. Change one with a flag when the table tells you to; the
 * table is the only thing that ever should.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const args = process.argv.slice(3);
const command = process.argv[2];
const has = n => args.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
const passe = args.filter(a => !a.startsWith('--store='));
const store = (args.find(a => a.startsWith('--store=')) || '--store=both').split('=')[1];

const APPLE = fs.existsSync(path.join(HERE, 'asc_api_config.json'));
const PLAY = fs.existsSync(path.join(HERE, 'play_config.json'));

function lance(script, sous, extra = []) {
    console.log(`\n${'─'.repeat(70)}\n  ${script === 'ppp_pricing.js' ? 'App Store' : 'Google Play'} — ${sous}\n${'─'.repeat(70)}`);
    try {
        execFileSync(process.execPath, [path.join(HERE, script), sous, ...extra], { stdio: 'inherit', cwd: HERE });
        return true;
    } catch (e) {
        // One store failing must not take the other down: two accounts, two APIs, two ways
        // to break — and fixing one while the other is already right is the normal case,
        // not the exception.
        console.log(`\n⚠️  ${script} ${sous} failed (exit ${e.status}) — the other store continues.`);
        return false;
    }
}

function stores() {
    const out = [];
    if (store !== 'play' && APPLE) out.push('ppp_pricing.js');
    if (store !== 'apple' && PLAY) out.push('play_pricing.js');
    if (!out.length) {
        console.error('❌ no store configured here.');
        console.error('   App Store: asc_api_config.json + the .p8 key');
        console.error('   Play     : node play_pricing.js init, then fill in package and service_account');
        process.exit(1);
    }
    return out;
}

const SOUS = {
    // Apple needs the territory to build the index; Play reads it out of ppp_config.json.
    run: s => s === 'ppp_pricing.js' ? ['run', passe] : ['plan', passe.filter(a => !a.startsWith('--ref='))],
    plan: s => s === 'ppp_pricing.js' ? ['plan', passe] : ['plan', []],
    apply: s => s === 'ppp_pricing.js' ? ['rollout', passe] : ['apply', []],
    verify: () => ['verify', []],
    products: () => ['products', []],
};

if (!SOUS[command]) {
    console.log('Usage: node ppp.js <run|plan|apply|verify|products> [--ref=ISO3] [--store=apple|play|both]');
    console.log('');
    console.log('  run --ref=FRA   builds the index, aligns Play on the App Store, simulates both. Writes nothing.');
    console.log('  plan            re-simulates without rebuilding anything');
    console.log('  apply           writes the prices to both stores');
    console.log('  verify          reads both stores\' prices back');
    console.log('  products        lists what each store sells');
    console.log('');
    console.log('  Settings (--floor --cap --freeze --no-increases) go to the App Store half,');
    console.log('  which owns ppp_config.json; Play reads the same index.');
    process.exit(1);
}

let ok = true;
for (const s of stores()) {
    const [sous, extra] = SOUS[command](s);
    if (!lance(s, sous, extra)) ok = false;
}
if (command === 'run' || command === 'plan') {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('  Read the tables. Then, to write:  node ppp.js apply');
}
if (!ok) process.exitCode = 1;
