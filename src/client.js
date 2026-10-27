/**
 * src/client.js
 * 前端客户端（原生 JS，经 esbuild 打包后供浏览器使用）。
 */

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { QuancGame, computeFamilyFates, pLabel, getTask } from './quanc.js';
import { Red7Game, RED7_COLORS, computeWinningIds, ruleKeyCards, effectiveRuleIndex } from './red7.js';
import { RegicideGame, RG_SUITS, rgDiscardValue } from './regicide.js';
import {
  PresagesGame,
  PRESAGES_COLOR_META,
  PRESAGES_TEAM_COLORS,
  PRESAGES_TEAM_SYMBOLS,
  presagesResolutionPreview,
} from './presages.js';
import { GAMES, getGame } from './games.js';
import { FAMILIES, getFamily } from './quanc-cards.js';
import { FAMILY_ICONS, TYPE_ICONS, BACK_EMBLEM, PRESAGES_TIMING_ICONS } from './quanc-icons.js';

const API_BASE = `${window.location.protocol}//${window.location.host}`;
/** 会话存储键：保存当前房间与座位凭证，用于刷新后自动恢复。 */
const SESSION_KEY = 'quanc_session';

let client = null;
let currentState = null;     // 最近一次渲染所用的状态
let currentGame = null;      // 当前选中的游戏条目（registry 中的元数据 + game 对象）
let selectedIndex = null;    // 当前选中的手牌索引
let pendingPick = null;      // pending 结算中选中的牌 { type: 'action1'|'action7', targetPlayerID?, paletteIndex }
let prevForcedAction = false; // 上一帧是否处于强制行动（用于自动定位只触发一次）
let currentMatchID = null;   // 当前对局 ID（用于展示与复制）
let roomInfo = null;         // 当前房间信息 { matchID, playerID, credentials }
let inGameScreen = false;    // 当前是否已切换到游戏界面
let currentPlayerName = '';  // 当前玩家昵称（用于恢复会话时回填）
let seenCardIds = new Set(); // 已出现过的卡牌 id，用于给新牌播放进入动画
let prevEnded = false;       // 上一帧是否已结束（用于一次性触发翻牌/得分滚动）
let justEnded = false;       // 本帧是否为游戏结束瞬间
let prevCardLocations = new Map(); // 上一帧的「卡牌 id → 逻辑位置」映射，用于 diff 出移动/新增/消失以播放飞行动画
const loadedCSS = new Set(); // 已动态加载的游戏 CSS 路径（去重）
const CSS_VERSION = '55';     // CSS 版本号：样式更新时递增，防止浏览器缓存旧样式
let rgSelected = [];         // Regicide 手牌多选索引（连招 / 承伤弃牌共用）
let prevRgForced = false;    // Regicide 上一帧是否处于强制结算（用于自动定位只触发一次）
let psSelected = null;       // Presages 当前选中的手牌索引
let psDreamTarget = '';      // Presages 《梦》的放置目标（空串表示打在自己面前）
let endTurnHintTimer = null;  // 结束回合闲置提示的定时器
let endTurnHintEl = null;     // 结束回合提示浮层 DOM

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
  const attrs = { class: cls.join(' '), style: `--c:${f.color}`, 'data-card-id': card.id };
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
      'data-card-id': card.id,
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
  const attrs = { class: cls.join(' '), style: `--c:${f.color}`, title, 'data-card-id': card.id };
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
      'data-player-id': id, // 刺客结算时按座位定位领地容器
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
  // data-zone 用于刺客结算时定位目标区域行
  const cardsRow = (zoneKey, sideText, sideCls) =>
    el('div', { class: 'board-row', 'data-zone': zoneKey }, [
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
        el('span', { class: 'fate-badge board-head-sub', text: '' }),
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
  // 手牌区标题右侧小字：摸牌堆剩余张数
  const handLabel = document.querySelector('.section-label-hand');
  if (handLabel) {
    handLabel.innerHTML = '';
    handLabel.appendChild(el('span', { text: '手牌区' }));
    handLabel.appendChild(el('span', { class: 'section-label-sub', style: 'margin-left: auto;', text: `摸牌堆 ${G.deck} 张` }));
  }
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

/**
 * 刺客结算面板：展示刺客目标区域的全部卡牌，可点击移除；
 * 也可直接点击场上对应区域的发光牌移除。守卫与刺客自身置灰不可选。
 */
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

  // 可移除目标数：排除刺客自身；守卫免疫；间谍（牌背）同样可被移除
  const removableCount = area.filter(c => c.id !== pending.assassinCardId && c.type !== 'guard').length;

  panel.appendChild(el('div', {
    class: 'assassin-title',
    text: removableCount > 0
      ? `🗡️ 刺客效果：点击下方【${areaName}】的牌将其移除（守卫免疫），或直接点击场上发光的牌。`
      : `🗡️ 刺客效果：【${areaName}】中没有可移除的牌，可选择不发动。`,
  }));

  // 展示目标区域全部卡牌：可移除的牌可点击移除，守卫/刺客自身置灰
  const cardRow = el('div', { class: 'assassin-cards' });
  area.forEach((card, idx) => {
    const isImmune = card.id === pending.assassinCardId || card.type === 'guard';
    const opts = {
      disabled: isImmune || !isActive,
      title: isImmune
        ? (card.type === 'guard' ? '守卫免疫，无法被移除' : '刺客自身不可移除')
        : '点击移除该牌',
    };
    if (!isImmune && isActive) {
      opts.onClick = () => client.moves.resolveAssassin(idx);
    }
    const node = miniCardNode(card, opts);
    if (!isImmune) node.classList.add('assassin-target');
    else node.classList.add('assassin-immune');
    cardRow.appendChild(node);
  });
  panel.appendChild(cardRow);

  // 任何情况下都允许不发动
  panel.appendChild(el('button', {
    class: 'btn btn-sm', text: '不发动刺客', disabled: isActive ? false : 'disabled',
    onClick: () => client.moves.resolveAssassin(-1),
  }));
}

/**
 * 刺客待结算且轮到当前玩家时：
 * - 区域内可移除的牌加发光脉冲并绑定点击直接移除（守卫与刺客自身则弱化置灰）；
 * 每次渲染后重挂。
 */
function armAssassinArea(state) {
  const { G, ctx, playerID } = state;
  const pending = G.pendingAssassin;
  const isActive = !G.results && !G.ended && !!pending && ctx.currentPlayer === playerID;
  if (!isActive) return;

  let areaEl = null;
  let area = [];
  if (pending.location.kind === 'territory') {
    areaEl = document.querySelector(`#players .territory[data-player-id="${pending.location.owner}"]`);
    area = (G.players[pending.location.owner] && G.players[pending.location.owner].territory) || [];
  } else {
    areaEl = document.querySelector(`#table .board-row[data-zone="${pending.location.zone}"]`);
    area = G.table[pending.location.zone] || [];
  }
  if (!areaEl) return;

  // 区域内卡牌按 data-card-id 映射回数组索引，绑定点击 → 直接移除
  const indexById = new Map(area.map((c, i) => [c.id, i]));
  for (const node of areaEl.querySelectorAll('[data-card-id]')) {
    const idx = indexById.get(node.getAttribute('data-card-id'));
    if (idx == null) continue;
    const card = area[idx];
    if (card.id === pending.assassinCardId || card.type === 'guard') {
      node.classList.add('assassin-immune');
      node.title = card.type === 'guard' ? '守卫免疫，无法被移除' : '刺客自身不可移除';
      continue;
    }
    node.classList.add('assassin-target');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.title = '点击移除该牌';
    const remove = () => client.moves.resolveAssassin(idx);
    node.addEventListener('click', remove);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); remove(); }
    });
  }
}

/** 隐藏并清理「结束回合」闲置提示。 */
function hideEndTurnHint() {
  if (endTurnHintTimer) { clearTimeout(endTurnHintTimer); endTurnHintTimer = null; }
  if (endTurnHintEl) { endTurnHintEl.remove(); endTurnHintEl = null; }
}

/** 弹出「结束回合」轻量提示框（底部浮层，含结束回合按钮与关闭按钮）。 */
function showEndTurnHint() {
  if (endTurnHintEl) return;
  const toast = el('div', { class: 'end-turn-toast' }, [
    el('span', { class: 'end-turn-toast-text', text: '本回合行动已完成，是否结束回合？' }),
    el('button', {
      class: 'btn btn-sm btn-primary', text: '结束回合',
      onClick: () => { client.moves.endTurn(); hideEndTurnHint(); },
    }),
    el('button', { class: 'end-turn-toast-close', text: '×', title: '稍后', onClick: hideEndTurnHint }),
  ]);
  document.body.appendChild(toast);
  endTurnHintEl = toast;
}

