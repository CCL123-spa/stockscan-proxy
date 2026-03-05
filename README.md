# StockScan Proxy

Proxy ligero para Yahoo Finance. Resuelve CORS para la PWA StockScan.

## Endpoints

- `GET /health` — estado del servidor
- `GET /quote?ticker=AAPL&range=1y&interval=1d` — datos históricos

### Parámetros
| Param | Opciones | Default |
|-------|----------|---------|
| ticker | cualquier ticker válido (AAPL, SAN.MC, ASML.AS…) | — |
| range | 1mo, 3mo, 6mo, 1y, 2y, 5y | 1y |
| interval | 1d, 1wk, 1mo | 1d |

## Deploy en Render

1. Fork este repo
2. Nuevo Web Service en render.com
3. Build command: (vacío)
4. Start command: `node server.js`
5. Plan: Free

## Tickers por mercado
- IBEX: `SAN.MC`, `ITX.MC`, `IBE.MC`, `BBVA.MC`
- Eurostoxx: `ASML.AS`, `MC.PA`, `SAP.DE`
- S&P 500: `AAPL`, `MSFT`, `NVDA`
- NASDAQ: `META`, `AMZN`, `GOOGL`
