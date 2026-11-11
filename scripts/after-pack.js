// afterPack для electron-builder.
//  • Windows: иконка и сведения о версии в «GoatDrey AI.exe» без wine/rcedit (resedit, чистый JS).
//  • macOS: ad-hoc подпись (codesign -s -). Без неё Apple Silicon считает неподписанное приложение «повреждённым».
//    Для universal подписываем только итоговую сборку: временные x64/arm64 должны совпадать байт-в-байт для склейки.
const path = require('path'), fs = require('fs');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'darwin') return macAdhocSign(ctx);
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const { productFilename } = ctx.packager.appInfo;
  const version = ctx.packager.appInfo.version;
  const exe = path.join(ctx.appOutDir, `${productFilename}.exe`);
  const ico = path.join(ctx.packager.projectDir, 'assets', 'icon', 'icon.ico');
  const data = fs.readFileSync(exe);
  const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
  // Заменяем главную группу иконок (id 1 у Electron), язык — как у существующей.
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups[0]?.id ?? 1, lang = groups[0]?.lang ?? 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, iconFile.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split('.').map(n => parseInt(n, 10) || 0);
  vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
  const strings = { ProductName: 'GoatDrey AI', FileDescription: 'GoatDrey AI', CompanyName: 'GoatDrey', LegalCopyright: '© GoatDrey', OriginalFilename: `${productFilename}.exe`, InternalName: 'GoatDrey AI', ProductVersion: version, FileVersion: version };
  const langs = vi.getAllLanguagesForStringValues(); const l = langs[0] || { lang: 1033, codepage: 1200 };
  vi.setStringValues(l, strings);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log(`  • afterPack: иконка и версия ${version} → ${path.basename(exe)}`);
};

function macAdhocSign(ctx) {
  const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  const arch = ARCH[ctx.arch] || String(ctx.arch);
  const targets = (ctx.targets || []).map(t => t.name);
  // Universal-сборка вызывает afterPack для x64-temp, arm64-temp и итоговой. Подписываем итоговую
  // (или одиночную arm64/x64, если собираем не universal).
  const universalBuild = /universal/.test(ctx.appOutDir) || arch === 'universal';
  const isTemp = /-(x64|arm64)-temp/.test(ctx.appOutDir) || (universalBuild && arch !== 'universal');
  if (isTemp) { console.log(`  • afterPack mac: пропускаю временную ${arch}`); return; }
  if (process.platform !== 'darwin') { console.log('  • afterPack mac: не macOS — ad-hoc подпись пропущена'); return; }
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const { execFileSync } = require('child_process');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  console.log(`  • afterPack mac: ad-hoc подпись → ${path.basename(app)} (${universalBuild ? 'universal' : arch}; ${targets.join(',')})`);
}
