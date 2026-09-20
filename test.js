const WebSocket = require('ws');
const readline = require('readline');

// create: node test.js create NAME SIZE     join: node test.js join CODE NAME
const [, , action, a, b] = process.argv;
const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
  if (action === 'create') ws.send(JSON.stringify({ type: 'create', name: a, max: Number(b) }));
  else ws.send(JSON.stringify({ type: 'join', code: a, name: b }));
  console.log('Commands: play 7C | draw | leave   (S=spades H=hearts D=diamonds C=clubs)');
});
ws.on('message', m => {
  const d = JSON.parse(m.toString());
  if (d.type === 'game') {
    console.log('TOP: ' + d.top + ' | TURN: ' + d.turn + ' | HAND: ' + d.hand.join(' ') + (d.winner ? ' | WINNER: ' + d.winner : ''));
  } else {
    console.log(m.toString());
  }
});
ws.on('close', () => process.exit());

readline.createInterface({ input: process.stdin }).on('line', l => {
  const t = l.trim();
  if (t === 'leave') ws.send(JSON.stringify({ type: 'leave' }));
  else if (t === 'draw') ws.send(JSON.stringify({ type: 'draw' }));
  else if (t.startsWith('play ')) ws.send(JSON.stringify({ type: 'play', card: t.slice(5).trim().toUpperCase() }));
});