function renderPlayPanel(state) {
  const { G, ctx, playerID } = state;
  const isActive = !G.results && ctx.currentPlayer === playerID;
  const panel = $('#play-panel');

  // 刺客待结算属于强制操作：复用全局红色脉冲边框强调
  const forced = isActive && !!G.pendingAssassin;
  panel.classList.toggle('panel-forced', forced);

  // 闲置 5 秒提示结束回合：仅当前回合玩家、无待结算刺客、且本回合行动已用完时触发
  const remaining = G.turnDrawCount - G.turnPlayCount;
  if (isActive && !forced && !G.results && remaining <= 0) {
    if (!endTurnHintTimer) {
      endTurnHintTimer = setTimeout(showEndTurnHint, 5000);
    }
  } else {
    hideEndTurnHint();
  }

  if (G.results) return;

  /** 构建「撤回 / 结束回合」按钮行（当前回合玩家可见） */
  const buildTurnActions = () => {
    const undoUsed = (G.undoCount && G.undoCount[playerID]) || 0;
    const undoLeft = 3 - undoUsed;
    const remaining = G.turnDrawCount - G.turnPlayCount;
    const actions = el('div', { class: 'turn-actions' });
    if (G.turnPlayCount > 0) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm btn-undo',
        text: `↩ 撤回（剩 ${undoLeft} 次）`,
        disabled: undoLeft <= 0 ? 'disabled' : false,
        onClick: () => client.moves.undoTurn(),
      }));
    }
    if (remaining <= 0) {
      actions.appendChild(el('button', {
        class: 'btn btn-sm btn-primary',
        text: '结束回合',
        onClick: () => client.moves.endTurn(),
      }));
    }
    return actions;
  };

  // 有待结算的刺客效果，且仅当前操作玩家可见并结算；其他玩家仅提示等待
  if (forced) {
    renderAssassinPanel(state);
    if (isActive) panel.appendChild(buildTurnActions());
    return;
  }

  panel.innerHTML = '';

  if (!isActive) {
    panel.appendChild(el('div', { class: 'empty-hint', text: '等待其他玩家行动...' }));
    return;
  }

  const me = G.players[playerID];
  const hand = Array.isArray(me.hand) ? me.hand : [];
  if (hand.length === 0) {
    panel.appendChild(el('div', { class: 'empty-hint', text: '本回合出牌已完成。' }));
    panel.appendChild(buildTurnActions());
    return;
  }

  if (selectedIndex == null || selectedIndex >= hand.length) {
    panel.appendChild(el('div', { class: 'empty-hint', text: `本回合还需打出 ${remaining} 张，请先点击一张手牌选择。` }));
    panel.appendChild(buildTurnActions());
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
      text: used.own ? '已执行' : '打到自己领地',
      onClick: () => play('own'),
    }),
  ]));

  panel.appendChild(row('其他玩家领地', others.map(id =>
    el('button', {
      class: 'btn btn-sm', disabled: used.opponent ? 'disabled' : false,
      text: used.opponent ? `玩家 ${pLabel(id)}（已执行）` : `打到玩家 ${pLabel(id)} 领地`,
      onClick: () => play('opponent', id),
    }),
  )));

  panel.appendChild(row('餐桌', [
    el('button', {
      class: 'btn btn-sm btn-favored', disabled: used.table ? 'disabled' : false,
      text: used.table ? '已执行' : '打入得宠区',
      onClick: () => play('table', 'favored'),
    }),
    el('button', {
      class: 'btn btn-sm btn-disfavored', disabled: used.table ? 'disabled' : false,
      text: used.table ? '已执行' : '打入失宠区',
      onClick: () => play('table', 'disfavored'),
    }),
  ]));
  panel.appendChild(buildTurnActions());
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

let gameoverScrolled = false; // 结算面板是否已自动滚动到位（每局仅滚动一次）

