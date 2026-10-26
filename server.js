const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const ALLOWED_SIZES = [2, 3, 4];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const WINNING_RANKS = ['4', '5', '6', '7', '9', '10']; // only these can finish a hand
const SKIP_START = ['2', '3', 'J', 'A']; // these can't be the opening pile card
const ENTRY_FEE = 10; // NETCOINS charged to each human when a Create Room / Add Bot game starts (1 sh = 10 NETCOINS)
const STARTING_BALANCE = 1000; // NETCOINS granted to a token the first time the server sees it
const STAKE_TIERS = [100, 200, 500, 1000]; // AUTOMATCH stake tiers, in NETCOINS (1 sh = 10 NETCOINS)
const FEE_PERCENT = 10; // AUTOMATCH: fee per player, as a percent of the stake
const MATCH_SIZE = 2; // AUTOMATCH pairs two players into a 2-player room
const MATCH_WAIT_MS = 10 * 60 * 1000; // a queued player waits this long before "no match found" (10 min)
const ACCEPT_WINDOW_MS = 30000; // both players get this long to accept a found match (30 s)
const DISCONNECT_GRACE_MS = 60000; // a disconnected waiter is dropped after this long (60 s)

const wss = new WebSocketServer({ port: PORT });
const rooms = new Map();

// ---------- server-side balances ----------
// Identity is the token alone; the app never tells us its balance. Map of
// token -> NETCOINS, persisted to a JSON file (temp file + rename = atomic write).
const BALANCE_FILE = path.join(__dirname, 'balances.json');
const BALANCE_TMP = BALANCE_FILE + '.tmp';
let balances = {};
try {
  balances = JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8')) || {};
} catch (e) {
  balances = {};
}
function saveBalances() {
  fs.writeFileSync(BALANCE_TMP, JSON.stringify(balances, null, 2));
  fs.renameSync(BALANCE_TMP, BALANCE_FILE);
}
function hasBalance(token) {
  return Object.prototype.hasOwnProperty.call(balances, token);
}
// Register a token on first sight (starting balance), then return its balance.
function accountFor(token) {
  if (!hasBalance(token)) { balances[token] = STARTING_BALANCE; saveBalances(); }
  return balances[token];
}
function balanceOf(token) {
  return hasBalance(token) ? balances[token] : 0;
}
function credit(token, amount) {
  balances[token] = balanceOf(token) + amount;
  saveBalances();
}

// Running total of AUTOMATCH fees collected on this server instance (fees are a
// slice of each pot that is never paid out to the winner).
let totalFees = 0;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function err(ws, message) {
  send(ws, { type: 'error', message });
}
function suitOf(c) { return c.slice(-1); }
function rankOf(c) { return c.slice(0, -1); }
function isWinningRank(r) { return WINNING_RANKS.includes(r); }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return shuffle(d);
}

function isHuman(p) { return !(p.ws && p.ws.isBot); }
function humanCount(room) { return room.players.filter(isHuman).length; }

function roomState(room) {
  return {
    type: 'room',
    code: room.code,
    host: room.players[0].name,
    players: room.players.map(p => p.name),
    max: room.max,
    waitingFor: room.max - room.players.length,
    started: room.started,
    entry: room.entry != null ? room.entry : ENTRY_FEE,
    pot: room.pot != null ? room.pot : humanCount(room) * ENTRY_FEE
  };
}
function broadcast(room) {
  room.players.forEach(p => send(p.ws, roomState(room)));
}
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// ---------- game ----------
function startGame(room) {
  room.started = true;
  room.settled = false;
  room.deck = newDeck();
  room.pile = [];
  room.dir = 1;
  room.turn = 0;
  room.winner = null;
  room.pendingPenalty = 0;
  room.pendingPenaltyRank = null;
  room.declaredSuit = null;
  room.players.forEach(p => { p.hand = []; });
  for (let i = 0; i < 4; i++) room.players.forEach(p => p.hand.push(room.deck.pop()));

  const skipped = [];
  let first = room.deck.pop();
  while (first && SKIP_START.includes(rankOf(first))) {
    skipped.push(first);
    first = room.deck.pop();
  }
  if (!first) first = '4H';
  room.deck = skipped.concat(room.deck);
  room.pile.push(first);
}

