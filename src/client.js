/**
 * src/client.js
 * 前端客户端（原生 JS，经 esbuild 打包后供浏览器使用）。
 */

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { QuancGame, computeFamilyFates, pLabel } from './game.js';
import { FAMILIES, getFamily } from './cards.js';
import { FAMILY_ICONS, TYPE_ICONS, BACK_EMBLEM } from './icons.js';

const GAME_NAME = QuancGame.name;
const API_BASE = `${window.location.protocol}//${window.location.host}`;
/** 会话存储键：保存当前房间与座位凭证，用于刷新后自动恢复。 */
const SESSION_KEY = 'quanc_session';

let client = null;
let currentState = null;     // 最近一次渲染所用的状态
let selectedIndex = null;    // 当前选中的手牌索引
let currentMatchID = null;   // 当前对局 ID（用于展示与复制）
let roomInfo = null;         // 当前房间信息 { matchID, playerID, credentials }
let inGameScreen = false;    // 当前是否已切换到游戏界面
let currentPlayerName = '';  // 当前玩家昵称（用于恢复会话时回填）
let seenCardIds = new Set(); // 已出现过的卡牌 id，用于给新牌播放进入动画
let prevEnded = false;       // 上一帧是否已结束（用于一次性触发翻牌/得分滚动）
let justEnded = false;       // 本帧是否为游戏结束瞬间

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
    return '请先填写昵称';
  }
  return serverMsg || `${fallback}（${res.status}）`;
}

/** 房间固定创建的座位数（2-5 人开局，未坐满时空座位不参与游戏）。 */
const ROOM_SEATS = 5;

