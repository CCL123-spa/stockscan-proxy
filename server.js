const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3000;
const ALLOWED_INTERVALS = ['1d','1wk','1mo'];
const ALLOWED_RANGES    = ['1mo','3mo','6mo','1y','2y','5y'];

// Polygon ticker map: nuestros tickers → formato Polygon
const POLYGON_MAP = {
  // IBEX (Polygon usa OTC para europeas, mejor usar el ticker directo con sufijo)
  'SAN.MC':'SAN','ITX.MC':'ITX','BBVA.MC':'BBVA','IBE.MC':'IBE','TEF.MC':'TEF',
  'REP.MC':'REP','CABK.MC':'CABK','AMS.MC':'AMS','FER.MC':'FER','MAP.MC':'MAP',
  // Eurostoxx
  'ASML.AS':'ASML','MC.PA':'MC','SAP.DE':'SAP','SIE.DE':'SIE','ALV.DE':'ALV',
  'BAS.DE':'BAS','VOW3.DE':'VOW3','AIR.PA':'AIR','DTE.DE':'DTE','AXA.PA':'CS',
  'NOVO-B.CO':'NOVO',
};

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      stream.on('data', chunk => data += chunk);
      stream.on('end', () => resolve({ status: res.statusCode, body: data }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchPolygon(ticker, range, apiKey) {
  // Calcular fechas
  const now  = new Date();
  const from = new Date();
  const rangeDays = { '1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825 };
  from.setDate(now.getDate() - (rangeDays[range] || 365));
  const fromStr = from.toISOString().slice(0,10);
  const toStr   = now.toISOString().slice(0,10);

  // Polygon usa tickers sin sufijo para europeas en su endpoint /v2/aggs
  const polyTicker = POLYGON_MAP[ticker] || ticker;
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(polyTicker)}/range/1/day/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  
  console.log(`[${new Date().toISOString()}] Polygon GET ${polyTicker} ${fromStr}→${toStr}`);
  const result = await httpsGet(url, { 'Accept': 'application/json' });
  console.log(`  -> status ${result.status}, length ${result.body.length}`);
  
  if (result.status !== 200) throw new Error(`Polygon HTTP ${result.status}`);
  const data = JSON.parse(result.body);
  if (data.status === 'ERROR') throw new Error(data.error || 'Polygon error');
  if (!data.results || data.results.length === 0) throw new Error('Sin datos para ' + polyTicker);
  
  return data;
}

// Fallback Yahoo si Polygon falla para europeas
async function fetchYahoo(ticker, interval, range) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`,
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };
  for (const url of urls) {
    try {
      const result = await httpsGet(url, headers);
      if (result.status === 200) return { status: 200, body: JSON.parse(result.body) };
    } catch(e) { console.error('Yahoo error:', e.message); }
  }
  throw new Error('Yahoo no disponible');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u    = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  if (path === '/' || path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'StockScan Proxy', version: '2.0' }));
    return;
  }

  if (path === '/quote') {
    const ticker   = (u.searchParams.get('ticker') || '').toUpperCase().trim();
    const range    = u.searchParams.get('range')    || '1y';
    const interval = u.searchParams.get('interval') || '1d';
    const apiKey   = u.searchParams.get('apikey')   || process.env.POLYGON_API_KEY || '';

    if (!ticker || ticker.length > 12 || !/^[A-Z0-9.\-\^=]+$/.test(ticker)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Ticker invalido' })); return;
    }
    if (!ALLOWED_RANGES.includes(range)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Rango no permitido' })); return;
    }

    try {
      let candles, name, price, currency;

      if (apiKey) {
        // Usar Polygon
        const data = await fetchPolygon(ticker, range, apiKey);
        candles = data.results.map(r => ({
          t: Math.floor(r.t / 1000), // Polygon devuelve ms, convertir a segundos
          o: +r.o.toFixed(4),
          h: +r.h.toFixed(4),
          l: +r.l.toFixed(4),
          c: +r.c.toFixed(4),
          v: r.v,
        }));
        name     = data.ticker || ticker;
        price    = candles[candles.length - 1].c;
        currency = ticker.endsWith('.MC') || ticker.endsWith('.PA') || ticker.endsWith('.DE') || ticker.endsWith('.AS') ? 'EUR' : 'USD';
      } else {
        // Fallback Yahoo
        const result = await fetchYahoo(ticker, interval, range);
        const chart  = result.body?.chart?.result?.[0];
        if (!chart) throw new Error('Ticker no encontrado en Yahoo');
        const timestamps = chart.timestamp || [];
        const quote      = chart.indicators?.quote?.[0] || {};
        const meta       = chart.meta || {};
        candles = timestamps.map((ts, i) => ({
          t: ts,
          o: quote.open?.[i]  != null ? +Number(quote.open[i]).toFixed(4)  : null,
          h: quote.high?.[i]  != null ? +Number(quote.high[i]).toFixed(4)  : null,
          l: quote.low?.[i]   != null ? +Number(quote.low[i]).toFixed(4)   : null,
          c: quote.close?.[i] != null ? +Number(quote.close[i]).toFixed(4) : null,
          v: quote.volume?.[i] ?? null,
        })).filter(d => d.c !== null && !isNaN(d.c));
        name     = meta.longName || meta.shortName || meta.symbol;
        price    = meta.regularMarketPrice;
        currency = meta.currency;
      }

      console.log(`  -> ${ticker}: ${candles.length} velas, último precio=${price}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ticker, name, price, currency, candles }));

    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, () => console.log(`StockScan Proxy v2.0 en puerto ${PORT}`));
