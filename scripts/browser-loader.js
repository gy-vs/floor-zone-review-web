// 模块解析钩子：把浏览器 import map 里的裸标识符映射到与 vendor 路由相同的文件。
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const NM = join(root, 'node_modules');

const MAP = {
  'polygon-clipping': join(NM, 'polygon-clipping/dist/polygon-clipping.esm.js'),
  splaytree: join(NM, 'splaytree/dist/splaytree.js'),
  'robust-predicates': join(NM, 'robust-predicates/esm/orient2d.js'),
};

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) return { url: pathToFileURL(MAP[specifier]).href, shortCircuit: true };
  // robust-predicates ESM 内部以 './orient2d.js' 等相对路径互相引用，默认解析即可正确命中 esm 目录。
  return nextResolve(specifier, context);
}
