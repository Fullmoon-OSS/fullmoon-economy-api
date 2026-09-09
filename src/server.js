// Economy API server factory. Dependency-injected ({ clients, pool }) so the
// whole HTTP surface is testable without a database.
//
// READ-ONLY BY CONSTRUCTION
// ------------------------
// This service can only SELECT. It holds no ledger, imports no wallet, and
// every non-GET request is refused with 405 before it can reach a query.
//
// It used to expose /v1/grant, /v1/revoke, /v1/transfer and config writes for
// third-party bots. That surface is gone (2026-07-12): the economy has a single
// owner, so the only writers are the bot process and the MC plugin, both of
// which talk to PostgreSQL directly. Nothing was gained by letting a bearer
// token mint money over the internet — and nginx does publish this service at
// https://api.fullmoon.ink/economy/, so a leaked key would have done exactly
// that. A leaked key now leaks reads.
//
// Reads are plain MVCC snapshots: always consistent, never blocking a writer.
// The aggregate endpoints reuse the bot's own TX_FILTERS classification, so a
// third-party dashboard cannot disagree with the numbers /경제현황 prints.

import http from 'node:http';
import crypto from 'node:crypto';
import { rowToSourceBreakdown, rankByActivity, TX_FILTERS, TRANSFER_TAX_SUM } from './vocabulary/economy-breakdown.js';
import { txLabel } from './vocabulary/txLabel.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * Build the HTTP server (not yet listening).
 *   clients : parsed registry (config.js parseClients)
 *   pool    : pg pool for the read queries
 *   rateLimit: { windowMs, max } fixed window per client
 */
