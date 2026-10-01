export const NEXUS_COLORS = ['#67f5d1', '#ff796c', '#ac98ff', '#f4cc75'];
export const CARTOON_COLORS = ['#23856c', '#ce594b', '#8061bb', '#ad791e'];
export const isCartoon = () => typeof document !== 'undefined' && document.documentElement?.dataset.theme === 'cartoon';
export const COLORS = [...(isCartoon() ? CARTOON_COLORS : NEXUS_COLORS)];
if (typeof window !== 'undefined') window.addEventListener('lifewar:theme', () => COLORS.splice(0, 4, ...(isCartoon() ? CARTOON_COLORS : NEXUS_COLORS)));

const canvasPalette = {
  '#67f5d1':'#23856c', '#ff796c':'#ce594b', '#ac98ff':'#8061bb',
  '#080f16':'#eeeadd', '#0b151d':'#fcfaf2', '#08131a':'#fcfaf2', '#08141a':'#fcfaf2',
  '#9bbfbd0d':'#c4d4c566', '#779caa0c':'#ccd8ce66', '#476777':'#c5d4c8', '#14262f':'#dce6dc',
  '#253f4b':'#dae4d7', '#2f5566':'#b8cbbc', '#b07cff16':'#8061bb18', '#bc96ff':'#8061bb',
  '#d8c1ff':'#674794', '#08151a66':'#fcfaf270', '#3f687255':'#98b9aa', '#b07cff':'#8061bb',
  '#40545e':'#8a9890', '#48616f':'#667b6f', '#f4cc75':'#ad791e', '#101b23e6':'#fff7dcef',
  '#6a8d9e':'#b0beb0', '#68828c':'#8c9f91', '#12212a':'#e8eee1', '#b4eaff':'#559ebe',
  '#24353e':'#d8e2d5', '#213942':'#d1ddcf', '#567787':'#8a9b8c', '#33434a':'#9aa89b',
  '#b2e7d799':'#23856cbb',
};
export function canvasColor(color) { return isCartoon() ? (canvasPalette[color] || color) : color; }

// Shared by the atlas, pattern thumbnails, deployment preview and both editors.
export function drawCell(ctx, x, y, width, height = width, cartoon = isCartoon()) {
  if (!cartoon || width < 2) { ctx.fillRect(x, y, width, height); return; }
  ctx.beginPath(); ctx.roundRect(x, y, width, height, Math.min(width, height) * .34); ctx.fill();
  if (width >= 6) {
    const color = ctx.fillStyle;
    ctx.fillStyle = '#ffffff80'; ctx.beginPath(); ctx.ellipse(x + width * .32, y + height * .27, width * .14, height * .09, -.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
  }
}
