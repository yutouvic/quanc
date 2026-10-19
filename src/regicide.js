/**
 * src/regicide.js
 * Regicide（弑君）合作游戏核心逻辑（boardgame.io Game 对象）。
 *
 * 规则概要（2-4 人合作，共抗 12 个敌人：4 J → 4 Q → 4 K）：
 * - 54 张牌：4 花色（红桃/方块/梅花/黑桃）×（A, 2-10, J, Q, K）+ 2 张小丑。
 * - 城堡牌堆：4 张 K 洗混置底、4 张 Q 洗混置中、4 张 J 洗混置顶，战斗顺序 J → Q → K。
 *   敌人属性：J 攻击 10 / 血量 20；Q 攻击 15 / 血量 30；K 攻击 20 / 血量 40。
 * - 酒馆牌堆：其余 A、2-10 与小丑（4 人 2 张 / 3 人 1 张 / 2 人 0 张）。
 *   手牌上限：4 人 5 张 / 3 人 6 张 / 2 人 7 张，开局摸满。
 * - 每回合阶段：① 打牌（单张 / 连招：非 A 同点数且总和 ≤10 / 小丑单出 / 跳过）
 *   ② 激活花色技能 ③ 伤害判定 ④ 未击败则当前玩家以弃牌承受反击。
 * - 花色技能：♥ 治疗（弃牌堆顶恢复等量牌到酒馆堆底）、♦ 抽牌（下家起顺时针轮流共摸等量张，
 *   不超手牌上限）、♣ 双倍伤害（本回合伤害 ×2，多张不叠加）、♠ 护盾（累计抵御该敌人攻击，
 *   直到该敌人被击败）。A（宠物牌）值 1 点、带自身花色技能，可单独打出或与其它牌合出。
 * - 免疫：敌人免疫同花色牌的花色技能（技能不发动，伤害仍计入）；小丑解除当前敌人的免疫（持续到其被击败）。
 * - 跳过：跳过阶段 1-3 直接承伤；上一位玩家跳过后不能连续跳过。空手玩家回合开始被迫跳过。
 * - 胜利：击败全部 4 张 K。失败：任一玩家无法弃牌承伤，或空手且不能跳过。
 * - 小丑：单独打出，解除免疫并跳过阶段 2-4，由打出者指定下一位行动玩家（可为任意玩家）。
 * - 承伤弃牌计值：A/数字按面值，J/Q/K 按 10/15/20（归化敌人），小丑按 0。
 * - 击败去向：敌人生命刚好为 0（恰好击杀）→ 放到酒馆牌堆顶（可被摸回）；生命为负（超额伤害）→ 放到弃牌堆顶。
 *   摸回/治疗回的 Boss 牌可正常打出，按承伤计值（J=10/Q=15/K=20）。
 *
 * 实现简化（与实体规则的差异，均为可玩性取舍）：
 * - ♥治疗自动从弃牌堆顶取牌（实体规则为玩家浏览弃牌堆自行挑选）。
 */

// boardgame.io 用于标记非法操作的常量（本地定义，避免服务端额外打包依赖）
const INVALID_MOVE = 'INVALID_MOVE';

/** 4 种花色与对应技能文案（颜色用于卡面与技能高亮）。 */
export const RG_SUITS = [
  { id: 'heart', name: '红桃', symbol: '♥', color: '#e53935', ability: '治疗：从弃牌堆恢复总点数的牌到酒馆堆底' },
  { id: 'diamond', name: '方块', symbol: '♦', color: '#fb8c00', ability: '抽牌：从下家起顺时针轮流共摸总点数的牌' },
  { id: 'club', name: '梅花', symbol: '♣', color: '#43a047', ability: '双倍伤害：本回合伤害 ×2' },
  { id: 'spade', name: '黑桃', symbol: '♠', color: '#5c6bc0', ability: '护盾：抵御敌人总点数的攻击，直到该敌人被击败' },
];

const RG_SUIT_MAP = Object.fromEntries(RG_SUITS.map((s) => [s.id, s]));

/** 敌人属性：J / Q / K 的攻击力与血量。 */
const RG_ENEMY_STATS = {
  J: { attack: 10, hp: 20 },
  Q: { attack: 15, hp: 30 },
  K: { attack: 20, hp: 40 },
};

/** 敌人牌在「承伤弃牌」中的计值（归化敌人）：J=10、Q=15、K=20。 */
const RG_ENEMY_DISCARD_VALUE = { J: 10, Q: 15, K: 20 };