function sendGame(room) {
  if (room.turn >= room.players.length) room.turn = 0;
  const n = room.players.length;
  room.players.forEach((p, i) => {
    const others = [];
    for (let j = 1; j < n; j++) {
      const o = room.players[(i + j) % n];
      others.push({ name: o.name, count: o.hand.length });
    }
    send(p.ws, {
      type: 'game',
      you: p.name,
      hand: p.hand,
      top: room.pile[room.pile.length - 1],
      deckCount: room.deck.length,
      turn: room.players[room.turn].name,
      direction: room.dir,
      others,
      winner: room.winner,
      pendingPenalty: room.pendingPenalty,
      pendingPenaltyRank: room.pendingPenaltyRank,
      declaredSuit: room.declaredSuit,
      entry: room.entry || 0,
      pot: room.pot || 0,
      balance: isHuman(p) ? balanceOf(p.token) : null
    });
  });
}

function nextTurn(room) {
  const n = room.players.length;
  room.turn = (room.turn + room.dir + n) % n;
}

function drawOneCard(room) {
  if (room.deck.length === 0 && room.pile.length > 1) {
    const top = room.pile.pop();
    room.deck = shuffle(room.pile);
    room.pile = [top];
  }
  return room.deck.length ? room.deck.pop() : null;
}

function canPlayServer(room, card, top) {
  if (room.pendingPenalty > 0) {
    return rankOf(card) === room.pendingPenaltyRank || rankOf(card) === 'A';
  }
  if (rankOf(card) === 'A') return true;
  if (room.declaredSuit) {
    return suitOf(card) === room.declaredSuit || rankOf(card) === rankOf(top);
  }
  return suitOf(card) === suitOf(top) || rankOf(card) === rankOf(top);
}

function stackPenalty(room, rank, amount) {
  if (room.pendingPenalty > 0 && room.pendingPenaltyRank === rank) {
    room.pendingPenalty += amount;
  } else {
    room.pendingPenalty = amount;
    room.pendingPenaltyRank = rank;
  }
}

function checkWin(room, player, lastPlayedRank) {
  if (player.hand.length === 0 && isWinningRank(lastPlayedRank)) {
    room.winner = player.name;
    return true;
  }
  return false;
}

function applyCardEffect(room, me, card, chosenSuit, previousTop) {
  const r = rankOf(card);
  switch (r) {
    case 'A':
      if (room.pendingPenalty > 0) {
        room.pendingPenalty = 0;
        room.pendingPenaltyRank = null;
        room.declaredSuit = suitOf(previousTop);
      } else {
        room.declaredSuit = (chosenSuit && SUITS.includes(chosenSuit)) ? chosenSuit : suitOf(card);
      }
      nextTurn(room);
      break;
    case 'K':
      room.declaredSuit = null;
      room.dir *= -1;
      nextTurn(room);
      break;
    case 'Q':
      room.declaredSuit = null;
      break;
    case 'J':
      room.declaredSuit = null;
      resolveJack(room);
      break;
    case '2':
      room.declaredSuit = null;
      stackPenalty(room, '2', 2);
      nextTurn(room);
      break;
    case '3':
      room.declaredSuit = null;
      stackPenalty(room, '3', 3);
      nextTurn(room);
      break;
    case '8':
      room.declaredSuit = null;
      break;
    default:
      room.declaredSuit = null;
      nextTurn(room);
      break;
  }
}

function resolveJackGroup(room, jumps) {
  let remaining = Math.min(jumps, room.players.length - 1);
  nextTurn(room);
  while (remaining > 0) {
    const candidate = room.players[room.turn];
    const idx = candidate.hand.findIndex(c => rankOf(c) === 'J');
    if (idx !== -1) {
      const escapeJack = candidate.hand.splice(idx, 1)[0];
      room.pile.push(escapeJack);
      if (checkWin(room, candidate, 'J')) return;
      nextTurn(room);
    } else {
      nextTurn(room);
      remaining--;
    }
  }
}

function resolveJack(room) {
  nextTurn(room);
  while (true) {
    const candidate = room.players[room.turn];
    const idx = candidate.hand.findIndex(c => rankOf(c) === 'J');
    if (idx !== -1) {
      const escapeJack = candidate.hand.splice(idx, 1)[0];
      room.pile.push(escapeJack);
      if (checkWin(room, candidate, 'J')) return;
      nextTurn(room);
    } else {
      nextTurn(room);
      return;
    }
  }
}

function settle(room) {
  if (room.settled || !room.winner) return;
  room.settled = true;
  const w = room.players.find(p => p.name === room.winner);
  // Only a human winner is paid; if a bot wins (or the winner already left) the
  // escrowed stakes stay spent. AUTOMATCH rooms carry an explicit winAmount (pot
  // minus both fees); Create Room / Add Bot rooms pay the whole pot as before.
  // The settled guard makes this the single payout for the game.
  if (w && isHuman(w) && w.token) credit(w.token, room.winAmount != null ? room.winAmount : room.pot);
}

