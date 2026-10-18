/**
 * src/red7.js
 * Red7（红7）游戏核心逻辑（boardgame.io Game 对象）。
 *
 * 规则概要（基础规则，单局定胜负）：
 * - 49 张牌：7 种颜色 × 数字 1-7。颜色强弱顺序：红 > 橙 > 黄 > 绿 > 青 > 蓝 > 紫。
 * - 开局每人发 7 张手牌 + 1 张正面调色盘牌；画布区初始规则为「红（最大的牌赢）」。
 * - 当前优胜者左手边的玩家先手。
 * - 每回合四选一：
 *   ① 打 1 张手牌到调色盘；
 *   ② 弃 1 张手牌到画布区（该牌颜色成为新规则）；
 *   ③ 打 1 张 + 弃 1 张改规则；
 *   ④ 跳过 → 出局。
 * - ①/②/③ 后若你不在当前规则的优胜集合中即淘汰；无手牌者回合开始自动淘汰；
 *   只剩一人时该玩家获胜。
 *
 * 判定「优胜」：对未淘汰玩家，按当前规则计算比较键（越大越优），
 * 取并列最优者集合（平局即并列优胜）。
 */

// boardgame.io 用于标记非法操作的常量（本地定义，避免服务端额外打包依赖）
const INVALID_MOVE = 'INVALID_MOVE';

/**
 * 7 种颜色（顺序即强弱：红最高，紫最低）。
 * rule 为各颜色对应的获胜规则文案。
 */
export const RED7_COLORS = [
  { id: 'red', name: '红', rule: '最大的牌赢', color: '#e53935' },
  { id: 'orange', name: '橙', rule: '同数字最多', color: '#fb8c00' },
  { id: 'yellow', name: '黄', rule: '同颜色最多', color: '#fdd835' },
  { id: 'green', name: '绿', rule: '偶数牌最多', color: '#43a047' },
  { id: 'cyan', name: '青', rule: '颜色种类最多', color: '#00acc1' },
  { id: 'blue', name: '蓝', rule: '连号最长', color: '#1e88e5' },
  { id: 'violet', name: '紫', rule: '小于4最多', color: '#8e24aa' },
];

/** 颜色强弱 rank：红 = 6，紫 = 0（越大越强）。 */
function colorRank(colorIndex) {
  return RED7_COLORS.length - 1 - colorIndex;
}

/** 玩家展示编号：内部 playerID 为 0 基，界面与日志统一从 1 开始显示。 */
export function pLabel(id) {
  return Number(id) + 1;
}

/** 创建一副 49 张牌（7 色 × 数字 1-7）。 */
function createDeck() {
  const deck = [];
  for (let ci = 0; ci < RED7_COLORS.length; ci++) {
    const c = RED7_COLORS[ci];
    for (let n = 1; n <= 7; n++) {
      deck.push({
        id: `${c.id}-${n}`,
        colorIndex: ci,
        color: c.id,
        colorName: c.name,
        number: n,
      });
    }
  }
  return deck;
}

/** 洗牌（使用 boardgame.io 提供的 random API，保证可复现）。 */
function shuffleDeck(deck, random) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random.Number() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 取一组牌中「最大」的一张：Red7 的核心比较原则——先比点数，再比颜色强弱。
 * 点数是第一优先级，颜色仅在点数相同时作为 tie-breaker（红 > 橙 > 黄 > 绿 > 青 > 蓝 > 紫）。
 * 此函数被所有规则的平局判定与高亮选牌复用，请勿改动比较顺序。
 */
function bestCard(cards) {
  let best = null;
  for (const c of cards) {
    if (
      !best ||
      c.number > best.number ||
      (c.number === best.number && colorRank(c.colorIndex) > colorRank(best.colorIndex))
    ) {
      best = c;
    }
  }
  return best;
}

