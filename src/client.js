/**
 * src/client.js
 * 前端客户端（原生 JS，经 esbuild 打包后供浏览器使用）。
 */

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { QuancGame, computeFamilyFates, pLabel, getTask } from './quanc.js';
import { Red7Game, RED7_COLORS, computeWinningIds, ruleKeyCards, effectiveRuleIndex } from './red7.js';
import { GAMES, getGame } from './games.js';
import { FAMILIES, getFamily } from './quanc-cards.js';
import { FAMILY_ICONS, TYPE_ICONS, BACK_EMBLEM } from './quanc-icons.js';

const API_BASE = `${window.location.protocol}//${window.location.host}`;
/** 会话存储键：保存当前房间与座位凭证，用于刷新后自动恢复。 */
const SESSION_KEY = 'quanc_session';

let client = null;
let currentState = null;     // 最近一次渲染所用的状态
let currentGame = null;      // 当前选中的游戏条目（registry 中的元数据 + game 对象）
let selectedIndex = null;    // 当前选中的手牌索引
let prevForcedAction = false; // 上一帧是否处于强制行动（用于自动定位只触发一次）
let currentMatchID = null;   // 当前对局 ID（用于展示与复制）
let roomInfo = null;         // 当前房间信息 { matchID, playerID, credentials }
let inGameScreen = false;    // 当前是否已切换到游戏界面
let currentPlayerName = '';  // 当前玩家昵称（用于恢复会话时回填）
let seenCardIds = new Set(); // 已出现过的卡牌 id，用于给新牌播放进入动画
let prevEnded = false;       // 上一帧是否已结束（用于一次性触发翻牌/得分滚动）
let justEnded = false;       // 本帧是否为游戏结束瞬间
const loadedCSS = new Set(); // 已动态加载的游戏 CSS 路径（去重）
const CSS_VERSION = '18';     // CSS 版本号：样式更新时递增，防止浏览器缓存旧样式

/** 当前游戏的 boardgame.io 名称（大厅路由键），未选择时为空串。 */
function gameName() {
  return currentGame ? currentGame.game.name : '';
}

// ---------- 基础工具 ----------

function $(sel) {
  return document.querySelector(sel);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== false && v != null) {
      node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** 将纹章 SVG 字符串注入为 .ico 容器（颜色/尺寸由 CSS 控制）。 */
function svgNode(svg) {
  const span = document.createElement('span');
  span.className = 'ico';
  if (svg) span.innerHTML = svg;
  return span;
}

/** 标记新出现的牌：首次渲染时返回 true（用于播放进入动画）。 */
function markNew(card) {
  if (card && card.id && !seenCardIds.has(card.id)) {
    seenCardIds.add(card.id);
    return true;
  }
  return false;
}

/** 结算分数从 0 滚动到目标值。 */
function animateScore(el, target) {
  const start = performance.now();
  const dur = 700;
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = `${Math.round(target * eased)} 分`;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = `${target} 分`;
  }
  requestAnimationFrame(tick);
}

// ---------- 大厅：创建 / 加入 / 离开对局 ----------

/** 将 boardgame.io REST 接口的错误响应转换为中文提示。 */
async function readErrorMessage(res, fallback) {
  const text = await res.text().catch(() => '');
  let serverMsg = text;
  try {
    const data = JSON.parse(text);
    if (data && (data.message || data.error)) serverMsg = data.message || data.error;
  } catch {
    // 非 JSON 响应（如 koa 默认纯文本错误），直接使用 text
  }
  if (res.status === 404) return '房间不存在，请检查对局 ID';
  if (res.status === 409) {
    if (/maximum number of players/i.test(serverMsg)) return '房间已满，无法加入';
    if (/not available/i.test(serverMsg)) return '该席位已被占用，请更换房间';
    return serverMsg || '房间当前无法加入';
  }
  if (res.status === 403) {
    if (/游戏已开始/.test(serverMsg)) return '游戏已开始，无法加入';
    if (/昵称已被/.test(serverMsg)) return serverMsg;
    return '请先填写昵称';
  }
  return serverMsg || `${fallback}（${res.status}）`;
}

/** 当前游戏的玩家人数范围文案（如「2-4 名玩家」）。 */
function playerRange() {
  if (!currentGame || !currentGame.game) return '';
  const g = currentGame.game;
  return `${g.minPlayers}-${g.maxPlayers} 名玩家`;
}

async function createMatch() {
  // 房间座位数随游戏的 maxPlayers 自适应（Quanc=5、Red7=4）
  const numPlayers = currentGame.game.maxPlayers;
  const res = await fetch(`${API_BASE}/games/${gameName()}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numPlayers }),
  });
  if (!res.ok) throw new Error(await readErrorMessage(res, '创建房间失败'));
  const data = await res.json();
  return data.matchID;
}

/**
 * 加入房间。
 * @param {string} [playerID] 不传时由服务端自动分配第一个空座位。
 * @returns {Promise<{playerID: string, credentials: string}>}
 */
async function joinMatch(matchID, playerName, playerID) {
  const body = { playerName };
  if (playerID !== undefined && playerID !== null && playerID !== '') {
    body.playerID = Number(playerID);
  }
  const res = await fetch(`${API_BASE}/games/${gameName()}/${matchID}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readErrorMessage(res, '加入房间失败'));
  const data = await res.json();
  return { playerID: String(data.playerID), credentials: data.playerCredentials };
}