function startIfFull(room) {
  if (room.started || room.players.length < room.max) return;

  // Charge the entry on every human. Refuse to start if any cannot pay, and drop
  // them from the room so the remaining players fall back to the lobby.
  const humans = room.players.filter(isHuman);
  const broke = humans.filter(p => balanceOf(p.token) < ENTRY_FEE);
  if (broke.length) {
    broke.forEach(p => {
      err(p.ws, 'Not enough NETCOINS to play (' + ENTRY_FEE + ' required)');
      p.ws.room = null;
    });
    room.players = room.players.filter(p => !broke.includes(p));
    if (room.players.length === 0) { rooms.delete(room.code); return; }
    broadcast(room);
    return;
  }

  // Escrow atomically: affordability is verified for everyone above, then every
  // human is debited and the file is written once (no interleaving in Node).
  room.entry = ENTRY_FEE;
  room.pot = humans.length * ENTRY_FEE;
  room.paid = true;
  humans.forEach(p => { balances[p.token] -= ENTRY_FEE; });
  saveBalances();

  startGame(room);
  const players = room.players.map(p => p.name);
  room.players.forEach(p => send(p.ws, {
    type: 'started',
    code: room.code,
    players,
    entry: room.entry,
    pot: room.pot,
    balance: isHuman(p) ? balanceOf(p.token) : null
  }));
  sendGameAndArm(room);
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const idx = room.players.findIndex(p => p.ws === ws);
  const leaver = idx !== -1 ? room.players[idx] : null;
  if (idx !== -1) room.players.splice(idx, 1);
  ws.room = null;
  // Escrow is only refunded while the game has not started. Once it is under way
  // the entry is spent (leaving loses the entry), and a finished game never pays
  // twice because settle() is guarded by room.settled.
  if (leaver && leaver.token && room.paid && !room.started) credit(leaver.token, ENTRY_FEE);
  if (room.players.length === 0) {
    disarmTurn(room); rooms.delete(room.code);
    return;
  }
  if (!room.started) {
    broadcast(room);
    return;
  }
  if (room.winner) return;
  if (room.players.length === 1) {
    room.winner = room.players[0].name;
    sendGameAndArm(room);
    return;
  }
  if (idx < room.turn) room.turn--;
  if (room.turn >= room.players.length) room.turn = 0;
  sendGameAndArm(room);
}

// ---------- AUTOMATCH (quick match, stake tiers) ----------
// Four fixed stake tiers. A token may sit in at most one tier queue, and a player
// may only queue for a tier they can afford. A queued player waits MATCH_WAIT_MS
// (10 min), or until they cancel, or until they have been disconnected for
// DISCONNECT_GRACE_MS (60 s). When two different players are waiting in the same
// tier, both are offered the match and must accept within ACCEPT_WINDOW_MS; nothing
// is charged until both accept. Only the display name is ever passed around.
const queues = new Map(); // stake -> [entry]
STAKE_TIERS.forEach(s => queues.set(s, []));

const pendingMatches = new Map(); // matchId -> match awaiting accept/decline

function feeFor(stake) { return Math.round(stake * FEE_PERCENT / 100); }

// "Users searching" counts only entries whose socket is live, since a disconnected
// entry (kept for the 60 s grace window) cannot be matched or accept an offer.
function tierCounts() {
  return STAKE_TIERS.map(s => ({ stake: s, count: queues.get(s).filter(e => e.ws).length }));
}

function broadcastTierCounts() {
  const msg = { type: 'tierCounts', tiers: tierCounts() };
  wss.clients.forEach(c => {
    if (c.readyState === 1 && (!c.room || !c.room.started)) send(c, msg);
  });
}

function findEntry(token) {
  for (const s of STAKE_TIERS) {
    const e = queues.get(s).find(x => x.token === token);
    if (e) return e;
  }
  return null;
}

// A token already seated in any room (waiting or playing) must not be able to
// queue for a tier from another socket, or it could be dealt into two games.
function tokenInAnyRoom(token) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.token === token)) return true;
  }
  return false;
}

function removeEntry(entry) {
  const list = queues.get(entry.stake);
  if (!list) return false;
  const i = list.indexOf(entry);
  if (i === -1) return false;
  list.splice(i, 1);
  clearTimeout(entry.waitTimer);
  clearTimeout(entry.disconnectTimer);
  return true;
}