/** 本局结算面板首次出现时，自动把玩家视角移到顶部的结束面板。 */
function scrollToGameover(box) {
  if (gameoverScrolled) return;
  gameoverScrolled = true;
  // 等本帧 DOM 写入完成后再滚动，确保面板高度已确定
  requestAnimationFrame(() => {
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/** 构建结算面板中的单个任务 chip（标签 + 名称 + 描述 + 完成状态）。 */
function goTaskChip(label, task, done) {
  if (!task) return null;
  return el('div', { class: `go-task ${done ? 'go-task-done' : ''}` }, [
    el('div', { class: 'go-task-head' }, [
      el('span', { class: 'go-task-label', text: label }),
      el('span', { class: 'go-task-status', text: done ? '✓ +3' : '✗ 未完成' }),
    ]),
    el('div', { class: 'go-task-name', text: task.name }),
    el('div', { class: 'go-task-desc', text: task.desc }),
  ]);
}

function renderGameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    gameoverScrolled = false;
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
    // 展示该玩家的 2 个任务（餐桌 / 领地）及完成状态
    const pTasks = G.players[id] && G.players[id].tasks;
    if (pTasks) {
      const chips = [
        goTaskChip('餐桌任务', getTask('table', pTasks.table), tr && tr.table),
        goTaskChip('领地任务', getTask('territory', pTasks.territory), tr && tr.territory),
      ].filter(Boolean);
      if (chips.length) children.push(el('div', { class: 'go-tasks' }, chips));
    }
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
  scrollToGameover(box);
}

function renderQuanc(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  justEnded = !!G.results && !prevEnded;
  prevEnded = !!G.results;
  const fates = computeFamilyFates(G.table);
  renderPlayers(G, ctx, playerID, fates);
  renderTable(G, fates);
  renderTaskPanel(G, playerID);
  // 有刺客待结算时禁用选牌
  const canPick = !G.ended && ctx.currentPlayer === playerID && !G.pendingAssassin;
  renderHand(G, playerID, canPick);
  renderPlayPanel(state);
  renderLog(G);
  renderGameover(G);
  // 刺客待结算：高亮触发区域并武装可移除牌（须在 DOM 全量重建后执行）
  armAssassinArea(state);
}

// ---------- Red7 渲染 ----------

/** Red7 卡牌文字标签（如「红7」）。 */
function red7CardLabel(card) {
  return `${card.colorName}${card.number}`;
}

/** 清空 Red7 的选中手牌与强制行动标记。 */
function resetRed7Selection() {
  selectedIndex = null;
  pendingPick = null;
  prevForcedAction = false;
}

/** 清空 Regicide 的选中手牌与强制行动标记。 */
function resetRegicideSelection() {
  rgSelected = [];
  prevRgForced = false;
}

/** 清空 Presages 的选中手牌与《梦》放置目标。 */
function resetPresagesSelection() {
  psSelected = null;
  psDreamTarget = '';
}

/** 重置与单局渲染相关的临时状态（进入房间 / 返回房间大厅时调用）。 */
function resetGameUIState() {
  resetRed7Selection();
  resetRegicideSelection();
  resetPresagesSelection();
  hideEndTurnHint();
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
  prevCardLocations = new Map(); // 清空牌位置快照，新一局首次渲染不播放飞行动画
  gameoverScrolled = false; // 新一局允许结算面板再次自动滚动
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
  const attrs = { class: cls.join(' '), style: `--c:${color.color}${key && keyColor ? `;--kc:${keyColor}` : ''}`, 'data-card-id': card.id };
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

/** 画布区：当前生效规则牌 + 7 种颜色规则一览（当前高亮）+ 弃牌堆历史。 */
function renderRed7RuleArea(G) {
  const container = $('#table');
  container.innerHTML = '';
  const rule = RED7_COLORS[G.ruleColorIndex];

  // 区域标题：画布区
  container.appendChild(el('div', { class: 'section-label section-label-canvas' }, [
    el('span', { text: '画布区/规则区' }),
    el('span', { class: 'section-label-sub', text: '弃牌到此改变规则' }),
  ]));

  // 当前生效规则
  const curKids = [
    el('div', { class: 'r7-rule-chip', style: `--c:${rule.color}` }, [
      el('span', { class: 'r7-rule-color', text: rule.name }),
    ]),
    el('div', { class: 'r7-rule-text', text: `${rule.name}规则：${rule.rule}` }),
  ];
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

  // 比较规则提示：点数 7 最大 1 最小，点数相等则按颜色红>橙>黄>绿>青>蓝>紫。
  container.appendChild(el('div', { class: 'r7-rule-hint' }, [
    el('span', { text: '比较卡牌：点数 7 最大、1 最小；点数相等则比颜色，红最大、紫最小。' }),
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
        // 统一「点击选中 → 在行动面板确认」：mustPlay 也先选中，由 tip 框内的按钮确认
        selectedIndex = (selectedIndex === idx ? null : idx);
        renderGame(currentState);
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
        el('div', { class: 'dest-buttons' }, palette.map((card, idx) => {
          const picked = pendingPick && pendingPick.type === 'action1'
            && pendingPick.targetPlayerID === id && pendingPick.paletteIndex === idx;
          return red7CardNode(card, {
            mini: true,
            selected: picked,
            onClick: () => {
              pendingPick = { type: 'action1', targetPlayerID: id, paletteIndex: idx };
              renderGame(currentState);
            },
          });
        })),
      ]));
    }
    // 选中后显示「移除」确认按钮
    if (pendingPick && pendingPick.type === 'action1') {
      panel.appendChild(el('div', { class: 'dest-row' }, [
        el('button', {
          class: 'btn btn-sm btn-primary r7-action-play',
          text: '移除',
          onClick: () => {
            client.moves.resolveAction1(pendingPick.targetPlayerID, pendingPick.paletteIndex);
            pendingPick = null;
          },
        }),
      ]));
    }
  } else if (pending.type === 'action7') {
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-forced', text: '打出 7：弃置 1 张调色盘中的牌（不含本张 7）到画布。' }));
    const me = G.players[playerID];
    const candidates = me.palette
      .map((card, idx) => ({ card, idx }))
      .filter(({ card }) => card.id !== pending.cardId);
    panel.appendChild(el('div', { class: 'dest-buttons' }, candidates.map(({ card, idx }) => {
      const picked = pendingPick && pendingPick.type === 'action7' && pendingPick.paletteIndex === idx;
      return red7CardNode(card, {
        mini: true,
        selected: picked,
        onClick: () => {
          pendingPick = { type: 'action7', paletteIndex: idx };
          renderGame(currentState);
        },
      });
    })));
    // 选中后显示「弃置到画布」确认按钮（本次弃置也可能触发摸牌）
    if (pendingPick && pendingPick.type === 'action7') {
      panel.appendChild(el('div', { class: 'dest-row' }, [
        el('button', {
          class: 'btn btn-sm btn-primary r7-action-play',
          text: '弃置到画布',
          onClick: () => {
            client.moves.resolveAction7(pendingPick.paletteIndex);
            pendingPick = null;
          },
        }),
      ]));
    }
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
  const canDiscard = !G.turnDiscarded && !G.mustPlay;
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

  // 特效提示文案：打出 1/3/5/7 触发特效、弃置点数大于调色盘数触发摸牌
  const playTriggers = [1, 3, 5, 7].includes(card.number);
  const discardDraw = card.number > paletteCount && deckCount > 0;

  // 操作回调（点击即执行，按钮文案已提示将触发的特效）
  const play = () => { client.moves.playCard(selectedIndex); resetRed7Selection(); };
  const discard = () => { client.moves.discardToCanvas(selectedIndex); resetRed7Selection(); };
  const end = () => { client.moves.endTurn(); resetRed7Selection(); };

  // 建议结束回合（结束回合按钮高亮引导）
  const winning = computeWinningIds(G).includes(playerID);
  const noMoreOps = G.turnPlayed && G.turnDiscarded && !G.mustPlay;
  const suggestEnd = !G.mustPlay && (winning || noMoreOps);

  const previewSection = (title, ok, lines, btn) => el('div', {
    class: `r7-tip-section ${ok ? '' : 'r7-tip-section-off'}`,
  }, [
    el('div', { class: 'r7-preview-title' }, [
      el('span', { text: title }),
      el('span', { class: `r7-preview-state ${ok ? 'r7-preview-state-ok' : 'r7-preview-state-off'}`, text: ok ? '可用' : '不可用' }),
    ]),
    ...lines,
    btn,
  ]);

  // 合并为单个「游戏小tip」卡片：头部 + 两个行动小节（内含对应操作按钮）+ 底部结束回合
  panel.appendChild(el('div', {
    class: 'r7-tip',
    style: `--c:${RED7_COLORS[card.colorIndex].color}`,
  }, [
    el('div', { class: 'r7-tip-head', text: `游戏小tip · ${red7CardLabel(card)}` }),
    el('div', { class: 'r7-tip-body' }, [
      previewSection('打出到调色盘', canPlay, playLines, el('button', {
        class: 'btn btn-sm btn-primary r7-action-play',
        text: G.mustPlay ? '确认打出' : playTriggers ? '打出到调色盘（可触发特效）' : '打出到调色盘',
        disabled: canPlay ? false : 'disabled', onClick: play,
      })),
      previewSection('弃置到画布', canDiscard, discardLines, el('button', {
        class: 'btn btn-sm btn-primary r7-action-play',
        text: discardDraw ? '弃置到画布（可摸1张牌）' : '弃置到画布',
        disabled: canDiscard ? false : 'disabled', onClick: discard,
      })),
    ]),
    el('div', { class: 'r7-tip-foot' }, [
      el('button', {
        class: `btn btn-sm btn-primary ${suggestEnd ? 'btn-end-suggest' : ''}`,
        text: '结束回合', disabled: G.mustPlay ? 'disabled' : false, onClick: end,
      }),
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
  panel.classList.toggle('panel-forced', forced);
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

  const hasSel = selectedIndex != null && selectedIndex < hand.length;

  // 建议结束回合：已处于优胜，或本回合打出/弃置次数均已用完（仅剩结束回合可操作）
  const winning = computeWinningIds(G).includes(playerID);
  const noMoreOps = played && discarded && !mustPlay;
  const suggestEnd = !mustPlay && (winning || noMoreOps);

  // 提示文案：mustPlay 下提示必须续打；普通状态下区分未选牌 / 已选牌 / 无操作
  let hint;
  if (mustPlay) {
    hint = hasSel
      ? `已选：${red7CardLabel(hand[selectedIndex])}。点击「确认打出」继续。`
      : '打出 5：必须继续打出 1 张牌，请先点击选择一张手牌。';
  } else if (noMoreOps) {
    hint = null; // 无可用操作次数时不再提示选牌（下方有结束回合引导）
  } else if (hand.length === 0) {
    hint = '手牌已空，可结束回合。';
  } else if (!hasSel) {
    hint = '请先点击选择一张手牌。';
  } else {
    hint = `已选：${red7CardLabel(hand[selectedIndex])}。`;
  }

  if (hint) panel.appendChild(el('div', { class: `r7-hint ${mustPlay ? 'r7-hint-forced' : ''}`, text: hint }));

  // 建议结束回合的引导提示
  if (suggestEnd) {
    const tip = noMoreOps
      ? '本回合已无其他可用操作，点击「结束回合」进入下一位玩家。'
      : '你已处于优胜状态，点击「结束回合」保住领先。';
    panel.appendChild(el('div', { class: 'r7-hint r7-hint-suggest', text: tip }));
  }

  if (hasSel && !noMoreOps) {
    // 选中手牌：tip 框内展示两种行动的规则效果预览与对应操作按钮（含结束回合）
    renderRed7ActionPreview(panel, state, hand[selectedIndex]);
  } else if (!mustPlay) {
    // 未选牌或已无其他操作：保留「结束回合」按钮（不依赖选牌）
    panel.appendChild(el('div', { class: 'dest-row' }, [
      el('button', {
        class: `btn btn-sm btn-primary ${suggestEnd ? 'btn-end-suggest' : ''}`,
        text: '结束回合',
        onClick: () => { client.moves.endTurn(); resetRed7Selection(); },
      }),
    ]));
  }
}

/** 结算：仅显示获胜者。 */
function renderRed7Gameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    gameoverScrolled = false;
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
  scrollToGameover(box);
}

/** Red7 统一渲染。 */
function renderRed7(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  const taskPanel = $('#task-panel');
  if (taskPanel) taskPanel.style.display = 'none';
  renderRed7RuleArea(G);
  renderRed7Players(G, ctx, playerID);
  renderRed7Hand(G, playerID, !G.ended && ctx.currentPlayer === playerID && !G.pending);
  renderRed7PlayPanel(state);
  renderLog(G);
  renderRed7Gameover(G);
}

// ---------- Regicide 渲染 ----------

/** Regicide 卡牌文字标签。 */
function rgCardLabel(card) {
  return card.isJoker ? '小丑' : `${card.suitName}${card.rank}`;
}

/** Regicide 卡牌节点：点数 + 花色（mini 用于弃牌堆 / 战利品）。 */
function rgCardNode(card, { mini = false, selected = false, dimmed = false, onClick = undefined } = {}) {
  const cls = ['rg-card'];
  if (mini) cls.push('rg-card-mini');
  if (selected) cls.push('rg-card-selected');
  if (dimmed) cls.push('rg-card-dimmed');
  if (card.isJoker) cls.push('rg-card-joker');
  if (!onClick) cls.push('rg-card-static');
  const attrs = { class: cls.join(' '), style: `--c:${card.color || '#777'}`, 'data-card-id': card.id };
  if (onClick) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }
  const kids = card.isJoker
    ? [el('div', { class: 'rg-num', text: '🃏' }), el('div', { class: 'rg-suit', text: '小丑' })]
    : [el('div', { class: 'rg-num', text: card.rank }), el('div', { class: 'rg-suit', text: `${card.symbol} ${card.suitName}` })];
  return el('div', attrs, kids);
}

/** 客户端预估本回合打出所选牌的总伤害（免疫只挡技能不挡伤害 + 梅花双倍），与服务端逻辑一致。 */
function rgPreviewDamage(G, cards) {
  if (!G.enemy) return 0;
  const immune = G.jokerUsed ? null : G.enemy.suit;
  let damage = 0;
  let hasClub = false;
  for (const c of cards) {
    if (c.isJoker) continue;
    damage += rgDiscardValue(c); // 免疫花色伤害仍计入；Boss 牌按承伤计值（J10/Q15/K20）
    if (c.suit === 'club' && c.suit !== immune) hasClub = true; // 梅花技能被免疫则不翻倍
  }
  return hasClub ? damage * 2 : damage;
}

/**
 * Regicide 花色技能看板：4 花色一览，标注
 * - 免疫：当前敌人同花色（技能不发动，伤害仍计入）；小丑打出后显示「免疫解除」
 * - 将触发：当前已选中手牌包含该花色
 * - 护盾生效：♠ 护盾累计值（直到该敌人被击败）
 */
function rgSuitBoard(G, playerID) {
  const shortDesc = {
    heart: '弃牌堆恢复牌到酒馆底',
    diamond: '玩家们顺时针轮流摸牌',
    club: '本回合伤害 ×2',
    spade: '累计护盾抵御反击',
  };
  // 当前选中手牌包含的花色（用于「将触发」提示）
  const me = G.players[playerID];
  const myHand = me && Array.isArray(me.hand) ? me.hand : [];
  const selectedSuits = new Set(
    rgSelected
      .filter((i) => i < myHand.length)
      .map((i) => myHand[i])
      .filter((c) => !c.isJoker)
      .map((c) => c.suit),
  );
  const enemySuit = G.enemy ? G.enemy.suit : null;

  return el('div', { class: 'rg-suits' },
    RG_SUITS.map((s) => {
      const badges = [];
      if (enemySuit === s.id) {
        badges.push(G.jokerUsed
          ? el('span', { class: 'rg-badge rg-badge-free', text: '免疫解除' })
          : el('span', { class: 'rg-badge rg-badge-immune', text: '免疫技能' }));
      }
      if (selectedSuits.has(s.id)) {
        badges.push(el('span', { class: 'rg-badge rg-badge-active', text: '将触发' }));
      }
      if (s.id === 'spade' && (G.shield || 0) > 0) {
        badges.push(el('span', { class: 'rg-badge rg-badge-shield', text: `护盾 ${G.shield}` }));
      }
      return el('div', { class: 'rg-suit-item', style: `--c:${s.color}` }, [
        el('span', { class: 'rg-suit-symbol', text: s.symbol }),
        el('span', { class: 'rg-suit-info' }, [
          el('span', { class: 'rg-suit-name', text: `${s.name} · ${s.ability.split('：')[0]}` }),
          el('span', { class: 'rg-suit-desc', text: shortDesc[s.id] }),
        ]),
        badges.length ? el('span', { class: 'rg-suit-badges' }, badges) : null,
      ].filter(Boolean));
    }));
}

/** Regicide 战场：当前敌人（血量 / 攻击 / 免疫 / 护盾）+ 花色技能看板 + 牌堆信息 + 战利品。 */
function renderRegicideTable(G, playerID) {
  const container = $('#table');
  container.innerHTML = '';

  container.appendChild(el('div', { class: 'section-label section-label-canvas' }, [
    el('span', { text: '战场' }),
    el('span', { class: 'section-label-sub', text: '击败敌人，或承受其反击' }),
  ]));

  // 当前敌人
  if (G.enemy) {
    const e = G.enemy;
    const hpPct = Math.max(0, Math.round((e.hp / e.maxHp) * 100));
    const nextDmg = Math.max(0, e.attack - (G.shield || 0));
    container.appendChild(el('div', { class: 'rg-enemy', style: `--c:${e.color}` }, [
      rgCardNode(e, {}),
      el('div', { class: 'rg-enemy-stats' }, [
        el('div', { class: 'rg-enemy-name', text: `${e.suitName} ${e.rank}` }),
        el('div', { class: 'rg-hpbar' }, [el('div', { class: 'rg-hp-fill', style: `width:${hpPct}%` })]),
        el('div', { class: 'rg-enemy-line', text: `血量 ${e.hp}/${e.maxHp}` }),
        el('div', { class: 'rg-enemy-line', text: `伤害：${nextDmg} 点（攻击 ${e.attack} − 护盾 ${G.shield || 0}）` }),
        el('div', { class: 'rg-enemy-badges' }, [
          G.jokerUsed
            ? el('span', { class: 'rg-badge rg-badge-free', text: '小丑：免疫已解除' })
            : el('span', { class: 'rg-badge rg-badge-immune', text: `免疫 ${e.suitName} 技能` }),
          (G.shield || 0) > 0 ? el('span', { class: 'rg-badge rg-badge-shield', text: `♠ 护盾 ${G.shield}` }) : null,
        ].filter(Boolean)),
      ]),
    ]));
  } else if (!G.ended) {
    container.appendChild(el('div', { class: 'empty-hint', text: '等待敌人登场…' }));
  }

  // 花色技能看板：免疫花色 / 当前选中触发 / 护盾生效
  container.appendChild(rgSuitBoard(G, playerID));

  // 牌堆信息行：城堡 / 酒馆 / 弃牌堆（公开信息；弃牌堆仅展示最新 10 张）
  const c = G.castle || {};
  const discardAll = G.discard || [];
  const discardTop = discardAll.slice(-10);
  container.appendChild(el('div', { class: 'rg-piles' }, [
    el('div', { class: 'rg-pile' }, [
      el('span', { class: 'rg-pile-title', text: '城堡牌堆' }),
      el('span', { class: 'rg-pile-body' }, [
        el('span', { class: 'rg-badge rg-badge-rank', text: `J×${c.J || 0}` }),
        el('span', { class: 'rg-badge rg-badge-rank', text: `Q×${c.Q || 0}` }),
        el('span', { class: 'rg-badge rg-badge-rank', text: `K×${c.K || 0}` }),
      ]),
    ]),
    el('div', { class: 'rg-pile' }, [
      el('span', { class: 'rg-pile-title', text: '酒馆牌堆' }),
      el('span', { class: 'rg-pile-body', text: `${G.tavern} 张` }),
    ]),
    el('div', { class: 'rg-pile' }, [
      el('span', { class: 'rg-pile-title', text: `弃牌堆（${discardAll.length} 张）` }),
      el('span', { class: 'rg-pile-body' }, [
        ...(discardAll.length > discardTop.length ? [el('span', { class: 'rg-pile-count', text: '…' })] : []),
        ...discardTop.map((cd) => rgCardNode(cd, { mini: true })),
        ...(discardTop.length ? [] : [el('span', { class: 'empty-hint', text: '空' })]),
      ]),
    ]),
  ]));

  // 战利品：已击败的敌人
  container.appendChild(el('div', { class: 'rg-slain' }, [
    el('span', { class: 'rg-pile-title', text: `已击败 ${G.slain.length}/12` }),
    el('span', { class: 'rg-pile-body' },
      G.slain.length
        ? G.slain.map((e2) => rgCardNode(e2, { mini: true, dimmed: true }))
        : [el('span', { class: 'empty-hint', text: '尚无战果' })]),
  ]));
}

/** Regicide 玩家区：手牌张数、回合高亮、结算状态角标。 */
function renderRegicidePlayers(G, ctx, playerID) {
  const container = $('#players');
  container.innerHTML = '';
  container.appendChild(el('div', { class: 'section-label section-label-palette' }, [
    el('span', { text: '玩家' }),
    el('span', { class: 'section-label-sub', text: '合作击败全部敌人' }),
  ]));
  const nicknames = nicknameMap();
  for (const id of G.playOrder) {
    const p = G.players[id];
    const isMe = id === playerID;
    const isCurrent = !G.ended && id === ctx.currentPlayer;
    const handCount = Array.isArray(p.hand) ? p.hand.length : p.hand;
    const cls = ['territory', 'rg-player'];
    if (isMe) cls.push('me');
    if (isCurrent) cls.push('active');
    // 回合状态角标文案：仅标记当前回合玩家
    let turnText = '';
    if (isCurrent) turnText = isMe ? '轮到你了' : '该玩家行动中';
    const rightKids = [el('span', { class: 'rg-hand-count', text: `手牌 ${handCount}/${G.handLimit} 张` })];
    if (G.pending && G.pending.type === 'damage' && G.pending.playerID === id) {
      rightKids.push(el('span', { class: 'rg-badge rg-badge-damage', text: '承受伤害中' }));
    } else if (G.pending && G.pending.type === 'chooseNext' && G.pending.playerID === id) {
      rightKids.push(el('span', { class: 'rg-badge rg-badge-free', text: '指定下一位中' }));
    } else if (isCurrent && handCount === 0) {
      rightKids.push(el('span', { class: 'rg-badge rg-badge-damage', text: '空手被迫跳过' }));
    }
    container.appendChild(el('div', { class: cls.join(' '), 'data-turn-text': turnText }, [
      el('div', { class: 'territory-head' }, [
        el('span', { class: 'territory-name' }, [playerNameNode(id, nicknames, { me: isMe })]),
        el('span', { class: 'r7-head-right' }, rightKids),
      ]),
      el('div', { class: 'territory-cards' }, [
        el('span', { class: 'empty-hint', text: isCurrent ? '正在行动…' : '等待行动' }),
      ]),
    ]));
  }
}

/** Regicide 手牌：连招多选；承伤结算时复用多选来挑选弃牌。 */
function renderRegicideHand(G, playerID, isMyTurn) {
  const container = $('#hand');
  container.innerHTML = '';
  // 手牌区标题：附加手牌上限提示
  const handLabel = document.querySelector('.section-label-hand');
  if (handLabel) {
    handLabel.innerHTML = '';
    handLabel.appendChild(el('span', { text: '手牌区' }));
    handLabel.appendChild(el('span', {
      class: 'section-label-sub', style: 'margin-left: auto;',
      text: `手牌上限 ${G.handLimit} · 酒馆 ${G.tavern} 张`,
    }));
  }
  const me = G.players[playerID];
  if (!me || !Array.isArray(me.hand)) {
    container.appendChild(el('div', { class: 'rg-hint', text: '等待其他玩家行动...' }));
    return;
  }
  if (me.hand.length === 0) {
    container.appendChild(el('div', {
      class: 'rg-hint',
      text: isMyTurn ? '手牌为空：本回合被迫跳过并承受伤害' : '手牌为空',
    }));
    return;
  }
  // 当前敌人的免疫花色（小丑已用则解除）：该花色手牌置灰
  const immuneSuit = G.enemy && !G.jokerUsed ? G.enemy.suit : null;
  me.hand.forEach((card, idx) => {
    container.appendChild(rgCardNode(card, {
      selected: rgSelected.includes(idx),
      dimmed: immuneSuit && !card.isJoker && card.suit === immuneSuit,
      onClick: isMyTurn
        ? () => {
            const pos = rgSelected.indexOf(idx);
            if (pos >= 0) rgSelected.splice(pos, 1);
            else rgSelected.push(idx);
            renderGame(currentState);
          }
        : undefined,
    }));
  });
}

/**
 * Regicide 行动面板：
 * - 承伤结算（阶段 4）：多选弃牌，确认总和 ≥ 反击伤害；不足以承受时只能认败；
 * - 小丑结算：指定下一位行动玩家；
 * - 常规行动：连招校验 + 伤害/技能预览 + 打出 / 打出小丑 / 跳过。
 */
function renderRegicidePanel(state) {
  const { G, ctx, playerID } = state;
  const panel = $('#play-panel');
  panel.innerHTML = '';

  const forced = !G.ended && ctx.currentPlayer === playerID && !!G.pending;
  panel.classList.toggle('panel-forced', forced);
  if (forced && !prevRgForced) {
    requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  prevRgForced = forced;

  if (G.results) return;

  const isMyTurn = ctx.currentPlayer === playerID;
  const me = G.players[playerID];
  const hand = me && Array.isArray(me.hand) ? me.hand : [];

  // —— 待结算：承受伤害（阶段 4） ——
  if (G.pending && G.pending.type === 'damage') {
    if (G.pending.playerID !== playerID) {
      panel.appendChild(el('div', { class: 'rg-hint', text: '该玩家正在弃牌承受伤害…' }));
      return;
    }
    const amount = G.pending.amount;
    const maxTotal = hand.reduce((s, c) => s + rgDiscardValue(c), 0);
    panel.appendChild(el('div', {
      class: 'rg-hint rg-hint-forced',
      text: amount > 0
        ? `阶段4：须弃掉数值总和 ≥ ${amount} 的手牌（A/数字按面值，J/Q/K 按 10/15/20，小丑按 0）。点击手牌选择弃牌。`
        : '护盾完全抵挡了反击，无需弃牌，直接确认即可。',
    }));
    if (amount > 0 && maxTotal < amount) {
      panel.appendChild(el('div', { class: 'rg-hint rg-hint-forced', text: `手牌数值总和最多 ${maxTotal} 点，不足以承受 ${amount} 点伤害！` }));
      panel.appendChild(el('div', { class: 'dest-row' }, [
        el('button', {
          class: 'btn btn-sm rg-btn-danger',
          text: '无力承受（全员败北）',
          onClick: () => { client.moves.surrenderDamage(); resetRegicideSelection(); },
        }),
      ]));
      return;
    }
    const total = rgSelected.filter((i) => i < hand.length).reduce((s, i) => s + rgDiscardValue(hand[i]), 0);
    panel.appendChild(el('div', { class: 'rg-damage-total', text: `已选总和：${total} / 需要 ≥ ${amount}` }));
    panel.appendChild(el('div', { class: 'dest-row' }, [
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: amount > 0 ? '确认弃牌承受伤害' : '确认（无伤害）',
        disabled: total >= amount ? false : 'disabled',
        onClick: () => { client.moves.resolveDamage([...rgSelected]); resetRegicideSelection(); },
      }),
    ]));
    return;
  }

  // —— 待结算：小丑后指定下一位玩家 ——
  if (G.pending && G.pending.type === 'chooseNext') {
    if (G.pending.playerID !== playerID) {
      panel.appendChild(el('div', { class: 'rg-hint', text: '该玩家正在指定下一位行动者…' }));
      return;
    }
    panel.appendChild(el('div', {
      class: 'rg-hint rg-hint-forced',
      text: '你打出了小丑：解除当前敌人的免疫，跳过阶段 2-4（不承受反击），并指定下一位行动的玩家。',
    }));
    panel.appendChild(el('div', { class: 'dest-row dest-buttons' }, G.playOrder.map((id) =>
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: id === playerID ? `玩家 ${pLabel(id)}（你自己）` : `玩家 ${pLabel(id)}`,
        onClick: () => { client.moves.chooseNext(id); resetRegicideSelection(); },
      }))));
    return;
  }

  if (!isMyTurn) {
    panel.appendChild(el('div', { class: 'rg-hint', text: '等待其他玩家行动...' }));
    return;
  }

  // —— 我的回合：选择行动 ——
  const cards = rgSelected.filter((i) => i < hand.length).map((i) => hand[i]);
  const yieldBlocked = G.lastAction === 'yield';
  const nextDmg = G.enemy ? Math.max(0, G.enemy.attack - (G.shield || 0)) : 0;

  if (cards.length === 0) {
    const hints = ['点击选择手牌：可单出、连招（同点数且总和 ≤ 10）或宠物协同（A 配任意牌）。'];
    if (yieldBlocked) hints.push('上一位玩家刚跳过，本回合不能再跳过。');
    panel.appendChild(el('div', { class: 'rg-hint', text: hints.join(' ') }));
    if (!yieldBlocked) {
      panel.appendChild(el('div', { class: 'dest-row' }, [
        el('button', {
          class: 'btn btn-sm',
          text: `跳过（直接承受 ${nextDmg} 点伤害）`,
          onClick: () => { client.moves.yieldTurn(); resetRegicideSelection(); },
        }),
      ]));
    }
    return;
  }

  // 校验所选牌构成合法行动（Boss 牌按承伤计值 J=10/Q=15/K=20）
  const jokers = cards.filter((c) => c.isJoker);
  const hasA = cards.some((c) => !c.isJoker && c.rank === 'A');
  const nonA = cards.filter((c) => !c.isJoker && c.rank !== 'A');
  const totalValue = cards.reduce((s, c) => s + (c.isJoker ? 0 : rgDiscardValue(c)), 0);
  const nonASame = nonA.length === 0 || nonA.every((c) => rgDiscardValue(c) === rgDiscardValue(nonA[0]));
  let mode = 'invalid'; // 'play' | 'joker' | 'invalid'
  let comboType = null;  // 'single' | 'combo' | 'pet' | 'joker'
  if (jokers.length > 0) {
    if (cards.length === 1) { mode = 'joker'; comboType = 'joker'; }
  } else if (cards.length === 1) {
    mode = 'play'; comboType = 'single';
  } else if (hasA) {
    // 宠物协同：A 可与任意非小丑牌合出，无同点数 / 总点数限制
    mode = 'play'; comboType = 'pet';
  } else if (nonASame && totalValue <= 10) {
    mode = 'play'; comboType = 'combo';
  }

  // 组合类型说明（宠物协同 / 连招 / 无效组合）
  const comboHint = {
    single: '单出一张牌。',
    combo: `连招：点数相同且总点数 ≤ 10（当前 ${nonA.length > 0 ? rgDiscardValue(nonA[0]) : '—'} 点 × ${nonA.length}，合计 ${totalValue}）。`,
    pet: `宠物协同：A 可与任意非小丑牌合出，A 计 1 点，无总点数限制（合计 ${totalValue}）。`,
    joker: null,
    invalid: null,
  }[comboType] || null;

  // 行动预览 tip（免疫花色：伤害计入但技能不发动，从触发列表排除）
  const suitAbilities = { heart: '♥治疗', diamond: '♦抽牌', club: '♣双倍伤害', spade: '♠护盾' };
  const immuneSuit = G.enemy && !G.jokerUsed ? G.enemy.suit : null;
  const totalPlayed = cards.filter((c) => !c.isJoker).reduce((s, c) => s + rgDiscardValue(c), 0);
  const abilities = [...new Set(cards.filter((c) => !c.isJoker && c.suit !== immuneSuit).map((c) => c.suit))]
    .map((s) => {
      const name = suitAbilities[s];
      return s === 'club' ? name : `${name} ${totalPlayed}`;
    }).join('、');
  const immuneBlocked = immuneSuit && cards.some((c) => !c.isJoker && c.suit === immuneSuit);
  const preview = rgPreviewDamage(G, cards);

  const lines = [];
  if (mode === 'invalid') {
    const reason = jokers.length > 0
      ? '小丑只能单独打出。'
      : !nonASame
        ? '连招无效：点数需相同。'
        : '连招无效：总点数超过 10。';
    lines.push(el('div', { class: 'rg-hint rg-hint-forced', text: `无效组合：${reason}` }));
    lines.push(el('div', {
      class: 'rg-preview-line',
      text: '合法组合：① 单出任意 1 张；② 连招 = 点数相同且总点数 ≤ 10；③ 宠物协同 = A（计 1 点）可与任意非小丑牌合出，无总点数限制；④ 小丑单独打出。',
    }));
  } else if (mode === 'joker') {
    lines.push(el('div', { class: 'rg-preview-line rg-preview-fx', text: '解除当前敌人的免疫，跳过阶段 2-4，指定下一位玩家。' }));
  } else {
    if (comboType === 'pet') {
      lines.push(el('div', { class: 'rg-preview-line rg-preview-fx', text: '宠物协同' }));
    } else if (comboType === 'combo') {
      lines.push(el('div', { class: 'rg-preview-line rg-preview-fx', text: '连招' }));
    }
    if (comboHint) lines.push(el('div', { class: 'rg-preview-line', text: comboHint }));
    lines.push(el('div', {
      class: 'rg-preview-line',
      text: `预计伤害：${preview}${immuneBlocked ? `（${G.enemy.suitName}免疫，同花色牌技能不发动）` : ''}`,
    }));
    if (abilities) lines.push(el('div', { class: 'rg-preview-line rg-preview-fx', text: `触发技能：${abilities}` }));
  }
  panel.appendChild(el('div', { class: 'rg-tip' }, [
    el('div', { class: 'rg-tip-head', text: '行动预览' }),
    el('div', { class: 'rg-tip-body' }, [
      el('div', { class: 'rg-preview-line', text: `已选：${cards.map(rgCardLabel).join(' + ')}` }),
      ...lines,
    ]),
  ]));

  // 操作按钮
  panel.appendChild(el('div', { class: 'dest-row' }, [
    mode === 'play'
      ? el('button', {
          class: 'btn btn-sm btn-primary',
          text: `打出 ${cards.length} 张牌`,
          onClick: () => { client.moves.playCards([...rgSelected]); resetRegicideSelection(); },
        })
      : null,
    mode === 'joker'
      ? el('button', {
          class: 'btn btn-sm btn-primary',
          text: '打出小丑',
          onClick: () => { client.moves.playJoker(rgSelected[0]); resetRegicideSelection(); },
        })
      : null,
    !yieldBlocked
      ? el('button', {
          class: 'btn btn-sm',
          text: `跳过（承受 ${nextDmg} 点）`,
          onClick: () => { client.moves.yieldTurn(); resetRegicideSelection(); },
        })
      : null,
  ].filter(Boolean)));
}

/** Regicide 结算：合作胜利 / 全员败北。 */
function renderRegicideGameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    gameoverScrolled = false;
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '';
  const win = !G.results.lost;
  box.appendChild(el('h2', { text: win ? '🏆 王座已定，玩家们胜利！' : '💀 全员败北' }));
  box.appendChild(el('p', { class: 'go-summary', text: G.results.reason }));
  box.appendChild(el('p', { class: 'go-summary', text: `本次共击败 ${G.slain.length}/12 个敌人。` }));
  box.appendChild(backToLobbyButton());
  scrollToGameover(box);
}

/** Regicide 统一渲染。 */
function renderRegicide(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  const taskPanel = $('#task-panel');
  if (taskPanel) taskPanel.style.display = 'none';
  renderRegicideTable(G, playerID);
  renderRegicidePlayers(G, ctx, playerID);
  renderRegicideHand(G, playerID, !G.ended && ctx.currentPlayer === playerID);
  renderRegicidePanel(state);
  renderLog(G);
  renderRegicideGameover(G);
}

// ---------- 渲染分发 ----------

/**
 * 各游戏的渲染函数（按 game.name 注册）。
 * 新增游戏时，在此把 game.name 映射到对应的渲染函数即可。
 */
// ---------- Presages 渲染 ----------

/** 读取一名玩家的手牌张数（他人手牌在 playerView 中只有数字）。 */
function psHandCount(G, id) {
  const p = G.players && G.players[id];
  if (!p) return 0;
  if (Array.isArray(p.hand)) return p.hand.length;
  return Number(p.hand) || 0;
}

/** Presages 卡牌节点：左上角点数 + 右上时机图标 + 名称 + 效果描述（细则提醒仅在详情面板显示，无悬停提示）。 */
function presagesCardNode(card, {
  selected = false, dimmed = false, clickable = false, winning = false,
  mini = false,
  onClick = undefined, extraClass = '',
} = {}) {
  const meta = PRESAGES_COLOR_META[card.color] || PRESAGES_COLOR_META.green;
  const cls = ['ps-card'];
  if (mini) cls.push('ps-card-mini');
  if (selected) cls.push('ps-card-selected');
  if (dimmed) cls.push('ps-card-dimmed');
  if (clickable) cls.push('ps-card-clickable');
  if (winning) cls.push('ps-card-winning');
  if (extraClass) cls.push(extraClass);
  if (!onClick) cls.push('ps-card-static');
  const attrs = {
    class: cls.join(' '),
    style: `--c:${meta.color};--ink:${meta.ink}`,
    'data-card-id': card.id,
  };
  if (onClick) { attrs.role = 'button'; attrs.tabindex = '0'; attrs.onClick = onClick; }
  return el('div', attrs, [
    el('div', { class: 'ps-corner', text: String(card.number) }),
    el('div', { class: 'ps-sym' }, [svgNode(PRESAGES_TIMING_ICONS[card.timing === 'lightning' ? 'lightning' : 'hourglass'])]),
    el('div', { class: 'ps-name', text: card.name }),
    el('div', { class: 'ps-effect', text: card.effect }),
  ]);
}

/** Presages 玩家框内已打出的一张牌：小卡 + 结算预览（会赢/会被弃），待结算时承担嫉妒/背叛/愤怒的点选。 */
function presagesFieldNode(entry, index, playerID, pending, preview) {
  let onClick;
  if (pending && pending.playerID === playerID) {
    if (pending.type === 'envy' && entry.card.id !== pending.envyCardId) {
      onClick = () => client.moves.resolveEnvy(index);
    } else if (pending.type === 'betrayalField' && entry.card.id !== pending.betrayalCardId) {
      onClick = () => client.moves.resolveBetrayalField(index);
    } else if (pending.type === 'angerField' && entry.owner === playerID) {
      onClick = () => client.moves.resolveAngerField(index);
    }
  }
  const isWinner = !!preview && preview.winningCardId === entry.card.id;
  const willDiscard = !!preview && preview.discardedIds.includes(entry.card.id);
  // 弃牌来源（效果导致）；仅因「赢得本回合」被弃时不显示来源
  const effectReasons = (preview && preview.discardReasons[entry.card.id]) || [];
  const discardSources = effectReasons.filter((r) => r !== '赢得本回合');
  const card = presagesCardNode(entry.card, {
    mini: true,
    clickable: !!onClick,
    winning: isWinner,
    onClick,
  });
  if (!preview) return card;
  // 结算预览：仅标注会赢/会被效果弃掉的牌（后续出牌会改变结果）
  const chips = [];
  if (isWinner) chips.push(el('span', { class: 'ps-preview-chip ps-preview-win', text: '赢' }));
  if (willDiscard && discardSources.length > 0) {
    chips.push(el('span', { class: 'ps-preview-chip ps-preview-discard', text: '可弃掉' }));
  }
  if (chips.length === 0) return card;
  return el('div', { class: 'ps-played-item' }, [
    card,
    el('div', { class: 'ps-preview' }, chips),
  ]);
}

/** Presages 顶部：轮次、律法与上一回合结算（队伍信息在各玩家框内，打出的牌显示在各自玩家框内）。 */
function renderPresagesTable(state) {
  const G = state.G;
  const container = $('#table');
  container.innerHTML = '';
  const nicknames = nicknameMap();

  // 轮次与状态
  const status = G.ended
    ? '本局已结束'
    : G.pending
      ? `等待 ${nicknames.get(String(G.pending.playerID)) || `玩家 ${G.pending.playerID}`} 作出选择`
      : G.turnConfirm
        ? '全员已出牌，等待确认结束回合'
        : `轮到 ${nicknames.get(String(G.playStage)) || `玩家 ${G.playStage}`} 出牌`;
  container.appendChild(el('div', { class: 'ps-round-head' }, [
    el('div', { class: 'ps-round-main' }, [
      el('div', { class: 'ps-round-title', text: `第 ${G.round} 轮 · 第 ${G.turnNo} 回合` }),
      el('div', { class: 'ps-round-sub', text: '先赢得 2 轮的小队获胜 · 禁止任何形式的沟通' }),
    ]),
    el('div', { class: 'ps-status', text: status }),
  ]));

  if (G.law) {
    container.appendChild(el('div', { class: 'ps-law' }, [
      el('span', { class: 'ps-law-badge', text: '律法' }),
      el('span', {
        text: `本回合尚未出牌的玩家须打出${G.law.mode === 'lower' ? '低于' : '高于'} 15 的牌。`,
      }),
    ]));
  }

  // 秘密揭示（仅对观看者/持有者可见）
  const visibleReveals = (G.reveals || []).filter((r) => r.card);
  if (visibleReveals.length > 0) {
    container.appendChild(el('div', { class: 'ps-reveals' }, [
      el('span', { class: 'ps-reveals-label', text: '揭示给你：' }),
      ...visibleReveals.map((r) => el('span', {
        class: 'ps-reveal-chip',
        text: `${nicknames.get(String(r.ownerId)) || `玩家 ${r.ownerId}`} → ${r.card.number}《${r.card.name}》`,
      })),
    ]));
  }

  // 上一回合结算摘要
  const lr = G.lastResolution;
  if (lr) {
    // 卡牌引用按其颜色渲染（.ps-last-card）
    const cardRefNode = (card) => el('span', {
      class: 'ps-last-card',
      style: `color:${(PRESAGES_COLOR_META[card.color] || PRESAGES_COLOR_META.green).color}`,
      text: `${card.number}《${card.name}》`,
    });
    // 格式：「XX玩家 弃掉 N《牌》 ，YY玩家 弃掉 M《牌》」
    const bodyChildren = [];
    lr.discarded.forEach((d, i) => {
      if (i > 0) bodyChildren.push(document.createTextNode('，'));
      const ownerName = nicknames.get(String(d.owner)) || `玩家 ${d.owner}`;
      bodyChildren.push(document.createTextNode(`【${ownerName}】弃掉`), cardRefNode(d.card));
    });
    if (lr.discarded.length === 0) bodyChildren.push(document.createTextNode('无弃牌'));
    container.appendChild(el('div', { class: 'ps-last', style: `--tc:${PRESAGES_TEAM_COLORS[lr.winnerTeam] || '#888'}` }, [
      el('span', { class: 'ps-last-title', text: '上一回合' }),
      el('span', { class: 'ps-last-body' }, bodyChildren),
    ]));
  }

  if (G.reserve != null) {
    container.appendChild(el('div', {
      class: 'ps-reserve',
      text: `备用牌堆：${G.reserve} 张（本轮不使用）`,
    }));
  }
}

/** Presages 玩家区域：与 Quanc/Red7 一致使用 .territory 样式，打出的牌显示在各自框内。 */
function renderPresagesPlayers(state) {
  const G = state.G;
  const playerID = state.playerID;
  const container = $('#players');
  container.innerHTML = '';
  const nicknames = nicknameMap();
  const preview = presagesResolutionPreview(G.field);
  for (const id of G.playOrder) {
    const isMe = id === playerID;
    const team = G.teamOf[id];
    const color = PRESAGES_TEAM_COLORS[team] || '#8b8b8b';
    // 与 Quanc/Red7 一致：当前应行动（出牌或待选择）的玩家金色高亮 + 角标
    const isCurrent = !G.ended && (G.playStage === id || (G.pending && G.pending.playerID === id));
    const turnText = isCurrent ? (isMe ? '轮到你了' : '该玩家行动中') : '';
    const cls = ['territory', 'ps-player'];
    if (isCurrent) cls.push('active');
    if (isMe) cls.push('me');
    const playedEntries = G.field
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry.owner === id)
      .sort((a, b) => b.entry.card.number - a.entry.card.number);
    const boxChildren = [
      el('div', { class: 'territory-head' }, [
        el('span', { class: 'territory-name' }, [playerNameNode(id, nicknames, { me: isMe })]),
        el('span', { class: 'ps-player-team', style: `--tc:${color}`, text: `小队${PRESAGES_TEAM_SYMBOLS[team] || ''}${' 🏆'.repeat(G.teamWins[team] || 0)}` }),
      ]),
      el('div', { class: 'ps-player-stats' }, [
        el('span', { class: 'ps-stat', text: `手牌 ${psHandCount(G, id)}` }),
      ]),
      el('div', { class: 'ps-played' },
        playedEntries.length === 0
          ? [el('span', { class: 'empty-hint', text: '尚未出牌' })]
          : playedEntries.map((item) => presagesFieldNode(item.entry, item.index, playerID, G.pending, preview)),
      ),
    ];
    // 区域内有已打出的牌时，在底部显示每张牌的效果描述与细则（样式同 ps-detail）
    if (playedEntries.length > 0) {
      boxChildren.push(el('div', { class: 'ps-played-details' },
        playedEntries.map(({ entry }) => {
          const meta = PRESAGES_COLOR_META[entry.card.color] || PRESAGES_COLOR_META.green;
          const rows = [
            el('div', { class: 'ps-played-detail-title', text: `${entry.card.number}《${entry.card.name}》` }),
            el('div', { class: 'ps-played-detail-text', text: entry.card.effect }),
          ];
          if (entry.card.note) {
            rows.push(el('div', { class: 'ps-played-detail-note', text: `注：${entry.card.note}` }));
          }
          return el('div', { class: 'ps-played-detail', style: `--c:${meta.color}` }, rows);
        }),
      ));
    }
    container.appendChild(el('div', { class: cls.join(' '), 'data-turn-text': turnText }, boxChildren));
  }
}

