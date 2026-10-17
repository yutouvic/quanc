/**
 * src/icons.js
 * 统一的纹章 SVG 图标（stroke 线稿风格，通过 currentColor 上色）。
 *
 * 用法：渲染时把字符串用 innerHTML 注入到一个 .ico 容器里，
 * 再由 CSS 设置父元素 color 与字号即可控制颜色与尺寸（svg 尺寸为 1em）。
 */

/** 包裹 SVG 通用模板：fill=none 线稿，stroke 跟随 currentColor。 */
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** 六个家族徽章（狮/鹰/狼/蛇/鹿/熊）。 */
export const FAMILY_ICONS = {
  // 狮：圆脸 + 四周鬃毛射线
  lion: svg(
    '<circle cx="12" cy="12.5" r="3.8"/>' +
      '<path d="M12 4.6v2M6.6 7l1.4 1.4M4.6 12.5H7M6.6 18l1.4-1.4M12 20.4v-2M17.4 18l-1.4-1.4M19.4 12.5H17M17.4 7 16 8.4"/>',
  ),
  // 鹰：双翼水平展开、头不明显的对称剪影
  eagle: svg(
    '<path d="M12 6L11 10C7 9.5 3.5 9.5 2 10.5C1.8 12 3 13.8 5 14.2C8 14.8 10 14.8 11.5 14.5L12 18L12.5 14.5C14 14.8 16 14.8 19 14.2C21 13.8 22.2 12 22 10.5C20.5 9.5 17 9.5 13 10L12 6z"/>',
  ),
  // 狼：外撇尖耳 + 尖下巴窄脸
  wolf: svg(
    '<path d="M12 3.5 6 8l5 1.5z"/>' +
      '<path d="M12 3.5 18 8l-5 1.5z"/>' +
      '<path d="M6.5 8h11L16 16.5 12 21.5 8 16.5z"/>' +
      '<circle cx="10" cy="12" r=".6" fill="currentColor" stroke="none"/>' +
      '<circle cx="14" cy="12" r=".6" fill="currentColor" stroke="none"/>',
  ),
  // 蛇：S 形盘身 + 头
  serpent: svg(
    '<path d="M17 7.5c2.5 1 2.5 4 .5 5.5S8 11 7 14s1 5 4 5.5c1.5.3 3-.3 4-1.5"/>' +
      '<circle cx="18" cy="7.5" r="1.7"/>',
  ),
  // 鹿：分叉鹿角 + 竖长脸（脸缩短、鹿角更突出）
  stag: svg(
    '<path d="M9.5 10.5 6.5 4.5 3.5 6M6.5 4.5 8 8.5"/>' +
      '<path d="M14.5 10.5 17.5 4.5 20.5 6M17.5 4.5 16 8.5"/>' +
      '<path d="M9.5 10.5h5l-1 9h-3z"/>' +
      '<circle cx="10.5" cy="13" r=".6" fill="currentColor" stroke="none"/>' +
      '<circle cx="13.5" cy="13" r=".6" fill="currentColor" stroke="none"/>',
  ),
  // 熊：双圆耳 + 大圆脸
  bear: svg(
    '<circle cx="8.5" cy="8.5" r="2.6"/>' +
      '<circle cx="15.5" cy="8.5" r="2.6"/>' +
      '<circle cx="12" cy="14.5" r="5.5"/>',
  ),
};

/** 四种卡牌类型图标（刺客/间谍/贵族/守卫）。 */
export const TYPE_ICONS = {
  // 刺客：剑（菱形刃 + 护手 + 柄）
  assassin: svg(
    '<path d="M12 3l4 7-4 5-4-5z"/>' +
      '<path d="M8 15h8"/>' +
      '<path d="M12 15v5"/>' +
      '<path d="M10 20h4"/>',
  ),
  // 间谍：眼
  spy: svg(
    '<path d="M2 12s3.5-5.5 10-5.5S22 12 22 12s-3.5 5.5-10 5.5S2 12 2 12z"/>' +
      '<circle cx="12" cy="12" r="2.8"/>',
  ),
  // 贵族：皇冠
  noble: svg(
    '<path d="M5 8l4 4 3-5 3 5 4-4-1 10H6z"/>',
  ),
  // 守卫：盾
  guard: svg(
    '<path d="M12 3l8 3v6c0 4.5-3.2 6.5-8 9-4.8-2.5-8-4.5-8-9V6z"/>' +
      '<path d="M12 9l3 3-3 3-3-3z"/>',
  ),
};

/** 牌背水印：问号（间谍背面 / 牌堆共用）。 */
export const BACK_EMBLEM = svg(
  '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
    '<path d="M12 17h.01"/>',
);
