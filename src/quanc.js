/**
 * src/quanc.js
 * 游戏核心逻辑定义（boardgame.io Game 对象）。
 *
 * 规则概要：
 * - 90 张牌，6 个家族 × 15 张（每家族：2 刺客 / 3 间谍 / 3 贵族 / 3 守卫 / 4 平民）。
 * - 公共区域「餐桌」分两块：上为得宠区，下为失宠区；每位玩家面前是自己的「领地」。
 * - 每回合：摸 3 张牌，然后必须全部打出——
 *   分别在【自己领地】【其他某位玩家领地】【餐桌（得宠/失宠由玩家选择）】各打出 1 张。
 * - 卡牌效果：
 *   · 贵族：权重 2（判定得宠/失宠与计分时，1 张贵族 = 2 张牌）。
 *   · 间谍：打出后背面向上，对所有人隐藏，游戏结束时统一翻开。
 *   · 刺客：打出后，可移除该区域内 1 张其他牌（守卫免疫、不可移除刺客自身），任何情况下都可选择不发动。
 *   · 守卫：无法被刺客移除。
 * - 游戏在牌堆抽完时结束，统一结算：
 *   · 家族命运：餐桌上该家族「得宠权重 > 失宠权重」则得宠，反之失宠，相等中立。
 *   · 领地得分：每张牌按其家族命运计 ±权重（得宠 +w，失宠 -w，中立 0），累加为玩家总分，最高分获胜。
 */

import { createDeck, shuffleDeck, drawFromDeck, FAMILIES } from './quanc-cards.js';

// boardgame.io 用于标记非法操作的常量（本地定义，避免服务端额外打包依赖）
const INVALID_MOVE = 'INVALID_MOVE';

// 每回合摸牌数
const CARDS_PER_TURN = 3;

// 不同人数下开局需移除（本局不使用）的牌数。
// 使剩余牌堆恰好能被「人数 × 每回合摸牌数」整除，保证轮次完整、最后轮每人行动次数相等。
const REMOVE_BY_PLAYERS = { 2: 30, 3: 18, 4: 6, 5: 0 };

/**
 * 正式游戏回合顺序：房间固定创建 5 个座位，但开局时只有实际加入的玩家参与。
 * playOrder 在 startGame 时写入 G.playOrder（座位号升序），未加入的空座位不参与轮转。
 * first 固定为 0：lobby 阶段会占用第 1 回合，默认顺序会把正式游戏先手推到座位 1，
 * 这里显式从座位 0（房主）开始。
 */
const PARTICIPANT_TURN_ORDER = {
  playOrder: ({ G }) => G.playOrder,
  first: () => 0,
  next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.playOrder.length,
};

/**
 * G 结构：
 * {
 *   deck: Array,                          // 牌堆（剩余）
 *   removedCount: number,                 // 开局移除的牌数
 *   table: { favored: [], disfavored: [] },// 餐桌：得宠区 / 失宠区
 *   players: { [id]: { hand, territory } },// 各玩家手牌与领地（开局时裁掉空座位）
 *   playOrder: string[],                  // 正式游戏的参与玩家 ID（座位升序）
 *   playerCount: number,                  // 实际参与人数（2-5）
 *   discard: Array,                       // 被刺客移除的牌（已移出本局）
 *   pendingAssassin: null | { location, assassinCardId }, // 待结算的刺客效果
 *   turnDrawCount, turnPlayCount,
 *   turnUsed: { own, opponent, table },
 *   lobby: { ready: { [playerID]: true }, started: bool }, // 大厅等待阶段状态
 *   ended: bool, round: number, log: Array,
 * }
 *
 * 阶段（phases）：
 * - lobby：房间等待阶段（初始阶段）。房间固定 5 个座位，玩家加入后自动「准备」，
 *   房主（玩家 1）在 2-5 名玩家就位后即可开始游戏。
 * - play：正式游戏阶段，摸牌 / 出牌等操作仅在此阶段可用。
 */

/**
 * 创建并洗牌后的牌堆。
 */
function buildShuffledDeck(random) {
  return shuffleDeck(createDeck(), random);
}

/**
 * 初始化玩家状态（手牌与领地均为空）。
 */
function initPlayers(numPlayers) {
  const players = {};
  for (let i = 0; i < numPlayers; i++) {
    players[String(i)] = { hand: [], territory: [] };
  }
  return players;
}