/** Presages 是否允许按律法打出某张牌（手牌中存在符合条件者时强制）。 */
function psLawAllows(G, card) {
  if (!G.law) return true;
  const me = G.players[statePlayerID()];
  const hand = me && Array.isArray(me.hand) ? me.hand : [];
  const meets = (c) => (G.law.mode === 'lower' ? c.number < 15 : c.number > 15);
  const hasValid = hand.some(meets);
  if (!hasValid) return true;
  return meets(card);
}

/** 当前查看者 id（playerView 渲染期间由 currentState 提供）。 */
function statePlayerID() {
  return currentState ? currentState.playerID : '';
}

/** Presages 手牌区：普通选中出牌，或在待结算时直接点选手牌完成选择。 */
function renderPresagesHand(state) {
  const G = state.G;
  const playerID = state.playerID;
  const container = $('#hand');
  container.innerHTML = '';
  const me = G.players[playerID];
  if (!me || !Array.isArray(me.hand)) return;

  const pending = G.pending;
  const myPending = pending && pending.playerID === playerID;
  const canNormalPlay = !G.ended && !pending && G.playStage === playerID;

  // 普通出牌与《梦》强制出牌采用「先选牌再确认」；其他待结算为点选即执行
  const selectionMode = canNormalPlay || (myPending && pending.type === 'dream');
  if (psSelected != null && (psSelected >= me.hand.length || !selectionMode)) {
    psSelected = null;
    psDreamTarget = '';
  }

  me.hand.forEach((card, index) => {
    let onClick;
    let dimmed = false;
    let clickable = false;
    if (myPending) {
      const t = pending.type;
      if (t === 'dream') {
        if (!psLawAllows(G, card)) {
          dimmed = true;
        } else {
          clickable = true;
          onClick = () => {
            psSelected = psSelected === index ? null : index;
            renderGame(currentState);
          };
        }
      } else if (t === 'secretReveal' || t === 'absoluteMine' || t === 'absoluteTheirs') {
        clickable = true;
        onClick = () => client.moves[{
          secretReveal: 'resolveSecretReveal',
          absoluteMine: 'resolveAbsoluteMine',
          absoluteTheirs: 'resolveAbsoluteTheirs',
        }[t]](index);
      } else if (t === 'betrayalHand') {
        clickable = true;
        onClick = () => client.moves.resolveBetrayalHand(index);
      } else if (t === 'angerHand') {
        clickable = true;
        onClick = () => client.moves.resolveAngerHand(index);
      } else if (t === 'luck') {
        const isFear = card.number === 12;
        if (isFear) {
          dimmed = true;
        } else {
          clickable = true;
          onClick = () => client.moves.resolveLuck(index);
        }
      }
    } else if (canNormalPlay) {
      const allowed = psLawAllows(G, card);
      if (allowed) {
        clickable = true;
        onClick = () => {
          if (psSelected === index) {
            psSelected = null;
            psDreamTarget = '';
          } else {
            psSelected = index;
            psDreamTarget = '';
          }
          renderGame(currentState);
        };
      } else {
        dimmed = true;
      }
    }

    const selected = selectionMode && psSelected === index;
    container.appendChild(presagesCardNode(card, {
      selected,
      dimmed,
      clickable,
      onClick,
    }));
  });
}

