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
import { PassThrough } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import serve from 'koa-static';
import { Server } from 'boardgame.io/dist/cjs/server.js';
import { GAMES } from './games.js';

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
  games: GAMES.map((g) => g.game),
  uuid: generateMatchID,
  // 玩家凭证仍使用高强度随机串，不随对局 ID 简化
  generateCredentials: () => crypto.randomUUID(),
  // 允许任意来源（开发环境；生产环境请收紧为具体域名）
  origins: ['*'],
  apiOrigins: ['*'],
});

// 命名空间事件校验：boardgame.io 的对局数据库按 matchID 全局共享，重启后
// 4 位随机 ID 可能被另一款游戏复用。若客户端用旧 matchID 自动重连到错误
// 游戏的命名空间，sync 会拉到结构不匹配的 G，导致该游戏的 playerView 抛错。
// 这里在事件分发前拦截 gameName 不匹配的 sync，客户端需重新进入房间。
for (const { game } of GAMES) {
  const nsp = server.app._io.of(game.name);
  nsp.on('connection', (socket) => {
    socket.use(async (packet, next) => {
      if (packet[0] !== 'sync') return next();
      try {
        const { metadata } = await server.db.fetch(packet[1], { metadata: true });
        if (metadata && metadata.gameName && metadata.gameName !== game.name) {
          // 静默丢弃：客户端未处理 socket error，避免无效对局被拉取
          return;
        }
      } catch {
        // 查询失败时不拦截，交由 boardgame.io 正常处理
      }
      next();
    });
  });
}

/** 读取请求体原始内容（本中间件先于路由级 koa-body 执行，需自行消费流）。 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 同一房间的加入请求串行化。
 * 重名校验与真正的入座是两次异步读写，多标签页/并发请求可能同时通过校验，
 * 随后各自占用不同空座位，导致大厅出现两个相同昵称。
 */
const joinLocks = new Map();

function withMatchJoinLock(matchID, task) {
  const prev = joinLocks.get(matchID) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  joinLocks.set(matchID, tail);
  return run.finally(() => {
    if (joinLocks.get(matchID) === tail) joinLocks.delete(matchID);
  });
}

// 房间加入拦截：
// 1. 对局必须属于当前游戏名称（boardgame.io 的 matchID 在各游戏间共享数据库，
//    重启后 4 位随机 ID 可能被其他游戏复用，跨游戏同步会让 playerView 拿到
//    结构不匹配的 G 而崩溃）；
// 2. 开局后禁止新玩家加入（房间固定 5 个座位，未开局前可随时加入空座位）；
// 3. 同一房间内玩家昵称不能重名。
// 必须在 server.run() 注册大厅路由前插入到中间件栈最前面，
// 否则已匹配 /join 的路由不会继续调用后续中间件。
server.app.middleware.unshift(async (ctx, next) => {
  const match = /^\/games\/([^/]+)\/([^/]+)\/join$/.exec(ctx.path);
  if (ctx.method === 'POST' && match) {
    const gameName = decodeURIComponent(match[1]);
    const matchID = decodeURIComponent(match[2]);
    await withMatchJoinLock(matchID, async () => {
      const { state, metadata } = await server.db.fetch(matchID, {
        state: true,
        metadata: true,
      });
      // 跨游戏复用 ID：拒绝加入，避免客户端连接到错误游戏的命名空间
      if (metadata && metadata.gameName && metadata.gameName !== gameName) {
        ctx.status = 403;
        ctx.body = '对局不存在或不属于当前游戏，请确认对局 ID';
        return;
      }
      if (state?.G?.lobby?.started) {
        ctx.status = 403;
        ctx.body = '游戏已开始，无法加入';
        return;
      }
      // 先消费请求体做重名校验（此时 koa-body 尚未运行）
      let raw = Buffer.alloc(0);
      let body = {};
      try {
        raw = await readRawBody(ctx.req);
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        body = {}; // 解析失败交由下游 koa-body 处理
      }
      const playerName = typeof body.playerName === 'string' ? body.playerName.trim() : '';
      if (playerName) {
        // metadata.players 为 { 座位号: { name, ... } } 的映射（也可能是数组），统一按值遍历
        const duplicated = Object.values(metadata?.players || {}).some(
          (p) => p && p.name && p.name === playerName,
        );
        if (duplicated) {
          ctx.status = 403;
          ctx.body = '昵称已被房间内玩家使用，请更换昵称';
          return;
        }
      }
      // 校验通过：把已消费的请求体重放为新的流，供下游 koa-body 正常解析
      // （koa-body 从 ctx.req 读流并依赖 headers 判断类型，需一并保留）
      const replay = new PassThrough();
      replay.headers = ctx.req.headers;
      replay.end(raw);
      ctx.req = replay;
      await next();
    });
    return;
  }
  await next();
});

// 查询对局元数据拦截：对局必须属于 URL 中的游戏名称。
// 刷新恢复会话时会先 GET /games/:name/:id 校验座位，若该 matchID 已被其他游戏
// 复用（重启后随机 ID 会重新发放），必须返回 404 让客户端清除会话，
// 否则客户端会用错误的游戏命名空间连接，playerView 拿到不匹配的 G 后崩溃。
server.app.middleware.unshift(async (ctx, next) => {
  const match = /^\/games\/([^/]+)\/([^/]+)$/.exec(ctx.path);
  if (ctx.method === 'GET' && match) {
    const gameName = decodeURIComponent(match[1]);
    const matchID = decodeURIComponent(match[2]);
    const { metadata } = await server.db.fetch(matchID, { metadata: true });
    if (metadata && metadata.gameName && metadata.gameName !== gameName) {
      ctx.status = 404;
      ctx.body = '对局不存在';
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
console.log(`\n  游戏合集服务器已启动:`);
console.log(`  - 客户端:  http://localhost:${PORT}`);
console.log(`  - 游戏库（${GAMES.length} 个游戏）:`);
for (const g of GAMES) {
  console.log(`    · ${g.title}  http://localhost:${PORT}/games/${g.game.name}`);
}
console.log(`\n  按 Ctrl+C 停止服务器。\n`);

// 优雅关闭
const shutdown = async () => {
  console.log('\n正在关闭服务器...');
  server.kill({ appServer });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