function armWaitTimer(entry) {
  clearTimeout(entry.waitTimer);
  entry.waitTimer = setTimeout(() => {
    if (removeEntry(entry)) {
      if (entry.ws) send(entry.ws, { type: 'matchTimeout', message: 'No match found' });
      broadcastTierCounts();
    }
  }, MATCH_WAIT_MS);
}

function automatch(token, name, ws, stake) {
  if (ws.room) return err(ws, 'You are already in a room');
  if (tokenInAnyRoom(token)) return err(ws, 'You are already in a game');
  const existing = findEntry(token);
  if (existing) {
    if (existing.ws) return err(ws, 'You are already in a queue');
    // Reconnect within the grace window: keep the original tier and queue position.
    clearTimeout(existing.disconnectTimer);
    existing.ws = ws;
    existing.name = name;
    send(ws, { type: 'matchQueued', stake: existing.stake });
    broadcastTierCounts();
    tryMatch(existing.stake);
    return;
  }
  const entry = { token, name, ws, stake };
  armWaitTimer(entry);
  queues.get(stake).push(entry);
  send(ws, { type: 'matchQueued', stake });
  broadcastTierCounts();
  tryMatch(stake);
}

// Put a player who accepted a failed offer back at the FRONT of their tier queue.
function enqueueFront(entry) {
  const list = queues.get(entry.stake);
  if (!list || list.includes(entry)) return;
  list.unshift(entry);
  armWaitTimer(entry);
  send(entry.ws, { type: 'matchQueued', stake: entry.stake });
  broadcastTierCounts();
  tryMatch(entry.stake);
}

function tryMatch(stake) {
  const list = queues.get(stake);
  if (!list) return;
  // Live entries are already distinct tokens (one entry per token), so a formed
  // pair can never be the same player twice.
  while (true) {
    const live = list.filter(e => e.ws);
    if (live.length < MATCH_SIZE) return;
    const pair = live.slice(0, MATCH_SIZE);
    const broke = pair.filter(e => balanceOf(e.token) < stake);
    if (broke.length) {
      broke.forEach(e => {
        removeEntry(e);
        err(e.ws, 'Not enough NETCOINS for the ' + stake + ' NETCOIN tier');
      });
      broadcastTierCounts();
      continue;
    }
    pair.forEach(removeEntry);
    broadcastTierCounts();
    beginNegotiation(stake, pair[0], pair[1]);
  }
}

function makeMatchId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  } while (pendingMatches.has(id));
  return id;
}

// Offer the match. Nothing is charged yet: both players must accept within
// ACCEPT_WINDOW_MS, after which the stakes are escrowed and the game starts.
function beginNegotiation(stake, a, b) {
  const fee = feeFor(stake);
  const pot = stake * MATCH_SIZE;
  const match = {
    id: makeMatchId(),
    stake,
    fee,
    pot,
    winAmount: pot - fee * MATCH_SIZE,
    entries: [a, b],
    accepted: new Set(),
    done: false,
    timer: null
  };
  a.match = b.match = match;
  a.ws.match = b.ws.match = match;
  pendingMatches.set(match.id, match);
  match.timer = setTimeout(() => finishMatch(match, 'timeout'), ACCEPT_WINDOW_MS);
  [a, b].forEach(e => send(e.ws, {
    type: 'matchFound',
    matchId: match.id,
    stake,
    fee,
    winAmount: match.winAmount
  }));
}

function acceptMatch(ws, matchId) {
  const match = pendingMatches.get(matchId);
  if (!match || match.done) return err(ws, 'That match is no longer available');
  const entry = match.entries.find(e => e.ws === ws);
  if (!entry) return err(ws, 'That is not your match');
  if (match.accepted.has(entry.token)) return;
  match.accepted.add(entry.token);
  send(ws, { type: 'matchAccepted', matchId: match.id });
  if (match.accepted.size === match.entries.length) startNegotiatedMatch(match);
}

function declineMatch(ws, matchId) {
  const match = pendingMatches.get(matchId);
  if (!match || match.done) return err(ws, 'That match is no longer available');
  const entry = match.entries.find(e => e.ws === ws);
  if (!entry) return err(ws, 'That is not your match');
  finishMatch(match, 'declined');
}