/** Presages 卡牌详情。 */
function psCardDetail(card) {
  const meta = PRESAGES_COLOR_META[card.color] || PRESAGES_COLOR_META.green;
  const children = [
    el('div', { class: 'ps-detail-title', text: `${card.number}《${card.name}》 · ${meta.name}` }),
    el('div', { class: 'ps-detail-text', text: card.effect }),
  ];
  if (card.note) {
    children.push(el('div', { class: 'ps-detail-note', text: `注：${card.note}` }));
  }
  return el('div', { class: 'ps-detail', style: `--c:${meta.color}` }, children);
}

/** Presages 底部操作面板：普通出牌 / 待结算选择。 */
function renderPresagesPanel(state) {
  const G = state.G;
  const playerID = state.playerID;
  const container = $('#play-panel');
  container.innerHTML = '';
  const nicknames = nicknameMap();
  const nameOf = (id) => nicknames.get(String(id)) || `玩家 ${id}`;

  if (G.ended) {
    container.appendChild(el('div', { class: 'ps-panel-hint', text: '本局已结束，可点击右上角「回到房间」开始新一局。' }));
    return;
  }

  const pending = G.pending;
  if (pending) {
    const isActor = pending.playerID === playerID;
    if (!isActor) {
      container.appendChild(el('div', {
        class: 'ps-panel-hint',
        text: `等待 ${nameOf(pending.playerID)} 完成「${psPendingLabel(pending.type)}」…`,
      }));
      return;
    }
    container.appendChild(el('div', { class: 'ps-panel-title', text: psPendingLabel(pending.type) }));
    if (pending.type === 'law') {
      container.appendChild(el('div', { class: 'ps-panel-row' }, [
        el('button', {
          class: 'btn btn-sm',
          text: '必须打出低于 15 的牌',
          onClick: () => client.moves.resolveLaw('lower'),
        }),
        el('button', {
          class: 'btn btn-sm',
          text: '必须打出高于 15 的牌',
          onClick: () => client.moves.resolveLaw('higher'),
        }),
      ]));
    } else if (pending.type === 'secretTarget') {
      container.appendChild(el('div', { class: 'ps-panel-hint', text: '选择一位玩家，由其选择一张手牌揭示：' }));
      container.appendChild(el('div', { class: 'ps-panel-row' }, G.playOrder
        .filter((id) => psHandCount(G, id) > 0)
        .map((id) => el('button', {
          class: 'btn btn-sm',
          text: nameOf(id),
          onClick: () => client.moves.resolveSecretTarget(id),
        }))));
    } else if (pending.type === 'secretViewer') {
      container.appendChild(el('div', { class: 'ps-panel-hint', text: '选择揭示给谁看：' }));
      container.appendChild(el('div', { class: 'ps-panel-row' }, G.playOrder.map((id) => el('button', {
        class: `btn btn-sm ${id === playerID ? 'btn-primary' : ''}`,
        text: id === playerID ? '自己' : nameOf(id),
        onClick: () => client.moves.resolveSecretViewer(id),
      }))));
    } else if (pending.type === 'angerTarget') {
      container.appendChild(el('div', { class: 'ps-panel-hint', text: '选择一位已出过牌的玩家：' }));
      container.appendChild(el('div', { class: 'ps-panel-row' }, G.playOrder
        .filter((id) => id !== playerID && G.field.some((e) => e.owner === id))
        .map((id) => el('button', {
          class: 'btn btn-sm',
          text: nameOf(id),
          onClick: () => client.moves.resolveAngerTarget(id),
        }))));
    } else if (pending.type === 'absoluteTarget') {
      container.appendChild(el('div', { class: 'ps-panel-hint', text: '选择一位玩家交换一张手牌：' }));
      container.appendChild(el('div', { class: 'ps-panel-row' }, G.playOrder
        .filter((id) => id !== playerID && psHandCount(G, id) > 0)
        .map((id) => el('button', {
          class: 'btn btn-sm',
          text: nameOf(id),
          onClick: () => client.moves.resolveAbsoluteTarget(id),
        }))));
    } else if (pending.type === 'dream') {
      const me = G.players[playerID];
      const sel = psSelected != null && me && Array.isArray(me.hand) && psSelected < me.hand.length
        ? me.hand[psSelected]
        : null;
      if (sel) {
        container.appendChild(psCardDetail(sel));
        container.appendChild(el('div', { class: 'ps-panel-row' }, [
          el('button', {
            class: 'btn btn-primary',
            text: '确认打出',
            onClick: () => {
              const idx = psSelected;
              psSelected = null;
              client.moves.resolveDream(idx);
            },
          }),
          el('button', {
            class: 'btn btn-ghost',
            text: '取消',
            onClick: () => { psSelected = null; renderGame(currentState); },
          }),
        ]));
      } else {
        container.appendChild(el('div', { class: 'ps-panel-hint', text: '请选择一张手牌，立刻打在《梦》的拥有者面前。' }));
      }
    } else {
      const hints = {
        envy: '请点击任意玩家框中已打出的牌，与《嫉妒》交换位置。',
        secretReveal: '请选择一张手牌向指定玩家揭示。',
        angerField: '请点击你自己框中已打出的牌，将其收回手中。',
        angerHand: '请选择一张手牌重新打出。',
        betrayalHand: '请选择一张手牌用于交换。',
        betrayalField: '请点击任意玩家框中已打出的牌完成交换。',
        absoluteMine: '请选择一张自己的手牌。',
        absoluteTheirs: '对方已选好手牌，请选择你要交换出的手牌。',
        luck: '《运气》触发：请选择一张手牌弃掉（不能弃《恐惧》）。',
      };
      container.appendChild(el('div', { class: 'ps-panel-hint', text: hints[pending.type] || '请完成选择。' }));
    }
    return;
  }

  // 全员已出牌：展示结算预览，等待全员点击「结束回合」后才真正结算
  if (G.turnConfirm) {
    const confirmed = G.playOrder.filter((id) => G.turnConfirm[id]).length;
    const total = G.playOrder.length;
    const isPlayer = G.playOrder.includes(playerID);
    const iConfirmed = isPlayer && !!G.turnConfirm[playerID];
    container.appendChild(el('div', { class: 'ps-panel-hint', text: '全员已出牌，确认后结算本回合（可先查看各牌旁的结算预览）。' }));
    if (isPlayer) {
      container.appendChild(el('div', { class: 'ps-panel-row' }, [
        el('button', {
          class: `btn ${iConfirmed ? 'btn-ghost' : 'btn-primary'}`,
          text: iConfirmed ? `已确认，等待其他玩家（${confirmed}/${total}）` : `结束回合（${confirmed}/${total}）`,
          disabled: iConfirmed ? 'disabled' : false,
          onClick: () => client.moves.confirmTurnEnd(),
        }),
      ]));
    } else {
      container.appendChild(el('div', { class: 'ps-panel-hint', text: `等待玩家确认结算（${confirmed}/${total}）。` }));
    }
    return;
  }

  if (G.playStage !== playerID) {
    container.appendChild(el('div', { class: 'ps-panel-hint', text: `等待 ${nameOf(G.playStage)} 出牌…` }));
    return;
  }

  const me = G.players[playerID];
  const selectedCard = psSelected != null && me && Array.isArray(me.hand) ? me.hand[psSelected] : null;
  if (!selectedCard) {
    container.appendChild(el('div', { class: 'ps-panel-hint', text: '选择一张手牌准备打出（点击手牌查看效果）。' }));
    return;
  }

  container.appendChild(psCardDetail(selectedCard));

  // 《梦》放置目标
  if (selectedCard.number === 21) {
    const targets = [
      { id: '', label: '打在自己面前（不启动效果）' },
      ...G.playOrder
        .filter((id) => id !== playerID && !G.playedSet[id])
        .map((id) => ({ id, label: `打在 ${nameOf(id)} 面前` })),
    ];
    container.appendChild(el('div', { class: 'ps-panel-row ps-dream-row' }, targets.map((t) => el('button', {
      class: `btn btn-sm ${psDreamTarget === t.id ? 'btn-primary' : ''}`,
      text: t.label,
      onClick: () => { psDreamTarget = t.id; renderGame(currentState); },
    }))));
  }

  container.appendChild(el('div', { class: 'ps-panel-row' }, [
    el('button', {
      class: 'btn btn-primary',
      text: '打出此牌',
      onClick: () => {
        const idx = psSelected;
        const target = selectedCard.number === 21 ? psDreamTarget : '';
        psSelected = null;
        psDreamTarget = '';
        client.moves.playCard(idx, target || '');
      },
    }),
    el('button', {
      class: 'btn btn-ghost',
      text: '取消',
      onClick: () => { psSelected = null; psDreamTarget = ''; renderGame(currentState); },
    }),
  ]));
}

