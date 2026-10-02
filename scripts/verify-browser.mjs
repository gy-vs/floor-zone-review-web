// 用 Node 的模块加载钩子复刻浏览器 import map，验证浏览器模块图可完整求值。
// 不替代自动测试，仅做发布前的资源完整性检查（npm run verify:browser）。
import { register } from 'node:module';

const VENDOR = new URL('../public/', import.meta.url);
register(String(new URL('./browser-loader.js', import.meta.url)));

const [{ analyze }, { default: pc }] = await Promise.all([
  import('../shared/geometry.js'),
  import('polygon-clipping'),
]);

if (typeof pc.intersection !== 'function') throw new Error('polygon-clipping 未正确加载');
const r = analyze({
  floor: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] },
  unusable: [],
  zones: [
    { id: 'a', name: 'A', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
    { id: 'b', name: 'B', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
  ],
});
const overlap = r.issues.find((i) => i.kind === 'overlap');
if (Math.abs(overlap.area - 8) > 1e-9) throw new Error('浏览器模块图中的几何结果不正确');
console.log('browser module graph OK: 1m 重叠带 =', overlap.area, 'm²');
void VENDOR;
