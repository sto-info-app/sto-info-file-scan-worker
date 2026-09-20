// Asks clamd whether it is listening yet, and says so with an exit code.
//
// Plain JavaScript and no dependencies, because it runs in a wait loop
// before the rehearsal proper and starting ts-node three hundred times
// would take longer than the scanner does.
const net = require('node:net');

const port = Number(process.argv[2]);
const socket = net.createConnection(port, '127.0.0.1');
let reply = '';

const give_up = setTimeout(() => {
  socket.destroy();
  process.exit(1);
}, 2000);

socket.on('connect', () => socket.write(Buffer.from('zPING\0', 'ascii')));
socket.on('data', chunk => {
  reply += chunk.toString('utf8');

  if (reply.includes('PONG')) {
    clearTimeout(give_up);
    socket.destroy();
    process.exit(0);
  }
});
socket.on('error', () => {
  clearTimeout(give_up);
  process.exit(1);
});
socket.on('close', () => process.exit(reply.includes('PONG') ? 0 : 1));