/** 待结算类型的中文名。 */
function psPendingLabel(type) {
  return {
    law: '《律法》宣言',
    dream: '《梦》强制出牌',
    envy: '《嫉妒》交换',
    secretTarget: '《秘密》选择对象',
    secretViewer: '《秘密》选择观看者',
    secretReveal: '《秘密》揭示手牌',
    angerTarget: '《愤怒》选择目标',
    angerField: '《愤怒》收回旧牌',
    angerHand: '《愤怒》重新出牌',
    betrayalHand: '《背叛》选择手牌',
    betrayalField: '《背叛》选择场上牌',
    absoluteTarget: '《绝对》选择玩家',
    absoluteMine: '《绝对》选择自己的手牌',
    absoluteTheirs: '《绝对》对方选择手牌',
    luck: '《运气》弃手牌',
  }[type] || '待结算';
}

/** Presages 结算面板。 */
function renderPresagesGameover(G) {
  const box = $('#gameover');
  if (!G.results) {
    box.style.display = 'none';
    box.innerHTML = '';
    gameoverScrolled = false;
    return;
  }
  const { winners, team, reason, teamWins } = G.results;
  const nicknames = nicknameMap();
  const color = PRESAGES_TEAM_COLORS[team] || '#d4a017';
  const symbol = PRESAGES_TEAM_SYMBOLS[team] || '?';
  box.style.display = 'block';
  box.innerHTML = '';
  box.appendChild(el('h2', { text: '游戏结束' }));
  box.appendChild(el('p', { class: 'go-summary', style: `--tc:${color}` }, [
    el('span', { class: 'ps-win-team', text: `小队${symbol}获胜` }),
    el('span', { text: ` · ${reason}` }),
  ]));
  box.appendChild(el('div', { class: 'go-scores' }, [
    el('div', { class: 'go-row' }, [
      el('span', { class: 'ps-go-label', text: '获胜成员：' }),
      ...winners.flatMap((w, i) => (i === 0
        ? [playerNameNode(w, nicknames)]
        : [el('span', { text: '、' }), playerNameNode(w, nicknames)])),
    ]),
    el('div', { class: 'go-row' }, [
      el('span', { class: 'ps-go-label', text: '各队轮次：' }),
      ...Object.keys(teamWins).map((t) => el('span', {
        class: 'ps-go-team',
        style: `--tc:${PRESAGES_TEAM_COLORS[t] || '#888'}`,
        text: `小队${PRESAGES_TEAM_SYMBOLS[t] || '?'} ${teamWins[t]} 轮`,
      })),
    ]),
  ]));
  box.appendChild(backToLobbyButton());
  scrollToGameover(box);
}