/** 离开房间（释放座位；房间无人时服务端会自动销毁房间）。 */
async function leaveMatch(matchID, playerID, credentials) {
  const res = await fetch(`${API_BASE}/games/${gameName()}/${matchID}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerID: Number(playerID), credentials }),
  });
  return res.ok;
}

// ---------- 家族 / 卡牌渲染 ----------

function fateLabel(fate) {
  if (fate === 'favored') return { text: '得宠', cls: 'fate-favored' };
  if (fate === 'disfavored') return { text: '失宠', cls: 'fate-disfavored' };
  return { text: '中立', cls: 'fate-neutral' };
}

/** 手牌（较大）：家族 + 类型，间谍在自己手中可见 */
function handCardNode(card, { onClick, selected = false } = {}) {
  const cls = ['card', `card-${card.type}`];
  if (selected) cls.push('card-selected');
  if (markNew(card)) cls.push('card-enter');
  const f = getFamily(card.family) || { name: card.familyName, icon: '', color: '#888' };
  const attrs = { class: cls.join(' '), style: `--c:${f.color}` };
  if (onClick) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }

  const typeSvg = TYPE_ICONS[card.type];
  const typeKids = [];
  if (typeSvg) typeKids.push(svgNode(typeSvg));
  typeKids.push(el('span', { text: card.typeName }));

  const kids = [
    el('div', { class: 'card-frame' }, [
      el('div', { class: 'card-tex' }),
      el('div', { class: 'card-gloss' }),
      el('div', { class: 'card-emblem' }, [svgNode(FAMILY_ICONS[card.family])]),
      el('div', { class: 'card-fam', text: f.name }),
      el('div', { class: 'card-type' }, typeKids),
    ]),
  ];
  if (card.type === 'noble') kids.push(el('div', { class: 'card-weight', text: '×2' }));
  return el('div', attrs, kids);
}

/** 区域小牌：间谍背面显示为牌背（传入 onClick 时牌背同样可点，用于刺客移除间谍） */
function miniCardNode(card, { onClick, disabled = false, title = '' } = {}) {
  // 小牌复用大卡结构（保留家族徽章/名称与类型文字），加 card-mini 缩放
  if (card.faceDown) {
    const cls = ['card', 'card-mini', 'card-back'];
    if (disabled) cls.push('card-disabled');
    if (markNew(card)) cls.push('card-enter');
    const attrs = {
      class: cls.join(' '),
      title: title || '间谍（背面，游戏结束时翻开）',
    };
    if (onClick && !disabled) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }
    return el('div', attrs, [
      el('div', { class: 'card-frame' }, [
        el('div', { class: 'card-tex' }),
        el('div', { class: 'card-emblem' }, [svgNode(BACK_EMBLEM)]),
      ]),
    ]);
  }
  const f = getFamily(card.family) || { name: card.familyName, icon: '', color: '#888' };
  const cls = ['card', 'card-mini', `card-${card.type}`];
  if (disabled) cls.push('card-disabled');
  if (markNew(card)) cls.push('card-enter');
  if (justEnded && card.type === 'spy') cls.push('card-flip');
  const attrs = { class: cls.join(' '), style: `--c:${f.color}`, title };
  if (onClick && !disabled) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }

  const typeKids = [el('span', { text: card.typeName })];

  const kids = [
    el('div', { class: 'card-frame' }, [
      el('div', { class: 'card-tex' }),
      el('div', { class: 'card-gloss' }),
      el('div', { class: 'card-emblem' }, [svgNode(FAMILY_ICONS[card.family])]),
      el('div', { class: 'card-fam', text: f.name }),
      el('div', { class: 'card-type' }, typeKids),
    ]),
  ];
  if (card.type === 'noble') kids.push(el('div', { class: 'card-weight', text: '×2' }));
  return el('div', attrs, kids);
}

/** 一组区域牌 */
function miniCardList(cards, opts = {}) {
  const frag = document.createDocumentFragment();
  if (cards.length === 0) {
    frag.appendChild(el('span', { class: 'empty-hint', text: opts.emptyText || '暂无' }));
    return frag;
  }
  cards.forEach((c, idx) => {
    frag.appendChild(miniCardNode(c, typeof opts.perCard === 'function' ? opts.perCard(c, idx) : opts));
  });
  return frag;
}

// ---------- 渲染 ----------

function renderHeader(G) {
  const deckNum = typeof G.deck === 'number' ? G.deck : G.deck.length;
  $('#deck-info').textContent =
    `第 ${G.round} 轮 · 本局移除 ${G.removedCount} 张 · 牌堆剩余 ${deckNum} 张`;
}

/** 根据 boardgame.io 推送的房间元数据构建「座位号 → 昵称」映射，玩家面板与结算面板共用。 */
function nicknameMap() {
  return new Map(
    (Array.isArray(client && client.matchData) ? client.matchData : [])
      .filter(s => s && s.name)
      .map(s => [String(s.id), s.name]),
  );
}

/** 玩家编号徽章节点：圆形徽章显示座号（不分颜色，避免与家族/规则色混淆）。 */
function playerNoBadge(id) {
  return el('span', {
    class: 'player-no',
    text: String(pLabel(id)),
  });
}

/** 玩家标识节点：编号徽章 + 昵称（编号与名称视觉分离），自己的区域附加醒目「你」徽章。 */
function playerNameNode(id, nicknames, { me = false } = {}) {
  const name = (nicknames && nicknames.get(String(id))) || '';
  const kids = [
    playerNoBadge(id),
    el('span', { class: 'player-name', text: name }),
  ];
  if (me) kids.push(el('span', { class: 'player-me', text: '你' }));
  return el('span', { class: 'player-tag' }, kids);
}

function renderPlayers(G, ctx, playerID, fates) {
  const container = $('#players');
  container.innerHTML = '';
  const nicknames = nicknameMap();
  for (const id of ctx.playOrder) {
    const p = G.players[id];
    // 与 Red7 一致：本局结束后不再高亮当前回合玩家
    const isCurrent = !G.ended && id === ctx.currentPlayer;
    const isMe = id === playerID;
    // 即时得分预览（按权重；背面牌未知，暂不计）
    let preview = 0;
    for (const card of p.territory) {
      if (card.faceDown) continue;
      const fate = fates[card.family] && fates[card.family].fate;
      const w = card.weight ?? 1;
      if (fate === 'favored') preview += w;
      else if (fate === 'disfavored') preview -= w;
    }
    // 回合状态角标文案（与 Red7 一致）：仅标记当前回合玩家，自己→轮到你了，他人→该玩家行动中
    const turnText = isCurrent ? (isMe ? '轮到你了' : '该玩家行动中') : '';
    const node = el('div', {
      class: `territory ${isCurrent ? 'active' : ''} ${isMe ? 'me' : ''}`,
      'data-turn-text': turnText,
    }, [
      el('div', { class: 'territory-head' }, [
        el('span', { class: 'territory-name' }, [playerNameNode(id, nicknames, { me: isMe })]),
        el('span', { class: 'territory-score', text: `得分 ${preview}` }),
      ]),
      el('div', { class: 'territory-cards' }, [
        miniCardList(p.territory, { emptyText: '领地暂无牌' }),
      ]),
    ]);
    container.appendChild(node);
  }
}

/**
 * 餐桌渲染：
 * - 得宠区 / 失宠区共用中间一条家族计分板（只显示得宠状态，不显示数字）；
 * - 6 个家族按 FAMILIES 顺序从左到右成列；未翻开的间谍暂存最右侧间谍列；
 * - 游戏结束间谍翻开（带 family）后，自动归入对应的家族列，间谍列保留为空。
 */
function renderTable(G, fates) {
  const container = $('#table');
  container.innerHTML = '';

  const favored = G.table.favored || [];
  const disfavored = G.table.disfavored || [];

  // 6 个家族列
  const cols = FAMILIES.map(f => ({
    kind: 'family',
    family: f,
    favored: favored.filter(c => c.family === f.id),
    disfavored: disfavored.filter(c => c.family === f.id),
  }));

  // 间谍列始终显示；仅收集尚未翻开的间谍（faceDown），结束后翻开的间谍已归入家族列
  cols.push({
    kind: 'spy',
    favored: favored.filter(c => c.type === 'spy' && c.faceDown),
    disfavored: disfavored.filter(c => c.type === 'spy' && c.faceDown),
  });

  // 列数（间谍列始终存在，共 7 列）
  const gridStyle = `grid-template-columns: repeat(${cols.length}, minmax(0, 1fr))`;

  // 得宠（上）/ 失宠（下）牌行；得宠列 wrap-reverse 向上叠放，失宠列正常向下叠放
  const cardsRow = (zoneKey, sideText, sideCls) =>
    el('div', { class: 'board-row' }, [
      el('div', { class: `board-side ${sideCls}` }, [el('span', { text: sideText })]),
      el('div', { class: 'board-grid', style: gridStyle }, cols.map((col) => {
        const cls = ['board-col', `board-col-${zoneKey}`];
        if (col.kind === 'spy') cls.push('board-col-spy');
        const style = col.kind === 'family' ? `--c:${col.family.color}` : '';
        return el('div', { class: cls.join(' '), style }, col[zoneKey].map(c => miniCardNode(c)));
      })),
    ]);

  // 中间共享计分板：家族图标 + 名称 + 得宠状态（无数值）
  const headCells = cols.map((col) => {
    if (col.kind === 'spy') {
      return el('div', { class: 'board-head-cell board-head-spy' }, [
        el('span', { class: 'chip-icon' }, [svgNode(TYPE_ICONS.spy)]),
        el('span', { class: 'board-head-name', text: '间谍' }),
        el('span', { class: 'fate-badge board-head-sub', text: '未翻开' }),
      ]);
    }
    const f = col.family;
    const lbl = fateLabel(fates[f.id].fate);
    return el('div', { class: `board-head-cell ${lbl.cls}`, style: `--c:${f.color}` }, [
      el('span', { class: 'chip-icon' }, [svgNode(FAMILY_ICONS[f.id])]),
      el('span', { class: 'board-head-name', text: f.name }),
      el('span', { class: 'fate-badge', text: lbl.text }),
    ]);
  });

  const board = el('div', { class: 'table-board' }, [
    cardsRow('favored', '得宠', 'board-side-favored'),
    el('div', { class: 'board-row' }, [
      el('div', { class: 'board-side' }, [el('span', { text: '餐桌' })]),
      el('div', { class: 'board-grid board-head', style: gridStyle }, headCells),
    ]),
    cardsRow('disfavored', '失宠', 'board-side-disfavored'),
  ]);
  container.appendChild(board);
}

function renderHand(G, playerID, active) {
  const container = $('#hand');
  container.innerHTML = '';
  const me = G.players[playerID];
  if (!me || !Array.isArray(me.hand)) {
    container.appendChild(el('div', { class: 'empty-hint', text: '等待其他玩家行动...' }));
    return;
  }
  if (me.hand.length === 0) {
    container.appendChild(el('div', { class: 'empty-hint', text: active ? '本回合已打完' : '手牌为空' }));
    return;
  }
  me.hand.forEach((card, idx) => {
    container.appendChild(handCardNode(card, {
      selected: selectedIndex === idx,
      onClick: active ? () => { selectedIndex = (selectedIndex === idx ? null : idx); renderGame(currentState); } : undefined,
    }));
  });
}

/** 刺客结算面板 */
function renderAssassinPanel(state) {
  const { G, ctx, playerID } = state;
  const isActive = !G.results && ctx.currentPlayer === playerID;
  const pending = G.pendingAssassin;
  const panel = $('#play-panel');
  panel.innerHTML = '';

  let area;
  let areaName;
  if (pending.location.kind === 'territory') {
    area = (G.players[pending.location.owner] && G.players[pending.location.owner].territory) || [];
    areaName = pending.location.owner === playerID ? '你的领地' : `玩家 ${pLabel(pending.location.owner)} 的领地`;
  } else {
    area = G.table[pending.location.zone] || [];
    areaName = pending.location.zone === 'favored' ? '餐桌·得宠区' : '餐桌·失宠区';
  }

  // 候选牌：排除刺客自身；守卫免疫；间谍（牌背）同样可被移除
  const entries = [];
  area.forEach((c, idx) => {
    if (c.id === pending.assassinCardId) return; // 不能移除刺客自身
    entries.push({ card: c, idx, removable: c.type !== 'guard' });
  });
  const removableCount = entries.filter(e => e.removable).length;

  panel.appendChild(el('div', {
    class: 'assassin-title',
    text: removableCount > 0
      ? `🗡️ 刺客效果：可移除【${areaName}】中的 1 张牌（守卫免疫），也可选择不发动。`
      : `🗡️ 刺客效果：【${areaName}】中没有可移除的牌，可选择不发动。`,
  }));
  const cand =
    entries.length === 0
      ? [el('span', { class: 'empty-hint', text: '该区域无可移除的牌' })]
      : entries.map(({ card, idx, removable }) => miniCardNode(card, {
          disabled: !removable,
          title: removable ? '点击移除该牌' : '守卫免疫，无法被移除',
          onClick: isActive && removable ? () => client.moves.resolveAssassin(idx) : undefined,
        }));
  panel.appendChild(el('div', { class: 'assassin-candidates' }, cand));
  // 任何情况下都允许不发动
  panel.appendChild(el('button', {
    class: 'btn btn-sm', text: '不发动', disabled: isActive ? false : 'disabled',
    onClick: () => client.moves.resolveAssassin(-1),
  }));
}

function renderPlayPanel(state) {
  const { G, ctx, playerID } = state;
  const isActive = !G.results && ctx.currentPlayer === playerID;
  const panel = $('#play-panel');

  if (G.results) return;

  // 有待结算的刺客效果，且仅当前操作玩家可见并结算；其他玩家仅提示等待
  if (G.pendingAssassin && isActive) {
    renderAssassinPanel(state);
    return;
  }

  panel.innerHTML = '';

  const remaining = G.turnDrawCount - G.turnPlayCount;
  if (!isActive) {
    panel.appendChild(el('div', { class: 'empty-hint', text: '等待其他玩家行动...' }));
    return;
  }

  const me = G.players[playerID];
  const hand = Array.isArray(me.hand) ? me.hand : [];
  if (hand.length === 0) {
    panel.appendChild(el('div', { class: 'empty-hint', text: '本回合出牌已完成，等待回合结束。' }));
    return;
  }

  if (selectedIndex == null || selectedIndex >= hand.length) {
    panel.appendChild(el('div', { class: 'empty-hint', text: `本回合还需打出 ${remaining} 张，请先点击一张手牌选择。` }));
    return;
  }

  const used = G.turnUsed;
  const others = ctx.playOrder.filter(id => id !== playerID);
  const play = (dest, target) => {
    client.moves.playCard(selectedIndex, dest, target);
    selectedIndex = null;
  };

  const row = (title, buttons) =>
    el('div', { class: 'dest-row' }, [
      el('span', { class: 'dest-title', text: title }),
      el('div', { class: 'dest-buttons' }, buttons),
    ]);

  panel.appendChild(el('div', { class: 'empty-hint', text: `已选：${getFamily(hand[selectedIndex].family).name}·${hand[selectedIndex].typeName}。选择出牌去向：` }));

  panel.appendChild(row('自己领地', [
    el('button', {
      class: 'btn btn-sm', disabled: used.own ? 'disabled' : false,
      text: used.own ? '已打过' : '打到自己领地',
      onClick: () => play('own'),
    }),
  ]));

  panel.appendChild(row('其他玩家领地', others.map(id =>
    el('button', {
      class: 'btn btn-sm', disabled: used.opponent ? 'disabled' : false,
      text: used.opponent ? `玩家 ${pLabel(id)}（已打过）` : `打到玩家 ${pLabel(id)} 领地`,
      onClick: () => play('opponent', id),
    }),
  )));

  panel.appendChild(row('餐桌', [
    el('button', {
      class: 'btn btn-sm btn-favored', disabled: used.table ? 'disabled' : false,
      text: used.table ? '已打过' : '打入得宠区',
      onClick: () => play('table', 'favored'),
    }),
    el('button', {
      class: 'btn btn-sm btn-disfavored', disabled: used.table ? 'disabled' : false,
      text: used.table ? '已打过' : '打入失宠区',
      onClick: () => play('table', 'disfavored'),
    }),
  ]));
}

function renderLog(G) {
  const container = $('#log');
  container.innerHTML = '';
  for (const line of G.log.slice(-12).reverse()) {
    container.appendChild(el('div', { class: 'log-line', text: line }));
  }
}

/**
 * 任务面板：显示当前玩家的餐桌 / 领地任务及其完成状态。
 * 实时状态基于客户端可见信息（playerView 后 G）预估；最终以结束结算为准。
 */
function renderTaskPanel(G, playerID) {
  const container = $('#task-panel');
  if (!container) return;
  const me = G.players[playerID];
  if (!me || !me.tasks) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = '';

  const items = [
    { label: '餐桌任务', task: getTask('table', me.tasks.table) },
    { label: '领地任务', task: getTask('territory', me.tasks.territory) },
  ];

  container.innerHTML = '';
  for (const { label, task } of items) {
    if (!task) continue;
    const done = task.check(G, playerID);
    container.appendChild(el('div', { class: `task-item ${done ? 'task-done' : ''}` }, [
      el('div', { class: 'task-head' }, [
        el('span', { class: 'task-label', text: label }),
        el('span', { class: 'task-status', text: done ? '得分+3' : '未完成' }),
      ]),
      el('div', { class: 'task-name', text: task.name }),
      el('div', { class: 'task-desc', text: task.desc }),
    ]));
  }
}

/**
 * 结算面板通用的「回到房间」按钮（点击后广播 backToLobby，全员退回大厅并清空本局）。
 * 所有游戏的结算界面统一复用，避免重复实现。
 */
function backToLobbyButton() {
  return el('button', {
    class: 'btn btn-primary go-back-lobby',
    text: '回到房间（开始新一局）',
    onClick: () => client.moves.backToLobby(),
  });
}

function renderGameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const { winners, scores, territoryScores, taskResults, fates } = G.results;
  const nicknames = nicknameMap();
  box.style.display = 'block';
  box.innerHTML = '';
  box.appendChild(el('h2', { text: '游戏结束' }));
  box.appendChild(el('p', { class: 'go-summary' }, [
    el('span', { text: '获胜者：' }),
    ...winners.flatMap((w, i) => (i === 0
      ? [playerNameNode(w, nicknames)]
      : [el('span', { text: '、' }), playerNameNode(w, nicknames)])),
  ]));
  const rows = Object.keys(scores).map(id => {
    const scoreEl = el('span', { class: 'go-score', text: `${justEnded ? 0 : scores[id]} 分` });
    if (justEnded) animateScore(scoreEl, scores[id]);
    const tr = taskResults ? taskResults[id] : null;
    const terr = territoryScores ? territoryScores[id] : undefined;
    const detail = [];
    if (terr !== undefined) detail.push(`领地 ${terr}`);
    if (tr) detail.push(`任务 +${tr.score}`);
    const children = [playerNameNode(id, nicknames), scoreEl];
    if (detail.length) children.push(el('span', { class: 'go-detail', text: detail.join(' · ') }));
    return el('div', { class: 'go-row' }, children);
  });
  box.appendChild(el('div', { class: 'go-scores' }, rows));
  const fateRows = FAMILIES.map(f => {
    const info = fates[f.id];
    const lbl = fateLabel(info.fate);
    return el('div', { class: `fate-item ${lbl.cls}`, style: `--c:${f.color}` }, [
      el('span', { class: 'chip-icon' }, [svgNode(FAMILY_ICONS[f.id])]),
      el('span', { class: 'chip-name', text: f.name }),
      el('span', { class: 'fate-badge', text: lbl.text }),
      el('span', { class: 'fate-nums', text: `+${info.favored}/-${info.disfavored}` }),
    ]);
  });
  box.appendChild(el('div', { class: 'fate-row' }, fateRows));
  box.appendChild(backToLobbyButton());
}

function renderQuanc(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  justEnded = !!G.results && !prevEnded;
  prevEnded = !!G.results;
  const fates = computeFamilyFates(G.table);
  renderHeader(G);
  renderPlayers(G, ctx, playerID, fates);
  renderTable(G, fates);
  renderTaskPanel(G, playerID);
  // 有刺客待结算时禁用选牌
  const canPick = !G.ended && ctx.currentPlayer === playerID && !G.pendingAssassin;
  renderHand(G, playerID, canPick);
  renderPlayPanel(state);
  renderLog(G);
  renderGameover(G);
}

// ---------- Red7 渲染 ----------

/** Red7 卡牌文字标签（如「红7」）。 */
function red7CardLabel(card) {
  return `${card.colorName}${card.number}`;
}

/** 清空 Red7 的选中手牌与强制行动标记。 */
function resetRed7Selection() {
  selectedIndex = null;
  prevForcedAction = false;
}

/** 重置与单局渲染相关的临时状态（进入房间 / 返回房间大厅时调用）。 */
function resetGameUIState() {
  resetRed7Selection();
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
}

/** Red7 卡牌节点：数字 + 颜色底；keyColor 用于关键牌脉冲特效（跟随当前规则色）。 */
function red7CardNode(card, { mini = false, selected = false, onClick = undefined, dimmed = false, key = false, keyColor = undefined, soft = false } = {}) {
  const color = RED7_COLORS[card.colorIndex];
  const cls = ['r7-card'];
  if (mini) cls.push('r7-card-mini');
  if (selected) cls.push('r7-card-selected');
  if (dimmed) cls.push('r7-card-dimmed');
  if (key) cls.push('r7-card-key');
  if (soft) cls.push('r7-card-soft');
  if (!onClick) cls.push('r7-card-static');
  const attrs = { class: cls.join(' '), style: `--c:${color.color}${key && keyColor ? `;--kc:${keyColor}` : ''}` };
  if (onClick) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }
  // 大卡右上角：数字 1/3/5/7 为特效牌，显示小闪电标记
  const kids = [
    el('div', { class: 'r7-num', text: String(card.number) }),
    el('div', { class: 'r7-color', text: card.colorName }),
  ];
  if (!mini && [1, 3, 5, 7].includes(card.number)) {
    kids.push(el('div', { class: 'r7-card-fx-badge', text: '⚡', title: '数字特效牌' }));
  }
  // key 牌：嵌套流光元素（外层 mask 固定裁剪边框，内层 transform 移动光带，GPU 加速）
  if (key) {
    kids.push(el('div', { class: 'r7-key-sheen-wrap' }, [
      el('div', { class: 'r7-key-sheen' }),
    ]));
  }
  return el('div', attrs, kids);
}

/** 头部信息：仅剩余人数（当前规则在画布区展示，避免重复）。 */
function renderRed7Header(G) {
  const activeCount = G.playOrder.filter((id) => !G.players[id].eliminated).length;
  $('#deck-info').textContent = `剩余 ${activeCount} 人`;
}

/** 画布区：当前生效规则牌 + 7 种颜色规则一览（当前高亮）+ 弃牌堆历史。 */
function renderRed7RuleArea(G) {
  const container = $('#table');
  container.innerHTML = '';
  const rule = RED7_COLORS[G.ruleColorIndex];
  const currentCard = G.canvas.length > 0 ? G.canvas[G.canvas.length - 1] : null;

  // 区域标题：画布区
  container.appendChild(el('div', { class: 'section-label section-label-canvas' }, [
    el('span', { text: '画布区/规则区' }),
    el('span', { class: 'section-label-sub', text: '弃牌到此改变规则' }),
  ]));

  // 当前生效规则牌
  const curKids = [
    el('div', { class: 'r7-rule-chip', style: `--c:${rule.color}` }, [
      el('span', { class: 'r7-rule-color', text: rule.name }),
    ]),
    el('div', { class: 'r7-rule-text', text: `${rule.name}规则：${rule.rule}` }),
  ];
  if (currentCard) {
    curKids.push(el('div', { class: 'r7-rule-card-current' }, [red7CardNode(currentCard, { mini: true })]));
  }
  container.appendChild(el('div', { class: 'r7-rule', style: `--c:${rule.color}` }, curKids));

  // 7 种颜色规则一览（当前规则高亮）
  container.appendChild(el('div', { class: 'r7-rule-list' }, [
    el('div', { class: 'r7-rules' }, RED7_COLORS.map((c, i) => {
      const active = i === G.ruleColorIndex;
      return el('div', {
        class: `r7-rule-card ${active ? 'r7-rule-card-active' : ''}`,
        style: `--c:${c.color}`,
      }, [
        el('span', { class: 'r7-rule-card-name', text: c.name }),
        el('span', { class: 'r7-rule-card-desc', text: c.rule }),
      ]);
    })),
  ]));

  // 画布区弃牌堆（无独立标题，间距收紧）；仅最上方一张为当前生效规则牌，其余历史牌弱化
  container.appendChild(el('div', { class: 'r7-canvas' }, [
    G.canvas.length === 0
      ? el('span', { class: 'empty-hint', text: '尚未弃牌，当前为初始规则' })
      : el('div', { class: 'r7-canvas-cards' }, G.canvas.map((c, i) => {
          const isActive = i === G.canvas.length - 1;
          return red7CardNode(c, { mini: true, soft: !isActive });
        })),
  ]));
}

/** 各玩家调色盘：淘汰置灰、当前回合高亮、优胜标记。 */
function renderRed7Players(G, ctx, playerID) {
  const container = $('#players');
  container.innerHTML = '';
  // 区域标题：调色盘
  container.appendChild(el('div', { class: 'section-label section-label-palette' }, [
    el('span', { text: '调色盘' }),
    el('span', { class: 'section-label-sub', text: '打出到此参与优胜判定' }),
  ]));
  const winners = computeWinningIds(G);
  const nicknames = nicknameMap();
  for (const id of G.playOrder) {
    const p = G.players[id];
    const isMe = id === playerID;
    const isCurrent = !G.ended && id === ctx.currentPlayer;
    const eliminated = p.eliminated;
    const winning = !eliminated && winners.includes(id);
    const cls = ['territory', 'r7-palette'];
    if (isMe) cls.push('me');
    if (isCurrent) cls.push('active');
    if (eliminated) cls.push('r7-eliminated');
    // 回合状态角标文案：仅标记当前回合玩家，自己→轮到你了，他人→该玩家行动中
    let turnText = '';
    if (!G.ended && !eliminated && isCurrent) {
      turnText = isMe ? '轮到你了' : '该玩家行动中';
    }
    const handCount = Array.isArray(p.hand) ? p.hand.length : p.hand;
    const rightKids = [el('span', { class: 'r7-hand-count', text: `手牌 ${handCount} 张` })];
    if (eliminated) rightKids.push(el('span', { class: 'r7-badge r7-badge-out', text: '已出局' }));
    else if (winning) rightKids.push(el('span', { class: 'r7-badge r7-badge-win', text: '优胜' }));
    const headKids = [
      el('span', { class: 'territory-name' }, [playerNameNode(id, nicknames, { me: isMe })]),
      el('span', { class: 'r7-head-right' }, rightKids),
    ];
    container.appendChild(el('div', { class: cls.join(' '), 'data-turn-text': turnText }, [
      el('div', { class: 'territory-head' }, headKids),
      el('div', { class: 'territory-cards' },
        p.palette.length === 0
          ? [el('span', { class: 'empty-hint', text: '调色盘为空' })]
          : (() => {
              const effRule = effectiveRuleIndex(G);
              const keyIds = new Set(ruleKeyCards(effRule, p.palette).map((k) => k.id));
              const keyColor = RED7_COLORS[effRule].color;
              return p.palette.map((c) => {
                const isKey = !eliminated && keyIds.has(c.id);
                return red7CardNode(c, { mini: true, dimmed: eliminated, key: isKey, keyColor, soft: !eliminated && !isKey });
              });
            })(),
      ),
    ]));
  }
}

/** 手牌：仅当前回合玩家可点选。 */
function renderRed7Hand(G, playerID, isMyTurn) {
  const container = $('#hand');
  container.innerHTML = '';
  // 手牌区标题右侧小字：摸牌堆剩余张数
  const handLabel = document.querySelector('.section-label-hand');
  if (handLabel) {
    handLabel.innerHTML = '';
    handLabel.appendChild(el('span', { text: '手牌区' }));
    handLabel.appendChild(el('span', { class: 'section-label-sub', style: 'margin-left: auto;', text: `摸牌堆 ${G.deck} 张` }));
  }
  const me = G.players[playerID];
  if (!me || !Array.isArray(me.hand)) {
    container.appendChild(el('div', { class: 'r7-hint', text: '等待其他玩家行动...' }));
    return;
  }
  if (me.hand.length === 0) {
    container.appendChild(el('div', { class: 'r7-hint', text: isMyTurn ? '手牌已空，回合开始将自动出局' : '手牌为空' }));
    return;
  }
  me.hand.forEach((card, idx) => {
    container.appendChild(red7CardNode(card, {
      selected: selectedIndex === idx,
      onClick: isMyTurn ? () => {
        // 打出 5 后强制续打：直接点击手牌即打出，无需选中再点按钮
        if (G.mustPlay) {
          client.moves.playCard(idx);
          resetRed7Selection();
        } else {
          selectedIndex = (selectedIndex === idx ? null : idx);
          renderGame(currentState);
        }
      } : undefined,
    }));
  });
}

/** 进阶规则待结算面板：打出1（选其他玩家牌）或打出7（弃自己调色盘牌）。 */
function renderRed7PendingPanel(state) {
  const { G, playerID } = state;
  const panel = $('#play-panel');
  panel.innerHTML = '';
  const nicknames = nicknameMap();
  const pending = G.pending;

  if (pending.type === 'action1') {
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-forced', text: '打出 1：选择其他玩家调色盘中的 1 张牌（置于抽牌堆顶部）。' }));
    const others = G.playOrder.filter(
      (id) => id !== playerID && !G.players[id].eliminated && G.players[id].palette.length > 0,
    );
    for (const id of others) {
      const palette = G.players[id].palette;
      panel.appendChild(el('div', { class: 'dest-row' }, [
        el('span', { class: 'dest-title' }, [playerNameNode(id, nicknames)]),
        el('div', { class: 'dest-buttons' }, palette.map((card, idx) => red7CardNode(card, {
          mini: true,
          onClick: () => client.moves.resolveAction1(id, idx),
        }))),
      ]));
    }
  } else if (pending.type === 'action7') {
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-forced', text: '打出 7：弃置 1 张调色盘中的牌（不含本张 7）到画布。' }));
    const me = G.players[playerID];
    const candidates = me.palette
      .map((card, idx) => ({ card, idx }))
      .filter(({ card }) => card.id !== pending.cardId);
    panel.appendChild(el('div', { class: 'dest-buttons' }, candidates.map(({ card, idx }) => red7CardNode(card, {
      mini: true,
      onClick: () => client.moves.resolveAction7(idx),
    }))));
  }
}

/**
 * 新手提示：选中手牌后，预览「打出到调色盘 / 弃置到画布」两种行动的规则效果。
 * 展示数字特效（1/3/5/7）与额外行动、规则切换详情、特殊摸牌判定。
 */
function renderRed7ActionPreview(panel, state, card) {
  const { G, playerID } = state;
  const me = G.players[playerID];
  const canPlay = !G.turnPlayed || G.mustPlay;
  const canDiscard = !G.turnDiscarded;
  const paletteCount = me.palette.length;
  // playerView 后 deck 为张数（数字）
  const deckCount = typeof G.deck === 'number' ? G.deck : 0;

  // —— 打出到调色盘：数字特效 / 额外行动 ——
  const playLines = [];
  if (canPlay) {
    if (card.number === 1) {
      const hasTarget = G.playOrder.some(
        (id) => id !== playerID && !G.players[id].eliminated && G.players[id].palette.length > 0,
      );
      playLines.push(hasTarget
        ? el('div', { class: 'r7-preview-line r7-preview-fx', text: '触发数字1特效：须选其他玩家调色盘中的 1 张牌，置于摸牌堆顶。' })
        : el('div', { class: 'r7-preview-line', text: '数字1特效：其他玩家调色盘均无牌，无实际效果。' }));
    } else if (card.number === 3) {
      playLines.push(deckCount > 0
        ? el('div', { class: 'r7-preview-line r7-preview-fx', text: '触发数字3特效：额外摸 1 张牌。' })
        : el('div', { class: 'r7-preview-line', text: '数字3特效：摸牌堆已空，无法摸牌。' }));
    } else if (card.number === 5) {
      playLines.push(me.hand.length - 1 > 0
        ? el('div', { class: 'r7-preview-line r7-preview-fx', text: '触发数字5特效：额外行动，必须继续打出 1 张牌。' })
        : el('div', { class: 'r7-preview-line', text: '数字5特效：打出后已无手牌，无需续打。' }));
    } else if (card.number === 7) {
      playLines.push(paletteCount > 0
        ? el('div', { class: 'r7-preview-line r7-preview-fx', text: '触发数字7特效：须弃置调色盘中 1 张牌（不含本张）到画布改规则。' })
        : el('div', { class: 'r7-preview-line', text: '数字7特效：调色盘无其他牌，无实际效果。' }));
    } else {
      playLines.push(el('div', { class: 'r7-preview-line', text: `数字${card.number}无特效，打出后不触发额外行动。` }));
    }
  } else {
    playLines.push(el('div', { class: 'r7-preview-line', text: '本回合已打出过，每回合限 1 次。' }));
  }

  // —— 弃置到画布：规则切换详情 / 特殊摸牌 ——
  const discardLines = [];
  if (canDiscard) {
    const rule = RED7_COLORS[card.colorIndex];
    discardLines.push(el('div', { class: 'r7-preview-line', text: `规则切换为「${rule.name}：${rule.rule}」。` }));
    if (card.number > paletteCount) {
      discardLines.push(deckCount > 0
        ? el('div', { class: 'r7-preview-line r7-preview-draw', text: `触发特殊摸牌：点数 ${card.number} > 调色盘 ${paletteCount} 张 → 摸 1 张牌。` })
        : el('div', { class: 'r7-preview-line', text: `点数 ${card.number} > 调色盘 ${paletteCount} 张，但摸牌堆已空，无法摸牌。` }));
    } else {
      discardLines.push(el('div', { class: 'r7-preview-line', text: `点数 ${card.number} ≤ 调色盘 ${paletteCount} 张，不满足特殊摸牌条件。` }));
    }
  } else {
    discardLines.push(el('div', { class: 'r7-preview-line', text: '本回合已弃牌到画布，每回合限 1 次。' }));
  }

  const previewSection = (title, ok, lines) => el('div', {
    class: `r7-tip-section ${ok ? '' : 'r7-tip-section-off'}`,
  }, [
    el('div', { class: 'r7-preview-title' }, [
      el('span', { text: title }),
      el('span', { class: `r7-preview-state ${ok ? 'r7-preview-state-ok' : 'r7-preview-state-off'}`, text: ok ? '可用' : '不可用' }),
    ]),
    ...lines,
  ]);

  // 合并为单个「游戏小tip」卡片：头部 + 两个行动小节
  panel.appendChild(el('div', {
    class: 'r7-tip',
    style: `--c:${RED7_COLORS[card.colorIndex].color}`,
  }, [
    el('div', { class: 'r7-tip-head', text: `游戏小tip · ${red7CardLabel(card)}` }),
    el('div', { class: 'r7-tip-body' }, [
      previewSection('打出到调色盘', canPlay, playLines),
      previewSection('弃置到画布', canDiscard, discardLines),
    ]),
  ]));
}

/** 行动面板：打出到调色盘 / 弃置到画布 / 结束回合；超出使用次数或未选牌则置灰；含进阶规则待结算与「必须继续打」。 */
function renderRed7PlayPanel(state) {
  const { G, ctx, playerID } = state;
  const panel = $('#play-panel');
  panel.innerHTML = '';

  // 强制行动（打出 5 须续打 / 打出 1、7 待结算）：面板脉冲强调，并在出现时自动滚动定位
  const forced = !G.ended && ctx.currentPlayer === playerID && !!(G.pending || G.mustPlay);
  panel.classList.toggle('r7-forced', forced);
  if (forced && !prevForcedAction) {
    requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  prevForcedAction = forced;

  if (G.results) return;

  const isMyTurn = ctx.currentPlayer === playerID;
  if (!isMyTurn) {
    panel.appendChild(el('div', { class: 'r7-hint', text: '等待其他玩家行动...' }));
    return;
  }

  // 进阶规则：待结算效果
  if (G.pending) {
    renderRed7PendingPanel(state);
    return;
  }

  const me = G.players[playerID];
  const hand = Array.isArray(me.hand) ? me.hand : [];
  const played = G.turnPlayed;
  const discarded = G.turnDiscarded;
  const mustPlay = G.mustPlay;

  // 打出 5 后强制续打：不显示操作按钮，直接点击手牌即可打出
  if (mustPlay) {
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-forced', text: '打出 5：必须继续打出 1 张牌，请直接点击手牌。' }));
    return;
  }

  const hasSel = selectedIndex != null && selectedIndex < hand.length;
  const canPlay = hasSel && (!played || mustPlay);
  const canDiscard = hasSel && !discarded;
  const canEnd = !mustPlay;

  // 建议结束回合：已处于优胜，或本回合打出/弃置次数均已用完（仅剩结束回合可操作）
  const winning = computeWinningIds(G).includes(playerID);
  const noMoreOps = played && discarded && !mustPlay;
  const suggestEnd = !mustPlay && (winning || noMoreOps);

  // 三个按钮始终显示，超出使用次数或未选牌则置灰
  const buttons = [
    el('button', {
      class: 'btn btn-sm',
      text: '打出到调色盘',
      disabled: canPlay ? false : 'disabled',
      onClick: () => { client.moves.playCard(selectedIndex); resetRed7Selection(); },
    }),
    el('button', {
      class: 'btn btn-sm',
      text: '弃置到画布',
      disabled: canDiscard ? false : 'disabled',
      onClick: () => { client.moves.discardToCanvas(selectedIndex); resetRed7Selection(); },
    }),
    el('button', {
      class: `btn btn-sm btn-primary ${suggestEnd ? 'btn-end-suggest' : ''}`,
      text: '结束回合',
      disabled: canEnd ? false : 'disabled',
      onClick: () => { client.moves.endTurn(); resetRed7Selection(); },
    }),
  ];

  let hint;
  if (noMoreOps) {
    hint = null; // 无可用操作次数时不再提示选牌（下方有结束回合引导）
  } else if (hand.length === 0) {
    hint = '手牌已空，可结束回合。';
  } else if (!hasSel) {
    hint = '请先点击选择一张手牌。';
  } else {
    hint = `已选：${red7CardLabel(hand[selectedIndex])}。选择行动：`;
  }
  if (mustPlay) hint = `打出 5：必须继续打出 1 张牌。 ${hint || ''}`;

  if (hint) panel.appendChild(el('div', { class: `r7-hint ${mustPlay ? 'r7-hint-forced' : ''}`, text: hint }));

  // 建议结束回合的引导提示
  if (suggestEnd) {
    const tip = noMoreOps
      ? '本回合已无其他可用操作，点击「结束回合」进入下一位玩家。'
      : '你已处于优胜状态，点击「结束回合」保住领先。';
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-suggest', text: tip }));
  }
  // 新手提示：选中手牌后展示两种行动的规则效果预览
  if (hasSel) renderRed7ActionPreview(panel, state, hand[selectedIndex]);
  panel.appendChild(el('div', { class: 'dest-row' }, buttons));
}

/** 结算：仅显示获胜者。 */
function renderRed7Gameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const nicknames = nicknameMap();
  box.style.display = 'block';
  box.innerHTML = '';
  box.appendChild(el('h2', { text: '本轮结束' }));
  box.appendChild(el('p', { class: 'go-summary' }, [
    el('span', { text: '获胜者：' }),
    ...G.results.winners.flatMap((w, i) => (i === 0
      ? [playerNameNode(w, nicknames)]
      : [el('span', { text: '、' }), playerNameNode(w, nicknames)])),
  ]));
  box.appendChild(backToLobbyButton());
}

/** Red7 统一渲染。 */
function renderRed7(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  const taskPanel = $('#task-panel');
  if (taskPanel) taskPanel.style.display = 'none';
  renderRed7Header(G);
  renderRed7RuleArea(G);
  renderRed7Players(G, ctx, playerID);
  renderRed7Hand(G, playerID, !G.ended && ctx.currentPlayer === playerID && !G.pending);
  renderRed7PlayPanel(state);
  renderLog(G);
  renderRed7Gameover(G);
}

// ---------- 渲染分发 ----------

/**
 * 各游戏的渲染函数（按 game.name 注册）。
 * 新增游戏时，在此把 game.name 映射到对应的渲染函数即可。
 */
const GAME_RENDERERS = {
  [QuancGame.name]: renderQuanc,
  [Red7Game.name]: renderRed7,
};

/** 按当前对局的游戏分发渲染。 */
function renderGame(state) {
  const fn = currentGame && GAME_RENDERERS[currentGame.game.name];
  if (fn) fn(state);
}

// ---------- 房间等待界面 ----------

/**
 * 渲染房间等待界面。
 * 座位昵称 / 在线状态来自 boardgame.io 推送的 client.matchData；
 * 「准备」状态来自游戏状态 G.lobby.ready。
 */
function renderLobby(state) {
  $('#room-match-id').textContent = currentMatchID || '-';

  const seatsEl = $('#room-seats');
  const countEl = $('#room-count');
  const actionEl = $('#room-action');
  const statusEl = $('#room-status');
  seatsEl.innerHTML = '';
  actionEl.innerHTML = '';
  statusEl.textContent = '';

  const matchData = client ? client.matchData : null;
  if (!state || !matchData) {
    countEl.textContent = '正在连接房间…';
    seatsEl.appendChild(el('div', { class: 'empty-hint', text: '正在与服务器同步房间信息…' }));
    return;
  }

  const seats = [...matchData].sort((a, b) => a.id - b.id);
  const total = seats.length;
  const readyMap = (state.G && state.G.lobby && state.G.lobby.ready) || {};
  const filledSeats = seats.filter(s => s.name);
  const joined = filledSeats.length;
  // 房间固定 5 个座位，只需检查已加入的玩家：2 人以上且全员在线、就位即可开局
  const allOnline = filledSeats.every(s => s.isConnected === true);
  const allReady = filledSeats.every(s => readyMap[String(s.id)]);
  const canStart = joined >= 2 && allOnline && allReady;
  const isHost = roomInfo && roomInfo.playerID === '0';

  countEl.textContent = `玩家 ${joined}/${total} · ${canStart ? '全员就位，可以开局' : joined < 2 ? '至少 2 人开局' : '等待就位'}`;

  seats.forEach(s => {
    const filled = Boolean(s.name);
    const online = s.isConnected === true;
    const ready = Boolean(readyMap[String(s.id)]);
    const isMe = roomInfo && String(s.id) === roomInfo.playerID;
    const cls = ['seat'];
    if (filled) cls.push('seat-filled');
    else cls.push('seat-empty');
    if (online) cls.push('online');
    if (ready) cls.push('ready');

    const badges = [];
    if (s.id === 0) badges.push(el('span', { class: 'badge badge-host', text: '房主' }));
    if (isMe) badges.push(el('span', { class: 'badge badge-me', text: '你' }));

    let stateText = '空位 · 等待加入';
    if (filled) stateText = ready ? (online ? '已就位' : '已准备 · 重连中…') : '准备中…';

    seatsEl.appendChild(el('div', { class: cls.join(' ') }, [
      el('div', { class: 'seat-head' }, [
        el('span', { class: 'seat-no player-tag' }, [el('span', { text: '座位' }), playerNoBadge(s.id)]),
        ...badges,
      ]),
      el('div', { class: 'seat-name', text: filled ? s.name : '虚位以待' }),
      el('div', { class: `seat-state ${online ? 'is-online' : ''}` }, [
        el('span', { class: `dot ${online ? 'dot-on' : filled ? 'dot-off' : 'dot-empty'}` }),
        el('span', { text: stateText }),
      ]),
    ]));
  });

  if (joined < 2) {
    actionEl.appendChild(el('div', {
      class: 'room-hint',
      text: isHost
        ? `至少还需 ${2 - joined} 名玩家，把对局 ID 发给好友加入吧。`
        : `等待其他玩家加入…（${joined}/${total}，至少 2 人开局）`,
    }));
  } else if (!allOnline) {
    actionEl.appendChild(el('div', { class: 'room-hint', text: '有玩家连接中断，等待重新连接…' }));
  } else if (!allReady) {
    actionEl.appendChild(el('div', { class: 'room-hint', text: '玩家准备中…' }));
  } else if (isHost) {
    actionEl.appendChild(el('button', {
      class: 'btn btn-primary btn-start',
      text: '开始游戏',
      onClick: () => {
        try {
          client.moves.startGame();
        } catch (e) {
          statusEl.textContent = `无法开始：${e.message}`;
        }
      },
    }));
  } else {
    actionEl.appendChild(el('div', { class: 'room-hint room-ready-hint', text: '全部玩家已就位，等待房主开始游戏…' }));
  }
}

// ---------- 会话持久化（刷新不退出） ----------

/** 保存当前房间与座位信息，供刷新后恢复。 */
function saveSession() {
  if (!roomInfo) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      ...roomInfo,
      playerName: currentPlayerName,
      game: gameName(),
    }));
  } catch {
    // 存储不可用时静默降级：仅本次刷新无法自动恢复，不影响正常游戏
  }
}

/** 读取已保存的房间与座位信息；缺失或格式异常时返回 null。 */
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.matchID || saved.playerID == null || !saved.credentials || !saved.game) return null;
    return saved;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // 忽略存储异常
  }
}

/**
 * 刷新后恢复上次的房间与座位：凭本地保存的凭证重连，避免退回首页。
 * 仅当对局仍存在、且座位仍属于本玩家（未被服务端释放）时才恢复。
 * @returns {Promise<boolean>} 是否恢复成功
 */
async function restoreSession() {
  const saved = loadSession();
  if (!saved) return false;

  const game = getGame(saved.game);
  if (!game) {
    clearSession();
    return false;
  }
  currentGame = game;

  const status = $('#library-status');
  const goneMsg = '上次的对局已结束，请重新选择游戏并创建或加入。';
  const abort = () => {
    clearSession();
    status.textContent = goneMsg;
    return false;
  };

  status.textContent = '正在恢复上次的对局…';

  let data;
  try {
    const res = await fetch(`${API_BASE}/games/${gameName()}/${saved.matchID}`);
    if (!res.ok) return abort(); // 房间已被销毁
    data = await res.json();
  } catch {
    return abort();
  }

  // 座位被释放（玩家已离开房间，服务端会清掉座位昵称），
  // 或对局 ID 被复用后落到他人座位（昵称不符）时，均不再恢复。
  const seat = (Array.isArray(data.players) ? data.players : [])
    .find(p => p && String(p.id) === String(saved.playerID));
  if (!seat || !seat.name || (saved.playerName && seat.name !== saved.playerName)) return abort();

  currentPlayerName = saved.playerName || '';
  $('#player-name').value = currentPlayerName;
  status.textContent = '';
  enterRoom(saved.matchID, saved.playerID, saved.credentials, saved.playerName);
  return true;
}

// ---------- 游戏库：选择游戏 ----------

/** 渲染游戏库卡片网格。 */
function renderLibrary() {
  const grid = $('#game-grid');
  grid.innerHTML = '';
  for (const g of GAMES) {
    grid.appendChild(el('div', {
      class: 'game-card',
      style: `--c:${g.color}`,
      role: 'button',
      tabindex: '0',
      onClick: () => selectGame(g),
    }, [
      el('div', { class: 'game-card-icon', text: g.icon }),
      el('div', { class: 'game-card-body' }, [
        el('div', { class: 'game-card-title', text: g.title }),
        el('div', { class: 'game-card-tagline', text: g.tagline }),
        el('div', { class: 'game-card-desc', text: g.description }),
      ]),
    ]));
  }
}

/** 按需加载游戏专属 CSS（base.css 已静态引入，游戏 CSS 首次需要时动态注入；带版本号防浏览器缓存）。 */
function ensureGameCSS(game) {
  const css = game && game.css;
  if (!css || loadedCSS.has(css)) return;
  loadedCSS.add(css);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${css}?v=${CSS_VERSION}`;
  document.head.appendChild(link);
}

/** 按当前游戏把对应的 <template> 注入到游戏界面容器。 */
function mountGameTemplate(game) {
  const body = $('#game-body');
  if (!body) return;
  body.innerHTML = '';
  const tpl = game && game.template ? document.getElementById(game.template) : null;
  if (tpl) body.appendChild(tpl.content.cloneNode(true));
}

/** 选中某个游戏，进入其创建 / 加入界面。 */
function selectGame(game) {
  currentGame = game;
  ensureGameCSS(game);
  $('#setup-status').textContent = '';
  renderSetupHeader();
  showSetupScreen();
}

/** 根据当前选中的游戏刷新设置界面标题。 */
function renderSetupHeader() {
  const g = currentGame;
  $('#setup-game-title').textContent = g ? g.title : '选择游戏';
  $('#setup-game-subtitle').textContent = g ? g.tagline : '';
  const hint = $('#setup-hint');
  if (hint) {
    hint.textContent = `提示：创建房间后，把对局 ID 发给好友；好友粘贴 ID 即可加入（自动分配空座位）。${playerRange()}就位后，由房主开始游戏。可在多个浏览器标签页加入同一房间模拟多名玩家。`;
  }
}

// ---------- 进入房间 / 切换界面 ----------

function showLibraryScreen() {
  inGameScreen = false;
  $('#setup').style.display = 'none';
  $('#lobby').style.display = 'none';
  $('#game').style.display = 'none';
  $('#library').style.display = 'block';
  renderLibrary();
}

function showSetupScreen() {
  inGameScreen = false;
  $('#library').style.display = 'none';
  $('#lobby').style.display = 'none';
  $('#game').style.display = 'none';
  $('#setup').style.display = 'block';
}

function showLobbyScreen() {
  inGameScreen = false;
  $('#library').style.display = 'none';
  $('#setup').style.display = 'none';
  $('#game').style.display = 'none';
  $('#lobby').style.display = 'block';
  const subtitle = $('#lobby-subtitle');
  if (subtitle) subtitle.textContent = `${playerRange()}就位后，由房主开始游戏`;
}

function showGameScreen() {
  if (!inGameScreen) {
    inGameScreen = true;
    resetRed7Selection();
    mountGameTemplate(currentGame);
    $('#library').style.display = 'none';
    $('#setup').style.display = 'none';
    $('#lobby').style.display = 'none';
    $('#game').style.display = 'block';
  }
  $('#game-title').textContent = currentGame ? currentGame.title : '';
  $('#match-id').textContent = currentMatchID;
  // 进行中仅房主（座位 0）可结束；本局结束后所有玩家都可返回房间大厅
  const isHost = !!roomInfo && roomInfo.playerID === '0';
  const isGameover = !!(currentState && currentState.G && currentState.G.results);
  $('#end-game-btn').style.display = (isHost || isGameover) ? '' : 'none';
  $('#end-game-btn').textContent = isGameover ? '回到房间' : '结束游戏';
}

/** 创建 / 加入成功后进入房间：立刻建立游戏连接，在大厅阶段等待房主开始。 */
function enterRoom(matchID, playerID, credentials, playerName) {
  ensureGameCSS(currentGame); // 覆盖创建/加入/会话恢复所有路径
  roomInfo = { matchID, playerID, credentials };
  if (playerName) currentPlayerName = playerName;
  saveSession(); // 记录会话，刷新后可自动恢复
  inGameScreen = false;
  currentState = null;
  resetGameUIState();
  currentMatchID = matchID;
  showLobbyScreen();
  renderLobby(null);

  client = Client({
    game: currentGame.game,
    matchID,
    playerID,
    credentials,
    multiplayer: SocketIO({ server: `${window.location.hostname}:${window.location.port}` }),
    // 关闭 boardgame.io 内置调试面板（Controls/Players/Moves/G/ctx）
    debug: false,
  });

  client.subscribe(state => {
    if (!state) {
      // 尚未完成首次同步
      showLobbyScreen();
      renderLobby(null);
      return;
    }

    const view = { ...state, playerID };
    currentState = view;
    const phase = state.ctx && state.ctx.phase;

    if (phase === 'play' || state.ctx.gameover) {
      // 房主已开始游戏（或游戏已结束）：进入游戏界面
      showGameScreen();
      renderGame(view);
      return;
    }

    // 回到大厅阶段（进入房间 / 本局结束返回房间）：重置单局界面状态
    resetGameUIState();
    // 大厅阶段：以服务端状态为准自动准备（幂等，且可在丢包/竞争时重发）
    if (state.isConnected && view.G?.lobby && !view.G.lobby.ready[roomInfo.playerID]) {
      client.moves.lobbyReady();
    }
    showLobbyScreen();
    renderLobby(view);
  });

  client.start();
}

/** 断开当前游戏连接并回到游戏库。 */
function resetToLibrary(message) {
  if (client) {
    client.stop();
    client = null;
  }
  currentState = null;
  currentGame = null;
  resetRed7Selection();
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
  currentMatchID = null;
  roomInfo = null;
  inGameScreen = false;
  clearSession(); // 主动离开后不再自动恢复

  // 清空游戏界面残留（模板内元素可能尚未注入，需空值安全）
  for (const sel of ['#players', '#table', '#log', '#hand', '#play-panel', '#task-panel', '#gameover', '#room-seats', '#room-action', '#game-body']) {
    const node = $(sel);
    if (node) node.innerHTML = '';
  }
  $('#gameover').style.display = 'none';
  $('#deck-info').textContent = '';
  $('#match-id').textContent = '-';
  $('#copy-match-btn').textContent = '复制';
  $('#room-copy-btn').textContent = '复制邀请';
  $('#room-count').textContent = '';

  showLibraryScreen();
  $('#library-status').textContent = message || '';
}

// ---------- 设置界面事件 ----------

function bindSetupEvents() {
  $('#back-to-library').addEventListener('click', () => {
    currentGame = null;
    showLibraryScreen();
  });

  $('#create-btn').addEventListener('click', async () => {
    const playerName = $('#player-name').value.trim();
    const status = $('#setup-status');
    if (!playerName) {
      status.textContent = '请先填写昵称';
      return;
    }
    status.textContent = '正在创建房间…';
    try {
      const matchID = await createMatch();
      const { playerID, credentials } = await joinMatch(matchID, playerName, 0);
      status.textContent = '';
      enterRoom(matchID, playerID, credentials, playerName);
    } catch (e) {
      status.textContent = `创建失败：${e.message}`;
    }
  });

  $('#join-btn').addEventListener('click', async () => {
    const matchID = $('#join-match').value.trim();
    const playerName = $('#player-name').value.trim();
    const status = $('#setup-status');
    if (!playerName) {
      status.textContent = '请先填写昵称';
      return;
    }
    if (!matchID) {
      status.textContent = '请输入对局 ID';
      return;
    }
    status.textContent = '正在加入房间…';
    try {
      // 不传座位号：由服务端自动分配第一个空座位
      const { playerID, credentials } = await joinMatch(matchID, playerName);
      status.textContent = '';
      $('#join-match').value = matchID;
      enterRoom(matchID, playerID, credentials, playerName);
    } catch (e) {
      status.textContent = `加入失败：${e.message}`;
    }
  });
}

/** 同步兜底复制（剪贴板 API 不可用或失败时使用）。 */
function copyViaTextarea(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/** 复制文本，并在按钮上给出短暂反馈。 */
async function copyText(text, btn, originalLabel) {
  if (btn) btn.textContent = '已复制';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      copyViaTextarea(text);
    }
  } catch {
    copyViaTextarea(text);
  }
  if (btn) setTimeout(() => { btn.textContent = originalLabel; }, 1200);
}

