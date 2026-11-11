// afterPack для electron-builder.
//  • Windows: иконка и сведения о версии в «GoatDrey AI.exe» без wine/rcedit (resedit, чистый JS).
//  • Electron Fuses (RunAsNode выкл., Node options/inspect выкл., asar integrity, cookie encryption).
//    Подпись macOS — в after-sign.js, уже после fuses.
const path = require('path'), fs = require('fs');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'darwin') return applyFuses(ctx);
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
  await applyFuses(ctx);
};

async function applyFuses(ctx) {
  let { flipFuses, FuseVersion, FuseV1Options } = {};
  try { ({ flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')); }
  catch (e) { console.warn('  • afterPack: @electron/fuses не установлен — пропускаю', e.message); return; }
  const name = ctx.packager.appInfo.productFilename;
  let binary;
  if (ctx.electronPlatformName === 'darwin') {
    const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
    const arch = ARCH[ctx.arch] || String(ctx.arch);
    const universalBuild = /universal/.test(ctx.appOutDir) || arch === 'universal';
    const isTemp = /-(x64|arm64)-temp/.test(ctx.appOutDir) || (universalBuild && arch !== 'universal');
    if (isTemp) { console.log(`  • afterPack fuses: пропускаю временную ${arch}`); return; }
    binary = path.join(ctx.appOutDir, `${name}.app`);
  } else if (ctx.electronPlatformName === 'win32') {
    binary = path.join(ctx.appOutDir, `${name}.exe`);
  } else return;
  if (!fs.existsSync(binary)) { console.warn('  • afterPack fuses: нет файла', binary); return; }
  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: ctx.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
  console.log('  • afterPack: Electron fuses →', path.basename(binary));
}
