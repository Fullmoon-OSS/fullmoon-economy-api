// Client registry parsing/validation for the (read-only) economy API.
//
// ECONOMY_API_CLIENTS is a JSON array of client definitions:
//   [{ "name": "lisybot", "key": "<random 32+ chars>" }]
//
// - name : stable identifier, used for the per-client rate-limit bucket and the
//          access log.
// - key  : bearer token. 32+ chars; generate with
//          `node -e "console.log(crypto.randomBytes(24).toString('base64url'))"`.
//
// There are no scopes any more. The API only reads, so every authenticated
// client can reach every endpoint, and a key confers exactly one power: seeing
// balances. The old registry also carried "scopes" and "source" (ledger
// attribution for that client's mutations); both are accepted and ignored, so a
// registry written before 2026-07-12 still boots — with a warning, because a
// key that looks like it can grant no longer can.

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Parse and validate the client registry JSON. Throws on any bad entry. */
export function parseClients(json, { warn = console.warn } = {}) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('ECONOMY_API_CLIENTS is not valid JSON');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('ECONOMY_API_CLIENTS must be a non-empty JSON array');
  }
  const seenNames = new Set();
  const seenKeys = new Set();
  return raw.map((c, i) => {
    const at = `clients[${i}]`;
    if (!NAME_RE.test(c?.name ?? '')) throw new Error(`${at}: name must match ${NAME_RE}`);
    if (seenNames.has(c.name)) throw new Error(`${at}: duplicate name '${c.name}'`);
    seenNames.add(c.name);
    if (typeof c.key !== 'string' || c.key.length < 32) throw new Error(`${at}: key must be a string of 32+ chars`);
    if (seenKeys.has(c.key)) throw new Error(`${at}: duplicate key`);
    seenKeys.add(c.key);
    if (c.scopes !== undefined || c.source !== undefined) {
      warn(`[api] ${at} ('${c.name}'): 'scopes'/'source' are obsolete and ignored — the API is read-only`);
    }
    return { name: c.name, key: c.key };
  });
}
