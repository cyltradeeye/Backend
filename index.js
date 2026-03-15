// TRADEYE Backend — Single file, no build needed
// Node.js + Express + PostgreSQL + Telegram

import express from ‘express’;
import cors from ‘cors’;
import pg from ‘pg’;

const { Pool } = pg;
const app  = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ── PostgreSQL ────────────────────────────────────────────
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false },
});

async function initDb() {
await pool.query(`CREATE TABLE IF NOT EXISTS signals ( id           SERIAL PRIMARY KEY, coin_id      TEXT NOT NULL, symbol       TEXT NOT NULL, image        TEXT NOT NULL, direction    TEXT NOT NULL, entry_price  TEXT NOT NULL, signal_score INTEGER NOT NULL, created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved     BOOLEAN NOT NULL DEFAULT FALSE, result       TEXT, exit_price   TEXT, pct_change   TEXT, pts          INTEGER ); CREATE INDEX IF NOT EXISTS idx_signals_coin_dir_time ON signals (coin_id, direction, created_at);`);
console.log(’[db] Table signals prête’);
}

// ── Telegram ──────────────────────────────────────────────
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
if (!TG_TOKEN || !TG_CHAT_ID) return;
try {
const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
});
if (!res.ok) console.warn(`[telegram] Erreur ${res.status}`);
} catch (e) { console.warn(’[telegram] Échec (ignoré):’, e.message); }
}

function fmtDate(d) {
const dd = String(d.getDate()).padStart(2,‘0’);
const mm = String(d.getMonth()+1).padStart(2,‘0’);
const hh = String(d.getHours()).padStart(2,‘0’);
const mi = String(d.getMinutes()).padStart(2,‘0’);
return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
}

function fmtPrice(p) {
return p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2);
}

// ── Scoring ───────────────────────────────────────────────
function scoreForLong(c) {
let s = 0;
if (c.change1h > 0) { s += Math.min(40, (c.change1h / 5) * 40); }
else { s -= 20; }
if (c.change < -2 && c.change1h > 1) { s += 15; }
else if (c.change > 0 && c.change1h > 0) { s += Math.min(15, (c.change / 10) * 15); }
if (c.volRatio > 0) { s += Math.min(20, (c.volRatio / 0.4) * 20); }
const avgH = c.change / 24;
if (c.change1h > 0 && c.change1h > avgH * 2) s += 10;
if (c.change > 15 && c.change1h < 0.5) s -= 10;
if (c.change > 20) s -= 20;
return Math.max(0, Math.min(100, s));
}

function scoreForShort(c) {
let s = 0;
if (c.change1h < 0) { s += Math.min(40, (Math.abs(c.change1h) / 5) * 40); }
else { s -= 20; }
if (c.change > 3 && c.change1h < -1) { s += 15; }
else if (c.change < -3 && c.change1h < 0) { s += Math.min(15, (Math.abs(c.change) / 10) * 15); }
if (c.volRatio > 0 && c.change1h < 0) { s += Math.min(20, (c.volRatio / 0.4) * 20); }
const avgH = c.change / 24;
if (c.change1h < 0 && c.change1h < avgH * 2) s += 10;
if (c.change < -15 && c.change1h < -3) s -= 12;
if (c.change < -20) s -= 20;
return Math.max(0, Math.min(100, s));
}

