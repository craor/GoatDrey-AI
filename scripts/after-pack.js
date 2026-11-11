// afterPack для electron-builder: ставит иконку и сведения о версии в «GoatDrey AI.exe» без wine/rcedit
// (чистый JS через resedit). Нужен при сборке на Linux, где signAndEditExecutable=false.
const path = require('path'), fs = require('fs');
exports.default = async function afterPack(ctx) {
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