/**
 * 卡牌文字描述。间谍不暴露家族（背面）。
 */
function describeCard(card) {
  if (card.type === 'spy') return '间谍（背面）';
  return `${card.familyName}·${card.typeName}`;
}

/**
 * 玩家展示编号：内部 playerID 为 0 基，界面与日志统一从 1 开始显示。
 */
export function pLabel(id) {
  return Number(id) + 1;
}

/**
 * 根据「区域定位」获取对应的卡牌数组引用。
 * loc: { kind: 'territory', owner } 或 { kind: 'table', zone }
 */
function areaArray(G, loc) {
  if (!loc) return null;
  if (loc.kind === 'territory') {
    const p = G.players[loc.owner];
    return p ? p.territory : null;
  }
  if (loc.kind === 'table') return G.table[loc.zone] || null;
  return null;
}

/**
 * 隐藏间谍：未结束时，间谍牌对所有人不可见（仅保留 id 与类型）。
 */
function maskCard(card, ended) {
  if (card.type === 'spy' && !ended) {
    return { id: card.id, type: 'spy', faceDown: true };
  }
  return card;
}

/**
 * 统计餐桌各家族的得宠 / 失宠权重与最终命运。
 * 隐藏的间谍牌无 family 字段，不参与统计（未知）。
 * @param {{favored: Array, disfavored: Array}} table
 */
export function computeFamilyFates(table) {
  const fates = {};
  for (const f of FAMILIES) {
    let favored = 0;
    let disfavored = 0;
    for (const c of table.favored) if (c.family === f.id) favored += c.weight ?? 1;
    for (const c of table.disfavored) if (c.family === f.id) disfavored += c.weight ?? 1;
    let fate = 'neutral';
    if (favored > disfavored) fate = 'favored';
    else if (disfavored > favored) fate = 'disfavored';
    fates[f.id] = { favored, disfavored, fate };
  }
  return fates;
}

/**
 * 汇总所有玩家的最终得分（按权重计）。
 */
export function computeScores(G) {
  const fates = computeFamilyFates(G.table);
  const scores = {};
  for (const id of Object.keys(G.players)) {
    let score = 0;
    for (const card of G.players[id].territory) {
      const fate = fates[card.family] && fates[card.family].fate;
      const w = card.weight ?? 1;
      if (fate === 'favored') score += w;
      else if (fate === 'disfavored') score -= w;
    }
    scores[id] = score;
  }
  return { scores, fates };
}

// ========== 任务系统 ==========

/** 下家：playOrder 中当前玩家的下一位（循环）。 */
function nextPlayerId(G, playerID) {
  const order = G.playOrder;
  if (!order || order.length === 0) return playerID;
  const idx = order.indexOf(playerID);
  if (idx < 0) return playerID;
  return order[(idx + 1) % order.length];
}

/** 统计一组牌中指定家族的张数（按张数计，非权重）。 */
function countFamily(cards, familyId) {
  let n = 0;
  for (const c of cards) if (c.family === familyId) n++;
  return n;
}

/**
 * 餐桌任务（10 个）。
 * check 接收 G：客户端为 playerView 后的状态（间谍无 family，按公开信息预估），
 * 服务端为完整状态（判定准确）。
 */
export const TABLE_TASKS = [
  {
    id: 'few-favored',
    name: '收敛锋芒',
    desc: '不超过 3 个家族得宠',
    check: (G) => {
      const fates = computeFamilyFates(G.table);
      return FAMILIES.filter((f) => fates[f.id].fate === 'favored').length <= 3;
    },
  },
  {
    id: 'many-disfavored',
    name: '失势者众',
    desc: '至少 2 个家族失宠',
    check: (G) => {
      const fates = computeFamilyFates(G.table);
      return FAMILIES.filter((f) => fates[f.id].fate === 'disfavored').length >= 2;
    },
  },
  {
    id: 'some-5-disfavored',
    name: '众矢之的',
    desc: '某个家族在失宠区至少有 3 张牌',
    check: (G) => FAMILIES.some((f) => countFamily(G.table.disfavored, f.id) >= 3),
  },
  {
    id: 'each-1-disfavored',
    name: '雨露均沾',
    desc: '每个家族在失宠区都至少有 1 张牌',
    check: (G) => FAMILIES.every((f) => countFamily(G.table.disfavored, f.id) >= 1),
  },
  ...FAMILIES.map((f) => ({
    id: `${f.id}-disfavored`,
    name: `${f.name}失宠`,
    desc: `${f.name}在餐桌失宠`,
    check: (G) => computeFamilyFates(G.table)[f.id].fate === 'disfavored',
  })),
];