export function createEconomyApi({ clients, pool, rateLimit = { windowMs: 10_000, max: 60 } }) {
  const byKeyHash = new Map(clients.map((c) => [sha256(c.key).toString('hex'), c]));
  const buckets = new Map(); // client name -> { windowStart, count }

  function authenticate(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const presented = sha256(header.slice(7));
    // Constant-time match against each registered key hash (registry is tiny).
    for (const [hashHex, client] of byKeyHash) {
      if (crypto.timingSafeEqual(presented, Buffer.from(hashHex, 'hex'))) return client;
    }
    return null;
  }

  function allowRate(client) {
    const now = Date.now();
    const b = buckets.get(client.name);
    if (!b || now - b.windowStart >= rateLimit.windowMs) {
      buckets.set(client.name, { windowStart: now, count: 1 });
      return true;
    }
    b.count += 1;
    return b.count <= rateLimit.max;
  }

  function send(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/v1/health') {
      return send(res, 200, { ok: true, service: 'economy-api', readOnly: true });
    }

    // Refused before authentication, before the body is even read: an old
    // integration-kit client pointed at /v1/grant gets a legible 405 rather than
    // a 404 that reads like a typo.
    if (req.method !== 'GET') {
      return send(res, 405, {
        ok: false,
        error: 'economy-api is read-only — grant/revoke/transfer and config writes were removed on 2026-07-12',
        hint: 'balances move only through the Discord bot and the MC plugin',
      }, { allow: 'GET' });
    }

    const client = authenticate(req);
    if (!client) return send(res, 401, { ok: false, error: 'unauthorized' });
    if (!allowRate(client)) return send(res, 429, { ok: false, error: 'rate limited' });

    const accountMatch = path.match(/^\/v1\/accounts\/(\d{5,25})$/);
    if (accountMatch) {
      const r = await pool.query(
        `SELECT a.discord_id, a.mc_username, a.linked_at IS NOT NULL AS linked,
                COALESCE(b.amount, 0) AS amount,
                CASE WHEN COALESCE(b.amount, 0) > 0
                     THEN (SELECT COUNT(*) + 1 FROM balances b2 WHERE b2.amount > b.amount)
                     ELSE NULL END AS rank
         FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
         WHERE a.discord_id = $1`,
        [accountMatch[1]]
      );
      if (r.rowCount === 0) return send(res, 404, { ok: false, error: 'no such account' });
      const row = r.rows[0];
      return send(res, 200, {
        ok: true,
        discordId: String(row.discord_id),
        balance: Number(row.amount),
        linked: row.linked,
        mcUsername: row.mc_username ?? null,
        rank: row.rank === null ? null : Number(row.rank),
      });
    }

    const txMatch = path.match(/^\/v1\/accounts\/(\d{5,25})\/transactions$/);
    if (txMatch) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
      // before = id 커서: 이보다 오래된 항목만 (CSV 내보내기 같은 페이지네이션용).
      const beforeRaw = Number(url.searchParams.get('before')) || 0;
      const before = beforeRaw > 0 ? beforeRaw : null;
      const r = await pool.query(
        `SELECT t.id, t.delta, t.balance_after, t.reason, t.source, t.ref_id, t.created_at
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE a.discord_id = $1 ${before ? 'AND t.id < $3' : ''}
         ORDER BY t.id DESC LIMIT $2`,
        before ? [txMatch[1], limit, before] : [txMatch[1], limit]
      );
      const transactions = r.rows.map((t) => ({
        id: Number(t.id),
        delta: Number(t.delta),
        balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
        reason: t.reason, source: t.source, refId: t.ref_id,
        createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at,
      }));
      return send(res, 200, {
        ok: true,
        transactions,
        // 다음 페이지용 커서: 이번 페이지의 가장 오래된 항목 id. 더 없으면 null.
        nextBefore: transactions.length === limit ? transactions[transactions.length - 1].id : null,
      });
    }

    // -- launcher reads -------------------------------------------------------
    // The launcher knows a Minecraft identity, not a Discord id (AGENTS: one
    // linked account per mc username). Same reads as above, same auth wall,
    // zero new powers — this is the player-shaped alias of /v1/accounts/:id.
    const byMcMatch = path.match(/^\/v1\/accounts\/by-mc\/([A-Za-z0-9_]{3,16})$/);
    if (byMcMatch) {
      const acc = await pool.query(
        `SELECT a.id, a.discord_id, a.mc_username, a.linked_at IS NOT NULL AS linked,
                COALESCE(b.amount, 0) AS amount,
                COALESCE(b.updated_at, a.linked_at, now()) AS updated_at,
                CASE WHEN COALESCE(b.amount, 0) > 0
                     THEN (SELECT COUNT(*) + 1 FROM balances b2 WHERE b2.amount > b.amount)
                     ELSE NULL END AS rank
         FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
         WHERE a.mc_username = $1
         ORDER BY a.linked_at DESC NULLS LAST LIMIT 1`,
        [byMcMatch[1]]
      );
      if (acc.rowCount === 0) {
        return send(res, 404, { ok: false, error: 'no linked account for that username' });
      }
      const row = acc.rows[0];
      const tx = await pool.query(
        `SELECT delta, balance_after, reason, source, ref_id, created_at
           FROM transactions WHERE account_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 30`,
        [row.id]
      );
      return send(res, 200, {
        ok: true,
        wallet: {
          currency: '원',
          balance: Number(row.amount),
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
          rank: row.rank === null ? null : Number(row.rank),
        },
        transactions: tx.rows.map((t) => ({
          delta: Number(t.delta),
          reason: t.reason,
          // the bot owns the label vocabulary — this file is a synced copy of
          // it (see src/vocabulary/); edit the bot, then sync here byte-for-byte
          label: txLabel(t.reason),
          balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
          at: t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at,
        })),
      });
    }

    // -- dashboard reads -------------------------------------------------------
    // Aggregate views built on the SAME classification fragments (TX_FILTERS)
    // the bot's /경제현황 uses, so a third-party dashboard can never disagree
    // with the in-Discord numbers.

    if (path === '/v1/overview') {
      const [supply, accounts, today, bySourceRows] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM balances'),
        pool.query('SELECT count(*) AS n FROM accounts'),
        pool.query(
          `SELECT
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.mint}), 0) AS mint,
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.burn}), 0) AS burn,
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.casino}), 0) AS casino_net,
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.auction}), 0) AS auction_net,
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.drop}), 0) AS drop_net,
             COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.shop}), 0) AS shop_net,
             ${TRANSFER_TAX_SUM} AS transfer_tax,
             COALESCE(SUM(delta), 0) AS net
           FROM transactions WHERE created_at::date = (now() AT TIME ZONE 'UTC')::date`
        ),
        pool.query(
          `SELECT source,
                  COALESCE(SUM(delta) FILTER (WHERE delta > 0 AND ${TX_FILTERS.nonTransfer}), 0) AS faucet,
                  COALESCE(SUM(delta) FILTER (WHERE delta < 0 AND ${TX_FILTERS.nonTransfer}), 0) AS sink
             FROM transactions
            WHERE created_at::date = (now() AT TIME ZONE 'UTC')::date
            GROUP BY source`
        ),
      ]);
      return send(res, 200, {
        ok: true,
        totalSupply: Number(supply.rows[0].total),
        accounts: Number(accounts.rows[0].n),
        today: {
          mint: Number(today.rows[0].mint),
          burn: Number(today.rows[0].burn),
          casinoNet: Number(today.rows[0].casino_net),
          auctionNet: Number(today.rows[0].auction_net),
          dropNet: Number(today.rows[0].drop_net),
          shopNet: Number(today.rows[0].shop_net),
          transferTax: Number(today.rows[0].transfer_tax),
          net: Number(today.rows[0].net),
        },
        bySource: rankByActivity(bySourceRows.rows.map(rowToSourceBreakdown)),
      });
    }

    if (path === '/v1/stats/daily') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 1), 90);
      const r = await pool.query(
        `SELECT created_at::date AS day,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.mint}), 0) AS mint,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.burn}), 0) AS burn,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.casino}), 0) AS casino_net,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.auction}), 0) AS auction_net,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.drop}), 0) AS drop_net,
                COALESCE(SUM(delta) FILTER (WHERE ${TX_FILTERS.shop}), 0) AS shop_net,
                COALESCE(SUM(delta), 0) AS net,
                count(DISTINCT account_id) AS active_accounts
           FROM transactions
          WHERE created_at >= (now() AT TIME ZONE 'UTC')::date - ($1 - 1) * INTERVAL '1 day'
          GROUP BY day ORDER BY day`,
        [days]
      );
      return send(res, 200, {
        ok: true,
        days: r.rows.map((row) => ({
          date: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
          mint: Number(row.mint),
          burn: Number(row.burn),
          casinoNet: Number(row.casino_net),
          auctionNet: Number(row.auction_net),
          dropNet: Number(row.drop_net),
          shopNet: Number(row.shop_net),
          net: Number(row.net),
          activeAccounts: Number(row.active_accounts),
        })),
      });
    }

    if (path === '/v1/transactions/recent') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
      const beforeRaw = Number(url.searchParams.get('before')) || 0;
      const before = beforeRaw > 0 ? beforeRaw : null;
      const r = await pool.query(
        `SELECT t.id, a.discord_id, a.mc_username, t.delta, t.balance_after, t.reason, t.source, t.created_at
           FROM transactions t JOIN accounts a ON a.id = t.account_id
          ${before ? 'WHERE t.id < $2' : ''}
          ORDER BY t.id DESC LIMIT $1`,
        before ? [limit, before] : [limit]
      );
      const transactions = r.rows.map((t) => ({
        id: Number(t.id),
        discordId: t.discord_id === null ? null : String(t.discord_id),
        mcUsername: t.mc_username ?? null,
        delta: Number(t.delta),
        balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
        reason: t.reason,
        source: t.source,
        createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : t.created_at,
      }));
      return send(res, 200, {
        ok: true,
        transactions,
        nextBefore: transactions.length === limit ? transactions[transactions.length - 1].id : null,
      });
    }

    if (path === '/v1/casino/today') {
      const r = await pool.query(
        `SELECT game, total_wagered, total_paid_out, net_burn
           FROM casino_ledger WHERE period = (now() AT TIME ZONE 'UTC')::date ORDER BY game`
      );
      return send(res, 200, {
        ok: true,
        games: r.rows.map((row) => ({
          game: row.game,
          wagered: Number(row.total_wagered),
          paidOut: Number(row.total_paid_out),
          netBurn: Number(row.net_burn),
        })),
      });
    }

    // -- community module reads -------------------------------------------------
    // 이 경로들은 데모 모듈을 실제로 만들다가 발견한 갭들이다 (EventTracker,
    // GuildBoard, CasinoMonitor 시나리오). 같은 규칙: GET 전용, clamp, 원장 읽기.

    // EventScheduler가 쓰는 events 테이블의 진행 중 이벤트. 이벤트 타이머 봇이
    // 폴링하는 용도 — 쓰기는 여전히 운영자 봇만 가능하다.
    if (path === '/v1/events') {
      const r = await pool.query(
        `SELECT name, kind, multiplier, starts_at, ends_at
           FROM events WHERE active = true
          ORDER BY starts_at ASC LIMIT 25`
      );
      return send(res, 200, {
        ok: true,
        events: r.rows.map((e) => ({
          name: e.name,
          kind: e.kind,
          multiplier: Number(e.multiplier),
          startsAt: e.starts_at instanceof Date ? e.starts_at.toISOString() : e.starts_at,
          endsAt: e.ends_at instanceof Date ? e.ends_at.toISOString() : e.ends_at,
        })),
      });
    }

    // 길드 랭킹 보드용: 기금 내림차순 길드 목록 + 멤버 수.
    if (path === '/v1/guilds') {
      const r = await pool.query(
        `SELECT g.name, g.fund_balance, COUNT(m.account_id)::int AS members
           FROM guilds g LEFT JOIN guild_members m ON m.guild_id = g.id
          GROUP BY g.id, g.name, g.fund_balance
          ORDER BY g.fund_balance DESC, g.name ASC LIMIT 25`
      );
      return send(res, 200, {
        ok: true,
        guilds: r.rows.map((g) => ({
          name: g.name,
          fund: Number(g.fund_balance),
          members: Number(g.members),
        })),
      });
    }

    // 카지노 건전성 모니터용 일별 이력: net_burn >= 0이면 디플레이션 정상.
    // period는 DATE 컬럼 — $1::int 캐스트가 없으면 파라미터가 float8으로
    // 추론되어 'date - double precision' 연산자가 없다고 500이 난다.
    // 게임별 행을 일별로 합친다 (casino_ledger PK = (game, period)).
    if (path === '/v1/casino/history') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 90);
      const r = await pool.query(
        `SELECT period::text AS date, SUM(total_wagered) AS total_wagered,
                SUM(total_paid_out) AS total_paid_out, SUM(net_burn) AS net_burn
           FROM casino_ledger
          WHERE period >= (now() AT TIME ZONE 'UTC')::date - ($1::int - 1)
          GROUP BY period
          ORDER BY period ASC`,
        [days]
      );
      return send(res, 200, {
        ok: true,
        days: r.rows.map((row) => ({
          date: row.date,
          wagered: Number(row.total_wagered),
          paidOut: Number(row.total_paid_out),
          netBurn: Number(row.net_burn),
        })),
      });
    }

    // The shared balance knobs (faucet cap, multipliers). Readable so a client
    // can scale its own numbers; writable only from the operator's side now.
    if (path === '/v1/config') {
      const r = await pool.query(
        'SELECT key, value, description, updated_by, updated_at FROM economy_config ORDER BY key'
      );
      return send(res, 200, {
        ok: true,
        config: r.rows.map((c) => ({
          key: c.key,
          value: Number(c.value),
          description: c.description ?? null,
          updatedBy: c.updated_by ?? null,
          updatedAt: c.updated_at instanceof Date ? c.updated_at.toISOString() : c.updated_at,
        })),
      });
    }

    if (path === '/v1/leaderboard') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
      const r = await pool.query(
        `SELECT a.discord_id, a.mc_username, b.amount
         FROM balances b JOIN accounts a ON a.id = b.account_id
         WHERE b.amount > 0 ORDER BY b.amount DESC, a.id ASC LIMIT $1`,
        [limit]
      );
      return send(res, 200, {
        ok: true,
        leaderboard: r.rows.map((row, i) => ({
          rank: i + 1,
          discordId: row.discord_id === null ? null : String(row.discord_id),
          mcUsername: row.mc_username ?? null,
          balance: Number(row.amount),
        })),
      });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[api] unhandled:', err);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } catch { /* headers already sent */ }
    });
  });
}
