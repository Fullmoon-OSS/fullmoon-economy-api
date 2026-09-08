// economy-api entry point.
//
// Read-only: this process holds a pg pool and nothing else. It does not import
// the wallet, so there is no code path from an HTTP request to a balance write
// — the bot process and the MC plugin are the only writers on the database.

import 'dotenv/config';
import pg from 'pg';
import { parseClients } from './config.js';
import { createEconomyApi } from './server.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}
if (!process.env.ECONOMY_API_CLIENTS) {
  console.error('FATAL: ECONOMY_API_CLIENTS is not set (see .env.example)');
  process.exit(1);
}

let clients;
try {
  clients = parseClients(process.env.ECONOMY_API_CLIENTS);
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (err) => console.error('idle pg client error:', err.message));

const server = createEconomyApi({
  clients,
  pool,
  rateLimit: {
    windowMs: Number(process.env.ECONOMY_API_RATE_WINDOW_MS) || 10_000,
    max: Number(process.env.ECONOMY_API_RATE_MAX) || 60,
  },
});

// Localhost by default: remote bots should come in over a reverse proxy /
// tailnet, not a raw exposed port.
const host = process.env.ECONOMY_API_HOST || '127.0.0.1';
const port = Number(process.env.ECONOMY_API_PORT) || 8790;
server.listen(port, host, () => {
  console.log(`[economy-api] listening (read-only) on http://${host}:${port} — clients: ${clients.map((c) => c.name).join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[economy-api] ${sig} — shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
