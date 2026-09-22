const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const ALLOWED_SIZES = [2, 3, 4];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const WINNING_RANKS = ['4', '5', '6', '7', '9', '10']; // only these can finish a hand
const SKIP_START = ['2', '3', 'J', 'A']; // these can't be the opening pile card

const wss = new WebSocketServer({ port: PORT });
const rooms = new Map();

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

function roomState(room) {
  return {
    type: 'room',
    code: room.code,
    host: room.players[0].name,
    players: room.players.map(p => p.name),
    max: room.max,
    waitingFor: room.max - room.players.length,
    started: room.started
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
      declaredSuit: room.declaredSuit
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

function startIfFull(room) {
  if (room.started || room.players.length < room.max) return;
  startGame(room);
  const players = room.players.map(p => p.name);
  room.players.forEach(p => send(p.ws, { type: 'started', code: room.code, players }));
  sendGameAndArm(room);
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const idx = room.players.findIndex(p => p.ws === ws);
  if (idx !== -1) room.players.splice(idx, 1);
  ws.room = null;
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
        const room = { code: makeCode(), max, players: [{ name, ws }], started: false };
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
        room.players.push({ name, ws });
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
        if (rank === 'A' || rank === 'J') return err(ws, 'That rank cannot be grouped');
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
      default:
        err(ws, 'Unknown action');
    }
  });

  ws.on('close', () => leave(ws));
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
  const botWs = { isBot: true, sent: [] };
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
  if (!me || room.players[state.turn] !== me) return;
  const delay = 1000 + Math.random() * 2000;
  setTimeout(() => {
    if (room.winner || !room.started) return;
    if (room.players[room.turn] !== me) return;
    const top = room.pile[room.pile.length - 1];
    let choice = null;
    for (const c of me.hand) {
      if (canPlayServer(room, c, top)) { choice = c; break; }
    }
    if (choice) {
      const others = me.hand.filter(c => c !== choice && rank(c) === rank(choice));
      if (others.length) {
        botPlayGroup(room, me, [choice, ...others]);
      } else {
        botPlay(room, me, choice, rank(choice) === 'A' ? suitOf(me.hand.find(c => c !== choice)) || 'H' : null);
      }
    } else {
      botDraw(room, me);
    }
  }, delay);
}

function botPlay(room, me, card, chosenSuit) {
  const idx = me.hand.indexOf(card);
  if (idx === -1) return;
  me.hand.splice(idx, 1);
  room.pile.push(card);
  if (rank(card) === 'A' && chosenSuit) room.declaredSuit = chosenSuit; else room.declaredSuit = null;
  if (rank(card) === '2' || rank(card) === '3') stackPenalty(room, rank(card), rank(card) === '2' ? 2 : 3);
  if (checkWin(room, me, rank(card))) { sendGameAndArm(room); return; }
  nextTurn(room);
  sendGameAndArm(room);
}

function botPlayGroup(room, me, cards) {
  for (const c of cards) {
    const idx = me.hand.indexOf(c);
    if (idx !== -1) { me.hand.splice(idx, 1); room.pile.push(c); }
  }
  const last = cards[cards.length - 1];
  if (rank(last) === '2' || rank(last) === '3') stackPenalty(room, rank(last), (rank(last) === '2' ? 2 : 3) * cards.length);
  if (checkWin(room, me, rank(last))) { sendGameAndArm(room); return; }
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
