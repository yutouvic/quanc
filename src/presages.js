/**
 * src/presages.js
 * Presages（奥秘小队）游戏逻辑。
 *
 * 团队合作卡牌游戏：4/5/6 人，通过出牌与结算牌面效果争夺回合，率先赢得 2 轮的小队获胜。
 * 完整规则见 presages-规则书.md。
 *
 * 关键实现约定：
 * - 每张奥秘牌全局唯一（1-35），因此场上点数不会重复，胜负判定无需处理同点数平局。
 * - 「场上」= 本回合所有玩家面前打出的牌，G.field 以 { card, owner } 记录（owner 可被嫉妒改变、card 可被背叛换走）。
 * - 闪电牌在打出时立即结算；沙漏牌在回合结束时以「同一快照」同时结算。
 * - 恐惧（12）不能被任何效果弃掉，除非它赢得本回合；回合结束时回到手中。
 * - 一个「回合」= 所有玩家各出一次牌。客户端用 G.playStage 标记当前该谁出牌。
 */

const INVALID = 'INVALID_MOVE';

/** 颜色元数据：卡牌主色、文字色（黄色等亮色使用深色字保证可读性）。 */
export const PRESAGES_COLOR_META = {
  green: { name: '绿', color: '#3f9b4f', ink: '#f2fff3' },
  yellow: { name: '黄', color: '#d9ae2e', ink: '#2b2205' },
  red: { name: '红', color: '#c9443f', ink: '#fff4f1' },
  blue: { name: '蓝', color: '#3f78c9', ink: '#f0f6ff' },
  multi: { name: '多色', color: '#8a5cc9', ink: '#f8f1ff' },
};

/** 队伍展示色与代号：按队伍序号从高到低依次为 红/蓝/绿，代号 A/B/C（展示为「小队A」等）。 */
export const PRESAGES_TEAM_COLORS = ['#d94f4a', '#4a7cc9', '#5fae72'];
export const PRESAGES_TEAM_SYMBOLS = ['A', 'B', 'C'];

/** 35 张奥秘牌：[名称, 颜色, 结算时机, 效果描述, 细则提醒?]。细则提醒为补充说明，仅展示在详情面板。 */
const CARD_DATA = {
  1: ['生命', 'green', 'hourglass', '弃掉数值最高的绿色牌。'],
  2: ['爱', 'green', 'hourglass', '场上若有其他绿色牌，弃掉此牌。'],
  3: ['友谊', 'green', 'hourglass', '场上若有黄色牌，弃掉此牌。'],
  4: ['平静', 'green', 'hourglass', '场上若有红色牌，弃掉此牌。'],
  5: ['盛宴', 'green', 'hourglass', '场上若有蓝色牌，弃掉此牌。'],
  6: ['希望', 'green', 'hourglass', '此牌数值若为场上最低，弃掉此牌。'],
  7: ['春', 'green', 'hourglass', '此牌若是场上唯一的绿色牌，弃掉此牌。'],
  8: ['死亡', 'green', 'hourglass', '弃掉数值最低的绿色牌。'],
  9: ['谎言', 'yellow', 'hourglass', '弃掉数值最高的黄色牌。'],
  10: ['谜', 'yellow', 'hourglass', '场上若有至少一张绝对牌（30-35），弃掉此牌。'],
  11: ['夏', 'yellow', 'hourglass', '此牌若是场上唯一的黄色牌，弃掉此牌。'],
  12: ['恐惧', 'yellow', 'hourglass', '不能弃掉此牌，除非它赢得此回合。', '《恐惧》不能被任何效果弃掉，除非它赢得该回合。回合结束时《恐惧》回到手上。《运气》的效果无法弃掉《恐惧》。'],
  13: ['运气', 'yellow', 'hourglass', '若此牌被弃掉，您从手中弃掉一张牌。', '若因《运气》效果使您回合结束时手牌变为0张，您的小队立即赢得这一轮。《运气》的效果无法弃掉《恐惧》。'],
  14: ['镜子', 'yellow', 'hourglass', '数值最低的牌赢得此回合。', '将该回合胜利条件从“数值最高的牌获胜”改为“数值最低的牌获胜”，数值最低的牌因而被弃掉。若《悲伤》与《镜子》同回合打出，可直接忽略《悲伤》效果。'],
  15: ['律法', 'yellow', 'lightning', '本回合尚未出牌的玩家须打出低/高于15的牌（由您指定）。', '若您没有手牌符合条件，则如常打出所选牌。'],
  16: ['真相', 'yellow', 'hourglass', '弃掉数值最低的黄色牌。'],
  17: ['狡黠', 'multi', 'hourglass', '此牌属于所有颜色（绿、黄、红、蓝）。'],
  18: ['白昼', 'red', 'hourglass', '弃掉数值最高的红色牌。'],
  19: ['秋', 'red', 'hourglass', '场上若无其他红色牌，弃掉此牌。'],
  20: ['和谐', 'red', 'hourglass', '弃掉数值最低的牌。'],
  21: ['梦', 'red', 'lightning', '若您将此牌打在未出牌玩家前，则他须立刻出牌在您面前。', '若打在自己面前，不启动效果；若打在其他尚未出牌玩家面前，该玩家必须立刻打出一张牌放在您面前。若该牌有符号，立刻结算该效果。'],
  22: ['骄傲', 'red', 'hourglass', '由您左侧的玩家开始下一回合。'],
  23: ['嫉妒', 'red', 'lightning', '将此牌与场上任一张牌交换。', '如果您换到的牌有符号，不能再次结算该效果（打出时已结算过）。'],
  24: ['秘密', 'red', 'lightning', '指定一位玩家对您或另一位玩家（由您指定）揭示一张手牌。'],
  25: ['黑夜', 'red', 'hourglass', '弃掉数值最低的红色牌。'],
  26: ['悲伤', 'blue', 'hourglass', '忽略数值最高的牌。', '在判定赢得本回合时，忽略数值最高的那张牌，改由数值第二高的牌获胜。数值最高的那张牌只有“数值”被忽略，效果依然会启动！'],
  27: ['冬', 'blue', 'hourglass', '弃掉场上所有黄色牌。'],
  28: ['愤怒', 'blue', 'lightning', '指定一位其他玩家，他将已打出的牌收回，并另出一张牌。', '如果被收回的牌是《律法》，《律法》所设定的条件在本回合后续游戏中不再适用。如果新打出的牌有符号，立即结算该效果。'],
  29: ['背叛', 'blue', 'lightning', '用一张手牌交换场上的一张牌。', '若牌上有“闪电”符号，该玩家立刻结算该效果。如果您拿走的牌是《律法》，其所设定的条件在本回合后续游戏中不再适用。'],
  30: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
  31: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
  32: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
  33: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
  34: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
  35: ['绝对', 'blue', 'lightning', '指定一位玩家与您交换一张手牌。'],
};