/**
 * 领地任务（10 个）。
 */
export const TERRITORY_TASKS = [
  {
    id: '4-guard',
    name: '坚盾',
    desc: '你的领地至少有 4 张守卫',
    check: (G, playerID) =>
      G.players[playerID].territory.filter((c) => c.type === 'guard').length >= 4,
  },
  {
    id: '3-noble',
    name: '权贵',
    desc: '你的领地至少有 3 张贵族',
    check: (G, playerID) =>
      G.players[playerID].territory.filter((c) => c.type === 'noble').length >= 3,
  },
  {
    id: '3-spy',
    name: '潜伏',
    desc: '你的领地至少有 3 张间谍',
    check: (G, playerID) =>
      G.players[playerID].territory.filter((c) => c.type === 'spy').length >= 3,
  },
  {
    id: '2-assassin',
    name: '暗杀',
    desc: '你的领地至少有 2 张刺客',
    check: (G, playerID) =>
      G.players[playerID].territory.filter((c) => c.type === 'assassin').length >= 2,
  },
  ...FAMILIES.map((f) => ({
    id: `${f.id}-less`,
    name: `${f.name}式微`,
    desc: `你领地的${f.name}牌比下家少`,
    check: (G, playerID) => {
      const next = nextPlayerId(G, playerID);
      return (
        countFamily(G.players[playerID].territory, f.id) <
        countFamily(G.players[next].territory, f.id)
      );
    },
  })),
];

/** 按类别 + id 查找任务定义。 */
export function getTask(category, taskId) {
  const list = category === 'table' ? TABLE_TASKS : TERRITORY_TASKS;
  return list.find((t) => t.id === taskId);
}

/** 判定所有玩家的任务完成情况并计算任务得分（每完成一个 +3 分）。 */
export function computeTaskResults(G) {
  const results = {};
  for (const id of Object.keys(G.players)) {
    const tasks = G.players[id].tasks;
    const tableTask = tasks && tasks.table ? getTask('table', tasks.table) : undefined;
    const territoryTask = tasks && tasks.territory ? getTask('territory', tasks.territory) : undefined;
    const tableDone = tableTask ? tableTask.check(G, id) : false;
    const territoryDone = territoryTask ? territoryTask.check(G, id) : false;
    results[id] = {
      table: tableDone,
      territory: territoryDone,
      score: (tableDone ? 3 : 0) + (territoryDone ? 3 : 0),
    };
  }
  return results;
}

/**
 * 构建全新的大厅初始状态（setup 与「返回房间」共用，保证房间可重复利用）。
 * 牌堆移除推迟到 startGame，按实际参与人数计算。
 */
function freshQuancG(ctx, random, logLine) {
  return {
    deck: buildShuffledDeck(random),
    removedCount: 0,
    table: { favored: [], disfavored: [] },
    players: initPlayers(ctx.numPlayers),
    playOrder: [],
    playerCount: 0,
    discard: [],
    pendingAssassin: null,
    turnDrawCount: 0,
    turnPlayCount: 0,
    turnUsed: { own: false, opponent: false, table: false },
    turnActions: [],  // 本回合已执行的操作（出牌/刺客移除），用于撤回
    undoCount: {},    // 各玩家已用撤回次数（上限 3 次/人/局）
    lobby: { ready: {}, started: false },
    ended: false,
    results: null, // 结算数据（获胜者/得分/任务/家族宠辱），结束时写入
    turnBase: 1,   // play 阶段起始回合基准（startGame 时写入），用于轮次计算
    round: 1,
    log: [logLine],
  };
}

/**
 * boardgame.io Game 定义。
 */
