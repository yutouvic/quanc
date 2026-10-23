/**
 * src/quanc-cards.js
 * 卡牌定义与牌堆工具。
 *
 * 规则：共 90 张牌，分 6 个家族，每个家族 15 张。
 * 每个家族的 15 张牌构成为：
 *   2 张刺客 + 3 张间谍 + 3 张贵族 + 3 张守卫 + 4 张平民牌 = 15 张
 *
 * 卡牌效果：
 * - 贵族（noble）：相当于 2 张牌——统计得宠/失宠与计分时权重均为 2。
 * - 间谍（spy）  ：打出时背面向上，对所有人隐藏，游戏结束时统一翻开。
 * - 刺客（assassin）：打出后，可移除该区域内 1 张其他牌（守卫免疫、不可移除刺客自身），任何情况下都可选择不发动。
 * - 守卫（guard）  ：无法被刺客移除。
 * - 平民（plain）  ：无特效。
 */

import { FAMILY_ICONS, TYPE_ICONS } from './quanc-icons.js';

/**
 * 六个家族定义。
 */
export const FAMILIES = [
  { id: 'lion', name: '狮族', icon: '🦁', iconSvg: FAMILY_ICONS.lion, color: '#d6c01bff' },
  { id: 'eagle', name: '鹰族', icon: '🦅', iconSvg: FAMILY_ICONS.eagle, color: '#3b72c5ff' },
  { id: 'wolf', name: '狼族', icon: '🐺', iconSvg: FAMILY_ICONS.wolf, color: '#9aa4b2' },
  { id: 'serpent', name: '蛇族', icon: '🐍', iconSvg: FAMILY_ICONS.serpent, color: '#d22369ff' },
  { id: 'stag', name: '鹿族', icon: '🦌', iconSvg: FAMILY_ICONS.stag, color: '#4caf50' },
  { id: 'bear', name: '熊族', icon: '🐻', iconSvg: FAMILY_ICONS.bear, color: '#8d5524' },
];

/**
 * 卡牌类型定义。
 * weight 为该牌在「得宠/失宠统计」与「领地计分」中的权重。
 */
export const CARD_TYPES = {
  assassin: { name: '刺客', icon: '🗡️', iconSvg: TYPE_ICONS.assassin, weight: 1 },
  spy: { name: '间谍', icon: '🕵️', iconSvg: TYPE_ICONS.spy, weight: 1 },
  noble: { name: '贵族', icon: '👑', iconSvg: TYPE_ICONS.noble, weight: 2 },
  guard: { name: '守卫', icon: '🛡️', iconSvg: TYPE_ICONS.guard, weight: 1 },
  plain: { name: '平民', icon: '·', iconSvg: '', weight: 1 },
};

/**
 * 每个家族的牌构成（合计 15 张）。
 */
export const FAMILY_COMPOSITION = [
  { type: 'assassin', count: 2 },
  { type: 'spy', count: 3 },
  { type: 'noble', count: 3 },
  { type: 'guard', count: 3 },
  { type: 'plain', count: 4 },
];

// 每个家族的牌数（由构成推导）
export const FAMILY_CARDS = FAMILY_COMPOSITION.reduce((s, c) => s + c.count, 0);

/**
 * 按 id 获取家族定义。
 */
export function getFamily(id) {
  return FAMILIES.find(f => f.id === id);
}

/**
 * 生成不泄露家族的卡牌 ID（对原始标识做确定性哈希）。
 * 间谍牌正面（手牌）与背面（打出后）共用同一 ID，不能沿用
 * `${family}-${type}-${index}` 这种会暴露家族的格式（如 lion-spy-0）。
 */
function opaqueId(seed) {
  let h = 2166136261; // FNV-1a 初始偏移
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'c' + (h >>> 0).toString(36);
}

/**
 * 创建一副 90 张的牌堆（6 家族 × 15 张）。
 * 卡牌结构：{ id, family, familyName, icon, color, type, typeName, typeIcon, weight }
 */
export function createDeck() {
  const deck = [];
  for (const f of FAMILIES) {
    for (const comp of FAMILY_COMPOSITION) {
      const t = CARD_TYPES[comp.type];
      for (let i = 0; i < comp.count; i++) {
        const rawId = `${f.id}-${comp.type}-${i}`;
        deck.push({
          id: comp.type === 'spy' ? opaqueId(rawId) : rawId,
          family: f.id,
          familyName: f.name,
          icon: f.icon,
          color: f.color,
          type: comp.type,
          typeName: t.name,
          typeIcon: t.icon,
          weight: t.weight,
        });
      }
    }
  }
  return deck;
}

/**
 * 洗牌（使用 boardgame.io 提供的 random API，保证可复现）。
 */
export function shuffleDeck(deck, random) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random.Number() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * 从牌堆顶抽取 n 张牌。
 */
export function drawFromDeck(deck, n) {
  const drawn = deck.slice(0, n);
  const remaining = deck.slice(n);
  return { drawn, remaining };
}