function renderPresages(state) {
  if (!state) return;
  currentState = state;
  const G = state.G;
  renderPresagesTable(state);
  renderPresagesPlayers(state);
  renderPresagesHand(state);
  renderPresagesPanel(state);
  renderLog(G);
  renderPresagesGameover(G);
}

const GAME_RENDERERS = {
  [QuancGame.name]: renderQuanc,
  [Red7Game.name]: renderRed7,
  [RegicideGame.name]: renderRegicide,
  [PresagesGame.name]: renderPresages,
};

// ---------- 卡牌飞行动画（FLIP：First / Last / Invert / Play） ----------

/** Red7：提取每张牌当前的逻辑位置（playerView 后 G 可用）。 */
function red7CardLocations(G) {
  const map = new Map();
  for (const id of Object.keys(G.players || {})) {
    const p = G.players[id];
    if (Array.isArray(p.hand)) for (const c of p.hand) map.set(c.id, 'hand');
    if (Array.isArray(p.palette)) for (const c of p.palette) map.set(c.id, `palette:${id}`);
  }
  if (Array.isArray(G.canvas)) for (const c of G.canvas) map.set(c.id, 'canvas');
  return map;
}

/** Quanc：提取每张牌当前的逻辑位置。 */
function quancCardLocations(G) {
  const map = new Map();
  for (const id of Object.keys(G.players || {})) {
    const p = G.players[id];
    if (Array.isArray(p.hand)) for (const c of p.hand) map.set(c.id, 'hand');
    if (Array.isArray(p.territory)) for (const c of p.territory) map.set(c.id, `territory:${id}`);
  }
  const table = G.table || {};
  if (Array.isArray(table.favored)) for (const c of table.favored) map.set(c.id, 'table:favored');
  if (Array.isArray(table.disfavored)) for (const c of table.disfavored) map.set(c.id, 'table:disfavored');
  // discard 不在界面上渲染，不纳入位置映射：被刺客移除的牌视为「消失」，播放飞出动画
  return map;
}

