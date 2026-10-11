/**
 * 版式常量：全站唯一的内容宽度与间距标尺。
 *
 * 之前每页各自定宽度（有的写死 1400、有的铺满），窗口一放大就露馅——
 * 表格拉到两千像素宽、说明文字却只有两百像素，右侧留白忽大忽小。
 * 统一到这里：改一个数字，六页一起对齐。
 */

/** 内容列最大宽度。表格类页面（完整目录）允许铺得更宽。 */
export const PAGE_WIDTH = 1240;
export const PAGE_WIDTH_WIDE = 1440;
/** 内容区左右留白（窗口够宽时生效） */
export const PAGE_GUTTER = 28;
/** 页头与首块内容、以及各区块之间的垂直间距 */
export const GAP_PAGE = 24;
export const GAP_SECTION = 16;
/** 卡片内边距（自成一块的面） */
export const CARD_PAD = 20;
