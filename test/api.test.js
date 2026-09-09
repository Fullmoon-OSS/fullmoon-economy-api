// HTTP-level tests for the (read-only) economy API: auth, rate limiting, the
// read routes' shapes, and the 405 wall in front of every mutation. Fake pool —
// no database, no wallet.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyApi } from '../src/server.js';
import { parseClients } from '../src/config.js';

const KEY = 'reader-key-0123456789abcdefghijklmn';
const KEY_LEGACY = 'legacy-key-0123456789abcdefghijklmn';

// The second entry still carries the pre-2026-07-12 scopes/source fields: a
// registry written when the API could mint must still boot, minus the powers.
const CLIENTS = parseClients(
  JSON.stringify([
    { name: 'viewer', key: KEY },
    { name: 'lisybot', key: KEY_LEGACY, scopes: ['read', 'grant', 'transfer'], source: 'bot:lisybot' },
  ]),
  { warn: () => {} }
);

// Fake pool. Default: every query returns poolRows; tests needing multiple
// distinct results install a per-SQL handler. Counts queries so a rejected
// mutation can be shown never to have reached the database.
let poolRows = { rows: [], rowCount: 0 };
let poolHandler = null; // (sql, params) => result | undefined
let queries = 0;
const pool = {
  async query(sql, params) {
    queries += 1;
    const scripted = poolHandler?.(sql.replace(/\s+/g, ' '), params);
    return scripted ?? poolRows;
  },
};

let server;
let base;