/** Regicide：提取每张牌当前的逻辑位置（playerView 后仅自己手牌为数组）。 */
function regicideCardLocations(G) {
  const map = new Map();
  for (const id of Object.keys(G.players || {})) {
    const p = G.players[id];
    if (Array.isArray(p.hand)) for (const c of p.hand) map.set(c.id, 'hand');
  }
  if (Array.isArray(G.discard)) for (const c of G.discard) map.set(c.id, 'discard');
  if (G.enemy) map.set(G.enemy.id, 'enemy');
  if (Array.isArray(G.slain)) for (const c of G.slain) map.set(c.id, 'slain');
  // 城堡 / 酒馆不在界面上逐张渲染，不纳入位置映射
  return map;
}

/** Presages：自己手牌 + 场上所有牌；弃牌堆不渲染。 */
function presagesCardLocations(G) {
  const map = new Map();
  for (const id of Object.keys(G.players || {})) {
    const p = G.players[id];
    if (Array.isArray(p.hand)) for (const c of p.hand) map.set(c.id, 'hand');
  }
  if (Array.isArray(G.field)) {
    for (const e of G.field) map.set(e.card.id, `field:${e.owner}`);
  }
  return map;
}

/** 摸牌飞入动画的起点锚点：手牌区上方（牌堆方向），无手牌区时退回视口顶部中央。 */
function deckAnchorRect() {
  const hand = $('#hand');
  if (hand) {
    const r = hand.getBoundingClientRect();
    return { left: r.left + r.width / 2, top: r.top - 24 };
  }
  return { left: window.innerWidth / 2, top: 0 };
}

/** 按当前对局的游戏分发渲染，并在渲染前后做卡牌飞行动画。 */
function renderGame(state) {
  if (!state) return;
  const fn = currentGame && GAME_RENDERERS[currentGame.game.name];
  if (!fn) return;

  const G = state.G || {};
  const locFns = {
    [Red7Game.name]: red7CardLocations,
    [RegicideGame.name]: regicideCardLocations,
    [PresagesGame.name]: presagesCardLocations,
  };
  const locFn = (currentGame && locFns[currentGame.game.name]) || quancCardLocations;
  const currLocs = locFn(G);
  const firstRender = prevCardLocations.size === 0;

  // First：记录将移动/消失的牌旧位置，识别新牌
  const oldRects = new Map();
  const moved = [];
  const added = [];
  const removed = [];
  if (!firstRender) {
    // 一次性收集旧卡牌节点建索引，避免逐张 querySelector 反复遍历 DOM
    const oldNodes = new Map();
    for (const n of document.querySelectorAll('[data-card-id]')) oldNodes.set(n.dataset.cardId, n);

    for (const [id, to] of currLocs) {
      const from = prevCardLocations.get(id);
      const node = oldNodes.get(id);
      if (node) {
        if (from !== to) {
          oldRects.set(id, node.getBoundingClientRect());
          moved.push({ id, from, to });
        }
      } else if (from === undefined) {
        added.push({ id });
      }
    }
    for (const [id] of prevCardLocations) {
      if (!currLocs.has(id)) {
        const node = oldNodes.get(id);
        if (node) removed.push({ clone: node.cloneNode(true), rect: node.getBoundingClientRect() });
      }
    }
  }

  // 渲染（全量重建 DOM，同步执行）
  fn(state);

  // Last + Invert + Play：确有移动/新增时才建新节点索引并补间
  if (moved.length || added.length) {
    const newNodes = new Map();
    for (const n of document.querySelectorAll('[data-card-id]')) newNodes.set(n.dataset.cardId, n);

    for (const m of moved) {
      const node = newNodes.get(m.id);
      const or = oldRects.get(m.id);
      if (!node || !or) continue;
      const nr = node.getBoundingClientRect();
      const dx = or.left - nr.left;
      const dy = or.top - nr.top;
      if (dx || dy) {
        node.animate(
          [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }],
          { duration: 420, easing: 'cubic-bezier(.22,.68,.35,1)' },
        );
      }
    }

    if (added.length) {
      const anchor = deckAnchorRect();
      for (const a of added) {
        const node = newNodes.get(a.id);
        if (!node) continue;
        node.classList.remove('card-enter'); // 移除 CSS 弹入动画，避免与飞入动画叠加冲突
        const nr = node.getBoundingClientRect();
        const dx = anchor.left - nr.left;
        const dy = anchor.top - nr.top;
        node.animate(
          [
            { transform: `translate(${dx}px,${dy}px) scale(0.7)`, opacity: 0 },
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
          ],
          { duration: 480, easing: 'ease-out' },
        );
      }
    }
  }

  // 消失牌：用克隆节点在原位置播放飞出
  for (const r of removed) {
    r.clone.removeAttribute('data-card-id'); // 克隆节点不参与后续节点索引
    r.clone.style.position = 'fixed';
    r.clone.style.left = `${r.rect.left}px`;
    r.clone.style.top = `${r.rect.top}px`;
    r.clone.style.width = `${r.rect.width}px`;
    r.clone.style.height = `${r.rect.height}px`;
    r.clone.style.margin = '0';
    r.clone.style.zIndex = '9999';
    r.clone.style.pointerEvents = 'none';
    document.body.appendChild(r.clone);
    const anim = r.clone.animate(
      [
        { transform: 'translate(0,0)', opacity: 1 },
        { transform: 'translate(0,-26px) scale(0.72)', opacity: 0 },
      ],
      { duration: 460, easing: 'ease-in' },
    );
    anim.onfinish = () => r.clone.remove();
  }

  prevCardLocations = currLocs;
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
  // 不同游戏最少开局人数不同（如 Presages 需要 4 人）
  const minStart = Math.max(2, (currentGame && currentGame.game && currentGame.game.minPlayers) || 2);
  const allOnline = filledSeats.every(s => s.isConnected === true);
  const allReady = filledSeats.every(s => readyMap[String(s.id)]);
  const canStart = joined >= minStart && allOnline && allReady;
  const isHost = roomInfo && roomInfo.playerID === '0';

  countEl.textContent = `玩家 ${joined}/${total} · ${canStart ? '全员就位，可以开局' : joined < minStart ? `至少 ${minStart} 人开局` : '等待就位'}`;

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

  if (joined < minStart) {
    actionEl.appendChild(el('div', {
      class: 'room-hint',
      text: isHost
        ? `至少还需 ${minStart - joined} 名玩家，把对局 ID 发给好友加入吧。`
        : `等待其他玩家加入…（${joined}/${total}，至少 ${minStart} 人开局）`,
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

// ---------- 会话持久化（localStorage：刷新 / 关闭浏览器后仍可恢复） ----------

/** 保存当前房间与座位信息，供刷新后恢复。 */
function saveSession() {
  if (!roomInfo) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
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
    const raw = localStorage.getItem(SESSION_KEY);
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
    localStorage.removeItem(SESSION_KEY);
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
    resetRegicideSelection();
    resetPresagesSelection();
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
  resetRegicideSelection();
  hideEndTurnHint();
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
  gameoverScrolled = false;
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