/** 玩家展示编号：内部 playerID 为 0 基，界面与日志统一从 1 开始显示。 */
function pLabel(id) {
  return Number(id) + 1;
}

/** 创建一张花色牌。 */
function makeCard(suit, rank) {
  const s = RG_SUIT_MAP[suit];
  const isEnemy = rank === 'J' || rank === 'Q' || rank === 'K';
  return {
    id: `${suit}-${rank}`,
    suit,
    suitName: s.name,
    symbol: s.symbol,
    color: s.color,
    rank,
    value: rank === 'A' ? 1 : isEnemy ? { J: 11, Q: 12, K: 13 }[rank] : Number(rank),
    enemy: isEnemy,
  };
}

/** 创建小丑牌（数值 0，仅可单独打出）。 */
function makeJoker(seq) {
  return {
    id: `joker-${seq}`,
    isJoker: true,
    suit: null,
    suitName: '小丑',
    symbol: '🃏',
    color: '#8e6cc9',
    rank: '小丑',
    value: 0,
    enemy: false,
  };
}

/** 承伤弃牌时的计值：A/数字按面值，J/Q/K 按 10/15/20（归化敌人），小丑按 0。 */
export function rgDiscardValue(card) {
  if (card.isJoker) return 0;
  if (card.enemy) return RG_ENEMY_DISCARD_VALUE[card.rank];
  return card.value;
}

