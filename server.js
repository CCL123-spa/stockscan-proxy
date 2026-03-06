const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3000;
const ALLOWED_RANGES = ['1mo','3mo','6mo','1y','2y','5y'];

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
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from.toISOString().slice(0,10)}/${now.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;
  const r   = await httpsGet(url, { 'Accept': 'application/json' });
  if (r.status !== 200) throw new Error(`Polygon HTTP ${r.status}`);
  const data = JSON.parse(r.body);
  if (data.status === 'ERROR') throw new Error(data.error || 'Polygon error');
  if (!data.results?.length)   throw new Error('Sin datos para ' + ticker);
  return data;
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
    res.end(JSON.stringify({ status: 'ok', service: 'StockScan Proxy', version: '3.0' }));
    return;
  }

  if (u.pathname === '/quote') {
    const ticker  = (u.searchParams.get('ticker') || '').toUpperCase().trim();
    const range   = u.searchParams.get('range')   || '1y';
    const apiKey  = u.searchParams.get('apikey')  || process.env.POLYGON_API_KEY || '';

    if (!ticker || ticker.length > 10 || !/^[A-Z0-9\-]+$/.test(ticker)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Ticker inválido (solo US)' })); return;
    }
    if (!ALLOWED_RANGES.includes(range)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Rango no permitido' })); return;
    }
    if (!apiKey) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'API key requerida' })); return;
    }

    try {
      const data   = await fetchPolygon(ticker, range, apiKey);
      const candles = data.results.map(r => ({
        t: Math.floor(r.t/1000),
        o: +r.o.toFixed(4), h: +r.h.toFixed(4), l: +r.l.toFixed(4), c: +r.c.toFixed(4), v: r.v,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ ticker, name: ticker, price: candles.at(-1).c, currency: 'USD', candles }));
    } catch(err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));

}).listen(PORT, () => console.log(`StockScan Proxy v3.0 en puerto ${PORT}`));
