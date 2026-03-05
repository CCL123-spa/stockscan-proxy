const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3000;

const ALLOWED_INTERVALS = ['1d','1wk','1mo'];
const ALLOWED_RANGES    = ['1mo','3mo','6mo','1y','2y','5y'];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
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

async function fetchYahoo(ticker, interval, range) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      console.log(`[${new Date().toISOString()}] GET ${url}`);
      const result = await httpsGet(url, BROWSER_HEADERS);
      console.log(`  -> status ${result.status}, length ${result.body.length}`);
      if (result.status === 200) {
        return { status: 200, body: JSON.parse(result.body) };
      }
      lastError = new Error(`Yahoo HTTP ${result.status}: ${result.body.slice(0,300)}`);
    } catch(e) {
      console.error(`  -> error: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError;
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
    res.end(JSON.stringify({ status: 'ok', service: 'StockScan Proxy', version: '1.1' }));
    return;
  }

  if (path === '/quote') {
    const ticker   = (u.searchParams.get('ticker') || '').toUpperCase().trim();
    const range    = u.searchParams.get('range')    || '1y';
    const interval = u.searchParams.get('interval') || '1d';

    if (!ticker || ticker.length > 12 || !/^[A-Z0-9.\-\^=]+$/.test(ticker)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Ticker invalido: ' + ticker })); return;
    }
    if (!ALLOWED_INTERVALS.includes(interval)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Intervalo no permitido' })); return;
    }
    if (!ALLOWED_RANGES.includes(range)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Rango no permitido' })); return;
    }

    try {
      const result = await fetchYahoo(ticker, interval, range);
      const chart  = result.body?.chart?.result?.[0];
      if (!chart) {
        const errMsg = result.body?.chart?.error?.description || 'Ticker no encontrado';
        res.writeHead(404); res.end(JSON.stringify({ error: errMsg })); return;
      }
      const timestamps = chart.timestamp || [];
      const quote      = chart.indicators?.quote?.[0] || {};
      const meta       = chart.meta || {};
      const candles = timestamps.map((ts, i) => ({
        t: ts,
        o: quote.open?.[i]  != null ? +Number(quote.open[i]).toFixed(4)  : null,
        h: quote.high?.[i]  != null ? +Number(quote.high[i]).toFixed(4)  : null,
        l: quote.low?.[i]   != null ? +Number(quote.low[i]).toFixed(4)   : null,
        c: quote.close?.[i] != null ? +Number(quote.close[i]).toFixed(4) : null,
        v: quote.volume?.[i] ?? null,
      })).filter(d => d.c !== null && !isNaN(d.c));
      console.log(`  -> ${ticker}: ${candles.length} candles`);
      res.writeHead(200);
      res.end(JSON.stringify({ ticker: meta.symbol, currency: meta.currency, name: meta.longName || meta.shortName || meta.symbol, price: meta.regularMarketPrice, candles }));
    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, () => console.log(`StockScan Proxy v1.1 en puerto ${PORT}`));