// Offer failed (decline, timeout, or disconnect): nobody is charged. Whoever
// accepted goes back to the front of their tier; whoever didn't is dropped.
function finishMatch(match, reason) {
  if (match.done) return;
  match.done = true;
  clearTimeout(match.timer);
  pendingMatches.delete(match.id);

  const accepted = [];
  const removed = [];
  match.entries.forEach(e => {
    if (e.ws) e.ws.match = null;
    e.match = null;
    (match.accepted.has(e.token) && e.ws ? accepted : removed).push(e);
  });

  removed.forEach(e => {
    if (e.ws) send(e.ws, { type: 'matchEnded', matchId: match.id, reason, requeued: false });
  });
  accepted.forEach(e => {
    send(e.ws, { type: 'matchEnded', matchId: match.id, reason, requeued: true });
    enqueueFront(e);
  });
  broadcastTierCounts();
}

function startNegotiatedMatch(match) {
  if (match.done) return;
  const { stake, fee } = match;

  // Re-check affordability before charging so escrow can never half-complete.
  if (match.entries.some(e => !e.ws || balanceOf(e.token) < stake)) {
    finishMatch(match, 'insufficient');
    return;
  }

  match.done = true;
  clearTimeout(match.timer);
  pendingMatches.delete(match.id);

  // Escrow atomically: both verified, debit both, single file write.
  match.entries.forEach(e => { balances[e.token] -= stake; });
  totalFees += fee * MATCH_SIZE;
  saveBalances();

  const room = {
    code: makeCode(),
    max: MATCH_SIZE,
    players: [],
    started: false,
    entry: stake,
    stake,
    fee,
    pot: stake * MATCH_SIZE,
    winAmount: stake * MATCH_SIZE - fee * MATCH_SIZE,
    paid: true
  };
  match.entries.forEach(e => {
    e.ws.match = null;
    e.match = null;
    room.players.push({ name: uniqueName(room, e.name), ws: e.ws, token: e.token });
    e.ws.room = room;
  });
  rooms.set(room.code, room);

  startGame(room);
  const players = room.players.map(p => p.name);
  room.players.forEach(p => send(p.ws, {
    type: 'started',
    code: room.code,
    players,
    entry: room.entry,
    pot: room.pot,
    balance: balanceOf(p.token)
  }));
  sendGameAndArm(room);
  broadcastTierCounts();
}

// A socket that drops while queued is held for DISCONNECT_GRACE_MS so a quick
// reconnect does not lose the player's place; after that it leaves the queue.
function handleDisconnect(ws) {
  STAKE_TIERS.forEach(s => {
    queues.get(s).forEach(e => {
      if (e.ws !== ws) return;
      e.ws = null;
      e.disconnectTimer = setTimeout(() => {
        if (!e.ws && removeEntry(e)) broadcastTierCounts();
      }, DISCONNECT_GRACE_MS);
    });
  });
  broadcastTierCounts();
}

function uniqueName(room, name) {
  let n = name, i = 2;
  while (room.players.some(p => p.name === n)) n = name + ' ' + i++;
  return n;
}

// ---------- FRIENDS (accounts live in kib-server) ----------
const KIB_URL = process.env.KIB_URL || 'https://kib-server.onrender.com';
const online = new Map(); // phone -> ws

