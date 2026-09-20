const WebSocket = require('ws');

const SERVER_URL = 'ws://127.0.0.1:3001';

const args = process.argv.slice(2);
const name = args[0];
const code = args[1];

if (!name || !code) {
  console.log('Usage: node bot-player.js <botName> <roomCode>');
  process.exit(1);
}

const ws = new WebSocket(SERVER_URL);

function suitOf(c) { return c.slice(-1); }
function rankOf(c) { return c.slice(0, -1); }
function canPlay(c, top) { return suitOf(c) === suitOf(top) || rankOf(c) === rankOf(top); }

function humanDelay() {
  // Feels like a person thinking: 1.5s to 3.5s
  return 1500 + Math.random() * 2000;
}

ws.on('open', () => {
  console.log(`[${name}] Connecting, joining room ${code}...`);
  ws.send(JSON.stringify({ type: 'join', name, code }));
});

ws.on('message', raw => {
  let m;
  try { m = JSON.parse(raw); } catch { console.log(`[${name}] Bad message from server:`, raw); return; }

  switch (m.type) {
    case 'room':
      console.log(`[${name}] Lobby: room ${m.code} — players: ${m.players.join(', ')} (waiting for ${m.waitingFor} more)`);
      break;

    case 'started':
      console.log(`[${name}] Game started! Players: ${m.players.join(', ')}`);
      break;

    case 'game':
      console.log(`[${name}] Top: ${m.top} | Deck: ${m.deckCount} | Turn: ${m.turn === name ? 'ME' : m.turn}`);
      if (m.winner) {
        console.log(`[${name}] *** ${m.winner} WINS! ***`);
        ws.close();
        process.exit(0);
      }
      if (m.turn === name) {
        const top = m.top;
        const playableCards = m.hand.filter(c => canPlay(c, top));
        setTimeout(() => {
          if (playableCards.length > 0) {
            const choice = playableCards[Math.floor(Math.random() * playableCards.length)];
            console.log(`[${name}] Playing ${choice}`);
            ws.send(JSON.stringify({ type: 'play', card: choice }));
          } else {
            console.log(`[${name}] No playable card, drawing`);
            ws.send(JSON.stringify({ type: 'draw' }));
          }
        }, humanDelay());
      }
      break;

    case 'error':
      console.log(`[${name}] [Error]`, m.message);
      break;

    case 'left':
      console.log(`[${name}] Left the room.`);
      break;

    default:
      console.log(`[${name}] Unknown message:`, m);
  }
});

ws.on('close', () => {
  console.log(`[${name}] Connection closed.`);
  process.exit(0);
});

ws.on('error', e => {
  console.log(`[${name}] Connection error:`, e.message);
});