/** 卡牌文字描述。 */
function describeCard(card) {
  return card.isJoker ? '小丑' : `${card.suitName}${card.rank}`;
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

/** 构建城堡牌堆：底 → 顶为 K、Q、J（各花色 4 张内洗混），战斗顺序 J → Q → K（pop 取堆顶）。 */
function buildCastle(random) {
  const byRank = { K: [], Q: [], J: [] };
  for (const suit of RG_SUITS) {
    for (const rank of ['J', 'Q', 'K']) byRank[rank].push(makeCard(suit.id, rank));
  }
  return [
    ...shuffleDeck(byRank.K, random),
    ...shuffleDeck(byRank.Q, random),
    ...shuffleDeck(byRank.J, random),
  ];
}

/** 构建酒馆牌堆：4 花色的 A 与 2-10，加指定数量的 J（小丑）；shift 取堆顶。 */
function buildTavern(jokerCount, random) {
  const cards = [];
  for (const suit of RG_SUITS) {
    cards.push(makeCard(suit.id, 'A'));
    for (let n = 2; n <= 10; n++) cards.push(makeCard(suit.id, String(n)));
  }
  for (let i = 1; i <= jokerCount; i++) cards.push(makeJoker(i));
  return shuffleDeck(cards, random);
}

/** 翻开新敌人：从城堡牌堆顶取一张，重置护盾与免疫解除状态。 */
function revealEnemy(G) {
  const card = G.castle.pop();
  const stats = RG_ENEMY_STATS[card.rank];
  G.enemy = { ...card, attack: stats.attack, hp: stats.hp, maxHp: stats.hp };
  G.shield = 0;
  G.jokerUsed = false;
  G.log.push(`新敌人登场：${describeCard(card)}（攻击 ${stats.attack} / 血量 ${stats.hp}），免疫${card.suitName}牌技能。`);
}

/** 计算并设置阶段 4 承伤结算请求（反击 = 攻击 − 护盾，最低 0）。 */
function requestDamage(G, playerID) {
  const amount = Math.max(0, G.enemy.attack - G.shield);
  G.pending = { type: 'damage', playerID, amount };
  G.log.push(
    amount > 0
      ? `敌人反击：玩家 ${pLabel(playerID)} 须弃掉总和 ≥ ${amount} 点的手牌（攻击 ${G.enemy.attack} − 护盾 ${G.shield}）。`
      : `护盾完全抵挡了反击，玩家 ${pLabel(playerID)} 无需弃牌。`,
  );
}

/** 合作胜利 / 失败结算（不设置 ctx.gameover，保证房间可复用）。 */
function winGame(G) {
  G.ended = true;
  G.results = { winners: [...G.playOrder], lost: false, reason: '击败全部 4 张国王，王国重归和平！' };
  G.log.push('最后一位国王被击败，玩家们获胜！');
}

function loseGame(G, reason) {
  G.ended = true;
  G.results = { winners: [], lost: true, reason };
  G.log.push(`玩家们落败：${reason}`);
}

/** 方块抽牌：从 fromID 的下家起顺时针，每人轮流摸 1 张，共 count 张；超手牌上限者跳过，酒馆空则提前停止。 */
function drawClockwise(G, fromID, count) {
  let drawn = 0;
  const order = G.playOrder;
  const start = (order.indexOf(fromID) + 1) % order.length;
  // 步数上限足够覆盖「多数玩家已满手牌」的绕圈情况
  for (let step = 0; drawn < count && step < order.length * (count + 1); step++) {
    if (G.tavern.length === 0) break; // 规则：酒馆摸空不会导致失败，只是摸不到
    const id = order[(start + step) % order.length];
    const p = G.players[id];
    if (p.hand.length >= G.handLimit) continue;
    p.hand.push(G.tavern.shift());
    drawn++;
  }
  return drawn;
}

/** 红桃治疗：从弃牌堆顶取 amount 张（不足则全取），放到酒馆牌堆底部。 */
function healFromDiscard(G, amount) {
  const n = Math.min(amount, G.discard.length);
  if (n <= 0) return;
  const taken = G.discard.splice(G.discard.length - n, n);
  G.tavern.push(...taken); // 酒馆 shift 取堆顶，push 即堆底
  const totalHealed = taken.reduce((s, c) => s + c.value, 0);
  G.log.push(`红桃治疗：从弃牌堆恢复 ${totalHealed} 点牌到酒馆牌堆底部。`);
}

/** 校验一组手牌索引：非空、无重复、均在范围内。返回升序索引数组或 null。 */
function validIndices(indices, handLength) {
  if (!Array.isArray(indices) || indices.length === 0) return null;
  const uniq = [...new Set(indices)];
  if (uniq.length !== indices.length) return null;
  if (uniq.some((i) => !Number.isInteger(i) || i < 0 || i >= handLength)) return null;
  return [...indices].sort((a, b) => a - b);
}

/** 按索引从手牌移除牌（降序 splice 防止索引位移），返回被移除的牌。 */
function takeCards(p, indicesDesc) {
  return indicesDesc.map((i) => p.hand.splice(i, 1)[0]);
}

/** 构建全新的大厅初始状态（setup 与「返回房间」共用，保证房间可重复利用）。 */
function freshRegicideG(ctx, logLine) {
  const G = {
    handLimit: 7,        // 手牌上限（按人数在开局时确定：5/6/7）
    players: {},         // { [id]: { hand: [] } }
    playOrder: [],       // 正式游戏座位顺序
    firstPlayerIndex: 0, // 房主先手
    castle: [],          // 城堡牌堆（pop 取堆顶；playerView 后变为 { J, Q, K } 张数）
    tavern: [],          // 酒馆摸牌堆（shift 取堆顶；playerView 后变为张数）
    discard: [],         // 弃牌堆（push 入顶，公开可见）
    enemy: null,         // 当前敌人 { ...card, attack, hp, maxHp }
    slain: [],           // 已击败的敌人（移出游戏，战利品展示）
    shield: 0,           // ♠ 护盾累计值（对当前敌人，直至其被击败）
    jokerUsed: false,    // 小丑已解除当前敌人免疫（持续到其被击败）
    forcedNextPlayer: null, // 小丑后指定下一位玩家（被 turn.next 消费）
    pending: null,       // 待结算：{ type: 'damage', playerID, amount } | { type: 'chooseNext', playerID }
    lastAction: 'play',  // 上一位玩家行动：'play' | 'yield' | 'joker'（连续跳过判定）
    lobby: { ready: {}, started: false },
    ended: false,
    results: null,
    log: [logLine],
  };
  for (let i = 0; i < ctx.numPlayers; i++) {
    G.players[String(i)] = { hand: [] };
  }
  return G;
}

/**
 * boardgame.io Game 定义。
 */
export const RegicideGame = {
  name: 'regicide',
  minPlayers: 2,
  maxPlayers: 4,

  setup: ({ ctx }) => {
    return freshRegicideG(ctx, '房间已创建：最多 4 人，至少 2 人即可开局，等待玩家加入。');
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
         * 房主开局：裁掉空座位、按人数确定小丑数与手牌上限、
         * 构建城堡 / 酒馆牌堆、发满手牌、翻开首个敌人。
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

            // 裁掉未加入的空座位
            for (const id of Object.keys(G.players)) {
              if (!G.lobby.ready[id]) delete G.players[id];
            }
            G.playOrder = participants;

            // 人数相关参数：小丑数量与手牌上限
            const jokerCount = count === 4 ? 2 : count === 3 ? 1 : 0;
            G.handLimit = count === 4 ? 5 : count === 3 ? 6 : 7;

            // 构建牌堆并发牌
            G.castle = buildCastle(random);
            G.tavern = buildTavern(jokerCount, random);
            for (const id of participants) {
              G.players[id].hand = G.tavern.splice(0, G.handLimit);
            }

            // 房主先手，翻开首个敌人（必为 J）
            G.firstPlayerIndex = 0;
            revealEnemy(G);
            G.lastAction = 'play';

            G.lobby.started = true;
            G.log.push(
              `已有 ${count} 名玩家就位，游戏开始。手牌上限 ${G.handLimit}，小丑 ${jokerCount} 张。房主先手。`,
            );
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
            // 小丑效果：打出者指定的下一位玩家优先
            if (G.forcedNextPlayer != null) {
              const pos = ctx.playOrder.indexOf(G.forcedNextPlayer);
              if (pos >= 0) return pos;
            }
            return (ctx.playOrderPos + 1) % n;
          },
        },

        // 所有玩家均处于 active：move 内部自行校验 currentPlayer
        activePlayers: { all: 'play' },

        onBegin: ({ G, ctx }) => {
          if (ctx.phase !== 'play' || G.ended || !G.lobby?.started) return;
          G.forcedNextPlayer = null; // 已被 turn.next 消费
          G.pending = null; // 回合开始时不应有遗留待结算（防御性清理）
          const playerID = ctx.currentPlayer;
          const p = G.players[playerID];
          if (!p) return;
          // 空手玩家被迫跳过：直接进入阶段 4 承伤；若上一位已跳过则无法行动 → 失败
          if (p.hand.length === 0) {
            if (G.lastAction === 'yield') {
              loseGame(G, `玩家 ${pLabel(playerID)} 无手牌且不能连续跳过`);
              return;
            }
            G.lastAction = 'yield';
            G.log.push(`玩家 ${pLabel(playerID)} 手牌为空，被迫跳过承受伤害。`);
            requestDamage(G, playerID);
          }
        },
      },
    },
  },

  moves: {
    /**
     * 行动①：打出 1 张牌或连招（阶段 1-3 一次性结算）。
     * 连招：非 A 牌须同点数，总点数（A=1）≤ 10；小丑不可在此打出。
     */
    playCards: {
      client: false,
      move: ({ G, ctx, playerID, events }, indices) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE;
        const p = G.players[playerID];
        if (!p) return INVALID_MOVE;

        const sorted = validIndices(indices, p.hand.length);
        if (!sorted) return INVALID_MOVE;
        const cards = sorted.map((i) => p.hand[i]);
        if (cards.some((c) => c.isJoker)) return INVALID_MOVE; // 小丑走 playJoker
        if (cards.length > 1) {
          const nonA = cards.filter((c) => c.rank !== 'A');
          if (nonA.length > 0 && nonA.some((c) => rgDiscardValue(c) !== rgDiscardValue(nonA[0]))) return INVALID_MOVE;
          const total = cards.reduce((s, c) => s + rgDiscardValue(c), 0);
          if (total > 10) return INVALID_MOVE;
        }

        // 从手牌移除（按降序索引 splice）
        const taken = takeCards(p, [...sorted].reverse());
        G.lastAction = 'play';
        G.log.push(
          `玩家 ${pLabel(playerID)} 打出 ${taken.map(describeCard).join(' + ')}${taken.length > 1 ? '（连招）' : ''}。`,
        );

        // —— 阶段 2：花色技能（免疫只挡技能，不挡伤害） ——
        const immune = G.jokerUsed ? null : G.enemy.suit;
        // 官方规则：连招时各花色技能的数值 = 所有打出牌的总点数之和（包括所有花色）；
        // 摸回/治疗回的 Boss 牌打出时按承伤计值（J=10/Q=15/K=20）
        const totalPlayed = taken.reduce((s, c) => s + rgDiscardValue(c), 0);
        let damage = totalPlayed; // 免疫只挡技能，伤害照常计入
        let hearts = 0;
        let diamonds = 0;
        let spades = 0;
        let hasClub = false;
        const immuneBlocked = [];
        for (const c of taken) {
          const blocked = immune && c.suit === immune;
          if (blocked) immuneBlocked.push(describeCard(c));
          if (c.suit === 'heart') { if (!blocked) hearts = totalPlayed; }
          else if (c.suit === 'diamond') { if (!blocked) diamonds = totalPlayed; }
          else if (c.suit === 'spade') { if (!blocked) spades = totalPlayed; }
          else if (c.suit === 'club') { if (!blocked) hasClub = true; }
        }
        if (immuneBlocked.length > 0) {
          G.log.push(`${G.enemy.suitName}免疫：${immuneBlocked.join('、')} 技能未发动（伤害仍计入）。`);
        }
        if (hearts > 0) healFromDiscard(G, hearts);
        if (diamonds > 0) {
          const drawn = drawClockwise(G, playerID, diamonds);
          G.log.push(`方块 ${diamonds}：玩家们共摸 ${drawn} 张牌。`);
        }
        if (spades > 0) {
          G.shield += spades;
          G.log.push(`黑桃 ${spades}：护盾提升至 ${G.shield}（持续到该敌人被击败）。`);
        }
        if (hasClub) {
          damage *= 2;
          G.log.push('梅花：伤害翻倍。');
        }

        // 打出的牌进入弃牌堆
        G.discard.push(...taken);

        // —— 阶段 3：伤害判定 ——
        G.enemy.hp -= damage;
        if (G.enemy.hp <= 0) {
          const enemy = G.enemy;
          const exactKill = G.enemy.hp === 0;
          G.slain.push({ ...enemy }); // 战利品区存档（进度计数/展示用）
          // 击败去向：生命刚好为 0（恰好击杀）→ 酒馆牌堆顶；生命为负（超额伤害）→ 弃牌堆顶
          if (exactKill) {
            G.tavern.unshift(enemy);
            G.log.push(`${describeCard(enemy)} 被恰好击败（造成 ${damage} 点伤害）！放到酒馆牌堆顶，可被摸回。`);
          } else {
            G.discard.push(enemy);
            G.log.push(`${describeCard(enemy)} 被击败（造成 ${damage} 点伤害，超出 ${-G.enemy.hp} 点）！放到弃牌堆顶。`);
          }
          G.enemy = null;
          G.shield = 0;
          G.jokerUsed = false;
          if (enemy.rank === 'K' && G.slain.filter((e) => e.rank === 'K').length === 4) {
            winGame(G);
          } else {
            revealEnemy(G);
          }
          events.endTurn();
          return undefined;
        }
        G.log.push(`造成 ${damage} 点伤害，敌人剩余血量 ${G.enemy.hp}/${G.enemy.maxHp}。`);
        // —— 阶段 4：未击败，当前玩家承受反击（等 resolveDamage 结算） ——
        requestDamage(G, playerID);
        return undefined;
      },
    },

    /** 行动①（小丑）：单独打出小丑，解除免疫并跳过阶段 2-4，指定下一位玩家。 */
    playJoker: {
      client: false,
      move: ({ G, ctx, playerID }, handIndex) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE;
        const p = G.players[playerID];
        if (!p) return INVALID_MOVE;
        if (typeof handIndex !== 'number' || handIndex < 0 || handIndex >= p.hand.length) {
          return INVALID_MOVE;
        }
        if (!p.hand[handIndex].isJoker) return INVALID_MOVE;
        const card = p.hand.splice(handIndex, 1)[0];
        G.discard.push(card);
        G.jokerUsed = true; // 当前敌人免疫解除，持续到其被击败
        G.lastAction = 'joker';
        G.log.push(`玩家 ${pLabel(playerID)} 打出小丑：当前敌人的免疫被解除。`);
        G.pending = { type: 'chooseNext', playerID };
        return undefined;
      },
    },

    /** 小丑结算：指定下一位行动玩家（可为任意玩家，含自己）。 */
    chooseNext: {
      client: false,
      move: ({ G, ctx, playerID, events }, targetPlayerID) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (!G.pending || G.pending.type !== 'chooseNext') return INVALID_MOVE;
        if (!G.playOrder.includes(targetPlayerID)) return INVALID_MOVE;
        G.forcedNextPlayer = targetPlayerID;
        G.pending = null;
        G.log.push(`玩家 ${pLabel(playerID)} 指定玩家 ${pLabel(targetPlayerID)} 行动。`);
        events.endTurn();
        return undefined;
      },
    },

    /** 行动①（跳过）：跳过阶段 1-3，直接承受反击；上一位玩家跳过后不能连续跳过。 */
    yieldTurn: {
      client: false,
      move: ({ G, ctx, playerID }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (G.pending) return INVALID_MOVE;
        const p = G.players[playerID];
        if (!p) return INVALID_MOVE;
        if (G.lastAction === 'yield') return INVALID_MOVE;
        G.lastAction = 'yield';
        G.log.push(`玩家 ${pLabel(playerID)} 选择跳过，直接承受伤害。`);
        requestDamage(G, playerID);
        return undefined;
      },
    },

    /**
     * 阶段 4 结算：弃掉数值总和 ≥ 反击伤害的手牌（A/数字按面值，J/Q/K 按 10/15/20，小丑按 0）。
     */
    resolveDamage: {
      client: false,
      move: ({ G, ctx, playerID, events }, indices) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const pending = G.pending;
        if (!pending || pending.type !== 'damage' || pending.playerID !== playerID) {
          return INVALID_MOVE;
        }
        const p = G.players[playerID];
        if (!p) return INVALID_MOVE;
        // amount 为 0 时允许空手牌结算
        let sorted = [];
        if (indices && indices.length > 0) {
          sorted = validIndices(indices, p.hand.length);
          if (!sorted) return INVALID_MOVE;
        }
        const sum = sorted.reduce((s, i) => s + rgDiscardValue(p.hand[i]), 0);
        if (sum < pending.amount) return INVALID_MOVE;
        const taken = sorted.length > 0 ? takeCards(p, [...sorted].reverse()) : [];
        if (taken.length > 0) G.discard.push(...taken);
        G.pending = null;
        G.log.push(
          taken.length > 0
            ? `玩家 ${pLabel(playerID)} 弃掉 ${taken.map(describeCard).join('、')}（共 ${sum} 点），承受 ${pending.amount} 点伤害。`
            : `玩家 ${pLabel(playerID)} 无需弃牌（伤害为 0）。`,
        );
        events.endTurn();
        return undefined;
      },
    },

    /** 无法弃牌承伤：当前玩家倒下，所有玩家失败。 */
    surrenderDamage: {
      client: false,
      move: ({ G, ctx, playerID, events }) => {
        if (ctx.phase !== 'play') return INVALID_MOVE;
        if (G.ended) return INVALID_MOVE;
        if (playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const pending = G.pending;
        if (!pending || pending.type !== 'damage' || pending.playerID !== playerID) {
          return INVALID_MOVE;
        }
        G.pending = null;
        loseGame(G, `玩家 ${pLabel(playerID)} 无法承受 ${pending.amount} 点伤害`);
        events.endTurn();
        return undefined;
      },
    },

    /**
     * 结束本局并返回房间大厅：
     * - 本局自然结束（G.ended）后，任意玩家可调用，全员回到大厅；
     * - 游戏进行中仅房主（座位 0）可调用。
     */
    backToLobby: ({ G, ctx, playerID, events }) => {
      if (!G.lobby || !G.lobby.started) return INVALID_MOVE; // 大厅阶段不可用
      if (!G.ended && playerID !== '0') return INVALID_MOVE; // 进行中仅房主可结束
      const endedByHost = !G.ended;
      const fresh = freshRegicideG(ctx, endedByHost
        ? '房主已结束本局，房间已重置，可开始新一局。'
        : '本局已结束，房间已重置，可开始新一局。');
      for (const k of Object.keys(G)) delete G[k];
      Object.assign(G, fresh);
      events.setPhase('lobby');
      return undefined;
    },
  },

  /**
   * 玩家视角：他人手牌仅显示张数；城堡 / 酒馆仅显示张数（城堡按 J/Q/K 分计）；
   * 弃牌堆、当前敌人、护盾、免疫状态、战利品均公开。
   */
  playerView: ({ G, playerID }) => {
    const players = {};
    for (const id of Object.keys(G.players)) {
      const p = G.players[id];
      players[id] = {
        hand: id === playerID ? p.hand : p.hand.length,
      };
    }
    const castleCounts = { J: 0, Q: 0, K: 0 };
    for (const c of G.castle) castleCounts[c.rank] += 1;
    return {
      ...G,
      castle: castleCounts,
      tavern: G.tavern.length,
      players,
    };
  },
};

export default RegicideGame;
