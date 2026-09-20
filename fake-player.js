const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = 'ws://127.0.0.1:3001';

const args = process.argv.slice(2);
const name = args[0];
const code = args[1];

if (!name || !code) {
  console.log('Usage: node fake-player.js <yourName> <roomCode>');
  process.exit(1);
}

const ws = new WebSocket(SERVER_URL);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let lastTop = null;

ws.on('open', () => {
  console.log(`Connecting as "${name}", joining room ${code}...`);
  ws.send(JSON.stringify({ type: 'join', name, code }));
});

ws.on('message', raw => {
  let m;
  try { m = JSON.parse(raw); } catch { console.log('Bad message from server:', raw); return; }

  switch (m.type) {
    case 'room':
      console.log(`\n[Lobby] Room ${m.code} — players: ${m.players.join(', ')} (waiting for ${m.waitingFor} more, max ${m.max})`);
      break;

    case 'started':
      console.log(`\nGame started! Players: ${m.players.join(', ')}`);
      break;

    case 'game':
      lastTop = m.top;
      console.log('\n--- Game state ---');
      console.log('Top card:', m.top, '| Deck left:', m.deckCount, '| Direction:', m.direction === 1 ? '->' : '<-');
      console.log('Turn:', m.turn === name ? 'YOUR TURN' : m.turn);
      console.log('Your hand:', m.hand.join(' '));
      m.others.forEach(o => console.log(`  ${o.name}: ${o.count} cards`));
      if (m.winner) {
        console.log(`\n*** ${m.winner} WINS! ***`);
        rl.close();
        ws.close();
        process.exit(0);
      }
      break;

    case 'error':
      console.log('[Error]', m.message);
      break;

    case 'left':
      console.log('You left the room.');
      break;

    default:
      console.log('Unknown message:', m);
  }
  promptNext();
});

ws.on('close', () => {
  console.log('Connection closed.');
  rl.close();
  process.exit(0);
});

ws.on('error', e => {
  console.log('Connection error:', e.message);
});

function promptNext() {
  rl.question('> ', input => {
    const [cmd, arg] = input.trim().split(/\s+/);
    if (cmd === 'play' && arg) {
      ws.send(JSON.stringify({ type: 'play', card: arg.toUpperCase() }));
    } else if (cmd === 'draw') {
      ws.send(JSON.stringify({ type: 'draw' }));
    } else if (cmd === 'leave' || cmd === 'quit') {
      ws.send(JSON.stringify({ type: 'leave' }));
    } else {
      console.log('Commands: play <card e.g. 5H>, draw, leave');
      promptNext();
    }
  });
}
