const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3000;
const ALLOWED_RANGES = ['1mo','3mo','6mo','1y','2y','5y'];

const POLYGON_MAP = {
  'SAN.MC':'SAN','ITX.MC':'ITX','BBVA.MC':'BBVA','IBE.MC':'IBE','TEF.MC':'TEF',
  'REP.MC':'REP','CABK.MC':'CABK','AMS.MC':'AMS','FER.MC':'FER','MAP.MC':'MAP',
  'ASML.AS':'ASML','MC.PA':'MC','SAP.DE':'SAP','SIE.DE':'SIE','ALV.DE':'ALV',
  'BAS.DE':'BAS','VOW3.DE':'VOW3','AIR.PA':'AIR','DTE.DE':'DTE','AXA.PA':'CS',
  'NOVO-B.CO':'NOVO',
};

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')         stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      stream.on('data', chunk => data += chunk);
      stream.on('end',  () => resolve({ status: res.statusCode, body: data }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchPolygon(ticker, range, apiKey) {
  const now = new Date(), from = new Date();
  const days = { '1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825 };
  from.setDate(now.getDate() - (days[range] || 365));
  const poly = POLYGON_MAP[ticker] || ticker;
  const url  = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(poly)}/range/1/day/${from.toISOString().slice(0,10)}/${now.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const r    = await httpsGet(url, { 'Accept': 'application/json' });
  if (r.status !== 200) throw new Error(`Polygon HTTP ${r.status}`);
  const data = JSON.parse(r.body);
  if (data.status === 'ERROR') throw new Error(data.error || 'Polygon error');
  if (!data.results?.length)   throw new Error('Sin datos para ' + poly);
  return data;
}

async function fetchYahoo(ticker, interval, range) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/',
  };
  for (const host of ['query1', 'query2']) {
    try {
      const r = await httpsGet(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`, headers);
      if (r.status === 200) return JSON.parse(r.body);
    } catch(e) { /* try next */ }
  }
  throw new Error('Yahoo no disponible');
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'StockScan Proxy', version: '2.1' }));
    return;
  }

  if (u.pathname === '/quote') {
    const ticker   = (u.searchParams.get('ticker') || '').toUpperCase().trim();
    const range    = u.searchParams.get('range')    || '1y';
    const interval = u.searchParams.get('interval') || '1d';
    const apiKey   = u.searchParams.get('apikey')   || process.env.POLYGON_API_KEY || '';

    if (!ticker || ticker.length > 12 || !/^[A-Z0-9.\-\^=]+$/.test(ticker)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Ticker inválido' })); return;
    }
    if (!ALLOWED_RANGES.includes(range)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Rango no permitido' })); return;
    }

    try {
      let candles, name, price, currency;

      if (apiKey) {
        const data = await fetchPolygon(ticker, range, apiKey);
        candles  = data.results.map(r => ({
          t: Math.floor(r.t/1000),
          o: +r.o.toFixed(4), h: +r.h.toFixed(4), l: +r.l.toFixed(4), c: +r.c.toFixed(4), v: r.v,
        }));
        name     = data.ticker || ticker;
        price    = candles.at(-1).c;
        currency = /\.(MC|PA|DE|AS|CO)$/.test(ticker) ? 'EUR' : 'USD';
      } else {
        const body  = await fetchYahoo(ticker, interval, range);
        const chart = body?.chart?.result?.[0];
        if (!chart) throw new Error('Ticker no encontrado');
        const ts = chart.timestamp || [], q = chart.indicators?.quote?.[0] || {}, meta = chart.meta || {};
        candles  = ts.map((t,i) => ({
          t, o: +Number(q.open?.[i]).toFixed(4), h: +Number(q.high?.[i]).toFixed(4),
             l: +Number(q.low?.[i]).toFixed(4),  c: +Number(q.close?.[i]).toFixed(4), v: q.volume?.[i]??null,
        })).filter(d => d.c && !isNaN(d.c));
        name     = meta.longName || meta.shortName || ticker;
        price    = meta.regularMarketPrice;
        currency = meta.currency;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ticker, name, price, currency, candles }));
    } catch(err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));

}).listen(PORT, () => console.log(`StockScan Proxy v2.1 en puerto ${PORT}`));