async function kibGet(pathname, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(KIB_URL + pathname, {
      headers: { Authorization: 'Bearer ' + token },
      signal: ctrl.signal
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isOnline(phone) {
  const w = online.get(phone);
  return !!(w && w.readyState === 1);
}

async function sendFriends(ws) {
  if (!ws.kibToken) return err(ws, 'Not signed in');
  const d = await kibGet('/friends', ws.kibToken);
  if (!d) return err(ws, 'Could not load friends');
  send(ws, {
    type: 'friends',
    friends: d.friends.map(f => ({ phone: f.phone, name: f.name, online: isOnline(f.phone) })),
    requests: d.requests
  });
}

wss.on('connection', ws => {
  ws.room = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return err(ws, 'Bad message'); }
    const name = String(msg.name || '').trim().slice(0, 20);

    switch (msg.type) {
      case 'addBot': {
      if (ws.room == null) return err(ws, 'You are not in a room');
      addBot(ws.room);
      break;
    }
    case 'create': {
        if (ws.room) return err(ws, 'You are already in a room');
        if (!name) return err(ws, 'Enter your name');
        const max = Number(msg.max);
        if (!ALLOWED_SIZES.includes(max)) return err(ws, 'Choose 2, 3 or 4 players');
        const token = String(msg.token || '').trim();
        if (!token) return err(ws, 'Authentication required');
        if (accountFor(token) < ENTRY_FEE)
          return err(ws, 'Not enough NETCOINS to play (' + ENTRY_FEE + ' required)');
        const room = { code: makeCode(), max, players: [{ name, ws, token }], started: false };
        rooms.set(room.code, room);
        ws.room = room;
        broadcast(room);
        break;
      }
      case 'join': {
        if (ws.room) return err(ws, 'You are already in a room');
        if (!name) return err(ws, 'Enter your name');
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return err(ws, 'Room not found');
        if (room.started) return err(ws, 'Game already started');
        if (room.players.length >= room.max) return err(ws, 'Room is full');
        if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
          return err(ws, 'That name is taken in this room');
        const token = String(msg.token || '').trim();
        if (!token) return err(ws, 'Authentication required');
        if (accountFor(token) < ENTRY_FEE)
          return err(ws, 'Not enough NETCOINS to play (' + ENTRY_FEE + ' required)');
        room.players.push({ name, ws, token });
        ws.room = room;
        broadcast(room);
        startIfFull(room);
        break;
      }
      case 'play': {
        const room = ws.room;
        if (!room || !room.started || room.winner) return err(ws, 'No game in progress');
        const me = room.players[room.turn];
        if (me.ws !== ws) return err(ws, 'Not your turn');
        const card = String(msg.card || '');
        const idx = me.hand.indexOf(card);
        if (idx === -1) return err(ws, 'You do not have that card');
        const top = room.pile[room.pile.length - 1];
        if (!canPlayServer(room, card, top)) return err(ws, 'That card does not match');

        const previousTop = top;
        me.hand.splice(idx, 1);
        room.pile.push(card);

        if (checkWin(room, me, rankOf(card))) {
          sendGameAndArm(room);
          break;
        }
        applyCardEffect(room, me, card, msg.suit, previousTop);
        sendGameAndArm(room);
        break;
      }
      case 'playGroup': {
        const room = ws.room;
        if (!room || !room.started || room.winner) return err(ws, 'No game in progress');
        const me = room.players[room.turn];
        if (me.ws !== ws) return err(ws, 'Not your turn');
        const cards = Array.isArray(msg.cards) ? msg.cards.map(String) : [];
        if (cards.length === 0) return err(ws, 'No cards selected');
        for (const c of cards) {
          if (me.hand.indexOf(c) === -1) return err(ws, 'You do not have that card');
        }
        const rank = rankOf(cards[0]);
        if (rank === 'A') return err(ws, 'That rank cannot be grouped');
        if (!cards.every(c => rankOf(c) === rank)) return err(ws, 'All cards must be the same rank');

        let simTop = room.pile[room.pile.length - 1];
        let simDeclaredSuit = room.declaredSuit;
        let simPending = room.pendingPenalty;
        let simPendingRank = room.pendingPenaltyRank;
        for (const c of cards) {
          let ok;
          if (simPending > 0) ok = rankOf(c) === simPendingRank || rankOf(c) === 'A';
          else if (rankOf(c) === 'A') ok = true;
          else if (simDeclaredSuit) ok = suitOf(c) === simDeclaredSuit || rankOf(c) === rankOf(simTop);
          else ok = suitOf(c) === suitOf(simTop) || rankOf(c) === rankOf(simTop);
          if (!ok) return err(ws, 'That combination is not playable');

          if (rankOf(c) === '2') {
            if (simPending === 0 || simPendingRank === '2') { simPending += 2; simPendingRank = '2'; }
            else return err(ws, 'That combination is not playable');
          } else if (rankOf(c) === '3') {
            if (simPending === 0 || simPendingRank === '3') { simPending += 3; simPendingRank = '3'; }
            else return err(ws, 'That combination is not playable');
          } else {
            simPending = 0;
            simPendingRank = null;
          }
          simDeclaredSuit = null;
          simTop = c;
        }

        for (const c of cards) {
          const idx = me.hand.indexOf(c);
          me.hand.splice(idx, 1);
          room.pile.push(c);
        }

        if (checkWin(room, me, rank)) {
          sendGameAndArm(room);
          break;
        }

          if (rank === '2') stackPenalty(room, '2', 2 * cards.length);
          else if (rank === '3') stackPenalty(room, '3', 3 * cards.length);
        else { room.pendingPenalty = 0; room.pendingPenaltyRank = null; }
        room.declaredSuit = null;

        if (rank === 'K') {
    // odd number of Ks reverses once; an even number cancels out and the same player plays again
    if (cards.length % 2 === 1) { room.dir = -room.dir; nextTurn(room); }
  } else if (rank === 'J') {
        resolveJackGroup(room, cards.length);
      } else if (rank === '8' || rank === 'Q') {
    // extra turn - no advance
  } else {
    nextTurn(room);
  }
        sendGameAndArm(room);
        break;
      }
      case 'draw': {
        const room = ws.room;
        if (!room || !room.started || room.winner) return err(ws, 'No game in progress');
        const me = room.players[room.turn];
        if (me.ws !== ws) return err(ws, 'Not your turn');

        if (room.pendingPenalty > 0) {
          const amount = room.pendingPenalty;
          for (let i = 0; i < amount; i++) {
            const c = drawOneCard(room);
            if (!c) break;
            me.hand.push(c);
          }
          room.pendingPenalty = 0;
          room.pendingPenaltyRank = null;
        } else {
          const c = drawOneCard(room);
          if (!c) return err(ws, 'No cards left to draw');
          me.hand.push(c);
        }
        nextTurn(room);
        sendGameAndArm(room);
        break;
      }
      case 'leave': {
        leave(ws);
        send(ws, { type: 'left' });
        break;
      }
      case 'automatch': {
        if (!name) return err(ws, 'Enter your name');
        const token = String(msg.token || '').trim();
        if (!token) return err(ws, 'Authentication required');
        const stake = Number(msg.stake);
        if (!STAKE_TIERS.includes(stake))
          return err(ws, 'Choose a stake of ' + STAKE_TIERS.join(', ') + ' NETCOINS');
        if (accountFor(token) < stake)
          return err(ws, 'Not enough NETCOINS for the ' + stake + ' NETCOIN tier');
        automatch(token, name, ws, stake);
        break;
      }
      case 'cancelMatch': {
        const entry = findEntry(String(msg.token || '').trim());
        if (entry && entry.ws === ws) {
          removeEntry(entry);
          send(ws, { type: 'matchCancelled' });
          broadcastTierCounts();
        } else {
          err(ws, 'You are not in the queue');
        }
        break;
      }
      case 'acceptMatch': {
        acceptMatch(ws, String(msg.matchId || ''));
        break;
      }
      case 'declineMatch': {
        declineMatch(ws, String(msg.matchId || ''));
        break;
      }
      case 'hello': {
        const token = String(msg.token || '').trim();
        if (!token) return err(ws, 'Authentication required');
        kibGet('/me', token).then(me => {
          if (!me || !me.phone) return err(ws, 'Login expired. Please log in again');
          if (ws.phone && online.get(ws.phone) === ws) online.delete(ws.phone);
          ws.kibToken = token;
          ws.phone = me.phone;
          ws.accountName = me.name;
          online.set(me.phone, ws);
          send(ws, { type: 'hello', phone: me.phone, name: me.name });
          sendFriends(ws);
        });
        break;
      }
      case 'friends': {
        sendFriends(ws);
        break;
      }
      case 'invite': {
        if (!ws.phone) return err(ws, 'Not signed in');
        const room = ws.room;
        if (!room || room.started) return err(ws, 'Create a room first');
        if (room.players.length >= room.max) return err(ws, 'Room is full');
        const now = Date.now();
        if (ws.lastInvite && now - ws.lastInvite < 3000) return err(ws, 'Wait a moment before inviting again');
        ws.lastInvite = now;
        const target = String(msg.phone || '').trim();
        kibGet('/friends', ws.kibToken).then(d => {
          const f = d && d.friends.find(x => x.phone === target);
          if (!f) return err(ws, 'That player is not your friend');
          if (ws.room !== room || room.started || room.players.length >= room.max)
            return err(ws, 'Room is no longer open');
          const tws = online.get(target);
          if (!tws || tws.readyState !== 1) return err(ws, 'Your friend is offline');
          if (tws.room) return err(ws, 'Your friend is already in a room');
          send(tws, {
            type: 'invite',
            from: ws.accountName || 'A friend',
            code: room.code,
            max: room.max,
            entry: ENTRY_FEE
          });
          send(ws, { type: 'inviteSent', name: f.name });
        });
        break;
      }
      case 'tierCounts': {
        send(ws, { type: 'tierCounts', tiers: tierCounts() });
        break;
      }
      default:
        err(ws, 'Unknown action');
    }
  });

  ws.on('close', () => {
    if (ws.phone && online.get(ws.phone) === ws) online.delete(ws.phone);
    if (ws.match) finishMatch(ws.match, 'disconnected');
    handleDisconnect(ws);
    leave(ws);
  });
});