async function createMatch() {
  const res = await fetch(`${API_BASE}/games/${GAME_NAME}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numPlayers: ROOM_SEATS }),
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
  const res = await fetch(`${API_BASE}/games/${GAME_NAME}/${matchID}/join`, {
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
  const res = await fetch(`${API_BASE}/games/${GAME_NAME}/${matchID}/leave`, {
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
  // 小牌复用大卡结构（card-frame/tex/gloss/emblem/fam/type），仅加 card-mini 缩放
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

/** 玩家展示文案：数字 + 昵称（如「1 · 张三」）。 */
function playerNameText(id, nicknames) {
  const name = nicknames && nicknames.get(String(id));
  return `${pLabel(id)}${name ? ` · ${name}` : ''}`;
}

function renderPlayers(G, ctx, playerID, fates) {
  const container = $('#players');
  container.innerHTML = '';
  const nicknames = nicknameMap();
  for (const id of ctx.playOrder) {
    const p = G.players[id];
    const isCurrent = id === ctx.currentPlayer;
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
    const node = el('div', { class: `territory ${isCurrent ? 'active' : ''} ${isMe ? 'me' : ''}` }, [
      el('div', { class: 'territory-head' }, [
        el('span', {
          class: 'territory-name',
          text: `${playerNameText(id, nicknames)}${isMe ? '（你）' : ''}`,
        }),
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
 * - 6 个家族按 FAMILIES 顺序从左到右成列，间谍单独占最右列；
 * - 非间谍牌按家族归入对应列：得宠牌在计分板上方向上叠放，失宠牌在下方向下叠放。
 */
function renderTable(G, fates) {
  const container = $('#table');
  container.innerHTML = '';

  const favored = G.table.favored || [];
  const disfavored = G.table.disfavored || [];

  // 7 列：6 个家族 + 最右侧间谍列
  const cols = FAMILIES.map(f => ({
    kind: 'family',
    family: f,
    favored: favored.filter(c => c.family === f.id),
    disfavored: disfavored.filter(c => c.family === f.id),
  }));
  cols.push({
    kind: 'spy',
    favored: favored.filter(c => c.type === 'spy'),
    disfavored: disfavored.filter(c => c.type === 'spy'),
  });

  // 得宠（上）/ 失宠（下）牌行；得宠列 wrap-reverse 向上叠放，失宠列正常向下叠放
  const cardsRow = (zoneKey, sideText, sideCls) =>
    el('div', { class: 'board-row' }, [
      el('div', { class: `board-side ${sideCls}` }, [el('span', { text: sideText })]),
      el('div', { class: 'board-grid' }, cols.map((col) => {
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
      el('div', { class: 'board-side' }),
      el('div', { class: 'board-grid board-head' }, headCells),
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
      onClick: active ? () => { selectedIndex = (selectedIndex === idx ? null : idx); render(currentState); } : undefined,
    }));
  });
}

/** 刺客结算面板 */
function renderAssassinPanel(state) {
  const { G, playerID, isActive } = state;
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
  const { G, ctx, playerID, isActive } = state;
  const panel = $('#play-panel');

  if (ctx.gameover) return;

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

function renderGameover(ctx) {
  const box = $('#gameover');
  if (!ctx.gameover) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const { winners, scores, fates } = ctx.gameover;
  const nicknames = nicknameMap();
  box.style.display = 'block';
  box.innerHTML = '';
  box.appendChild(el('h2', { text: '游戏结束' }));
  box.appendChild(el('p', {
    class: 'go-summary',
    text: `获胜者：${winners.map(w => playerNameText(w, nicknames)).join('、')}`,
  }));
  const rows = Object.keys(scores).map(id => {
    const scoreEl = el('span', { class: 'go-score', text: `${justEnded ? 0 : scores[id]} 分` });
    if (justEnded) animateScore(scoreEl, scores[id]);
    return el('div', { class: 'go-row' }, [
      el('span', { text: playerNameText(id, nicknames) }),
      scoreEl,
    ]);
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
}

function render(state) {
  if (!state) return;
  currentState = state;
  const { G, ctx, playerID } = state;
  justEnded = !!ctx.gameover && !prevEnded;
  prevEnded = !!ctx.gameover;
  const fates = computeFamilyFates(G.table);
  renderHeader(G);
  renderPlayers(G, ctx, playerID, fates);
  renderTable(G, fates);
  // 有刺客待结算时禁用选牌
  const canPick = state.isActive && !ctx.gameover && !G.pendingAssassin;
  renderHand(G, playerID, canPick);
  renderPlayPanel(state);
  renderLog(G);
  renderGameover(ctx);
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
        el('span', { class: 'seat-no', text: `座位 ${pLabel(s.id)}` }),
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
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...roomInfo, playerName: currentPlayerName }));
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
    if (!saved || !saved.matchID || saved.playerID == null || !saved.credentials) return null;
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

  const status = $('#setup-status');
  const goneMsg = '上次的对局已结束，请重新创建或加入。';
  const abort = () => {
    clearSession();
    status.textContent = goneMsg;
    return false;
  };

  status.textContent = '正在恢复上次的对局…';

  let data;
  try {
    const res = await fetch(`${API_BASE}/games/${GAME_NAME}/${saved.matchID}`);
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
  enterRoom(saved.matchID, saved.playerID, saved.credentials);
  return true;
}

// ---------- 进入房间 / 切换界面 ----------

function showLobbyScreen() {
  inGameScreen = false;
  $('#game').style.display = 'none';
  $('#setup').style.display = 'none';
  $('#lobby').style.display = 'block';
}

function showGameScreen() {
  if (!inGameScreen) {
    inGameScreen = true;
    selectedIndex = null;
    $('#lobby').style.display = 'none';
    $('#setup').style.display = 'none';
    $('#game').style.display = 'block';
  }
  $('#match-id').textContent = currentMatchID;
  // 仅房主（座位 0）可以结束游戏
  const isHost = !!roomInfo && roomInfo.playerID === '0';
  $('#end-game-btn').style.display = isHost ? '' : 'none';
}

/** 创建 / 加入成功后进入房间：立刻建立游戏连接，在大厅阶段等待房主开始。 */
function enterRoom(matchID, playerID, credentials, playerName) {
  roomInfo = { matchID, playerID, credentials };
  if (playerName) currentPlayerName = playerName;
  saveSession(); // 记录会话，刷新后可自动恢复
  inGameScreen = false;
  currentState = null;
  selectedIndex = null;
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
  currentMatchID = matchID;
  showLobbyScreen();
  renderLobby(null);

  client = Client({
    game: QuancGame,
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

    // 房主结束本局：所有玩家退出游戏页，回到设置界面
    if (state.G && state.G.hostEnded) {
      setTimeout(() => resetToSetup('本局已结束，本局信息已清除，可重新创建或加入对局。'), 300);
      return;
    }

    const view = { ...state, playerID };
    currentState = view;
    const phase = state.ctx && state.ctx.phase;

    if (phase === 'play' || state.ctx.gameover) {
      // 房主已开始游戏（或游戏已结束）：进入游戏界面
      showGameScreen();
      render(view);
      return;
    }

    // 大厅阶段：以服务端状态为准自动准备（幂等，且可在丢包/竞争时重发）
    if (state.isConnected && view.G?.lobby && !view.G.lobby.ready[roomInfo.playerID]) {
      client.moves.lobbyReady();
    }
    showLobbyScreen();
    renderLobby(view);
  });

  client.start();
}

/** 断开当前游戏连接并回到设置界面。 */
function resetToSetup(message) {
  if (client) {
    client.stop();
    client = null;
  }
  currentState = null;
  selectedIndex = null;
  seenCardIds.clear();
  prevEnded = false;
  justEnded = false;
  currentMatchID = null;
  roomInfo = null;
  inGameScreen = false;
  clearSession(); // 主动离开后不再自动恢复

  // 清空游戏界面残留
  for (const sel of ['#players', '#table', '#log', '#hand', '#play-panel', '#gameover', '#room-seats', '#room-action']) {
    $(sel).innerHTML = '';
  }
  $('#gameover').style.display = 'none';
  $('#deck-info').textContent = '';
  $('#match-id').textContent = '-';
  $('#copy-match-btn').textContent = '复制';
  $('#room-copy-btn').textContent = '复制邀请';
  $('#room-count').textContent = '';

  $('#game').style.display = 'none';
  $('#lobby').style.display = 'none';
  $('#setup').style.display = 'block';
  $('#setup-status').textContent = message || '';
}

// ---------- 设置界面事件 ----------

function bindSetupEvents() {
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
    resetToSetup('你已离开房间，可重新创建或加入对局。');
  });
}

/** 游戏页事件：复制对局 ID、结束本局（不结算，清除本局信息，退回大厅）。 */
function bindGameEvents() {
  $('#copy-match-btn').addEventListener('click', () => {
    if (currentMatchID) copyText(currentMatchID, $('#copy-match-btn'), '复制');
  });

  $('#end-game-btn').addEventListener('click', () => {
    if (!roomInfo || roomInfo.playerID !== '0') return; // 仅房主可结束
    if (!window.confirm('确定要结束本局吗？本局信息将被清除，且不做结算。')) return;
    // 游戏已结束（ctx.gameover 已生成）后，boardgame.io 会拒绝所有 move，
    // endGame 无法再广播，此时直接退回设置界面即可。
    if (currentState && currentState.ctx && currentState.ctx.gameover) {
      resetToSetup('本局已结束，本局信息已清除，可重新创建或加入对局。');
      return;
    }
    // 通过 move 广播给房间内所有玩家，所有客户端（含房主）统一退出游戏页
    client.moves.endGame();
  });
}

async function init() {
  bindSetupEvents();
  bindRoomEvents();
  bindGameEvents();
  // 刷新页面后自动回到上次的房间 / 对局（无有效会话则留在设置界面）
  await restoreSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