export const QuancGame = {
  name: 'quanc-card-game',
  minPlayers: 2,
  maxPlayers: 5,

  setup: ({ ctx, random }) => {
    // 房间固定创建 5 个座位，实际人数在房主开局时才确定；
    return freshQuancG(ctx, random, '房间已创建：最多 5 人，至少 2 人即可开局，等待玩家加入。');
  },

  /**
   * 阶段定义：
   * - lobby（初始阶段）：房间等待，不摸牌、不轮转，所有已连接玩家都可「准备」；
   *   仅房主（座位 0）在全员准备后可开始游戏。
   * - play：正式游戏，沿用回合摸牌 / 出牌与自动结束回合逻辑。
   */
  phases: {
    lobby: {
      start: true,
      next: 'play',

      // 覆盖游戏级 turn：不配置 onBegin（不会摸牌），
      // activePlayers 允许所有座位的玩家同时发起准备 / 开始操作。
      turn: {
        activePlayers: { all: 'waiting' },
      },

      moves: {
        /**
         * 玩家进入房间后自动标记已准备。
         * 设为长格式 + ignoreStaleStateID（不设 client:false，保留客户端乐观更新）：
         * - 两名玩家几乎同时重连 / 返回房间时，各自的 lobbyReady 可能携带同一个
         *   旧 stateID，后到者会被 boardgame.io 以「invalid stateID」拒绝；
         *   该 move 幂等（只写自己的 ready 标记），可安全忽略陈旧 stateID。
         * - 必须保留乐观更新：客户端依赖本地 ready 标记立刻变 true 来终止
         *   自动 lobbyReady 重试，否则会在 subscribe 回调里无限重发。
         */
        lobbyReady: {
          ignoreStaleStateID: true,
          move: ({ G, playerID }) => {
            if (!G.lobby) return INVALID_MOVE;
            G.lobby.ready[playerID] = true;
            return undefined;
          },
        },

        /**
         * 房主开局：加入人数在 2-5 之间即可开始。
         * 此处只裁掉空座位、固定正式游戏回合顺序；
         * 牌堆移除放在 play 阶段 onBegin（客户端乐观更新拿到的是
         * playerView 后的状态，deck 仅为数字张数，不能在 move 里直接操作牌组）。
         *
         * 与 Red7 一致设为 client:false（仅服务端结算）：
         * 开局依赖 random 抽任务，且会触发 endPhase → play.onBegin（操作牌堆），
         * 这些都不应在客户端乐观执行（会造成任务不一致 / 操作数字牌堆）。
         */
        startGame: {
          client: false,
          move: ({ G, ctx, playerID, events, random }) => {
            if (!G.lobby || G.lobby.started) return INVALID_MOVE;
            if (playerID !== '0') return INVALID_MOVE; // 仅房主（创建者，座位 0）
            const participants = Object.keys(G.lobby.ready).sort((a, b) => Number(a) - Number(b));
            const count = participants.length;
            if (count < 2 || count > ctx.numPlayers) return INVALID_MOVE; // 至少 2 人，不超过座位数

            // 裁掉未加入的空座位，并固定正式游戏回合顺序
            for (const id of Object.keys(G.players)) {
              if (!G.lobby.ready[id]) delete G.players[id];
            }
            G.playOrder = participants;
            G.playerCount = count;
            // 初始化各玩家撤回次数
            participants.forEach(id => { G.undoCount[id] = 0; });
            // 记录 play 阶段起始回合基准：房间重开后 ctx.turn 不会归零，
            // 轮次计算须以本次开局时的回合数为基准
            G.turnBase = ctx.turn;

            // 抽取任务（不放回，每名玩家各 1 个餐桌任务 + 1 个领地任务）
            const tableTasks = shuffleDeck(TABLE_TASKS, random).slice(0, count);
            const territoryTasks = shuffleDeck(TERRITORY_TASKS, random).slice(0, count);
            participants.forEach((id, i) => {
              G.players[id].tasks = {
                table: tableTasks[i].id,
                territory: territoryTasks[i].id,
              };
            });

            G.lobby.started = true;
            G.log.push(`已有 ${count} 名玩家就位，游戏开始。`);
            events.endPhase();
            return undefined;
          },
        },
      },
    },

    play: {
      // 进入正式游戏时按实际人数移除牌，保证牌堆可被「人数 × 每回合摸牌数」整除。
      // 只在服务端主状态执行（客户端看到的 deck 是数字张数）。
      onBegin: ({ G }) => {
        const removeCount = REMOVE_BY_PLAYERS[G.playerCount] ?? 0;
        G.deck.splice(0, removeCount);
        G.removedCount = removeCount;
        G.log.push(`移除 ${removeCount} 张牌，牌堆剩余 ${G.deck.length} 张。`);
      },

      turn: {
        // lobby 阶段已占用第 1 回合；这里显式从座位 0 开始，并把回合顺序限定为
        // 实际参与玩家（房间固定 5 个座位，可能只有 2-4 人开局）。
        order: PARTICIPANT_TURN_ORDER,

        // 所有玩家均处于 active：出牌/结算类 move 内部自行校验 currentPlayer，
        // 这样「结束游戏」这类房主全局操作无需受当前回合玩家限制。
        activePlayers: { all: 'play' },

        onBegin: ({ G, ctx }) => {
          // 仅在本局进行中的 play 阶段推进回合：
          // 本局已结束（等待返回房间）或状态已被 backToLobby 重置（lobby.started=false）时冻结，
          // 防止重置后回合自动推进到下一玩家并误发手牌，污染干净的房间状态
          if (ctx.phase !== 'play' || G.ended || !G.lobby?.started) return;
          const playerID = ctx.currentPlayer;
          const player = G.players[playerID];
          player.hand = [];
          const numPlayers = ctx.playOrder.length;
          // 回合数以 startGame 时的基准（G.turnBase）计算：
          // 轮次 = floor((当前回合 - 基准) / 实际人数) + 1
          G.round = Math.floor((ctx.turn - G.turnBase) / numPlayers) + 1;
          G.pendingAssassin = null;
          G.turnActions = [];

          if (G.deck.length === 0) {
            // 牌堆已空且所有玩家无手牌 → 触发结束
            const allHandsEmpty = Object.values(G.players).every((p) => p.hand.length === 0);
            if (allHandsEmpty) {
              G.ended = true;
              G.turnDrawCount = 0;
              G.turnPlayCount = 0;
              // 结算数据写入 G.results（不再设置 ctx.gameover，
              // 保证结束后仍可执行「返回房间」move，房间可复用）
              const { scores, fates } = computeScores(G);
              const taskResults = computeTaskResults(G);
              const ids = Object.keys(G.players);
              const total = {};
              for (const id of ids) total[id] = scores[id] + taskResults[id].score;
              const max = Math.max(...ids.map(id => total[id]));
              G.results = {
                winners: ids.filter(id => total[id] === max),
                scores: total,
                territoryScores: scores,
                taskResults,
                fates,
                reason: '牌堆抽完且所有玩家无手牌，游戏结束',
              };
              G.log.push('牌堆已空且所有玩家无手牌，游戏结束。');
              return;
            }
            // 牌堆已空但仍有玩家持有手牌：无法摸牌，本回合直接跳过，等待其余玩家清空手牌
            G.turnDrawCount = 0;
            G.turnPlayCount = 0;
            G.log.push('牌堆已空，仍有玩家持有手牌，本回合跳过。');
            return;
          }

          const n = Math.min(CARDS_PER_TURN, G.deck.length);
          const { drawn, remaining } = drawFromDeck(G.deck, n);
          G.deck = remaining;
          player.hand.push(...drawn);

          G.turnDrawCount = n;
          G.turnPlayCount = 0;
          G.turnUsed = { own: false, opponent: false, table: false };
          G.log.push(`玩家 ${pLabel(playerID)} 回合开始，摸 ${n} 张牌。`);
        },

        // 仅当牌堆已空、无牌可摸时自动结束回合（此时玩家无牌可打，无需手动操作）；
        // 正常回合需玩家手动点击「结束回合」按钮。
        // （本局已结束 / 状态已被 backToLobby 重置后冻结当前回合，不再轮转）
        endIf: ({ G, ctx }) => ctx.phase === 'play' && G.lobby?.started && !G.ended
          && G.turnDrawCount === 0 && !G.pendingAssassin,
      },
    },
  },

  moves: {
    /**
     * 打出一张手牌。
     * @param {number} handIndex
     * @param {string} destination - 'own' | 'opponent' | 'table'
     * @param {string} target - opponent 时为对方 playerID；table 时为 'favored' | 'disfavored'
     *
     * 采用长格式 move 并将 client 置为 false：出牌只由服务端结算，
     * 避免客户端乐观更新把间谍牌以正面渲染出来（家族泄露）。
     */
    playCard: {
      client: false,
      move: ({ G, ctx, playerID }, handIndex, destination, target) => {
        // 仅在正式游戏阶段可出牌
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE; // 本局已结束，等待返回房间
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const player = G.players[playerID];
        if (!player) return INVALID_MOVE;
        if (typeof handIndex !== 'number' || handIndex < 0 || handIndex >= player.hand.length) {
          return INVALID_MOVE;
        }
        // 有未结算的刺客效果时，需先结算
        if (G.pendingAssassin) return INVALID_MOVE;
        if (!G.turnUsed || typeof G.turnUsed[destination] !== 'boolean') return INVALID_MOVE;
        if (G.turnUsed[destination]) return INVALID_MOVE;

        let card;
        let location;
        if (destination === 'own') {
          card = player.hand.splice(handIndex, 1)[0];
          player.territory.push({ ...card, playedBy: playerID });
          G.turnUsed.own = true;
          location = { kind: 'territory', owner: playerID };
          G.log.push(`玩家 ${pLabel(playerID)} 将 ${describeCard(card)} 打入自己领地。`);
        } else if (destination === 'opponent') {
          const opp = G.players[target];
          if (!opp || target === playerID) return INVALID_MOVE;
          card = player.hand.splice(handIndex, 1)[0];
          opp.territory.push({ ...card, playedBy: playerID });
          G.turnUsed.opponent = true;
          location = { kind: 'territory', owner: target };
          G.log.push(`玩家 ${pLabel(playerID)} 将 ${describeCard(card)} 打入玩家 ${pLabel(target)} 的领地。`);
        } else if (destination === 'table') {
          const zone = target;
          if (zone !== 'favored' && zone !== 'disfavored') return INVALID_MOVE;
          card = player.hand.splice(handIndex, 1)[0];
          G.table[zone].push({ ...card, playedBy: playerID });
          G.turnUsed.table = true;
          location = { kind: 'table', zone };
          const zoneName = zone === 'favored' ? '得宠区' : '失宠区';
          G.log.push(`玩家 ${pLabel(playerID)} 将 ${describeCard(card)} 打入餐桌${zoneName}。`);
        } else {
          return INVALID_MOVE;
        }

        G.turnPlayCount += 1;
        G.turnActions.push({ type: 'play', card, location });

        // 刺客：打出后进入待结算状态
        if (card.type === 'assassin') {
          G.pendingAssassin = { location, assassinCardId: card.id };
          G.log.push(`玩家 ${pLabel(playerID)} 打出刺客：可移除区域内 1 张其他牌（守卫免疫），也可选择不发动。`);
        }
        return undefined;
      },
    },

    /**
     * 结算刺客效果。
     * @param {number} targetIndex - 目标牌在该区域数组中的索引；传 -1 / null 表示不发动。
     * 规则：任何情况下都可选择不发动；发动时可移除区域内除刺客自身与守卫外的任意 1 张牌。
     */
    resolveAssassin: {
      // 仅服务端结算：客户端 playerView 不含 turnActions，乐观更新会导致 push 报错
      client: false,
      move: ({ G, ctx, playerID }, targetIndex) => {
      if (ctx.phase !== 'play') return INVALID_MOVE;
      if (G.ended) return INVALID_MOVE; // 本局已结束，等待返回房间
      if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
      const pending = G.pendingAssassin;
      if (!pending) return INVALID_MOVE;
      const area = areaArray(G, pending.location);
      if (!area) return INVALID_MOVE;

      // 不发动：任何情况下都允许
      if (targetIndex === null || targetIndex === undefined || targetIndex < 0) {
        G.pendingAssassin = null;
        G.log.push(`玩家 ${pLabel(playerID)} 未发动刺客效果。`);
        return undefined;
      }

      if (typeof targetIndex !== 'number' || targetIndex >= area.length) return INVALID_MOVE;
      const targetCard = area[targetIndex];
      if (targetCard.id === pending.assassinCardId) return INVALID_MOVE; // 不能移除刺客自身
      if (targetCard.type === 'guard') return INVALID_MOVE;            // 守卫免疫

      area.splice(targetIndex, 1);
      G.discard.push(targetCard);
      G.turnActions.push({ type: 'assassinRemove', card: targetCard, location: pending.location, index: targetIndex });
      G.pendingAssassin = null;
        G.log.push(`玩家 ${pLabel(playerID)} 的刺客移除了 1 张牌（移出本局）。`);
        return undefined;
      },
    },

    /**
     * 手动结束回合：需已打出全部手牌且无待结算刺客效果。
     */
    endTurn: {
      client: false,
      move: ({ G, ctx, playerID, events }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pendingAssassin) return INVALID_MOVE;
        if (G.turnPlayCount < G.turnDrawCount) return INVALID_MOVE;
        G.log.push(`玩家 ${pLabel(playerID)} 结束回合。`);
        events.endTurn();
        return undefined;
      },
    },

    /**
     * 撤回本回合全部操作：收回所有已打出的牌，恢复刺客移除的牌。
     * 每名玩家每局至多 3 次。
     */
    undoTurn: {
      client: false,
      move: ({ G, ctx, playerID }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.turnPlayCount === 0) return INVALID_MOVE;
        const used = G.undoCount[playerID] || 0;
        if (used >= 3) return INVALID_MOVE;

        const player = G.players[playerID];
        // 清除未结算的刺客效果
        G.pendingAssassin = null;

        // 逆序撤回本回合所有操作
        for (let i = G.turnActions.length - 1; i >= 0; i--) {
          const action = G.turnActions[i];
          if (action.type === 'play') {
            // 从目标区域找回卡牌，放回手中
            const area = areaArray(G, action.location);
            if (area) {
              const idx = area.findIndex(c => c.id === action.card.id);
              if (idx >= 0) {
                area.splice(idx, 1);
                player.hand.push(action.card);
              }
            }
          } else if (action.type === 'assassinRemove') {
            // 从弃牌堆找回被移除的牌，放回原位置
            const didx = G.discard.findIndex(c => c.id === action.card.id);
            if (didx >= 0) {
              G.discard.splice(didx, 1);
              const area = areaArray(G, action.location);
              if (area) area.splice(action.index, 0, action.card);
            }
          }
        }

        G.turnActions = [];
        G.turnPlayCount = 0;
        G.turnUsed = { own: false, opponent: false, table: false };
        G.undoCount[playerID] = used + 1;
        const left = 3 - used - 1;
        G.log.push(`玩家 ${pLabel(playerID)} 撤回了本回合操作（剩余 ${left} 次撤回机会）。`);
        return undefined;
      },
    },

    /**
     * 结束本局并返回房间大厅：
     * - 本局自然结束（G.ended）后，任意玩家可调用，全员回到大厅；
     * - 游戏进行中仅房主（座位 0）可调用。
     * 调用后清空上局全部游戏信息（重置为全新大厅状态），房间回到等待阶段，可开始新一局。
     */
    backToLobby: ({ G, ctx, playerID, events, random }) => {
      if (!G.lobby || !G.lobby.started) return INVALID_MOVE; // 大厅阶段不可用
      if (!G.ended && playerID !== '0') return INVALID_MOVE; // 进行中仅房主可结束
      const endedByHost = !G.ended;
      const fresh = freshQuancG(ctx, random, endedByHost
        ? '房主已结束本局，房间已重置，可开始新一局。'
        : '本局已结束，房间已重置，可开始新一局。');
      for (const k of Object.keys(G)) delete G[k];
      Object.assign(G, fresh);
      events.setPhase('lobby');
      return undefined;
    },
  },

  /**
   * 玩家视角：
   * - 其他玩家的手牌仅显示数量；
   * - 未结束时，所有区域的间谍牌隐藏家族（对所有人不可见）；
   * - 任务只对本人可见（其他玩家看不到任务内容）；
   * - 牌堆仅显示剩余张数。
   */
  playerView: ({ G, playerID }) => {
    const ended = G.ended;
    const players = {};
    for (const id of Object.keys(G.players)) {
      const p = G.players[id];
      players[id] = {
        hand: id === playerID ? p.hand : p.hand.length,
        territory: p.territory.map(c => maskCard(c, ended)),
        tasks: (id === playerID || ended) ? p.tasks : null,
      };
    }
    return {
      ...G,
      deck: G.deck.length,
      players,
      table: {
        favored: G.table.favored.map(c => maskCard(c, ended)),
        disfavored: G.table.disfavored.map(c => maskCard(c, ended)),
      },
      discard: G.discard.map(c => maskCard(c, ended)),
      turnActions: undefined, // 服务端内部状态，不下发（含未遮罩的卡牌信息）
    };
  },
};

export default QuancGame;