// ── Fetch CoinGecko ───────────────────────────────────────
const RESOLVE_AFTER_MS      = 30 * 60 * 1000;
const INTER_PAGE_DELAY_MS   = 2_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MIN_SCORE             = 55;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(page) {
const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=1h,24h`;
const res = await fetch(url);
if (res.status === 429) { const e = new Error(‘429’); e.is429 = true; throw e; }
if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
return res.json();
}

async function fetchCoins() {
const p1 = await fetchPage(1);
await sleep(INTER_PAGE_DELAY_MS);
const p2 = await fetchPage(2);
return […p1, …p2].map(c => ({
rank:     c.market_cap_rank || 999,
id:       c.id,
symbol:   c.symbol.toUpperCase(),
image:    c.image,
price:    c.current_price || 0,
change:   c.price_change_percentage_24h || 0,
change1h: c.price_change_percentage_1h_in_currency || 0,
volume:   c.total_volume || 0,
mcap:     c.market_cap || 0,
volRatio: c.market_cap > 0 ? c.total_volume / c.market_cap : 0,
}));
}

// ── Résolution ────────────────────────────────────────────
async function resolveSignals(coins) {
const priceMap = new Map(coins.map(c => [c.id, c.price]));
const cutoff   = new Date(Date.now() - RESOLVE_AFTER_MS);
const { rows } = await pool.query(
`SELECT * FROM signals WHERE resolved=false AND created_at <= $1`, [cutoff]
);
for (const entry of rows) {
const currentPrice = priceMap.get(entry.coin_id);
if (currentPrice == null) continue;
const entryPrice = parseFloat(entry.entry_price);
const pct  = ((currentPrice - entryPrice) / entryPrice) * 100;
const abs  = Math.abs(pct);
const ok   = (entry.direction===‘long’ && pct>0.1) || (entry.direction===‘short’ && pct<-0.1);
const neu  = abs <= 0.1;
let result, pts;
if (neu)      { result=‘neutral’;   pts=5; }
else if (ok)  { result=‘correct’;   pts=abs>=2?10:abs>=1?9:abs>=0.5?8:abs>=0.3?7:6; }
else          { result=‘incorrect’; pts=abs>=1?0:abs>=0.3?2:3; }
await pool.query(
`UPDATE signals SET resolved=true,result=$1,exit_price=$2,pct_change=$3,pts=$4 WHERE id=$5`,
[result, String(currentPrice), String(pct), pts, entry.id]
);
const sign  = pct>=0?’+’:’’;
const emoji = result===‘correct’?‘✅’:result===‘incorrect’?‘❌’:‘➡️’;
console.log(`[cron] Résolu: ${entry.symbol} ${entry.direction.toUpperCase()} → ${result} ${sign}${pct.toFixed(2)}% ${pts}pts`);
await sendTelegram(`${emoji} RÉSULTAT — ${entry.symbol} ${entry.direction.toUpperCase()}\nEntrée : $${fmtPrice(entryPrice)} → Sortie : $${fmtPrice(currentPrice)}\nVariation : ${sign}${pct.toFixed(2)}%\nScore : ${pts}/10 pts`);
}
}

// ── Logger signal ─────────────────────────────────────────
async function logSignal(coin, direction, score) {
if (score < MIN_SCORE) return;
const since = new Date(Date.now() - RESOLVE_AFTER_MS);
const { rows } = await pool.query(
`SELECT id FROM signals WHERE coin_id=$1 AND direction=$2 AND created_at>=$3 AND resolved=false LIMIT 1`,
[coin.id, direction, since]
);
if (rows.length > 0) return;
const now = new Date();
await pool.query(
`INSERT INTO signals (coin_id,symbol,image,direction,entry_price,signal_score,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
[coin.id, coin.symbol, coin.image, direction, String(coin.price), score, now]
);
console.log(`[cron] Signal loggé: ${coin.symbol} ${direction.toUpperCase()} score=${score}/100 @ $${coin.price}`);
const emoji = direction===‘long’?‘🟢’:‘🔴’;
await sendTelegram(`${emoji} SIGNAL ${direction.toUpperCase()} — ${coin.symbol}\nScore : ${score}/100\nPrix : $${fmtPrice(coin.price)}\n📅 ${fmtDate(now)}\n⏱ Résolution dans 30min`);
}

// ── Cycle cron ────────────────────────────────────────────
let isRunning = false;

async function runCycle() {
if (isRunning) { console.log(’[cron] Skip — déjà en cours’); return; }
isRunning = true;
console.log(`[cron] Cycle @ ${new Date().toISOString()}`);
try {
const coins = await fetchCoins();
console.log(`[cron] ${coins.length} coins récupérés`);
await resolveSignals(coins);
const tradeable = coins.filter(c => c.volume > 3_000_000);
const scored    = tradeable.map(c => ({ …c, lScore: scoreForLong(c), sScore: scoreForShort(c) }));
const bestLong  = […scored].sort((a,b) => b.lScore-a.lScore)[0];
const bestShort = […scored].sort((a,b) => b.sScore-a.sScore)[0];
if (bestLong)  await logSignal(bestLong,  ‘long’,  Math.round(bestLong.lScore));
if (bestShort) await logSignal(bestShort, ‘short’, Math.round(bestShort.sScore));
} catch(e) {
if (e.is429) { console.warn(’[cron] 429 — pause 5min’); await sleep(RATE_LIMIT_BACKOFF_MS); }
else console.error(’[cron] Erreur:’, e.message);
} finally { isRunning = false; }
}

// ── Routes API ────────────────────────────────────────────
app.get(’/api/healthz’, (_req, res) => res.json({ status:‘ok’, time: new Date().toISOString() }));

app.get(’/api/test-telegram’, async (_req, res) => {
const text = `🤖 Test TRADEYE\n✅ Connexion OK\n📅 ${fmtDate(new Date())}`;
await sendTelegram(text);
res.json({ success: true });
});