/** 生成一张奥秘牌对象（id 与点数绑定，全局唯一）。 */
export function makePresagesCard(number) {
  const [name, color, timing, effect, note] = CARD_DATA[number];
  return {
    id: `ps-${number}`,
    number,
    name,
    color,
    colorName: PRESAGES_COLOR_META[color].name,
    timing,
    effect,
    note: note || '',
  };
}

/** 回合结算时预览胜利牌（供界面高亮；完整结算以服务端为准）。 */
export function presagesWinningCardId(field) {
  return presagesResolutionPreview(field).winningCardId;
}

/**
 * 回合结算预览：按当前场上状态模拟结算，返回获胜牌 id、会被弃掉的牌 id 列表及每张被弃牌的来源。
 * 与服务端 resolveTurnEnd 共用 computeTurnDiscards，保证口径一致。
 * （仅为界面预览：回合后续打出的牌会改变结果；运气的弃手牌等交互选择不在预览范围。）
 * discardReasons: { [cardId]: string[] }，如 ['赢得本回合', '17《狡黠》']。
 */
export function presagesResolutionPreview(field) {
  if (!Array.isArray(field) || field.length === 0) return { winningCardId: null, discardedIds: [], discardReasons: {} };
  const { winnerEntry, discard, reasons } = computeTurnDiscards(field);
  const discardReasons = {};
  for (const [id, list] of reasons) discardReasons[id] = [...list];
  return { winningCardId: winnerEntry.card.id, discardedIds: [...discard], discardReasons };
}

// ---------- 基础工具 ----------

/** 洗牌（boardgame.io random API，保证可复现）。 */
function shuffleDeck(deck, random) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random.Number() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** 手牌排序：仅用于展示，不影响规则。 */
function sortHand(hand) {
  hand.sort((a, b) => a.number - b.number);
}

function pushLog(G, text) {
  G.log.push(text);
  if (G.log.length > 90) G.log.splice(0, G.log.length - 90);
}

/** 狡黠（17）属于所有颜色。 */
function isColor(card, color) {
  return card.number === 17 || card.color === color;
}

function cardsOfColor(field, color) {
  return field.filter((e) => isColor(e.card, color));
}

function highestOf(field, color) {
  const list = cardsOfColor(field, color);
  if (list.length === 0) return null;
  return list.reduce((best, e) => (e.card.number > best.card.number ? e : best));
}

function lowestOf(field, color) {
  const list = cardsOfColor(field, color);
  if (list.length === 0) return null;
  return list.reduce((best, e) => (e.card.number < best.card.number ? e : best));
}

function lowestOverall(field) {
  if (field.length === 0) return null;
  return field.reduce((best, e) => (e.card.number < best.card.number ? e : best));
}

function playerName(G, id) {
  const name = G.playerNames && G.playerNames[id];
  return name || `玩家 ${id}`;
}

/** 左侧玩家（顺时针下一位）。 */
function leftPlayer(G, id) {
  const idx = G.playOrder.indexOf(id);
  if (idx < 0) return G.playOrder[0];
  return G.playOrder[(idx + 1) % G.playOrder.length];
}

// ---------- 初始化 ----------

