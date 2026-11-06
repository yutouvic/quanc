export const DISCONNECT_TIMEOUT_MS = 10 * 60 * 1000;

export class RoomLifecycle {
  constructor(server, usedMatchIDs, { timeoutMs = DISCONNECT_TIMEOUT_MS } = {}) {
    this.server = server;
    this.usedMatchIDs = usedMatchIDs;
    this.timeoutMs = timeoutMs;
    this.timers = new Map();
    this.closing = new Set();
  }

  enqueue(matchID, task) {
    return this.server.transport.getMatchQueue(matchID).add(task);
  }

  isConnected(matchID, playerID, credentials) {
    return [...this.server.transport.clientInfo.values()].some(client =>
      client.matchID === matchID && String(client.playerID) === String(playerID)
      && client.credentials === credentials);
  }

  cancel(matchID, playerID) {
    const timers = this.timers.get(matchID);
    if (!timers) return;
    clearTimeout(timers.get(String(playerID))?.timer);
    timers.delete(String(playerID));
    if (!timers.size) this.timers.delete(matchID);
  }

  watch(matchID, playerID, credentials) {
    if (this.closing.has(matchID) || this.isConnected(matchID, playerID, credentials)) return;
    const key = String(playerID);
    let timers = this.timers.get(matchID);
    if (!timers) this.timers.set(matchID, timers = new Map());
    if (timers.get(key)?.credentials === credentials) return;
    this.cancel(matchID, key);
    if (!this.timers.has(matchID)) this.timers.set(matchID, timers);
    const entry = { credentials };
    entry.timer = setTimeout(() => {
      this.enqueue(matchID, async () => {
        if (this.timers.get(matchID)?.get(key) !== entry) return;
        const { metadata } = await this.server.db.fetch(matchID, { metadata: true });
        const player = metadata?.players[key];
        if (!player?.name || player.credentials !== credentials || this.isConnected(matchID, key, credentials)) {
          this.cancel(matchID, key);
          return;
        }
        await this.destroy(matchID, metadata.gameName, '有玩家断线超过10分钟，房间已关闭，请重新创建房间。');
      }).catch(error => console.error('Room expiry failed:', error));
    }, this.timeoutMs);
    entry.timer.unref?.();
    timers.set(key, entry);
  }

  async refresh(matchID, gameName) {
    const { state, metadata } = await this.server.db.fetch(matchID, { state: true, metadata: true });
    const members = Object.values(metadata?.players || {}).filter(player => player.name);
    if (!members.length) return this.destroy(matchID, gameName, '房间已关闭。');
    if (metadata.gameName !== gameName || !state) return;
    const next = structuredClone(state);
    const previousHost = String(next.G.hostID ?? '0');
    const ids = members.map(player => String(player.id)).sort((a, b) => Number(a) - Number(b));
    next.G.hostID = ids.includes(previousHost) ? previousHost
      : ids.find(id => Number(id) > Number(previousHost)) || ids[0];
    // Clear vacant readiness so departed players cannot be dealt into a new game.
    for (const id of Object.keys(next.G.lobby?.ready || {})) {
      if (!ids.includes(id)) delete next.G.lobby.ready[id];
    }
    next._undo = [];
    next._redo = [];
    next._stateID++;
    await this.server.db.setState(matchID, next);
    for (const client of [...this.server.transport.clientInfo.values()]) {
      if (client.matchID !== matchID) continue;
      if (metadata.players[client.playerID]?.credentials === client.credentials) continue;
      this.server.transport.removeClient(client.socket.id);
      client.socket.disconnect();
    }
    for (const id of [...(this.timers.get(matchID)?.keys() || [])]) {
      if (!ids.includes(id)) this.cancel(matchID, id);
    }
    for (const player of members) {
      if (this.isConnected(matchID, player.id, player.credentials)) this.cancel(matchID, player.id);
      else this.watch(matchID, player.id, player.credentials);
    }
    // The framework applies each recipient's playerView before sending this update.
    this.server.transport.pubSub.publish(`MATCH-${matchID}`, { type: 'update', args: [matchID, next] });
    const players = Object.values(metadata.players).map(({ credentials, ...player }) => player);
    this.server.app._io.of(gameName).to(matchID).emit('matchData', matchID, players);
  }

  async destroy(matchID, gameName, message) {
    if (this.closing.has(matchID)) return;
    this.closing.add(matchID);
    try {
      for (const id of [...(this.timers.get(matchID)?.keys() || [])]) this.cancel(matchID, id);
      this.server.app._io.of(gameName).to(matchID).emit('roomClosed', matchID, { message });
      // Remove transport registrations before disconnect callbacks can start new timers.
      for (const client of [...this.server.transport.clientInfo.values()]) {
        if (client.matchID !== matchID) continue;
        this.server.transport.removeClient(client.socket.id);
        client.socket.disconnect();
      }
      await this.server.db.wipe(matchID);
      this.server.transport.deleteMatchQueue(matchID);
      this.usedMatchIDs.delete(matchID);
    } finally {
      this.closing.delete(matchID);
    }
  }

  dispose() {
    for (const [matchID, timers] of this.timers) {
      for (const id of [...timers.keys()]) this.cancel(matchID, id);
    }
  }
}