console.log('RAFIKI PLAY server running on port ' + PORT);

const TURN_MS = 10000;

function disarmTurn(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

function armTurn(room) {
  disarmTurn(room);
  if (!room.started || room.winner) return;
  room.turnTimer = setTimeout(() => {
    if (!room.started || room.winner) return;
    const p = room.players[room.turn];
    if (room.pendingPenalty > 0) {
      const amount = room.pendingPenalty;
      for (let k = 0; k < amount; k++) {
        const pc = drawOneCard(room);
        if (!pc) break;
        p.hand.push(pc);
      }
      room.pendingPenalty = 0;
      room.pendingPenaltyRank = null;
    } else {
      const c = drawOneCard(room);
      if (c) p.hand.push(c);
    }
    nextTurn(room);
    sendGameAndArm(room);
  }, TURN_MS);
}

function sendGameAndArm(room) {
  settle(room);
  sendGame(room);
  if (room.winner) disarmTurn(room);
  else armTurn(room);
}

// ---- Kadi Bot: a fake player that joins on request and plays like a human ----
function addBot(room) {
  if (room.started || room.players.length >= room.max) return false;
  let botNum = 1;
  while (room.players.some(p => p.name === 'Kadi Bot' + (botNum > 1 ? ' ' + botNum : ''))) botNum++;
  const botName = 'Kadi Bot' + (botNum > 1 ? ' ' + botNum : '');
  const botWs = { isBot: true, sent: [], readyState: 1 };
  botWs.send = (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'game') scheduleBotMove(room, botWs, m);
    } catch (e) {}
  };
  room.players.push({ name: botName, ws: botWs });
  broadcast(room);
  startIfFull(room);
  return true;
}