function freshPresagesG(ctx, logLine) {
  const G = {
    players: {},           // id -> { hand: [] }
    playerNames: {},       // id -> 昵称（由 startGame 从 metadata 写入，仅用于日志）
    playOrder: [],
    teams: [],             // 队伍 -> [玩家 id]
    teamOf: {},            // 玩家 id -> 队伍下标
    teamWins: {},          // 队伍下标 -> 已赢轮数
    round: 0,
    turnNo: 0,
    field: [],             // [{ card, owner }]
    playedSet: {},         // 本回合已出牌的玩家
    turnConfirm: null,     // 全员出牌后的结算确认：null=未进入；{ playerID: true }=各玩家确认状态
    playStage: null,       // 当前应出牌的玩家
    actingPlayer: null,    // 本次普通出牌的玩家（用于效果结算后推进顺序）
    leader: null,          // 本回合先手玩家
    law: null,             // { mode: 'lower'|'higher', sourceId }
    pending: null,         // 待结算选择
    reveals: [],           // 秘密揭示记录
    discard: [],           // 本轮弃牌堆（公开）
    reserve: [],           // 本局未使用的牌（公开张数）
    lastResolution: null,  // 上一回合结算摘要
    resolveMeta: null,     // 结算中间状态（幸运弃牌）
    pendingLeader: null,   // 骄傲指定的下回合先手
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

/** 从 metadata（服务端注入）读取昵称；无则留空，由日志回退为「玩家 id」。 */
function capturePlayerNames(G, ctx) {
  const players = ctx && ctx.metadata && ctx.metadata.players;
  if (!players) return;
  const entries = Array.isArray(players) ? players : Object.values(players);
  for (const p of entries) {
    if (p && p.id != null && p.name) G.playerNames[String(p.id)] = p.name;
  }
}

// ---------- 开局 / 发牌 / 分队 ----------

/** 按人数与队伍人数返回本局每人手牌数。 */
function handSizeFor(G, id) {
  const n = G.playOrder.length;
  if (n === 4) return 5;
  if (n === 6) return 4;
  if (n === 5) return G.teams[G.teamOf[id]].length === 3 ? 5 : 4;
  return 0;
}

/** 第一轮：绝对牌分队 + 发牌。 */
function startFirstRound(G, random) {
  const count = G.playOrder.length;
  const absPool = shuffleDeck([30, 31, 32, 33, 34, 35], random).slice(0, count);
  const absByPlayer = {};
  G.playOrder.forEach((id, i) => { absByPlayer[id] = absPool[i]; });

  G.teams = [];
  G.teamOf = {};
  G.teamWins = {};

  if (count === 6) {
    const pairTeam = { 30: 0, 35: 0, 31: 1, 34: 1, 32: 2, 33: 2 };
    G.teams = [[], [], []];
    for (const id of G.playOrder) {
      const team = pairTeam[absByPlayer[id]];
      G.teams[team].push(id);
      G.teamOf[id] = team;
    }
  } else {
    const sorted = [...G.playOrder].sort((a, b) => absByPlayer[b] - absByPlayer[a]);
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    const rest = sorted.slice(1, -1);
    G.teams = [[top, bottom], rest];
    G.teamOf[top] = 0;
    G.teamOf[bottom] = 0;
    for (const id of rest) G.teamOf[id] = 1;
  }
  for (let t = 0; t < G.teams.length; t++) G.teamWins[t] = 0;

  // 绝对牌进入手牌，其余 1-29 洗匀后按人数发放
  const deck = shuffleDeck(Array.from({ length: 29 }, (_, i) => i + 1), random);
  for (const id of G.playOrder) {
    const hand = [makePresagesCard(absByPlayer[id])];
    const extra = handSizeFor(G, id) - 1;
    for (let k = 0; k < extra; k++) hand.push(makePresagesCard(deck.shift()));
    sortHand(hand);
    G.players[id].hand = hand;
  }
  G.reserve = deck;
  G.discard = [];
  G.round = 1;

  // 绝对牌数值最高者先手
  const first = G.playOrder.reduce(
    (best, id) => (absByPlayer[id] > absByPlayer[best] ? id : best),
    G.playOrder[0],
  );

  const teamDesc = G.teams
    .map((team, i) => `小队${PRESAGES_TEAM_SYMBOLS[i]}：${team.map((id) => playerName(G, id)).join('、')}`)
    .join('；');
  pushLog(G, `分队完成。${teamDesc}。`);
  pushLog(G, `第 1 轮：绝对牌数值最高的 ${playerName(G, first)} 先出牌。`);

  startMacroTurn(G, first);
}

/** 新一轮：全部 35 张洗匀，按人数重新发牌，队伍不变。 */
function startRound(G, ctx, random, leaderId) {
  G.round += 1;
  G.field = [];
  G.playedSet = {};
  G.pending = null;
  G.law = null;
  G.reveals = [];
  G.discard = [];
  G.resolveMeta = null;
  G.pendingLeader = null;
  G.lastResolution = null;

  const deck = shuffleDeck(Array.from({ length: 35 }, (_, i) => i + 1), random);
  for (const id of G.playOrder) {
    const hand = [];
    const size = handSizeFor(G, id);
    for (let k = 0; k < size; k++) hand.push(makePresagesCard(deck.shift()));
    sortHand(hand);
    G.players[id].hand = hand;
  }
  G.reserve = deck;
  pushLog(G, `第 ${G.round} 轮开始：所有奥秘牌重新洗匀并发放，由上一轮获胜的 ${playerName(G, leaderId)} 先出牌。`);
  startMacroTurn(G, leaderId);
}

/** 开始一个新的「回合」（所有玩家各出一次牌）。 */
function startMacroTurn(G, leaderId) {
  const validLeader = G.playOrder.includes(leaderId) ? leaderId : G.playOrder[0];
  G.turnNo += 1;
  G.field = [];
  G.playedSet = {};
  G.turnConfirm = null;
  G.law = null;
  G.reveals = [];
  G.pending = null;
  G.leader = validLeader;
  G.actingPlayer = validLeader;
  G.playStage = validLeader;
  // 安全兜底：无手牌玩家视为已出牌，避免流程卡死
  for (const id of G.playOrder) {
    if (G.players[id].hand.length === 0) G.playedSet[id] = true;
  }
  if (G.playedSet[validLeader]) {
    const n = G.playOrder.length;
    const start = G.playOrder.indexOf(validLeader);
    for (let k = 1; k <= n; k++) {
      const id = G.playOrder[(start + k) % n];
      if (!G.playedSet[id]) { G.playStage = id; G.actingPlayer = id; break; }
    }
  }
  pushLog(G, `第 ${G.round} 轮·第 ${G.turnNo} 回合：由 ${playerName(G, G.playStage)} 先出牌。`);
}

// ---------- 出牌与即时（闪电）效果 ----------

/** 律法限制：若手牌中存在符合条件的牌，则必须打出符合条件的牌。 */
function lawAllows(G, id, card) {
  if (!G.law) return true;
  const hand = G.players[id] && G.players[id].hand;
  if (!Array.isArray(hand)) return true;
  const meets = (c) => (G.law.mode === 'lower' ? c.number < 15 : c.number > 15);
  const hasValid = hand.some(meets);
  if (!hasValid) return true;
  return meets(card);
}

/** 把一张牌放到场上（owner 为牌所在玩家面前的区域）。 */
function placeOnField(G, card, owner) {
  G.field.push({ card, owner });
}

/** 立即结算闪电牌效果；必要时写入 G.pending。 */
function triggerLightning(G, card, actor) {
  switch (card.number) {
    case 15: // 律法
      G.pending = { type: 'law', playerID: actor, lawCardId: card.id };
      return;
    case 21: // 梦：由效果引入时简化处理（正常打出时在 playCard 中处理放置）
      return;
    case 23: // 嫉妒：场上须有另一张牌可交换
      if (G.field.some((e) => e.card.id !== card.id)) {
        G.pending = { type: 'envy', playerID: actor, envyCardId: card.id };
      }
      return;
    case 24: // 秘密：须有玩家手牌可供揭示
      if (G.playOrder.some((id) => G.players[id].hand.length > 0)) {
        G.pending = { type: 'secretTarget', playerID: actor, secretCardId: card.id };
      }
      return;
    case 28: // 愤怒：须有其他玩家已打出牌
      if (G.field.some((e) => e.owner !== actor)) {
        G.pending = { type: 'angerTarget', playerID: actor, angerCardId: card.id };
      }
      return;
    case 29: // 背叛：须有手牌且场上有另一张牌
      if (G.players[actor].hand.length > 0 && G.field.some((e) => e.card.id !== card.id)) {
        G.pending = { type: 'betrayalHand', playerID: actor, betrayalCardId: card.id };
      }
      return;
    default:
      if (card.number >= 30 && card.number <= 35) {
        const hasHand = G.players[actor].hand.length > 0;
        const hasTarget = G.playOrder.some(
          (id) => id !== actor && G.players[id].hand.length > 0,
        );
        if (hasHand && hasTarget) {
          G.pending = { type: 'absoluteTarget', playerID: actor, absoluteCardId: card.id };
        }
      }
      return;
  }
}

/** 出牌或效果结算后推进流程；若所有玩家已出牌则进入结算确认阶段（全员点击「结束回合」后才真正结算）。 */
function afterAction(G, ctx, random, events) {
  if (G.ended || G.pending) return;
  const allPlayed = G.playOrder.every((id) => !!G.playedSet[id]);
  if (allPlayed) {
    openTurnConfirm(G);
    return;
  }
  const n = G.playOrder.length;
  const start = Math.max(0, G.playOrder.indexOf(G.actingPlayer));
  for (let k = 1; k <= n; k++) {
    const id = G.playOrder[(start + k) % n];
    if (G.playedSet[id]) continue;
    if (G.players[id].hand.length === 0) { G.playedSet[id] = true; continue; }
    G.playStage = id;
    return;
  }
  openTurnConfirm(G);
}

/** 全员已出牌：打开结算确认阶段，等待所有玩家点击「结束回合」。 */
function openTurnConfirm(G) {
  G.turnConfirm = {};
  G.playStage = null;
}

// ---------- 回合结束结算 ----------

function markDiscard(discard, reasons, entry, reason, winnerCardId) {
  // 恐惧不能被效果弃掉，除非它赢得本回合
  if (entry.card.number === 12 && entry.card.id !== winnerCardId) return;
  if (!discard.has(entry.card.id)) {
    discard.add(entry.card.id);
    reasons.set(entry.card.id, []);
  }
  const list = reasons.get(entry.card.id);
  if (list && !list.includes(reason)) list.push(reason);
}

/**
 * 回合结算共用判定：胜利牌 + 沙漏效果弃牌集合（以同一快照同时结算）。
 * 服务端 resolveTurnEnd 与客户端预览 presagesResolutionPreview 共用，保证口径一致。
 * 返回 { winnerEntry, discard, reasons, prideOwner }；prideOwner 仅服务端用于决定下回合先手。
 */
function computeTurnDiscards(field) {
  // 胜利条件：默认数值最高；镜子改为最低；悲伤忽略最高改取第二高（与镜子同场时忽略悲伤）
  const sortedDesc = [...field].sort((a, b) => b.card.number - a.card.number);
  const mirror = field.some((e) => e.card.number === 14);
  const sadness = field.some((e) => e.card.number === 26);
  let winnerEntry;
  if (mirror) winnerEntry = sortedDesc[sortedDesc.length - 1];
  else if (sadness && sortedDesc.length > 1) winnerEntry = sortedDesc[1];
  else winnerEntry = sortedDesc[0];

  const winnerCard = winnerEntry.card;

  const discard = new Set([winnerCard.id]);
  const reasons = new Map([[winnerCard.id, ['赢得本回合']]]);
  let prideOwner = null;

  // 同时结算所有沙漏牌（快照为结算开始时的场上状态）
  for (const entry of field) {
    if (entry.card.timing !== 'hourglass') continue;
    const card = entry.card;
    const src = `${card.number}《${card.name}》`; // 弃牌来源（用于日志与界面预览）
    switch (card.number) {
      case 1: { const t = highestOf(field, 'green'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 2: {
        const hasOtherGreen = field.some((o) => o.card.id !== card.id && isColor(o.card, 'green'));
        if (hasOtherGreen) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 3: {
        const hasYellow = field.some((o) => isColor(o.card, 'yellow'));
        if (hasYellow) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 4: {
        const hasRed = field.some((o) => isColor(o.card, 'red'));
        if (hasRed) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 5: {
        const hasBlue = field.some((o) => isColor(o.card, 'blue'));
        if (hasBlue) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 6: {
        const min = Math.min(...field.map((e) => e.card.number));
        if (card.number === min) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 7: {
        const otherGreen = field.some((o) => o.card.id !== card.id && isColor(o.card, 'green'));
        if (!otherGreen) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 8: { const t = lowestOf(field, 'green'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 9: { const t = highestOf(field, 'yellow'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 10: {
        const hasAbsolute = field.some((e) => e.card.number >= 30 && e.card.number <= 35);
        if (hasAbsolute) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 11: {
        const otherYellow = field.some((o) => o.card.id !== card.id && isColor(o.card, 'yellow'));
        if (!otherYellow) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 12: // 恐惧：仅在有其他效果弃掉它时被过滤；若获胜已弃掉
        break;
      case 13: // 运气：弃牌后的弃手牌在下方单独处理
        break;
      case 14: // 镜子：改变胜利条件（已生效）
      case 26: // 悲伤：改变胜利条件（已生效）
        break;
      case 16: { const t = lowestOf(field, 'yellow'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 18: { const t = highestOf(field, 'red'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 19: {
        const otherRed = field.some((o) => o.card.id !== card.id && isColor(o.card, 'red'));
        if (!otherRed) markDiscard(discard, reasons, entry, src, winnerCard.id);
        break;
      }
      case 20: { const t = lowestOverall(field); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 22: // 骄傲：下一回合由左侧玩家先手（由调用方处理）
        prideOwner = entry.owner;
        break;
      case 25: { const t = lowestOf(field, 'red'); if (t) markDiscard(discard, reasons, t, src, winnerCard.id); break; }
      case 27: // 冬：弃掉所有黄色牌
        for (const e of field) {
          if (isColor(e.card, 'yellow')) markDiscard(discard, reasons, e, src, winnerCard.id);
        }
        break;
      default:
        break;
    }
  }

  return { winnerEntry, discard, reasons, prideOwner };
}

/**
 * 回合结束：判定胜利牌、以同一快照结算所有沙漏效果、弃牌并回收未弃牌。
 * 若《运气》触发弃手牌，会挂起 pending 由对应玩家选择。
 */
function resolveTurnEnd(G, ctx, random, events) {
  const field = G.field;
  if (field.length === 0) {
    startMacroTurn(G, G.leader);
    return;
  }

  const { winnerEntry, discard, reasons, prideOwner } = computeTurnDiscards(field);
  const winnerCard = winnerEntry.card;
  const winnerId = winnerEntry.owner;
  const nextLeader = prideOwner ? leftPlayer(G, prideOwner) : null;

  // 恐惧不能被弃掉（获胜者除外）；其余弃牌进入弃牌堆，未弃掉的牌收回手中
  const discardedEntries = [];
  const keptEntries = [];
  for (const e of field) {
    if (e.card.id !== winnerCard.id && e.card.number === 12) {
      keptEntries.push(e);
    } else if (discard.has(e.card.id)) {
      discardedEntries.push(e);
    } else {
      keptEntries.push(e);
    }
  }
  for (const e of discardedEntries) G.discard.push(e.card);
  for (const e of keptEntries) {
    const p = G.players[e.owner];
    if (p) { p.hand.push(e.card); sortHand(p.hand); }
  }
  G.field = [];

  // 运气：若被弃掉，拥有者从手中弃一张牌（不能弃恐惧）
  const luckEntry = field.find((e) => e.card.number === 13 && discard.has(e.card.id));
  let luckOwner = null;
  if (luckEntry) {
    luckOwner = luckEntry.owner;
    const valid = G.players[luckOwner].hand.filter((c) => c.number !== 12);
    if (valid.length > 0) {
      G.resolveMeta = { winnerId, winnerCard, nextLeader: nextLeader || null, luckOwner };
      G.pending = { type: 'luck', playerID: luckOwner };
      G.lastResolution = buildResolutionSummary(
        G, field, discardedEntries, reasons, winnerId, winnerCard, null,
      );
      pushLog(G, `第 ${G.round} 轮·第 ${G.turnNo} 回合：${playerName(G, winnerId)} 的 ${winnerCard.number}《${winnerCard.name}》赢得回合。`);
      pushLog(G, `${playerName(G, luckOwner)} 的《运气》被弃掉，需从手中再弃一张牌。`);
      return;
    }
  }

  const meta = { winnerId, winnerCard, nextLeader: nextLeader || null, luckOwner };
  G.resolveMeta = meta;
  G.reveals = [];
  G.lastResolution = buildResolutionSummary(
    G, field, discardedEntries, reasons, winnerId, winnerCard, null,
  );
  const discardedText = discardedEntries
    .map((e) => `${e.card.number}《${e.card.name}》`)
    .join('、') || '无';
  pushLog(
    G,
    `第 ${G.round} 轮·第 ${G.turnNo} 回合：${playerName(G, winnerId)} 的 ${winnerCard.number}《${winnerCard.name}》赢得回合；弃牌：${discardedText}。`,
  );
  finalizeTurnEnd(G, ctx, random, events);
}

function buildResolutionSummary(G, field, discardedEntries, reasons, winnerId, winnerCard, luckOwner) {
  return {
    round: G.round,
    turnNo: G.turnNo,
    winnerId,
    winnerCard,
    winnerTeam: G.teamOf[winnerId],
    discarded: discardedEntries.map((e) => ({
      card: e.card,
      owner: e.owner,
      reasons: reasons.get(e.card.id) || [],
    })),
    luckOwner,
  };
}

/** 运气弃手牌完成后继续回合收尾。 */
function resolveLuckPick(G, card) {
  G.discard.push(card);
  pushLog(G, `${playerName(G, G.pending.playerID)} 因《运气》弃掉一张手牌。`);
  G.pending = null;
}

/** 回合最终收尾：检查运气即时胜利 / 轮结束 / 下一回合。 */
function finalizeTurnEnd(G, ctx, random, events) {
  const meta = G.resolveMeta || {};
  const luckOwner = meta.luckOwner;

  // 运气使手牌变为 0：立即赢得本轮（优先级最高）
  if (luckOwner && G.players[luckOwner] && G.players[luckOwner].hand.length === 0) {
    pushLog(G, `${playerName(G, luckOwner)} 因《运气》手牌归零，其小队立即赢得本轮！`);
    awardRound(G, ctx, random, events, luckOwner, '《运气》手牌归零');
    return;
  }

  // 常规轮结束：有人只剩 1 张手牌；多人同时只剩 1 张时比较手牌数值
  const candidates = G.playOrder.filter((id) => G.players[id].hand.length <= 1);
  if (candidates.length > 0) {
    let best = null;
    let bestValue = -1;
    for (const id of candidates) {
      const hand = G.players[id].hand;
      const value = hand.length > 0 ? Math.max(...hand.map((c) => c.number)) : 0;
      if (value > bestValue) { bestValue = value; best = id; }
    }
    awardRound(G, ctx, random, events, best, '手牌仅剩 1 张');
    return;
  }

  // 下一回合由本回合胜者先手；骄傲会改为其左侧玩家
  const leader = meta.nextLeader && G.playOrder.includes(meta.nextLeader)
    ? meta.nextLeader
    : meta.winnerId;
  G.resolveMeta = null;
  startMacroTurn(G, leader);
}

/** 小队赢得一轮；达到 2 轮时结束游戏。 */
function awardRound(G, ctx, random, events, winnerId, reason) {
  const team = G.teamOf[winnerId];
  if (team == null) return;
  G.teamWins[team] = (G.teamWins[team] || 0) + 1;
  G.resolveMeta = null;
  G.pending = null;
  G.reveals = [];
  pushLog(
    G,
    `${playerName(G, winnerId)} 为小队${PRESAGES_TEAM_SYMBOLS[team]}赢得第 ${G.round} 轮（${reason}）。`,
  );

  if (G.teamWins[team] >= 2) {
    G.ended = true;
    G.playStage = null;
    G.actingPlayer = null;
    G.results = {
      winners: [...G.teams[team]],
      team,
      reason: `小队${PRESAGES_TEAM_SYMBOLS[team]}率先赢得 2 轮`,
      teamWins: { ...G.teamWins },
    };
    pushLog(G, `游戏结束：小队${PRESAGES_TEAM_SYMBOLS[team]}获胜！`);
    return;
  }
  startRound(G, ctx, random, winnerId);
}

// ---------- Game 定义 ----------

export const PresagesGame = {
  name: 'presages',
  minPlayers: 4,
  maxPlayers: 6,

  setup: ({ ctx }) => freshPresagesG(
    ctx,
    '房间已创建：Presages 支持 4-6 人，需 4 人以上就位后由房主开局。',
  ),

  phases: {
    lobby: {
      start: true,
      next: 'play',
      turn: {
        activePlayers: { all: 'waiting' },
      },
      moves: {
        /**
         * 玩家进入房间后自动标记已准备。
         * 与 Quanc 一致：幂等 + ignoreStaleStateID（多人同时进入时各自的 lobbyReady
         * 可能携带同一个旧 stateID，后到者会被以「invalid stateID」拒绝；
         * 该 move 只写自己的 ready 标记，可安全忽略陈旧 stateID）。
         */
        lobbyReady: {
          ignoreStaleStateID: true,
          move: ({ G, playerID }) => {
            if (!G.lobby || !G.lobby.ready || !G.players[playerID]) return INVALID;
            G.lobby.ready[playerID] = true;
            return undefined;
          },
        },

        /** 房主开局：4/5/6 人；绝对牌分队后发牌。 */
        startGame: {
          client: false,
          move: ({ G, ctx, playerID, events, random }) => {
            if (!G.lobby || G.lobby.started) return INVALID;
            if (playerID !== '0') return INVALID;
            const participants = Object.keys(G.lobby.ready)
              .filter((id) => G.players[id])
              .sort((a, b) => Number(a) - Number(b));
            const count = participants.length;
            if (count < 4 || count > 6 || count > ctx.numPlayers) return INVALID;

            capturePlayerNames(G, ctx);

            // 裁掉未加入的空座位
            for (const id of Object.keys(G.players)) {
              if (!G.lobby.ready[id]) delete G.players[id];
            }
            G.playOrder = participants;
            G.lobby.started = true;
            startFirstRound(G, random);
            events.endPhase();
            return undefined;
          },
        },
      },
    },

    play: {
      turn: {
        activePlayers: { all: 'play' },
      },
      moves: {
        /** 普通出牌。targetId 仅用于《梦》选择放置区域（空串/自己 = 打在自己面前）。 */
        playCard: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex, targetId) => {
            if (!G.lobby || !G.lobby.started || G.ended) return INVALID;
            if (ctx.phase !== 'play' || G.pending) return INVALID;
            if (playerID !== G.playStage) return INVALID;
            const me = G.players[playerID];
            if (!me || !Array.isArray(me.hand)) return INVALID;
            const idx = Number(handIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;

            const card = me.hand[idx];
            if (!lawAllows(G, playerID, card)) return INVALID;

            // 梦：可以选择打在其他尚未出牌的玩家面前
            let owner = playerID;
            let dreamTarget = '';
            if (card.number === 21 && targetId) {
              const target = String(targetId);
              if (target !== playerID) {
                if (!G.players[target] || G.playedSet[target]) return INVALID;
                owner = target;
                dreamTarget = target;
              }
            }

            me.hand.splice(idx, 1);
            placeOnField(G, card, owner);
            G.playedSet[playerID] = true;
            G.actingPlayer = playerID;
            G.playStage = playerID;

            pushLog(
              G,
              `${playerName(G, playerID)} 打出 ${card.number}《${card.name}》${
                dreamTarget ? `（放在 ${playerName(G, dreamTarget)} 面前）` : ''
              }。`,
            );

            if (card.timing === 'lightning') {
              if (card.number === 21) {
                if (dreamTarget) {
                  const targetHand = G.players[dreamTarget].hand;
                  if (targetHand.length > 0) {
                    G.pending = {
                      type: 'dream',
                      playerID: dreamTarget,
                      dreamOwner: playerID,
                    };
                    return undefined;
                  }
                }
                // 打在自己面前：不启动效果
              } else {
                triggerLightning(G, card, playerID);
                if (G.pending) return undefined;
              }
            }

            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 律法：选择低/高于 15。 */
        resolveLaw: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, mode) => {
            if (!G.pending || G.pending.type !== 'law' || G.pending.playerID !== playerID) return INVALID;
            if (mode !== 'lower' && mode !== 'higher') return INVALID;
            G.law = { mode, sourceId: G.pending.lawCardId };
            pushLog(G, `${playerName(G, playerID)} 以《律法》规定：尚未出牌者须打出${mode === 'lower' ? '低' : '高'}于 15 的牌。`);
            G.pending = null;
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 梦：被指定的玩家立刻打出一张牌放在梦玩家面前。 */
        resolveDream: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'dream' || pending.playerID !== playerID) return INVALID;
            const me = G.players[playerID];
            const idx = Number(handIndex);
            if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
            const card = me.hand[idx];
            if (!lawAllows(G, playerID, card)) return INVALID;

            me.hand.splice(idx, 1);
            placeOnField(G, card, pending.dreamOwner);
            G.playedSet[playerID] = true;
            G.pending = null;
            pushLog(
              G,
              `${playerName(G, playerID)} 受《梦》影响，打出 ${card.number}《${card.name}》放在 ${playerName(G, pending.dreamOwner)} 面前。`,
            );
            if (card.timing === 'lightning') {
              triggerLightning(G, card, playerID);
              if (G.pending) return undefined;
            }
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 嫉妒：选择场上任意一张牌交换位置。 */
        resolveEnvy: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, fieldIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'envy' || pending.playerID !== playerID) return INVALID;
            const idx = Number(fieldIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= G.field.length) return INVALID;
            const target = G.field[idx];
            if (target.card.id === pending.envyCardId) return INVALID;
            const envy = G.field.find((e) => e.card.id === pending.envyCardId);
            if (!envy) return INVALID;
            const envyOwner = envy.owner;
            envy.owner = target.owner;
            target.owner = envyOwner;
            pushLog(G, `${playerName(G, playerID)} 用《嫉妒》与 ${target.card.number}《${target.card.name}》交换位置。`);
            G.pending = null;
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 秘密：选择要揭示手牌的玩家。 */
        resolveSecretTarget: ({ G, playerID }, targetId) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'secretTarget' || pending.playerID !== playerID) return INVALID;
          const target = String(targetId || '');
          if (!G.players[target] || G.players[target].hand.length === 0) return INVALID;
          G.pending = {
            type: 'secretViewer',
            playerID,
            secretCardId: pending.secretCardId,
            targetId: target,
          };
          return undefined;
        },

        /** 秘密：选择揭示给谁看（自己或另一位玩家）。 */
        resolveSecretViewer: ({ G, playerID }, viewerId) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'secretViewer' || pending.playerID !== playerID) return INVALID;
          const viewer = String(viewerId || '');
          if (!G.players[viewer]) return INVALID;
          G.pending = {
            type: 'secretReveal',
            playerID: pending.targetId,
            secretOwner: playerID,
            viewerId: viewer,
          };
          return undefined;
        },

        /** 秘密：被指定的玩家选择一张手牌揭示。 */
        resolveSecretReveal: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'secretReveal' || pending.playerID !== playerID) return INVALID;
            const me = G.players[playerID];
            const idx = Number(handIndex);
            if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
            const card = me.hand[idx];
            G.reveals.push({
              card,
              ownerId: playerID,
              viewerId: pending.viewerId,
              round: G.round,
              turnNo: G.turnNo,
            });
            G.pending = null;
            pushLog(
              G,
              `${playerName(G, playerID)} 向 ${playerName(G, pending.viewerId)} 揭示了一张手牌。`,
            );
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 愤怒：选择要针对的玩家（须已出过牌）。 */
        resolveAngerTarget: ({ G, playerID }, targetId) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'angerTarget' || pending.playerID !== playerID) return INVALID;
          const target = String(targetId || '');
          if (target === playerID || !G.players[target]) return INVALID;
          const hasField = G.field.some((e) => e.owner === target);
          if (!hasField) return INVALID;
          G.pending = {
            type: 'angerField',
            playerID: target,
            angerOwner: playerID,
            angerCardId: pending.angerCardId,
          };
          return undefined;
        },

        /** 愤怒：目标选择自己场上的哪张牌收回。 */
        resolveAngerField: ({ G, playerID }, fieldIndex) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'angerField' || pending.playerID !== playerID) return INVALID;
          const idx = Number(fieldIndex);
          if (!Number.isInteger(idx) || idx < 0 || idx >= G.field.length) return INVALID;
          const entry = G.field[idx];
          if (entry.owner !== playerID) return INVALID;
          G.pending = {
            ...pending,
            type: 'angerHand',
            fieldCardId: entry.card.id,
          };
          return undefined;
        },

        /** 愤怒：目标收回旧牌并另打一张。 */
        resolveAngerHand: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'angerHand' || pending.playerID !== playerID) return INVALID;
            const me = G.players[playerID];
            const idx = Number(handIndex);
            if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;

            // 先取出新打出的手牌，再把被收回的牌放回手中（避免索引被打乱）
            const card = me.hand.splice(idx, 1)[0];

            const fieldIdx = G.field.findIndex((e) => e.card.id === pending.fieldCardId && e.owner === playerID);
            if (fieldIdx < 0) return INVALID;
            const removed = G.field.splice(fieldIdx, 1)[0];
            // 律法被收回：其条件立即失效
            if (removed.card.number === 15 && G.law && G.law.sourceId === removed.card.id) {
              G.law = null;
              pushLog(G, '《律法》被《愤怒》收回，其条件在本回合后续不再适用。');
            }
            me.hand.push(removed.card);
            sortHand(me.hand);

            placeOnField(G, card, playerID);
            G.pending = null;
            pushLog(
              G,
              `${playerName(G, playerID)} 受《愤怒》影响收回 ${removed.card.number}《${removed.card.name}》，改打 ${card.number}《${card.name}》。`,
            );
            if (card.timing === 'lightning') {
              triggerLightning(G, card, playerID);
              if (G.pending) return undefined;
            }
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 背叛：先选择自己的手牌。 */
        resolveBetrayalHand: ({ G, playerID }, handIndex) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'betrayalHand' || pending.playerID !== playerID) return INVALID;
          const me = G.players[playerID];
          const idx = Number(handIndex);
          if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
          G.pending = {
            ...pending,
            type: 'betrayalField',
            handCardId: me.hand[idx].id,
          };
          return undefined;
        },

        /** 背叛：再选择场上的一张牌完成交换。 */
        resolveBetrayalField: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, fieldIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'betrayalField' || pending.playerID !== playerID) return INVALID;
            const idx = Number(fieldIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= G.field.length) return INVALID;
            const target = G.field[idx];
            if (target.card.id === pending.betrayalCardId) return INVALID;

            const me = G.players[playerID];
            const handIdx = me.hand.findIndex((c) => c.id === pending.handCardId);
            if (handIdx < 0) return INVALID;
            const handCard = me.hand.splice(handIdx, 1)[0];

            const taken = target.card;
            const takenOwner = target.owner;
            me.hand.push(taken);
            sortHand(me.hand);

            // 交换位置：手牌放到被换走牌的位置（仍在原拥有者面前）
            target.card = handCard;

            if (taken.number === 15 && G.law && G.law.sourceId === taken.id) {
              G.law = null;
              pushLog(G, '《律法》被《背叛》拿走，其条件在本回合后续游戏中不再适用。');
            }
            G.pending = null;
            pushLog(
              G,
              `${playerName(G, playerID)} 用 ${handCard.number}《${handCard.name}》换走 ${playerName(G, takenOwner)} 面前的 ${taken.number}《${taken.name}》。`,
            );
            // 放入场上的牌若有闪电符号，由该位置的拥有者立刻结算
            if (handCard.timing === 'lightning') {
              triggerLightning(G, handCard, takenOwner);
              if (G.pending) return undefined;
            }
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 绝对牌：选择交换对象。 */
        resolveAbsoluteTarget: ({ G, playerID }, targetId) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'absoluteTarget' || pending.playerID !== playerID) return INVALID;
          const target = String(targetId || '');
          if (target === playerID || !G.players[target] || G.players[target].hand.length === 0) return INVALID;
          if (G.players[playerID].hand.length === 0) {
            G.pending = null;
            return undefined;
          }
          G.pending = {
            type: 'absoluteMine',
            playerID,
            targetId: target,
            absoluteCardId: pending.absoluteCardId,
          };
          return undefined;
        },

        /** 绝对牌：自己先选一张手牌。 */
        resolveAbsoluteMine: ({ G, playerID }, handIndex) => {
          const pending = G.pending;
          if (!pending || pending.type !== 'absoluteMine' || pending.playerID !== playerID) return INVALID;
          const me = G.players[playerID];
          const idx = Number(handIndex);
          if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
          G.pending = {
            type: 'absoluteTheirs',
            playerID: pending.targetId,
            sourceId: playerID,
            mineCardId: me.hand[idx].id,
            absoluteCardId: pending.absoluteCardId,
          };
          return undefined;
        },

        /** 绝对牌：对方选一张手牌，完成交换。 */
        resolveAbsoluteTheirs: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'absoluteTheirs' || pending.playerID !== playerID) return INVALID;
            const me = G.players[playerID];
            const source = G.players[pending.sourceId];
            if (!me || !source) return INVALID;
            const idx = Number(handIndex);
            if (!Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
            const sourceIdx = source.hand.findIndex((c) => c.id === pending.mineCardId);
            if (sourceIdx < 0) return INVALID;

            const mine = me.hand.splice(idx, 1)[0];
            const theirs = source.hand.splice(sourceIdx, 1)[0];
            me.hand.push(theirs);
            source.hand.push(mine);
            sortHand(me.hand);
            sortHand(source.hand);
            G.pending = null;
            pushLog(
              G,
              `${playerName(G, pending.sourceId)} 与 ${playerName(G, playerID)} 通过《绝对》交换了一张手牌。`,
            );
            afterAction(G, ctx, random, events);
            return undefined;
          },
        },

        /** 运气：选择因《运气》弃掉的手牌（不能弃《恐惧》）。 */
        resolveLuck: {
          client: false,
          move: ({ G, ctx, playerID, random, events }, handIndex) => {
            const pending = G.pending;
            if (!pending || pending.type !== 'luck' || pending.playerID !== playerID) return INVALID;
            const me = G.players[playerID];
            const idx = Number(handIndex);
            if (!me || !Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) return INVALID;
            const card = me.hand[idx];
            if (card.number === 12) return INVALID;
            me.hand.splice(idx, 1);
            resolveLuckPick(G, card);
            finalizeTurnEnd(G, ctx, random, events);
            return undefined;
          },
        },
        /** 全员出牌后确认结束回合：所有玩家都点击后才真正结算。 */
        confirmTurnEnd: {
          client: false,
          move: ({ G, ctx, playerID, random, events }) => {
            if (ctx.phase !== 'play' || G.ended || G.pending) return INVALID;
            if (!G.turnConfirm || G.turnConfirm[playerID]) return INVALID;
            G.turnConfirm[playerID] = true;
            if (G.playOrder.every((id) => G.turnConfirm[id])) {
              G.turnConfirm = null;
              resolveTurnEnd(G, ctx, random, events);
            }
            return undefined;
          },
        },
      },
    },
  },

  /** 顶层 moves：不依赖阶段的通用操作。 */
  moves: {
    /** 结束本局并返回大厅：进行中仅房主可操作，结束后任意玩家可操作。 */
    backToLobby: ({ G, ctx, playerID, events }) => {
      if (!G.lobby || !G.lobby.started) return INVALID;
      if (!G.ended && playerID !== '0') return INVALID;
      const endedByHost = !G.ended;
      const fresh = freshPresagesG(ctx, endedByHost
        ? '房主已结束本局，房间已重置，可开始新一局。'
        : '本局已结束，房间已重置，可开始新一局。');
      for (const k of Object.keys(G)) delete G[k];
      Object.assign(G, fresh);
      events.setPhase('lobby');
      return undefined;
    },
  },

  /** 玩家视角：他人手牌仅显示张数；备用牌堆仅显示张数；秘密揭示仅对指定观看者可见。 */
  playerView: ({ G, playerID }) => {
    const players = {};
    for (const id of Object.keys(G.players)) {
      const p = G.players[id];
      players[id] = {
        hand: id === playerID ? p.hand : p.hand.length,
      };
    }

    let pending = null;
    if (G.pending) {
      pending = { ...G.pending };
      // 背叛者选择的手牌在交换前对他人保密
      if (pending.type === 'betrayalField' && pending.playerID !== playerID) {
        delete pending.handCardId;
      }
      // 绝对牌交换中，先选定的手牌只对选择者可见
      if (pending.type === 'absoluteTheirs' && pending.sourceId !== playerID) {
        delete pending.mineCardId;
      }
    }

    const reveals = (G.reveals || []).map((r) => {
      const visible = playerID === r.viewerId || playerID === r.ownerId;
      return { ...r, card: visible ? r.card : null };
    });

    return {
      ...G,
      players,
      pending,
      reveals,
      reserve: Array.isArray(G.reserve) ? G.reserve.length : G.reserve,
    };
  },
};

export default PresagesGame;
