/**
 * src/games.js
 * 游戏库注册表：所有可玩的游戏及其元数据。
 *
 * 新增游戏的步骤：
 * 1. 在 src/ 下新建游戏定义文件（boardgame.io Game 对象，name 需全局唯一）。
 * 2. 在本文件 import 该游戏并加入 GAMES 数组。
 * 3. 在 src/client.js 的 GAME_RENDERERS 中注册该游戏的渲染函数。
 *
 * 说明：boardgame.io 用 game.name 作为大厅路由（/games/:name/...），
 * 因此这里统一以 game.name 作为游戏库的查找键，避免重复维护一套 id。
 */

import { QuancGame } from './quanc.js';
import { Red7Game } from './red7.js';
import { RegicideGame } from './regicide.js';

export const GAMES = [
  {
    title: 'Quanc',
    tagline: '2-5 人 · 回合制 · 卡牌博弈',
    description: '六大家族争名逐利，是扶持，是制衡，还是压制？间谍潜伏、刺客暗算、贵族权重，阴谋一触即发。',
    icon: '🦁',
    color: '#d6c01bff',
    game: QuancGame,
    css: 'css/quanc.css',
    template: 'template-quanc',
  },
  {
    title: 'Red7',
    tagline: '2-4 人 · 规则瞬息万变 · 卡牌博弈',
    description: '计划不如变化快。7个点数、7种颜色，规则组合千变万化。淘汰你的对手，坚持到最后。',
    icon: '🔴',
    color: '#e53935',
    game: Red7Game,
    css: 'css/red7.css',
    template: 'template-red7',
  },
  {
    title: 'Regicide',
    tagline: '2-4 人 · 合作游戏 · 击败魔王',
    description: '全体玩家合力齐心击败 12 位敌人，巧妙运用花色和组合，抵御魔王的进攻，不能丢下任何一个队友，否则你们就会落败。',
    icon: '👑',
    color: '#8e6cc9',
    game: RegicideGame,
    css: 'css/regicide.css',
    template: 'template-regicide',
  },
];

/** 按 game.name 查找游戏条目；未找到返回 null。 */
export function getGame(gameName) {
  return GAMES.find((g) => g.game.name === gameName) || null;
}
