// SYNCED COPY — the canonical source lives in the operator monorepo:
//   coin-bridge-bot/src/economy-breakdown.js
// Edit there first, then copy this file byte-for-byte and bump the sync date.
// A divergent copy becomes a second definition of "what counts as mint/burn",
// and the disagreement shows up as dashboards that disagree with /경제현황.
// Synced: 2026-09-08 (Fullmoon-OSS extraction).
//
// Pure transforms + SQL predicate fragments for economy measurement. Extracted
// from db.js (which throws on import without DATABASE_URL) so the shape
// contract can be unit-tested in isolation AND so economy-api can build the
// exact same aggregate queries without importing db.js — one definition of
// "what counts as mint/burn" for every dashboard and command.

/**
 * Subsystems whose gross ledger legs recycle internally rather than changing the
 * money supply: casino wager↔payout, auction bid↔refund↔sale, drop escrow↔pick↔
 * refund, shop buy↔refund. Each is pulled OUT of the mint/burn headline and
 * reported as its own net line — SUM(delta) over the subsystem is its real
 * effect: casino house edge, auction fee, shop net spend (a real sink), drop
 * redistribution (zero — a drop moves coin from dropper to picker, or back on
 * expiry, minting nothing). Counting a gross leg as mint or burn double-counts
 * every reversal — an outbid war, an expired drop, a failed-role refund — as a
 * phantom supply change even though the coins never left circulation.
 *
 * The SQL LIKE prefix here and the startsWith prefix in classifyLedgerRow() are
 * the SAME list, in lockstep — add a subsystem to BOTH. The `<prefix>.%.refund`
 * legs still match `%.refund` too, which the faucet cap already excludes; the
 * subsystem filter is what keeps the escrow/gross legs out of the headline.
 */
export const SUBSYSTEM_FILTERS = {
  casino: `reason LIKE 'casino.%'`,
  auction: `reason LIKE 'discord.auction.%'`,
  drop: `reason LIKE 'discord.drop.%'`,
  shop: `reason LIKE 'discord.shop.%'`,
};
const SUBSYSTEM_PREFIXES = { casino: 'casino.', auction: 'discord.auction.', drop: 'discord.drop.', shop: 'discord.shop.' };
const NOT_SUBSYSTEM = Object.values(SUBSYSTEM_FILTERS).map((f) => `NOT (${f})`).join(' AND ');

/**
 * Transaction-classification WHERE fragments (V7 earned_today_capped-aligned).
 * Interpolated into aggregate SQL — no user input, constants only.
 *   mint  : true currency creation — a positive delta that is not a transfer
 *           leg, not a refund reversal, and not a subsystem gross leg.
 *   burn  : true destruction — a negative delta that is not a transfer leg and
 *           not a subsystem gross leg.
 *   casino/auction/drop/shop : every row of that subsystem; SUM(delta) = its net.
 * classifyLedgerRow() below is the JS mirror of these predicates — change BOTH.
 */
export const TX_FILTERS = {
  mint: `delta > 0 AND reason <> 'discord.transfer' AND reason NOT LIKE '%.refund' AND ${NOT_SUBSYSTEM}`,
  burn: `delta < 0 AND reason <> 'discord.transfer' AND ${NOT_SUBSYSTEM}`,
  ...SUBSYSTEM_FILTERS,
  nonTransfer: `reason <> 'discord.transfer'`,
};

/**
 * Transfer-tax burn, as a SUM expression (not a row filter): the tax is the
 * asymmetry between a /송금's two legs, recorded in both legs' metadata.tax.
 * Both legs carry reason 'discord.transfer', which mint/burn exclude — so
 * without this expression the burned tax is invisible in every headline and
 * only shows up as an unexplained gap between (mint+burn+subsystem nets) and
 * the raw net. Summed over the SENDER leg only (delta < 0) so each transfer
 * counts its tax exactly once.
 */
export const TRANSFER_TAX_SUM =
  `COALESCE(SUM((metadata->>'tax')::numeric) FILTER (WHERE reason = 'discord.transfer' AND delta < 0), 0)`;

/** JS mirror of TRANSFER_TAX_SUM for one ledger row {delta, reason, metadata}. */
export function transferTaxOf({ delta, reason, metadata }) {
  if (reason !== 'discord.transfer' || !(delta < 0)) return 0;
  const tax = Number(metadata?.tax);
  return Number.isFinite(tax) && tax > 0 ? tax : 0;
}

/**
 * JS mirror of the TX_FILTERS SQL predicates for a single ledger row
 * {delta, reason}. Kept adjacent so the two stay in lockstep: the SQL runs in
 * economyOverview(), this runs in tests and any JS-side aggregation. A row
 * belongs to at most one subsystem; subsystem rows are pulled out of the
 * mint/burn headline and reported as that subsystem's net instead.
 */
export function classifyLedgerRow({ delta, reason }) {
  const isTransfer = reason === 'discord.transfer';
  const isRefund = reason.endsWith('.refund');
  const sub = Object.keys(SUBSYSTEM_PREFIXES).find((k) => reason.startsWith(SUBSYSTEM_PREFIXES[k])) ?? null;
  return {
    mint: delta > 0 && !isTransfer && !isRefund && !sub,
    burn: delta < 0 && !isTransfer && !sub,
    casino: sub === 'casino',
    auction: sub === 'auction',
    drop: sub === 'drop',
    shop: sub === 'shop',
  };
}

/**
 * Normalize a raw DB row { source, faucet, sink } (numeric strings or numbers
 * from SUM aggregates) into { source, faucet, sink, net }. `net` = faucet + sink
 * (sink is already negative), so a net-positive source is a net minter and a
 * net-negative one is a net drainer.
 */
export function rowToSourceBreakdown(r) {
  const faucet = Number(r.faucet);
  const sink = Number(r.sink);
  return { source: r.source, faucet, sink, net: faucet + sink };
}

/**
 * Order breakdown entries by gross activity (faucet volume + |sink| volume),
 * most active first, and drop fully-inactive sources. Mirrors the ORDER BY in
 * economyOverview's SQL so the presentation sort is testable independently.
 */
export function rankByActivity(entries, limit = 12) {
  return entries
    .filter((s) => s.faucet !== 0 || s.sink !== 0)
    .sort((a, b) => (b.faucet + Math.abs(b.sink)) - (a.faucet + Math.abs(a.sink)))
    .slice(0, limit);
}
