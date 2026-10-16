/**
 * src/server.js
 * boardgame.io 游戏服务器。
 *
 * - 注册 QuancGame 游戏
 * - 提供大厅 API（创建/加入对局等）
 * - 通过 WebSocket 与客户端实时同步
 * - 同时托管 public/ 目录下的前端静态资源
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import serve from 'koa-static';
import { Server } from 'boardgame.io/dist/cjs/server.js';
import { QuancGame } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8000;

/** 已发放的对局 ID，避免 4 位数字撞号。 */
const usedMatchIDs = new Set();

/** 生成 4 位纯数字对局 ID（允许前导零，避开在用房间号）。 */
function generateMatchID() {
  let id;
  do {
    id = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  } while (usedMatchIDs.has(id));
  usedMatchIDs.add(id);
  return id;
}

const server = Server({
  games: [QuancGame],
  uuid: generateMatchID,
  // 玩家凭证仍使用高强度随机串，不随对局 ID 简化
  generateCredentials: () => crypto.randomUUID(),
  // 允许任意来源（开发环境；生产环境请收紧为具体域名）
  origins: ['*'],
  apiOrigins: ['*'],
});

// 房间开局后禁止新玩家加入（房间固定 5 个座位，未开局前可随时加入空座位）。
// 必须在 server.run() 注册大厅路由前插入到中间件栈最前面，
// 否则已匹配 /join 的路由不会继续调用后续中间件。
server.app.middleware.unshift(async (ctx, next) => {
  const match = /^\/games\/[^/]+\/([^/]+)\/join$/.exec(ctx.path);
  if (ctx.method === 'POST' && match) {
    const matchID = decodeURIComponent(match[1]);
    const { state } = await server.db.fetch(matchID, { state: true });
    if (state?.G?.lobby?.started) {
      ctx.status = 403;
      ctx.body = '游戏已开始，无法加入';
      return;
    }
  }
  await next();
});

// 托管前端静态资源（public/）
server.app.use(serve(PUBLIC_DIR));

// SPA 回退：未匹配到静态文件时返回 index.html
server.app.use(async (ctx, next) => {
  // 仅对 GET 且非 API 路径回退到 index.html
  if (
    ctx.method === 'GET' &&
    !ctx.path.startsWith('/games/') &&
    !ctx.path.startsWith('/rooms/')
  ) {
    ctx.type = 'html';
    ctx.body = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  await next();
});

const { appServer } = await server.run({ port: PORT });
console.log(`\n  Quanc 卡牌游戏服务器已启动:`);
console.log(`  - 客户端:  http://localhost:${PORT}`);
console.log(`  - 大厅 API: http://localhost:${PORT}/games/${QuancGame.name}`);
console.log(`\n  按 Ctrl+C 停止服务器。\n`);

// 优雅关闭
const shutdown = async () => {
  console.log('\n正在关闭服务器...');
  server.kill({ appServer });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
