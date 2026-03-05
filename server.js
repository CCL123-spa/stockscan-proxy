const https = require('https');
const http  = require('http');

const PORT = process.env.PORT || 3000;

// Tickers válidos para evitar abuso
const ALLOWED_INTERVALS = ['1d','1wk','1mo'];
const ALLOWED_RANGES    = ['1mo','3mo','6mo','1y','2y','5y'];

function fetchYahoo(ticker, interval, range) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StockScanProxy/1.0)',
        'Accept': 'application/json',
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS — permite peticiones desde cualquier origen (solo la app lo usa)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url    = new URL(req.url, `http://localhost`);
  const path   = url.pathname;

  // Health check
  if (path === '/' || path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'StockScan Proxy', version: '1.0' }));
    return;
  }

  // GET /quote?ticker=AAPL&range=1y&interval=1d
  if (path === '/quote') {
    const ticker   = (url.searchParams.get('ticker') || '').toUpperCase().trim();
    const range    = url.searchParams.get('range')    || '1y';
    const interval = url.searchParams.get('interval') || '1d';

    if (!ticker || ticker.length > 10 || !/^[A-Z0-9.\-\^=]+$/.test(ticker)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Ticker inválido' }));
      return;
    }
    if (!ALLOWED_INTERVALS.includes(interval)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Intervalo no permitido. Usa: ' + ALLOWED_INTERVALS.join(', ') }));
      return;
    }
    if (!ALLOWED_RANGES.includes(range)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Rango no permitido. Usa: ' + ALLOWED_RANGES.join(', ') }));
      return;
    }

    try {
      console.log(`[${new Date().toISOString()}] Fetching ${ticker} ${interval} ${range}`);
      const result = await fetchYahoo(ticker, interval, range);

      if (result.status !== 200) {
        res.writeHead(result.status);
        res.end(JSON.stringify({ error: 'Yahoo Finance devolvió error', status: result.status }));
        return;
      }

      // Extraer y simplificar datos para la app
      const chart  = result.body?.chart?.result?.[0];
      if (!chart) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Ticker no encontrado' }));
        return;
      }

      const timestamps = chart.timestamp || [];
      const quote      = chart.indicators?.quote?.[0] || {};
      const meta       = chart.meta || {};

      const candles = timestamps.map((ts, i) => ({
        t: ts,                                            // unix timestamp
        o: quote.open?.[i]   != null ? +quote.open[i].toFixed(4)   : null,
        h: quote.high?.[i]   != null ? +quote.high[i].toFixed(4)   : null,
        l: quote.low?.[i]    != null ? +quote.low[i].toFixed(4)    : null,
        c: quote.close?.[i]  != null ? +quote.close[i].toFixed(4)  : null,
        v: quote.volume?.[i] != null ? quote.volume[i]              : null,
      })).filter(d => d.c !== null);

      res.writeHead(200);
      res.end(JSON.stringify({
        ticker:   meta.symbol,
        currency: meta.currency,
        name:     meta.longName || meta.shortName || meta.symbol,
        price:    meta.regularMarketPrice,
        candles,
      }));

    } catch(err) {
      console.error('Error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error interno: ' + err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, () => {
  console.log(`StockScan Proxy corriendo en puerto ${PORT}`);
});