function scheduleBotMove(room, botWs, state) {
  if (room.winner || !room.started) return;
  const me = room.players.find(p => p.ws === botWs);
  if (!me || state.turn !== me.name) return;
  if (botWs.pending) return;
  botWs.pending = true;
  const delay = 3000 + Math.random() * 1000;
  setTimeout(() => {
    botWs.pending = false;
    try {
      if (room.winner || !room.started) return;
      if (room.players[room.turn] !== me) return;
      const top = room.pile[room.pile.length - 1];
      let choice = null;
      for (const c of me.hand) {
        if (canPlayServer(room, c, top)) { choice = c; break; }
      }
      if (choice) {
        const others = me.hand.filter(c => c !== choice && rankOf(c) === rankOf(choice));
        if (others.length) {
          botPlayGroup(room, me, [choice, ...others]);
        } else {
          const chosenSuit = rankOf(choice) === 'A'
            ? (suitOf(me.hand.find(c => c !== choice)) || 'H')
            : null;
          botPlay(room, me, choice, chosenSuit);
        }
      } else {
        botDraw(room, me);
      }
    } catch (e) {
      console.error('[BOT] error during move, drawing as fallback:', e);
      try { botDraw(room, me); } catch (e2) { console.error('[BOT] fallback draw failed:', e2); }
    }
  }, delay);
}

function botPlay(room, me, card, chosenSuit) {
  const idx = me.hand.indexOf(card);
  if (idx === -1) return;
  me.hand.splice(idx, 1);
  room.pile.push(card);
  if (rankOf(card) === 'A' && chosenSuit) room.declaredSuit = chosenSuit; else room.declaredSuit = null;
  if (rankOf(card) === '2' || rankOf(card) === '3') stackPenalty(room, rankOf(card), rankOf(card) === '2' ? 2 : 3);
  if (checkWin(room, me, rankOf(card))) { sendGameAndArm(room); return; }
  nextTurn(room);
  sendGameAndArm(room);
}

function botPlayGroup(room, me, cards) {
  for (const c of cards) {
    const idx = me.hand.indexOf(c);
    if (idx !== -1) { me.hand.splice(idx, 1); room.pile.push(c); }
  }
  const last = cards[cards.length - 1];
  if (rankOf(last) === '2' || rankOf(last) === '3') stackPenalty(room, rankOf(last), (rankOf(last) === '2' ? 2 : 3) * cards.length);
  if (checkWin(room, me, rankOf(last))) { sendGameAndArm(room); return; }
  nextTurn(room);
  sendGameAndArm(room);
}

function botDraw(room, me) {
  if (room.pendingPenalty > 0) {
    for (let i = 0; i < room.pendingPenalty; i++) { const c = drawOneCard(room); if (c) me.hand.push(c); }
    room.pendingPenalty = 0; room.pendingPenaltyRank = null;
  } else {
    const c = drawOneCard(room); if (c) me.hand.push(c);
  }
  nextTurn(room);
  sendGameAndArm(room);
}
