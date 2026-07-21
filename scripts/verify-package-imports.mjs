const gameDomain = await import('@guandan/game-domain');
const protocol = await import('@guandan/protocol');

if (Object.keys(gameDomain).length !== 0) {
  throw new Error('@guandan/game-domain must remain an empty scaffold');
}

if (protocol.SCAFFOLD_PING_EVENT !== 'scaffold:ping') {
  throw new Error('@guandan/protocol did not expose the scaffold event');
}

console.log('Shared package public imports resolved successfully');
