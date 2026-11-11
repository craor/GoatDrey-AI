// afterSign: ad-hoc подпись macOS ПОСЛЕ того, как electron-builder переключил Electron Fuses.
// Без неё Apple Silicon считает приложение «повреждённым». Fuses должны быть применены до подписи.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterSign(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  const arch = ARCH[ctx.arch] || String(ctx.arch);
  const universalBuild = /universal/.test(ctx.appOutDir) || arch === 'universal';
  const isTemp = /-(x64|arm64)-temp/.test(ctx.appOutDir) || (universalBuild && arch !== 'universal');
  if (isTemp) { console.log(`  • afterSign mac: пропускаю временную ${arch}`); return; }
  if (process.platform !== 'darwin') { console.log('  • afterSign mac: не macOS — ad-hoc подпись пропущена'); return; }
  const appPath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log(`  • afterSign mac: ad-hoc подпись → ${path.basename(appPath)} (${universalBuild ? 'universal' : arch})`);
};