before(async () => {
  server = createEconomyApi({ clients: CLIENTS, pool, rateLimit: { windowMs: 60_000, max: 1000 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const req = (path, { method = 'GET', key, body } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('health needs no auth and advertises read-only', async () => {
  const r = await req('/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: 'economy-api', readOnly: true });
});

test('missing/wrong bearer key -> 401', async () => {
  assert.equal((await req('/v1/leaderboard')).status, 401);
  assert.equal((await req('/v1/leaderboard', { key: 'x'.repeat(32) })).status, 401);
});

test('every mutation is 405 — including with a valid key, and it never touches the DB', async () => {
  const attempts = [
    ['POST', '/v1/grant', { discordId: '123456789', amount: 10, refId: 'r1' }],
    ['POST', '/v1/revoke', { discordId: '123456789', amount: 10, refId: 'r1' }],
    ['POST', '/v1/transfer', { fromDiscordId: '1', toDiscordId: '2', amount: 10, refId: 'r1' }],
    ['PUT', '/v1/config/reward.multiplier', { value: 99 }],
    ['DELETE', '/v1/config/reward.multiplier', undefined],
    ['PATCH', '/v1/accounts/123456789', { balance: 1e9 }],
  ];
  queries = 0;
  for (const [method, path, body] of attempts) {
    for (const key of [KEY, KEY_LEGACY, undefined]) {
      const r = await req(path, { method, key, body });
      assert.equal(r.status, 405, `${method} ${path} (key=${key ? 'yes' : 'none'})`);
      assert.equal(r.headers.get('allow'), 'GET');
      const b = await r.json();
      assert.equal(b.ok, false);
      assert.match(b.error, /read-only/);
    }
  }
  assert.equal(queries, 0, 'a refused mutation must not reach the database');
});

test('reads: account 404 vs shape, leaderboard shape', async () => {
  poolRows = { rows: [], rowCount: 0 };
  assert.equal((await req('/v1/accounts/123456789', { key: KEY })).status, 404);

  poolRows = { rows: [{ discord_id: '123456789', mc_username: 'Steve', linked: true, amount: '250.0000', rank: '2' }], rowCount: 1 };
  const acc = await (await req('/v1/accounts/123456789', { key: KEY })).json();
  assert.deepEqual(acc, { ok: true, discordId: '123456789', balance: 250, linked: true, mcUsername: 'Steve', rank: 2 });

  // 잔액 0이면 순위 자체가 없다 (SQL CASE의 ELSE NULL 경로).
  poolRows = { rows: [{ discord_id: '123456789', mc_username: 'Steve', linked: true, amount: '0', rank: null }], rowCount: 1 };
  const zero = await (await req('/v1/accounts/123456789', { key: KEY })).json();
  assert.equal(zero.rank, null);

  poolRows = { rows: [{ discord_id: '1', mc_username: null, amount: '10' }], rowCount: 1 };
  const lb = await (await req('/v1/leaderboard?limit=5', { key: KEY })).json();
  assert.deepEqual(lb.leaderboard, [{ rank: 1, discordId: '1', mcUsername: null, balance: 10 }]);
});

test('reads: account transaction history shape (with id for cursoring)', async () => {
  poolHandler = (sql) => sql.includes('FROM transactions t JOIN accounts a')
    ? { rows: [{ id: '900', delta: '50', balance_after: '250', reason: 'quest.win', source: 'bot:lisybot', ref_id: 'lisybot:q1', created_at: '2026-07-11T00:00:00Z' }] }
    : undefined;
  try {
    const body = await (await req('/v1/accounts/123456789/transactions?limit=5', { key: KEY })).json();
    assert.deepEqual(body.transactions[0], {
      id: 900, delta: 50, balanceAfter: 250, reason: 'quest.win', source: 'bot:lisybot',
      refId: 'lisybot:q1', createdAt: '2026-07-11T00:00:00Z',
    });
    assert.equal(body.nextBefore, null); // a short page has no next cursor
  } finally {
    poolHandler = null;
  }
});

test('reads: account transactions accept a before cursor (id-based pagination)', async () => {
  let seenSql;
  poolHandler = (sql) => {
    seenSql = sql.replace(/\s+/g, ' ');
    return seenSql.includes('AND t.id < $3')
      ? { rows: [
          { id: '41', delta: '10', balance_after: '40', reason: 'discord.daily', source: 'bot', ref_id: null, created_at: '2026-07-01T00:00:00Z' },
          { id: '40', delta: '10', balance_after: '30', reason: 'discord.daily', source: 'bot', ref_id: null, created_at: '2026-06-30T00:00:00Z' },
        ], rowCount: 2 }
      : undefined;
  };
  try {
    const body = await (await req('/v1/accounts/123456789/transactions?limit=2&before=42', { key: KEY })).json();
    assert.match(seenSql, /AND t\.id < \$3/);
    assert.match(seenSql, /LIMIT \$2/); // limit still clamped
    assert.equal(body.nextBefore, 40); // oldest id on the page - pass as the next ?before
    assert.deepEqual(body.transactions.map((t) => t.id), [41, 40]);
  } finally {
    poolHandler = null;
  }
});

test('unknown route -> 404', async () => {
  assert.equal((await req('/v1/nope', { key: KEY })).status, 404);
});

test('per-client rate limit -> 429', async () => {
  const tight = createEconomyApi({ clients: CLIENTS, pool, rateLimit: { windowMs: 60_000, max: 2 } });
  await new Promise((r) => tight.listen(0, '127.0.0.1', r));
  const tbase = `http://127.0.0.1:${tight.address().port}`;
  try {
    const hit = () => fetch(`${tbase}/v1/leaderboard`, { headers: { authorization: `Bearer ${KEY}` } });
    poolRows = { rows: [], rowCount: 0 };
    assert.equal((await hit()).status, 200);
    assert.equal((await hit()).status, 200);
    assert.equal((await hit()).status, 429);
  } finally {
    await new Promise((r) => tight.close(r));
  }
});

test('overview: aggregates use the shared classification and shape', async () => {
  poolHandler = (sql) => {
    if (sql.includes('SUM(amount)')) return { rows: [{ total: '5000' }] };
    if (sql.includes('count(*) AS n FROM accounts')) return { rows: [{ n: '42' }] };
    if (sql.includes('AS casino_net') && sql.includes('AS net')) {
      // net is the raw SUM over every row, so it reconciles to the headline plus
      // all four subsystem nets: 300 - 120 - 45 - 8 + 0 - 60 = 67.
      return { rows: [{ mint: '300', burn: '-120', casino_net: '-45', auction_net: '-8', drop_net: '0', shop_net: '-60', transfer_tax: '5', net: '67' }] };
    }
    if (sql.includes('GROUP BY source')) {
      return { rows: [
        { source: 'bot:lisybot', faucet: '200', sink: '0' },
        { source: 'plugin:survival', faucet: '100', sink: '-120' },
      ] };
    }
    return undefined;
  };
  try {
    const r = await req('/v1/overview', { key: KEY });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.totalSupply, 5000);
    assert.equal(body.accounts, 42);
    assert.deepEqual(body.today, { mint: 300, burn: -120, casinoNet: -45, auctionNet: -8, dropNet: 0, shopNet: -60, transferTax: 5, net: 67 });
    assert.equal(body.bySource.length, 2);
    assert.equal(body.bySource[0].source, 'plugin:survival'); // most active first
    assert.equal(body.bySource[0].net, -20);
  } finally {
    poolHandler = null;
  }
});

test('stats/daily: day clamp is passed to SQL; rows map to shape', async () => {
  let seenParams;
  poolHandler = (sql, params) => {
    if (sql.includes('GROUP BY day')) {
      seenParams = params;
      return { rows: [{ day: '2026-07-11', mint: '10', burn: '-3', casino_net: '0', auction_net: '0', drop_net: '0', shop_net: '0', net: '7', active_accounts: '4' }] };
    }
    return undefined;
  };
  try {
    const r = await req('/v1/stats/daily?days=500', { key: KEY });
    assert.equal(r.status, 200);
    assert.deepEqual(seenParams, [90]); // clamped to 90
    const body = await r.json();
    assert.deepEqual(body.days[0], {
      date: '2026-07-11', mint: 10, burn: -3, casinoNet: 0, auctionNet: 0, dropNet: 0, shopNet: 0, net: 7, activeAccounts: 4,
    });
  } finally {
    poolHandler = null;
  }
});

test('transactions/recent: global feed shape + before cursor', async () => {
  poolHandler = (sql, params) => {
    if (!sql.includes('ORDER BY t.id DESC')) return undefined;
    if (sql.includes('WHERE t.id < $2')) {
      assert.deepEqual(params, [5, 500]);
      return { rows: [{ id: '499', discord_id: '123', mc_username: 'Steve', delta: '-50', balance_after: '100', reason: 'casino.slots.wager', source: 'plugin:casino', created_at: '2026-07-11T00:00:00Z' }] };
    }
    return { rows: [{ id: '501', discord_id: '123', mc_username: 'Steve', delta: '-50', balance_after: '100', reason: 'casino.slots.wager', source: 'plugin:casino', created_at: '2026-07-11T00:00:00Z' }] };
  };
  try {
    const body = await (await req('/v1/transactions/recent?limit=5', { key: KEY })).json();
    assert.deepEqual(body.transactions[0], {
      id: 501, discordId: '123', mcUsername: 'Steve', delta: -50, balanceAfter: 100,
      reason: 'casino.slots.wager', source: 'plugin:casino', createdAt: '2026-07-11T00:00:00Z',
    });
    const paged = await (await req('/v1/transactions/recent?limit=5&before=500', { key: KEY })).json();
    assert.equal(paged.transactions[0].id, 499);
    assert.equal(paged.nextBefore, null); // a short page has no next cursor
  } finally {
    poolHandler = null;
  }
});

test('casino/today: per-game burn shape', async () => {
  poolHandler = (sql) => sql.includes('FROM casino_ledger')
    ? { rows: [{ game: 'slots', total_wagered: '500', total_paid_out: '420', net_burn: '-80' }] }
    : undefined;
  try {
    const body = await (await req('/v1/casino/today', { key: KEY })).json();
    assert.deepEqual(body.games[0], { game: 'slots', wagered: 500, paidOut: 420, netBurn: -80 });
  } finally {
    poolHandler = null;
  }
});

test('config: GET lists the shared knobs', async () => {
  poolHandler = (sql) => sql.includes('FROM economy_config')
    ? { rows: [{ key: 'reward.multiplier', value: '1.5', description: '배수', updated_by: 'api:opsbot', updated_at: '2026-07-11T00:00:00Z' }] }
    : undefined;
  try {
    const list = await (await req('/v1/config', { key: KEY })).json();
    assert.deepEqual(list.config[0], {
      key: 'reward.multiplier', value: 1.5, description: '배수',
      updatedBy: 'api:opsbot', updatedAt: '2026-07-11T00:00:00Z',
    });
  } finally {
    poolHandler = null;
  }
});

test('registry: bad entries are rejected, obsolete fields only warn', () => {
  const bad = [
    [[], /non-empty JSON array/],
    [[{ name: 'UPPER', key: 'k'.repeat(32) }], /name must match/],
    [[{ name: 'a', key: 'short' }], /32\+ chars/],
    [[{ name: 'a', key: 'k'.repeat(32) }, { name: 'a', key: 'j'.repeat(32) }], /duplicate name/],
    [[{ name: 'a', key: 'k'.repeat(32) }, { name: 'b', key: 'k'.repeat(32) }], /duplicate key/],
  ];
  for (const [entries, re] of bad) {
    assert.throws(() => parseClients(JSON.stringify(entries), { warn: () => {} }), re);
  }
  assert.throws(() => parseClients('{nope', { warn: () => {} }), /not valid JSON/);

  const warnings = [];
  const parsed = parseClients(
    JSON.stringify([{ name: 'old', key: 'k'.repeat(32), scopes: ['grant'], source: 'bot:old' }]),
    { warn: (m) => warnings.push(m) }
  );
  assert.deepEqual(parsed, [{ name: 'old', key: 'k'.repeat(32) }]); // scopes/source dropped
  assert.match(warnings[0], /obsolete/);
});

// -- launcher by-mc reads ----------------------------------------------------

test('by-mc returns the wallet and the newest 30 transactions for a linked username', async () => {
  const seen = [];
  poolHandler = (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM accounts a LEFT JOIN balances b')) {
      return {
        rows: [{ id: 7, discord_id: '12345678901234567', mc_username: 'BlackCow', linked: true, amount: '128450.0000', updated_at: new Date('2026-09-01T12:00:00Z'), rank: '4' }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM transactions WHERE account_id = $1')) {
      return {
        rows: [
          { delta: '-3500', balance_after: '128450.0000', reason: 'discord.shop.buy', source: 'bot', ref_id: 'shop:1', created_at: new Date('2026-08-22T20:12:00Z') },
          { delta: '1200', balance_after: '131950.0000', reason: 'discord.daily', source: 'bot', ref_id: 'daily:2026-08-22', created_at: new Date('2026-08-22T09:02:00Z') },
        ],
        rowCount: 2,
      };
    }
    return undefined;
  };
  try {
    const r = await req('/v1/accounts/by-mc/BlackCow', { key: KEY });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.wallet, { currency: '원', balance: 128450, updatedAt: '2026-09-01T12:00:00.000Z', rank: 4 });
    assert.equal(body.transactions.length, 2);
    assert.equal(body.transactions[0].label, '상점 구매'); // bot-owned vocabulary, imported not forked
    assert.equal(body.transactions[1].at, '2026-08-22T09:02:00.000Z');
    // the lookup is by username, never by raw id interpolation
    assert.deepEqual(seen[0].params, ['BlackCow']);
  } finally {
    poolHandler = null;
  }
});

test('by-mc is 404 when no account carries that username', async () => {
  poolHandler = (sql) =>
    sql.includes('FROM accounts a LEFT JOIN balances b') ? { rows: [], rowCount: 0 } : undefined;
  try {
    const r = await req('/v1/accounts/by-mc/Nobody', { key: KEY });
    assert.equal(r.status, 404);
  } finally {
    poolHandler = null;
  }
});

test('by-mc is behind the same auth wall as every other read', async () => {
  const r = await req('/v1/accounts/by-mc/BlackCow');
  assert.equal(r.status, 401);
});

// -- community module reads (added from demo scenarios) ----------------------

test('events: active events for timer bots', async () => {
  poolHandler = (sql) => sql.includes('FROM events WHERE active = true')
    ? { rows: [
        { name: '두 배 드롭', kind: 'drop_rate', multiplier: '2', starts_at: '2026-09-08T00:00:00Z', ends_at: '2026-09-10T00:00:00Z' },
        { name: '출석 보너스', kind: 'faucet_boost', multiplier: '1.5', starts_at: '2026-09-09T00:00:00Z', ends_at: null },
      ], rowCount: 2 }
    : undefined;
  try {
    const body = await (await req('/v1/events', { key: KEY })).json();
    assert.equal(body.events.length, 2);
    assert.deepEqual(body.events[0], {
      name: '두 배 드롭', kind: 'drop_rate', multiplier: 2,
      startsAt: '2026-09-08T00:00:00Z', endsAt: '2026-09-10T00:00:00Z',
    });
    assert.equal(body.events[1].endsAt, null); // no end date = runs until deactivated
  } finally {
    poolHandler = null;
  }
});

test('events: empty list when nothing is active', async () => {
  poolHandler = (sql) => sql.includes('FROM events WHERE active = true')
    ? { rows: [], rowCount: 0 } : undefined;
  try {
    const body = await (await req('/v1/events', { key: KEY })).json();
    assert.deepEqual(body, { ok: true, events: [] });
  } finally {
    poolHandler = null;
  }
});

test('guilds: fund ranking with member counts', async () => {
  poolHandler = (sql) => sql.includes('FROM guilds g LEFT JOIN guild_members m')
    ? { rows: [
        { name: '달빛기사단', fund_balance: '50000', members: '12' },
        { name: '별빛상회', fund_balance: '1234', members: '3' },
      ], rowCount: 2 }
    : undefined;
  try {
    const body = await (await req('/v1/guilds?limit=10', { key: KEY })).json();
    assert.deepEqual(body.guilds, [
      { name: '달빛기사단', fund: 50000, members: 12 },
      { name: '별빛상회', fund: 1234, members: 3 },
    ]);
  } finally {
    poolHandler = null;
  }
});

test('casino/history: per-day burn series with clamped days', async () => {
  let seenSql; let seenParams;
  poolHandler = (sql, params) => {
    if (sql.includes('FROM casino_ledger') && sql.includes('- ($1::int - 1)')) {
      seenSql = sql.replace(/\s+/g, ' ');
      seenParams = params;
      return { rows: [
        { date: '2026-09-07', total_wagered: '500', total_paid_out: '450', net_burn: '50' },
        { date: '2026-09-08', total_wagered: '800', total_paid_out: '900', net_burn: '-100' },
      ], rowCount: 2 };
    }
    return undefined;
  };
  try {
    const r = await req('/v1/casino/history?days=400', { key: KEY });
    assert.equal(r.status, 200);
    assert.deepEqual(seenParams, [90]); // clamped to 90
    assert.match(seenSql, /GROUP BY period/); // per-day aggregate, not per game×day
    const body = await r.json();
    assert.deepEqual(body.days[1], { date: '2026-09-08', wagered: 800, paidOut: 900, netBurn: -100 });
  } finally {
    poolHandler = null;
  }
});