/** 字典序比较两个三元组键：返回 >0 表示 a 更优，<0 表示 b 更优，0 平局。 */
function compareKeys(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * 按规则计算某调色盘的比较键（三元组，越大越优）。
 * @param {number} ruleIndex 当前规则对应的颜色索引
 * @param {Array} palette 该玩家的调色盘牌
 */
function ruleKey(ruleIndex, palette) {
  const cards = palette;
  switch (ruleIndex) {
    case 0: {
      // 红：最大的牌赢
      const b = bestCard(cards);
      return b ? [b.number, colorRank(b.colorIndex), 0] : [-1, -1, -1];
    }
    case 1: {
      // 橙：同一数字最多
      const counts = new Map();
      for (const c of cards) counts.set(c.number, (counts.get(c.number) || 0) + 1);
      let maxCount = 0;
      let bestNumber = -1;
      for (const [num, cnt] of counts) {
        if (cnt > maxCount || (cnt === maxCount && num > bestNumber)) {
          maxCount = cnt;
          bestNumber = num;
        }
      }
      const b = bestCard(cards.filter((c) => c.number === bestNumber));
      return [maxCount, bestNumber, b ? colorRank(b.colorIndex) : -1];
    }
    case 2: {
      // 黄：同一颜色最多，并列时先比该色最大牌点数，再比颜色强弱
      const counts = new Map();
      const maxNumByColor = new Map();
      for (const c of cards) {
        counts.set(c.colorIndex, (counts.get(c.colorIndex) || 0) + 1);
        const cur = maxNumByColor.get(c.colorIndex);
        if (cur === undefined || c.number > cur) maxNumByColor.set(c.colorIndex, c.number);
      }
      let maxCount = 0;
      let bestColor = -1;
      let bestMaxNum = -1;
      for (const [ci, cnt] of counts) {
        const ciMaxNum = maxNumByColor.get(ci) || -1;
        if (
          cnt > maxCount ||
          (cnt === maxCount && ciMaxNum > bestMaxNum) ||
          (cnt === maxCount && ciMaxNum === bestMaxNum && colorRank(ci) > colorRank(bestColor))
        ) {
          maxCount = cnt;
          bestColor = ci;
          bestMaxNum = ciMaxNum;
        }
      }
      return [maxCount, bestMaxNum, bestColor === -1 ? -1 : colorRank(bestColor)];
    }
    case 3: {
      // 绿：偶数牌最多
      const evens = cards.filter((c) => c.number % 2 === 0);
      const b = bestCard(evens);
      return [evens.length, b ? b.number : -1, b ? colorRank(b.colorIndex) : -1];
    }
    case 4: {
      // 青：不同颜色种类最多
      const kinds = new Set(cards.map((c) => c.colorIndex)).size;
      const b = bestCard(cards);
      return [kinds, b ? b.number : -1, b ? colorRank(b.colorIndex) : -1];
    }
    case 5: {
      // 蓝：最长连号（去重数字的连续序列）
      const nums = [...new Set(cards.map((c) => c.number))].sort((a, b) => a - b);
      let runLen = 0;
      let topNum = -1;
      let cur = 0;
      let curTop = -1;
      for (const n of nums) {
        if (curTop === -1 || n === curTop + 1) {
          cur += 1;
          curTop = n;
        } else {
          cur = 1;
          curTop = n;
        }
        if (cur > runLen || (cur === runLen && curTop > topNum)) {
          runLen = cur;
          topNum = curTop;
        }
      }
      const b = bestCard(cards.filter((c) => c.number === topNum));
      return [runLen, topNum, b ? colorRank(b.colorIndex) : -1];
    }
    case 6: {
      // 紫：数字小于 4 最多
      const lows = cards.filter((c) => c.number < 4);
      const b = bestCard(lows);
      return [lows.length, b ? b.number : -1, b ? colorRank(b.colorIndex) : -1];
    }
    default:
      return [-1, -1, -1];
  }
}

/**
 * 计算某调色盘中「满足当前规则的最优牌」集合（用于高亮）。
 * 各规则的关键牌：
 *   红：最大的牌；橙：同数字最多的牌；黄：同颜色最多的牌；
 *   绿：所有偶数牌；青：每种颜色最高的一张；蓝：最长连号的牌；紫：所有小于 4 的牌。
 * 可在客户端 playerView 后的 G 上运行（调色盘公开）。
 */
export function ruleKeyCards(ruleIndex, palette) {
  const cards = palette;
  switch (ruleIndex) {
    case 0: {
      // 红：最大的牌
      const b = bestCard(cards);
      return b ? [b] : [];
    }
    case 1: {
      // 橙：同数字最多的牌
      const counts = new Map();
      for (const c of cards) counts.set(c.number, (counts.get(c.number) || 0) + 1);
      let maxCount = 0;
      let bestNumber = -1;
      for (const [num, cnt] of counts) {
        if (cnt > maxCount || (cnt === maxCount && num > bestNumber)) {
          maxCount = cnt;
          bestNumber = num;
        }
      }
      return cards.filter((c) => c.number === bestNumber);
    }
    case 2: {
      // 黄：同颜色最多的牌，并列时先比该色最大牌点数，再比颜色强弱
      const counts = new Map();
      const maxNumByColor = new Map();
      for (const c of cards) {
        counts.set(c.colorIndex, (counts.get(c.colorIndex) || 0) + 1);
        const cur = maxNumByColor.get(c.colorIndex);
        if (cur === undefined || c.number > cur) maxNumByColor.set(c.colorIndex, c.number);
      }
      let maxCount = 0;
      let bestColor = -1;
      let bestMaxNum = -1;
      for (const [ci, cnt] of counts) {
        const ciMaxNum = maxNumByColor.get(ci) || -1;
        if (
          cnt > maxCount ||
          (cnt === maxCount && ciMaxNum > bestMaxNum) ||
          (cnt === maxCount && ciMaxNum === bestMaxNum && colorRank(ci) > colorRank(bestColor))
        ) {
          maxCount = cnt;
          bestColor = ci;
          bestMaxNum = ciMaxNum;
        }
      }
      return cards.filter((c) => c.colorIndex === bestColor);
    }
    case 3: {
      // 绿：所有偶数牌
      return cards.filter((c) => c.number % 2 === 0);
    }
    case 4: {
      // 青：每种颜色最高的一张
      const byColor = new Map();
      for (const c of cards) {
        const cur = byColor.get(c.colorIndex);
        if (!cur || c.number > cur.number || (c.number === cur.number && colorRank(c.colorIndex) > colorRank(cur.colorIndex))) {
          byColor.set(c.colorIndex, c);
        }
      }
      return [...byColor.values()];
    }
    case 5: {
      // 蓝：最长连号的牌
      const nums = [...new Set(cards.map((c) => c.number))].sort((a, b) => a - b);
      let runLen = 0;
      let topNum = -1;
      let cur = 0;
      let curTop = -1;
      for (const n of nums) {
        if (curTop === -1 || n === curTop + 1) {
          cur += 1;
          curTop = n;
        } else {
          cur = 1;
          curTop = n;
        }
        if (cur > runLen || (cur === runLen && curTop > topNum)) {
          runLen = cur;
          topNum = curTop;
        }
      }
      const result = [];
      for (let n = topNum - runLen + 1; n <= topNum; n++) {
        result.push(bestCard(cards.filter((c) => c.number === n)));
      }
      return result.filter(Boolean);
    }
    case 6: {
      // 紫：所有小于 4 的牌
      return cards.filter((c) => c.number < 4);
    }
    default:
      return [];
  }
}

/**
 * 计算当前规则的优胜玩家集合（并列最优者均为优胜）。
 * 可在客户端 playerView 后的 G 上运行（调色盘与规则公开）。
 */
export function computeWinningIds(G) {
  const active = G.playOrder.filter((id) => !G.players[id].eliminated);
  if (active.length === 0) return [];
  let bestKey = null;
  let winners = [];
  for (const id of active) {
    const key = ruleKey(G.ruleColorIndex, G.players[id].palette);
    if (bestKey === null || compareKeys(key, bestKey) > 0) {
      bestKey = key;
      winners = [id];
    } else if (compareKeys(key, bestKey) === 0) {
      winners.push(id);
    }
  }
  return winners;
}

/** 卡牌文字描述。 */
function describeCard(card) {
  return `${card.colorName}${card.number}`;
}

/**
 * 淘汰后检查是否只剩一人，若是则结束本轮。
 * @returns {boolean} 是否已结束
 */
function checkRoundEnd(G) {
  const active = G.playOrder.filter((id) => !G.players[id].eliminated);
  if (active.length === 1) {
    G.roundWinner = active[0];
    G.ended = true;
    G.log.push(`玩家 ${pLabel(active[0])} 是唯一剩下的玩家，赢得本轮。`);
    return true;
  }
  return false;
}

/** 行动①/②/③ 后统一结算：未处于优胜则淘汰，随后检查是否只剩一人。 */
function afterAction(G, playerID) {
  const winners = computeWinningIds(G);
  if (!winners.includes(playerID)) {
    G.players[playerID].eliminated = true;
    G.log.push(`玩家 ${pLabel(playerID)} 回合结束未处于优胜，出局。`);
  }
  checkRoundEnd(G);
}

/**
 * boardgame.io Game 定义。
 */
export const Red7Game = {
  name: 'red7',
  minPlayers: 2,
  maxPlayers: 4,

  setup: ({ ctx }) => {
    const G = {
      deck: [],
      players: {},
      playOrder: [],
      firstPlayerIndex: 0,
      ruleColorIndex: 0, // 初始规则：红
      canvas: [],         // 画布区弃牌堆（牌的颜色即当时规则）
      turnPlayed: false,    // 本回合是否已打出到调色盘
      turnDiscarded: false, // 本回合是否已弃牌到画布
      mustPlay: false,      // 打出 5 后必须继续打出 1 张牌
      pending: null,        // 待结算效果：null | { type: 'action1' } | { type: 'action7', cardId }
      lobby: { ready: {}, started: false },
      ended: false,
      hostEnded: false,
      roundWinner: null,
      log: [],
    };
    for (let i = 0; i < ctx.numPlayers; i++) {
      G.players[String(i)] = { hand: [], palette: [], eliminated: false };
    }
    G.log.push('房间已创建：最多 4 人，至少 2 人即可开局，等待玩家加入。');
    return G;
  },

  phases: {
    lobby: {
      start: true,
      next: 'play',
      turn: {
        activePlayers: { all: 'waiting' },
      },
      moves: {
        /** 玩家进入房间后自动标记已准备。 */
        lobbyReady: ({ G, playerID }) => {
          if (!G.lobby) return INVALID_MOVE;
          G.lobby.ready[playerID] = true;
          return undefined;
        },

        /**
         * 房主开局：裁掉空座位、固定回合顺序、洗牌发牌、确定先手。
         * 洗牌依赖 random，放在此 move 内（client:false，仅服务端执行，
         * 此时 G.deck 为完整数组，可安全操作）。
         */
        startGame: {
          client: false,
          move: ({ G, ctx, playerID, events, random }) => {
            if (!G.lobby || G.lobby.started) return INVALID_MOVE;
            if (playerID !== '0') return INVALID_MOVE; // 仅房主（创建者，座位 0）
            const participants = Object.keys(G.lobby.ready).sort(
              (a, b) => Number(a) - Number(b),
            );
            const count = participants.length;
            if (count < 2 || count > ctx.numPlayers) return INVALID_MOVE;

            // 裁掉未加入的空座位，并固定正式游戏座位顺序（升序）
            for (const id of Object.keys(G.players)) {
              if (!G.lobby.ready[id]) delete G.players[id];
            }
            G.playOrder = participants;

            // 洗牌发牌：每人 7 手牌 + 1 调色盘（牌堆顶顺序发）
            G.deck = shuffleDeck(createDeck(), random);
            let top = 0;
            for (const id of participants) {
              const p = G.players[id];
              p.hand = G.deck.slice(top, top + 7);
              top += 7;
              p.palette = G.deck.slice(top, top + 1);
              top += 1;
            }
            G.deck = G.deck.slice(top);

            // 初始规则为红（最高牌赢）：优胜者为调色盘最高牌玩家；
            // 先手为优胜者左手边（座位升序中的下一位）。
            G.ruleColorIndex = 0;
            const winnerId = computeWinningIds(G)[0];
            const winnerIdx = G.playOrder.indexOf(winnerId);
            G.firstPlayerIndex = (winnerIdx + 1) % G.playOrder.length;

            G.lobby.started = true;
            G.log.push(`已有 ${count} 名玩家就位，游戏开始。初始规则：红（最大的牌赢）。`);
            events.endPhase();
            return undefined;
          },
        },
      },
    },

    play: {
      turn: {
        order: {
          playOrder: ({ G }) => G.playOrder,
          first: ({ G }) => G.firstPlayerIndex,
          next: ({ G, ctx }) => {
            const n = ctx.playOrder.length;
            for (let step = 1; step <= n; step++) {
              const pos = (ctx.playOrderPos + step) % n;
              const id = ctx.playOrder[pos];
              if (!G.players[id].eliminated) return pos;
            }
            return undefined;
          },
        },

        // 所有玩家均处于 active：出牌类 move 内部自行校验 currentPlayer，
        // 这样「结束游戏」这类房主全局操作无需受当前回合玩家限制。
        activePlayers: { all: 'play' },

        onBegin: ({ G, ctx, events }) => {
          // 重置本回合的打牌 / 弃牌次数与进阶规则状态
          G.turnPlayed = false;
          G.turnDiscarded = false;
          G.mustPlay = false;
          G.pending = null;
          const active = G.playOrder.filter((id) => !G.players[id].eliminated);
          if (active.length === 1) {
            G.roundWinner = active[0];
            G.ended = true;
            G.log.push(`玩家 ${pLabel(active[0])} 是唯一剩下的玩家，赢得本轮。`);
            return;
          }
          const playerID = ctx.currentPlayer;
          const p = G.players[playerID];
          if (p && !p.eliminated && p.hand.length === 0) {
            p.eliminated = true;
            G.log.push(`玩家 ${pLabel(playerID)} 无手牌，自动出局。`);
            checkRoundEnd(G);
            events.endTurn();
          }
        },
      },
    },
  },

  moves: {
    /**
     * 行动①：打 1 张手牌到调色盘。
     * 进阶规则2：打出 1/3/5/7 时触发对应效果。
     */
    playCard: {
      client: false,
      move: ({ G, ctx, playerID }, handIndex) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE; // 有待结算效果，需先结算
        const p = G.players[playerID];
        if (!p || p.eliminated) return INVALID_MOVE;
        // 本回合已打出过，且不是「打出5后必须继续打」→ 拒绝
        if (G.turnPlayed && !G.mustPlay) return INVALID_MOVE;
        if (typeof handIndex !== 'number' || handIndex < 0 || handIndex >= p.hand.length) {
          return INVALID_MOVE;
        }
        const card = p.hand.splice(handIndex, 1)[0];
        p.palette.push(card);
        G.turnPlayed = true;
        G.log.push(`玩家 ${pLabel(playerID)} 将 ${describeCard(card)} 打到调色盘。`);

        // 进阶规则2：打出特殊点数触发
        if (card.number === 1) {
          const othersHave = G.playOrder.some(
            (id) => id !== playerID && !G.players[id].eliminated && G.players[id].palette.length > 0,
          );
          if (othersHave) {
            G.pending = { type: 'action1' };
            G.log.push('打出 1：选择其他玩家调色盘中的 1 张牌，置于抽牌堆顶部。');
          }
          G.mustPlay = false;
        } else if (card.number === 3) {
          if (G.deck.length > 0) {
            const drawn = G.deck.shift();
            p.hand.push(drawn);
            G.log.push(`打出 3：摸 1 张牌（${describeCard(drawn)}）。`);
          }
          G.mustPlay = false;
        } else if (card.number === 5) {
          // 打出5且仍有手牌 → 必须继续打；否则结束循环
          G.mustPlay = p.hand.length > 0;
          if (G.mustPlay) G.log.push('打出 5：必须继续打出 1 张牌。');
        } else if (card.number === 7) {
          if (p.palette.length > 1) {
            G.pending = { type: 'action7', cardId: card.id };
            G.log.push('打出 7：弃置 1 张调色盘中的牌（不含本张 7）到画布。');
          }
          G.mustPlay = false;
        } else {
          G.mustPlay = false;
        }
        return undefined;
      },
    },

    /**
     * 行动②：弃 1 张手牌到画布区，该牌颜色成为新规则。
     * 进阶规则1：弃牌点数大于自己调色盘牌数时，摸 1 张牌。
     */
    discardToCanvas: {
      client: false,
      move: ({ G, ctx, playerID }, handIndex) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE; // 有待结算效果，需先结算
        if (G.turnDiscarded) return INVALID_MOVE; // 本回合已弃牌到画布
        const p = G.players[playerID];
        if (!p || p.eliminated) return INVALID_MOVE;
        if (typeof handIndex !== 'number' || handIndex < 0 || handIndex >= p.hand.length) {
          return INVALID_MOVE;
        }
        const card = p.hand.splice(handIndex, 1)[0];
        G.canvas.push(card);
        G.ruleColorIndex = card.colorIndex;
        G.turnDiscarded = true;
        const rule = RED7_COLORS[card.colorIndex];
        G.log.push(`玩家 ${pLabel(playerID)} 弃 ${describeCard(card)} 到画布区，规则改为「${rule.name}：${rule.rule}」。`);

        // 进阶规则1：弃牌点数 > 调色盘牌数 → 摸 1 张
        if (card.number > p.palette.length && G.deck.length > 0) {
          const drawn = G.deck.shift();
          p.hand.push(drawn);
          G.log.push(`弃牌点数大于调色盘牌数，摸 1 张牌（${describeCard(drawn)}）。`);
        }
        return undefined;
      },
    },

    /**
     * 行动③：跳过 → 出局。
     */
    pass: {
      client: false,
      move: ({ G, ctx, playerID, events }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE; // 有待结算效果，需先结算
        const p = G.players[playerID];
        if (!p || p.eliminated) return INVALID_MOVE;
        p.eliminated = true;
        G.log.push(`玩家 ${pLabel(playerID)} 跳过，出局。`);
        checkRoundEnd(G);
        events.endTurn();
        return undefined;
      },
    },

    /**
     * 结算打出 1 的效果：选择其他玩家调色盘中的 1 张牌，置于抽牌堆顶部。
     * @param {string} targetPlayerID 被拿牌玩家的 playerID
     * @param {number} paletteIndex 该玩家调色盘中的牌索引
     */
    resolveAction1: {
      client: false,
      move: ({ G, ctx, playerID }, targetPlayerID, paletteIndex) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const pending = G.pending;
        if (!pending || pending.type !== 'action1') return INVALID_MOVE;
        if (targetPlayerID === playerID) return INVALID_MOVE; // 不能选自己的调色盘
        const target = G.players[targetPlayerID];
        if (!target || target.eliminated) return INVALID_MOVE;
        if (typeof paletteIndex !== 'number' || paletteIndex < 0 || paletteIndex >= target.palette.length) {
          return INVALID_MOVE;
        }
        const card = target.palette.splice(paletteIndex, 1)[0];
        G.deck.unshift(card); // 置于抽牌堆顶部
        G.pending = null;
        G.log.push(`打出 1：将玩家 ${pLabel(targetPlayerID)} 的 ${describeCard(card)} 置于抽牌堆顶部。`);
        return undefined;
      },
    },

    /**
     * 结算打出 7 的效果：弃置自己调色盘中的 1 张牌（不含本张 7）到画布，本回合不能再弃牌到画布。
     * @param {number} paletteIndex 自己调色盘中的牌索引
     */
    resolveAction7: {
      client: false,
      move: ({ G, ctx, playerID }, paletteIndex) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const pending = G.pending;
        if (!pending || pending.type !== 'action7') return INVALID_MOVE;
        const p = G.players[playerID];
        if (!p || p.eliminated) return INVALID_MOVE;
        if (typeof paletteIndex !== 'number' || paletteIndex < 0 || paletteIndex >= p.palette.length) {
          return INVALID_MOVE;
        }
        const card = p.palette[paletteIndex];
        if (card.id === pending.cardId) return INVALID_MOVE; // 不能弃置本张 7
        p.palette.splice(paletteIndex, 1);
        G.canvas.push(card);
        G.ruleColorIndex = card.colorIndex;
        G.turnDiscarded = true; // 本回合不能再弃牌到画布
        G.pending = null;
        const rule = RED7_COLORS[card.colorIndex];
        G.log.push(`打出 7：弃置 ${describeCard(card)} 到画布，规则改为「${rule.name}：${rule.rule}」。`);
        return undefined;
      },
    },

    /**
     * 结束本回合：检查当前规则下的优胜，未处于优胜者淘汰，然后轮到下一位玩家。
     * 无待结算效果、无「必须继续打」即可结束；未出牌/弃牌时同样直接判定优胜。
     */
    endTurn: {
      client: false,
      move: ({ G, ctx, playerID, events }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE; // 有待结算效果，需先结算
        if (G.mustPlay) return INVALID_MOVE; // 打出5后必须继续打
        const p = G.players[playerID];
        if (!p || p.eliminated) return INVALID_MOVE;
        afterAction(G, playerID);
        events.endTurn();
        return undefined;
      },
    },

    /**
     * 房主结束本局：仅作为广播信号，标记本局被房主主动结束。
     */
    endGame: ({ G, playerID }) => {
      if (playerID !== '0') return INVALID_MOVE; // 仅房主（座位 0）可结束
      G.hostEnded = true;
      return undefined;
    },
  },

  /**
   * 玩家视角：他人手牌仅显示张数；牌堆仅显示张数；调色盘/画布/淘汰状态公开。
   */
  playerView: ({ G, playerID }) => {
    const players = {};
    for (const id of Object.keys(G.players)) {
      const p = G.players[id];
      players[id] = {
        hand: id === playerID ? p.hand : p.hand.length,
        palette: p.palette,
        eliminated: p.eliminated,
      };
    }
    return {
      ...G,
      deck: G.deck.length,
      players,
    };
  },

  /**
   * 结束条件与结算：仅剩一名玩家时结束，该玩家获胜。
   */
  endIf: ({ G }) => {
    if (!G.ended) return undefined;
    return { winners: [G.roundWinner], reason: '仅剩一名玩家' };
  },
};

export default Red7Game;