app.get(’/api/signals/history’, async (_req, res) => {
try {
const since = new Date(Date.now() - 30*24*60*60*1000);
const { rows } = await pool.query(`SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC`, [since]);
res.json({ success:true, data: rows.map(r => ({ …r, timestamp: new Date(r.created_at).getTime() })) });
} catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get(’/api/signals/pending’, async (_req, res) => {
try {
const { rows } = await pool.query(`SELECT * FROM signals WHERE resolved=false ORDER BY created_at DESC`);
res.json({ success:true, data:rows });
} catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get(’/api/signals/perfo’, async (_req, res) => {
try {
const since7d = new Date(Date.now() - 7*24*60*60*1000);
const { rows } = await pool.query(`SELECT * FROM signals WHERE resolved=true AND created_at>=$1`, [since7d]);
const correct   = rows.filter(r=>r.result===‘correct’).length;
const incorrect = rows.filter(r=>r.result===‘incorrect’).length;
const neutral   = rows.filter(r=>r.result===‘neutral’).length;
const withPts   = rows.filter(r=>r.pts!=null);
const score7d   = withPts.length ? withPts.reduce((s,r)=>s+r.pts,0)/withPts.length : null;
const winRate   = rows.length ? (correct/rows.length)*100 : null;
res.json({ success:true, data:{ correct,incorrect,neutral,total:rows.length,score7d,winRate }});
} catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get(’/api/signals/export’, async (_req, res) => {
try {
const since = new Date(Date.now() - 30*24*60*60*1000);
const { rows } = await pool.query(`SELECT * FROM signals WHERE created_at>=$1 ORDER BY created_at DESC`, [since]);
const resolved = rows.filter(r=>r.resolved);
const pending  = rows.filter(r=>!r.resolved);
const correct  = resolved.filter(r=>r.result===‘correct’).length;
const incorrect= resolved.filter(r=>r.result===‘incorrect’).length;
const neutral  = resolved.filter(r=>r.result===‘neutral’).length;
const withPts  = resolved.filter(r=>r.pts!=null);
const score    = withPts.length ? (withPts.reduce((s,r)=>s+r.pts,0)/withPts.length).toFixed(1) : ‘—’;
const winRate  = resolved.length ? Math.round((correct/resolved.length)*100)+’%’ : ‘—’;
const SEP = ‘=’.repeat(52)+’\n’;
let txt = SEP+`  TRADEYE - HISTORIQUE (30 JOURS)\n  Exporté le ${fmtDate(new Date())}\n`+SEP+’\n’;
txt += `SCORE 7J : ${score}/10 | WIN RATE : ${winRate}\n`;
txt += `CORRECTS : ${correct} | INCORRECTS : ${incorrect} | NEUTRES : ${neutral}\n`;
txt += `TOTAL : ${resolved.length} signaux résolus\n\n`;
txt += SEP+’  EN COURS\n’+SEP+’\n’;
pending.forEach((r,i)=>{ const age=Math.floor((Date.now()-new Date(r.created_at))/60000); txt+=`[${i+1}] ${r.symbol} ${r.direction.toUpperCase()} Score:${r.signal_score} il y a ${age}min\n    Entrée: $${r.entry_price}\n\n`; });
txt += SEP+’  RÉSOLUS\n’+SEP+’\n’;
resolved.forEach((r,i)=>{ const icon=r.result===‘correct’?‘OK’:r.result===‘neutral’?’->’:‘XX’; const pct=parseFloat(r.pct_change||‘0’); const sign=pct>=0?’+’:’’; txt+=`[${i+1}] ${icon} ${r.symbol} ${r.direction.toUpperCase()} Score:${r.signal_score}\n    Date: ${fmtDate(new Date(r.created_at))}\n    ${sign}${pct.toFixed(2)}% | ${r.pts??'—'}/10 pts\n\n`; });
txt += SEP+’  FIN DU RAPPORT\n’+SEP;
res.setHeader(‘Content-Type’,‘text/plain; charset=utf-8’);
res.setHeader(‘Content-Disposition’,`attachment; filename="tradeye_${new Date().toISOString().slice(0,10)}.txt"`);
res.send(txt);
} catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ── Démarrage ─────────────────────────────────────────────
async function main() {
await initDb();
app.listen(port, () => console.log(`[server] Port ${port}`));
console.log(’[cron] Démarrage (3min)’);
void runCycle();
setInterval(()=>{ void runCycle(); }, 180_000);
}

main().catch(console.error);