/** 房间等待界面事件：复制对局 ID、离开房间。 */
function bindRoomEvents() {
  $('#room-copy-btn').addEventListener('click', () => {
    if (currentMatchID) copyText(currentMatchID, $('#room-copy-btn'), '复制邀请');
  });

  $('#room-leave-btn').addEventListener('click', async () => {
    if (!window.confirm('确定要离开房间吗？')) return;
    const info = roomInfo;
    if (info) await leaveMatch(info.matchID, info.playerID, info.credentials).catch(() => {});
    resetToLibrary('你已离开房间，可返回游戏库重新选择游戏。');
  });
}

/** 游戏页事件：复制对局 ID、结束本局 / 回到房间（清空本局信息，全员退回大厅，房间可复用）。 */
function bindGameEvents() {
  $('#copy-match-btn').addEventListener('click', () => {
    if (currentMatchID) copyText(currentMatchID, $('#copy-match-btn'), '复制');
  });

  $('#end-game-btn').addEventListener('click', () => {
    // 本局已自然结束：任意玩家点击均可让全员回到房间大厅（可开始新一局）
    const isGameover = !!(currentState && currentState.G && currentState.G.results);
    if (isGameover) {
      client.moves.backToLobby();
      return;
    }
    // 进行中：仅房主可结束，并通过 move 广播给所有玩家统一返回房间大厅
    if (!roomInfo || roomInfo.playerID !== '0') return;
    if (!window.confirm('确定要结束本局吗？本局信息将被清除且不做结算，所有玩家将回到房间大厅。')) return;
    client.moves.backToLobby();
  });
}

async function init() {
  bindSetupEvents();
  bindRoomEvents();
  bindGameEvents();
  // 默认展示游戏库
  showLibraryScreen();
  // 刷新页面后自动回到上次的房间 / 对局（无有效会话则留在游戏库）
  await restoreSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
