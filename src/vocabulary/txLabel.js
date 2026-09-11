// SYNCED COPY — the canonical source lives in the operator monorepo:
//   coin-bridge-bot/src/economy/txLabel.js
// Edit there first, then copy this file byte-for-byte and bump the sync date.
// Synced: 2026-09-08 (fullmoon-network extraction).
//
// Ledger `reason` codes → Korean, in one place.
//
// Extracted from cardTheme.js because it had stopped being only the card
// renderer's concern: the wallet page and the admin stats screen render the
// same codes, and each had grown its own table. They had already drifted in
// both directions — the web knew the Minecraft plugin's reasons
// (economy.withdraw, enhancement.attempt, casino.moonfall) and the cards did
// not; the cards knew the social and auction ones and the web did not. Whoever
// added a reason taught one table about it.
//
// Same reasoning as economy-breakdown.js: a second implementation of a shared
// vocabulary is a second implementation that will disagree, and the disagreement
// shows up as a raw code in front of a member.

/**
 * Longest-prefix-first, matched by dot segment. An unrecognised reason falls
 * through to the raw string rather than to a guess — `casino.newgame.wager` in
 * front of a reader is worse than nothing only if it is wrong, and it is not.
 */
const LABELS = {
  // bot — discord
  'discord.daily': '출석 보상',
  'discord.transfer': '송금',
  'discord.chat': '채팅 활동',
  'discord.voice': '음성 활동',
  'discord.work': '알바',
  'discord.event.claim': '코인 이벤트',
  'discord.firstcome.claim': '선착 보상',
  'discord.achievement': '업적 보상',
  'discord.drop.escrow': '돈뿌리기',
  'discord.drop.pick': '돈뿌리기 줍기',
  'discord.drop.refund': '돈뿌리기 환급',
  'discord.auction.bid': '경매 입찰',
  'discord.auction.refund': '경매 입찰 환불',
  'discord.auction.sale': '경매 낙찰',
  'discord.auction': '경매',
  'discord.shop.buy': '상점 구매',
  'discord.shop.refund': '상점 환불',
  'discord.join.bonus': '가입 보너스',
  'discord.birthday.gift': '생일 선물',
  'discord.social.cake': '케이크 선물',
  'discord.social.pet': '쓰다듬기',
  'discord.social.snuggle': '껴안기',
  'discord.social': '소셜',
  'discord.gift': '선물',

  // casino — the game name; .wager/.payout/.refund ride on top
  'casino.jackpot.ticket': '잭팟 티켓',
  'casino.jackpot.win': '잭팟 당첨',
  'casino.jackpot.refund': '잭팟 환불',
  'casino.blackjack': '블랙잭',
  'casino.slots': '슬롯',
  'casino.coinflip': '동전 던지기',
  'casino.dice': '주사위',
  'casino.roulette': '룰렛',
  'casino.moonfall': '문폴',
  'casino.race': '레이스',
  casino: '카지노',

  // minecraft plugin
  'enhancement.attempt': '강화 시도',
  'economy.withdraw': '인출',
  'economy.deposit': '입금',
  'economy.playtime': '플레이타임',
  'booster.multiplier': '부스트 보너스',
  playtime: '플레이타임',
};

/** Ride on top of whatever they are attached to. */
const SUFFIXES = { wager: '배팅', payout: '당첨', refund: '환불' };

/** Korean display label for a transaction reason code. */
export function txLabel(reason) {
  const raw = String(reason ?? '');
  // A row with no reason at all still has to say something in a column.
  if (!raw) return '기타';
  const parts = raw.split('.');

  for (let i = parts.length; i > 0; i--) {
    const label = LABELS[parts.slice(0, i).join('.')];
    if (!label) continue;
    // The suffix comes off the last segment, not the whole remainder, so an
    // unknown game still reads: casino.mystery.payout → 카지노 당첨. An exact
    // hit leaves nothing over and must not gain one — casino.jackpot.refund is
    // already a complete label and 잭팟 환불 환불 is not.
    const suffix = i < parts.length ? SUFFIXES[parts[parts.length - 1]] : null;
    return suffix ? `${label} ${suffix}` : label;
  }

  return String(reason ?? '');
}

/** `plugin:casino` / `discord` — where the movement happened, not why. */
export function txOrigin(source) {
  const s = String(source ?? '');
  if (s.startsWith('plugin:')) return '인게임';
  if (s.startsWith('discord') || s.startsWith('bot')) return '디스코드';
  return s;
}
