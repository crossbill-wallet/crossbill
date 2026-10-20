#!/usr/bin/env node
// Sets up the ShrikeWidgets widget extension in the Xcode project and keeps it matched to the app. Run by
// `npm run ios:sync`, or on its own with `npm run ios:widgets`; running it again changes nothing.
//
// It reads the app target's bundle ID, team, version and signing style, so a project set up with your own keeps
// them. The widgets get "<app bundle ID>.widgets", and both targets get the App Group "group.<app bundle ID>" in
// their entitlements, which is how the app hands the widgets what to show. The first run adds the target; later
// runs only bring its settings back in line with the app's. Nothing else in the project is touched: every line
// already there stays as it was.
//
// Usage: node scripts/ios-widgets.mjs [path to ios/App]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = 'ShrikeWidgets';
const SOURCES = ['ShrikeWidgets.swift', 'Snapshot.swift', 'Look.swift', 'PriceWidget.swift', 'BalanceWidget.swift'];
const WIDGET_ENTITLEMENTS = `${TARGET}/${TARGET}.entitlements`;
const APP_ENTITLEMENTS = 'App/App.entitlements';
const GROUPS_KEY = 'com.apple.security.application-groups';

/** Settings the widget target takes from the app target, on every run. */
const FOLLOW = ['CODE_SIGN_STYLE', 'CURRENT_PROJECT_VERSION', 'DEVELOPMENT_TEAM', 'IPHONEOS_DEPLOYMENT_TARGET', 'MARKETING_VERSION', 'TARGETED_DEVICE_FAMILY'];

// Fixed IDs for what this adds, so every copy of the project gets the same lines.
const id = (n) => `5EED1D9E${n.toString(16).toUpperCase().padStart(16, '0')}`;
const ID = {
  target: id(0x01),
  product: id(0x02),
  group: id(0x03),
  sources: id(0x04),
  frameworks: id(0x05),
  resources: id(0x06),
  configList: id(0x07),
  embedPhase: id(0x0a),
  embedFile: id(0x0b),
  proxy: id(0x0c),
  dependency: id(0x0d),
  appEntitlements: id(0x0e),
  entitlements: id(0x0f),
  infoPlist: id(0x10),
  assets: id(0x11),
  assetsFile: id(0x12),
  config: (i) => id(0x20 + i),
  sourceRef: (i) => id(0x40 + i),
  sourceFile: (i) => id(0x60 + i),
};

// ------------------------------------------------------------------ reading the project file

/** Quotes a value the way Xcode does when it holds anything but letters, digits, dots, slashes and `_`. */
export function quote(v) {
  return /^[A-Za-z0-9_./]+$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(v) {
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : v;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A multi-line object at the top level of `objects`: where it starts and ends, and its text. */
function object(text, objId) {
  const m = new RegExp(`^\\t\\t${objId}(?: /\\*.*?\\*/)? = \\{\\n`, 'm').exec(text);
  if (!m) return null;
  const close = text.indexOf('\n\t\t};\n', m.index);
  if (close < 0) throw new Error(`Couldn't find the end of object ${objId}`);
  const end = close + '\n\t\t};\n'.length;
  return { start: m.index, end, body: text.slice(m.index, end) };
}

function replaceObject(text, o, body) {
  return text.slice(0, o.start) + body + text.slice(o.end);
}

function field(body, key) {
  const m = new RegExp(`^\\t\\t\\t${esc(key)} = (.*);$`, 'm').exec(body);
  return m ? unquote(m[1].replace(/ \/\*.*\*\/$/, '')) : null;
}

function listIds(body, key) {
  const open = body.indexOf(`\t\t\t${key} = (\n`);
  if (open < 0) return [];
  const close = body.indexOf('\t\t\t);', open);
  return [...body.slice(open, close).matchAll(/^\t\t\t\t([0-9A-F]{24})/gm)].map((m) => m[1]);
}

/** Adds `entry` to a list in an object, after the entry whose ID is `after` if given, else at the end. */
function addToList(body, key, entry, after) {
  const open = body.indexOf(`\t\t\t${key} = (\n`);
  if (open < 0) throw new Error(`No ${key} list in ${body.split('\n')[0].trim()}`);
  const close = body.indexOf('\t\t\t);', open);
  if (body.slice(open, close).includes(entry.slice(0, 24))) return body;
  let at = close;
  if (after) {
    const a = body.indexOf(`\t\t\t\t${after}`, open);
    if (a >= 0 && a < close) at = body.indexOf('\n', a) + 1;
  }
  return body.slice(0, at) + `\t\t\t\t${entry},\n` + body.slice(at);
}

function setting(body, key) {
  const m = new RegExp(`^\\t\\t\\t\\t${esc(key)} = (.*);$`, 'm').exec(body);
  return m ? unquote(m[1]) : null;
}

/** Sets a build setting in a configuration, keeping the keys in order. null removes it. */
function setSetting(body, key, value) {
  const open = body.indexOf('\t\t\tbuildSettings = {\n');
  if (open < 0) throw new Error('A build configuration without build settings');
  const start = open + '\t\t\tbuildSettings = {\n'.length;
  const close = body.indexOf('\t\t\t};', start);
  const lines = body.slice(start, close).split('\n').filter(Boolean);
  const keyOf = (l) => unquote(l.trim().split(' = ')[0]);
  const i = lines.findIndex((l) => keyOf(l) === key);
  const line = value == null ? null : `\t\t\t\t${quote(key)} = ${quote(value)};`;
  if (i >= 0) {
    if (line === lines[i]) return body;
    if (line == null) lines.splice(i, 1);
    else lines[i] = line;
  } else if (line != null) {
    const after = lines.findIndex((l) => keyOf(l) > key);
    lines.splice(after < 0 ? lines.length : after, 0, line);
  } else {
    return body;
  }
  return body.slice(0, start) + lines.map((l) => l + '\n').join('') + body.slice(close);
}

function addToSection(text, isa, objects) {
  const end = `/* End ${isa} section */`;
  const i = text.indexOf(end);
  if (i >= 0) return text.slice(0, i) + objects + text.slice(i);
  // A new section goes where Xcode keeps it, in alphabetical order with the others
  const re = /\/\* Begin (\w+) section \*\//g;
  let at = -1;
  for (let m; (m = re.exec(text)); ) {
    if (m[1] > isa) {
      at = m.index;
      break;
    }
  }
  if (at < 0) throw new Error(`Couldn't place the ${isa} section`);
  return text.slice(0, at) + `/* Begin ${isa} section */\n${objects}/* End ${isa} section */\n\n` + text.slice(at);
}

function nativeTargets(text) {
  const out = [];
  for (const m of text.matchAll(/^\t\t([0-9A-F]{24}) \/\* .*? \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/gm)) {
    const o = object(text, m[1]);
    out.push({ id: m[1], name: field(o.body, 'name'), productType: field(o.body, 'productType'), body: o.body });
  }
  return out;
}

function configsOf(text, targetBody) {
  const list = object(text, field(targetBody, 'buildConfigurationList'));
  return listIds(list.body, 'buildConfigurations').map((cid) => {
    const o = object(text, cid);
    return { id: cid, name: field(o.body, 'name'), body: o.body };
  });
}

// ------------------------------------------------------------------ what's added

function buildSettingsFor(appCfg) {
  const s = {
    CODE_SIGN_ENTITLEMENTS: WIDGET_ENTITLEMENTS,
    INFOPLIST_FILE: `${TARGET}/Info.plist`,
    LD_RUNPATH_SEARCH_PATHS: '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
    PRODUCT_BUNDLE_IDENTIFIER: `${setting(appCfg.body, 'PRODUCT_BUNDLE_IDENTIFIER')}.widgets`,
    PRODUCT_NAME: '$(TARGET_NAME)',
    SKIP_INSTALL: 'YES',
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: setting(appCfg.body, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS') ?? (appCfg.name === 'Debug' ? 'DEBUG' : ''),
    SWIFT_VERSION: setting(appCfg.body, 'SWIFT_VERSION') ?? '5.0',
  };
  for (const k of FOLLOW) {
    const v = setting(appCfg.body, k);
    if (v != null) s[k] = v;
  }
  if (!s.IPHONEOS_DEPLOYMENT_TARGET) s.IPHONEOS_DEPLOYMENT_TARGET = '16.0';
  return s;
}

function configObject(cid, name, settings) {
  const keys = Object.keys(settings).sort();
  return (
    `\t\t${cid} /* ${name} */ = {\n` +
    `\t\t\tisa = XCBuildConfiguration;\n` +
    `\t\t\tbuildSettings = {\n` +
    keys.map((k) => `\t\t\t\t${quote(k)} = ${quote(settings[k])};\n`).join('') +
    `\t\t\t};\n` +
    `\t\t\tname = ${quote(name)};\n` +
    `\t\t};\n`
  );
}

function phase(pid, name, isa, files) {
  return (
    `\t\t${pid} /* ${name} */ = {\n` +
    `\t\t\tisa = ${isa};\n` +
    `\t\t\tbuildActionMask = 2147483647;\n` +
    `\t\t\tfiles = (\n` +
    files.map((f) => `\t\t\t\t${f},\n`).join('') +
    `\t\t\t);\n` +
    `\t\t\trunOnlyForDeploymentPostprocessing = 0;\n` +
    `\t\t};\n`
  );
}

function addTarget(text, app, appConfigs, appEntitlementsNew) {
  const projectId = /rootObject = ([0-9A-F]{24})/.exec(text)?.[1];
  const project = object(text, projectId);
  const mainGroup = field(project.body, 'mainGroup');
  const productGroup = field(project.body, 'productRefGroup');

  const fileRef = (fid, path, type) => `\t\t${fid} /* ${path} */ = {isa = PBXFileReference; lastKnownFileType = ${type}; path = ${path}; sourceTree = "<group>"; };\n`;
  const buildFile = (bid, ref, path, where) => `\t\t${bid} /* ${path} in ${where} */ = {isa = PBXBuildFile; fileRef = ${ref} /* ${path} */; };\n`;

  text = addToSection(
    text,
    'PBXBuildFile',
    SOURCES.map((f, i) => buildFile(ID.sourceFile(i), ID.sourceRef(i), f, 'Sources')).join('') +
      buildFile(ID.assetsFile, ID.assets, 'Assets.xcassets', 'Resources') +
      `\t\t${ID.embedFile} /* ${TARGET}.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${ID.product} /* ${TARGET}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`,
  );
  text = addToSection(
    text,
    'PBXContainerItemProxy',
    `\t\t${ID.proxy} /* PBXContainerItemProxy */ = {\n` +
      `\t\t\tisa = PBXContainerItemProxy;\n` +
      `\t\t\tcontainerPortal = ${projectId} /* Project object */;\n` +
      `\t\t\tproxyType = 1;\n` +
      `\t\t\tremoteGlobalIDString = ${ID.target};\n` +
      `\t\t\tremoteInfo = ${TARGET};\n` +
      `\t\t};\n`,
  );
  text = addToSection(
    text,
    'PBXCopyFilesBuildPhase',
    `\t\t${ID.embedPhase} /* Embed Foundation Extensions */ = {\n` +
      `\t\t\tisa = PBXCopyFilesBuildPhase;\n` +
      `\t\t\tbuildActionMask = 2147483647;\n` +
      `\t\t\tdstPath = "";\n` +
      `\t\t\tdstSubfolderSpec = 13;\n` +
      `\t\t\tfiles = (\n` +
      `\t\t\t\t${ID.embedFile} /* ${TARGET}.appex in Embed Foundation Extensions */,\n` +
      `\t\t\t);\n` +
      `\t\t\tname = "Embed Foundation Extensions";\n` +
      `\t\t\trunOnlyForDeploymentPostprocessing = 0;\n` +
      `\t\t};\n`,
  );
  text = addToSection(
    text,
    'PBXFileReference',
    `\t\t${ID.product} /* ${TARGET}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${TARGET}.appex; sourceTree = BUILT_PRODUCTS_DIR; };\n` +
      SOURCES.map((f, i) => fileRef(ID.sourceRef(i), f, 'sourcecode.swift')).join('') +
      fileRef(ID.infoPlist, 'Info.plist', 'text.plist.xml') +
      fileRef(ID.entitlements, `${TARGET}.entitlements`, 'text.plist.entitlements') +
      fileRef(ID.assets, 'Assets.xcassets', 'folder.assetcatalog') +
      (appEntitlementsNew ? fileRef(ID.appEntitlements, 'App.entitlements', 'text.plist.entitlements') : ''),
  );
  text = addToSection(text, 'PBXFrameworksBuildPhase', phase(ID.frameworks, 'Frameworks', 'PBXFrameworksBuildPhase', []));
  text = addToSection(
    text,
    'PBXGroup',
    `\t\t${ID.group} /* ${TARGET} */ = {\n` +
      `\t\t\tisa = PBXGroup;\n` +
      `\t\t\tchildren = (\n` +
      SOURCES.map((f, i) => `\t\t\t\t${ID.sourceRef(i)} /* ${f} */,\n`).join('') +
      `\t\t\t\t${ID.assets} /* Assets.xcassets */,\n` +
      `\t\t\t\t${ID.infoPlist} /* Info.plist */,\n` +
      `\t\t\t\t${ID.entitlements} /* ${TARGET}.entitlements */,\n` +
      `\t\t\t);\n` +
      `\t\t\tpath = ${TARGET};\n` +
      `\t\t\tsourceTree = "<group>";\n` +
      `\t\t};\n`,
  );
  text = addToSection(
    text,
    'PBXNativeTarget',
    `\t\t${ID.target} /* ${TARGET} */ = {\n` +
      `\t\t\tisa = PBXNativeTarget;\n` +
      `\t\t\tbuildConfigurationList = ${ID.configList} /* Build configuration list for PBXNativeTarget "${TARGET}" */;\n` +
      `\t\t\tbuildPhases = (\n` +
      `\t\t\t\t${ID.sources} /* Sources */,\n` +
      `\t\t\t\t${ID.frameworks} /* Frameworks */,\n` +
      `\t\t\t\t${ID.resources} /* Resources */,\n` +
      `\t\t\t);\n` +
      `\t\t\tbuildRules = (\n\t\t\t);\n` +
      `\t\t\tdependencies = (\n\t\t\t);\n` +
      `\t\t\tname = ${TARGET};\n` +
      `\t\t\tproductName = ${TARGET};\n` +
      `\t\t\tproductReference = ${ID.product} /* ${TARGET}.appex */;\n` +
      `\t\t\tproductType = "com.apple.product-type.app-extension";\n` +
      `\t\t};\n`,
  );
  text = addToSection(text, 'PBXResourcesBuildPhase', phase(ID.resources, 'Resources', 'PBXResourcesBuildPhase', [`${ID.assetsFile} /* Assets.xcassets in Resources */`]));
  text = addToSection(
    text,
    'PBXSourcesBuildPhase',
    phase(
      ID.sources,
      'Sources',
      'PBXSourcesBuildPhase',
      SOURCES.map((f, i) => `${ID.sourceFile(i)} /* ${f} in Sources */`),
    ),
  );
  text = addToSection(
    text,
    'PBXTargetDependency',
    `\t\t${ID.dependency} /* PBXTargetDependency */ = {\n` +
      `\t\t\tisa = PBXTargetDependency;\n` +
      `\t\t\ttarget = ${ID.target} /* ${TARGET} */;\n` +
      `\t\t\ttargetProxy = ${ID.proxy} /* PBXContainerItemProxy */;\n` +
      `\t\t};\n`,
  );
  text = addToSection(text, 'XCBuildConfiguration', appConfigs.map((c, i) => configObject(ID.config(i), c.name, buildSettingsFor(c))).join(''));
  text = addToSection(
    text,
    'XCConfigurationList',
    `\t\t${ID.configList} /* Build configuration list for PBXNativeTarget "${TARGET}" */ = {\n` +
      `\t\t\tisa = XCConfigurationList;\n` +
      `\t\t\tbuildConfigurations = (\n` +
      appConfigs.map((c, i) => `\t\t\t\t${ID.config(i)} /* ${c.name} */,\n`).join('') +
      `\t\t\t);\n` +
      `\t\t\tdefaultConfigurationIsVisible = 0;\n` +
      `\t\t\tdefaultConfigurationName = Release;\n` +
      `\t\t};\n`,
  );

  // The app builds the widgets first and copies them in, before the CocoaPods script phases at the end
  let o = object(text, app.id);
  const phases = listIds(o.body, 'buildPhases');
  const resources = phases.find((p) => /isa = PBXResourcesBuildPhase;/.test(object(text, p)?.body ?? ''));
  let body = addToList(o.body, 'buildPhases', `${ID.embedPhase} /* Embed Foundation Extensions */`, resources);
  body = addToList(body, 'dependencies', `${ID.dependency} /* PBXTargetDependency */`);
  text = replaceObject(text, o, body);

  o = object(text, mainGroup);
  const firstChild = listIds(o.body, 'children')[0];
  text = replaceObject(text, o, addToList(o.body, 'children', `${ID.group} /* ${TARGET} */`, firstChild));

  o = object(text, productGroup);
  text = replaceObject(text, o, addToList(o.body, 'children', `${ID.product} /* ${TARGET}.appex */`));

  if (appEntitlementsNew) {
    o = object(text, firstChild);
    if (o && field(o.body, 'isa') === 'PBXGroup') text = replaceObject(text, o, addToList(o.body, 'children', `${ID.appEntitlements} /* App.entitlements */`));
  }

  o = object(text, projectId);
  body = addToList(o.body, 'targets', `${ID.target} /* ${TARGET} */`);
  const ta = body.indexOf('\t\t\t\tTargetAttributes = {\n');
  if (ta >= 0 && !body.includes(`\t\t\t\t\t${ID.target} = {`)) {
    const close = body.indexOf('\n\t\t\t\t};', ta);
    body = body.slice(0, close + 1) + `\t\t\t\t\t${ID.target} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;\n\t\t\t\t\t};\n` + body.slice(close + 1);
  }
  text = replaceObject(text, o, body);
  return text;
}

// ------------------------------------------------------------------ entitlements

function entitlements(group) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>${GROUPS_KEY}</key>
	<array>
		<string>${group}</string>
	</array>
</dict>
</plist>
`;
}

/** Makes an entitlements file name `group` as its App Group, keeping anything else already in it. */
export function withGroup(existing, group) {
  if (existing == null) return entitlements(group);
  const re = new RegExp(`(<key>${esc(GROUPS_KEY)}</key>\\s*<array>)[\\s\\S]*?(</array>)`);
  if (re.test(existing)) return existing.replace(re, `$1\n\t\t<string>${group}</string>\n\t$2`);
  const re2 = new RegExp(`<key>${esc(GROUPS_KEY)}</key>\\s*<array/>`);
  if (re2.test(existing)) return existing.replace(re2, `<key>${GROUPS_KEY}</key>\n\t<array>\n\t\t<string>${group}</string>\n\t</array>`);
  const at = existing.lastIndexOf('</dict>');
  if (at < 0) throw new Error('An entitlements file that isn’t a property list');
  return existing.slice(0, at) + `\t<key>${GROUPS_KEY}</key>\n\t<array>\n\t\t<string>${group}</string>\n\t</array>\n` + existing.slice(at);
}

// ------------------------------------------------------------------ the run

/**
 * Brings the project at `iosDir` in line. Returns what changed, in words. With `write` false, only says what
 * would change.
 */
export function setUpWidgets(iosDir, { write = true } = {}) {
  const pbxPath = join(iosDir, 'App.xcodeproj', 'project.pbxproj');
  if (!existsSync(pbxPath)) throw new Error(`No Xcode project at ${pbxPath}`);
  let text = readFileSync(pbxPath, 'utf8');
  const before = text;
  const changes = [];

  const targets = nativeTargets(text);
  const app = targets.find((t) => t.productType === 'com.apple.product-type.application');
  if (!app) throw new Error('The project has no app target');
  let appConfigs = configsOf(text, app.body);
  const release = appConfigs.find((c) => c.name === 'Release') ?? appConfigs[0];
  const appId = setting(release.body, 'PRODUCT_BUNDLE_IDENTIFIER');
  if (!appId || appId.includes('$(')) throw new Error('The app target has no plain PRODUCT_BUNDLE_IDENTIFIER to build on');
  for (const c of appConfigs) {
    const other = setting(c.body, 'PRODUCT_BUNDLE_IDENTIFIER');
    if (other !== appId) throw new Error(`The app's ${c.name} bundle ID (${other}) differs from Release (${appId}); the widgets need one App Group`);
  }
  const group = `group.${appId}`;

  // The app's entitlements: its own file if it has one, else App/App.entitlements
  const existingAppEnt = setting(release.body, 'CODE_SIGN_ENTITLEMENTS');
  const appEntPath = existingAppEnt ?? APP_ENTITLEMENTS;
  const appEntitlementsNew = existingAppEnt == null;
  for (const c of appConfigs) {
    const o = object(text, c.id);
    const body = setSetting(o.body, 'CODE_SIGN_ENTITLEMENTS', appEntPath);
    if (body !== o.body) text = replaceObject(text, o, body);
  }
  if (appEntitlementsNew) changes.push(`gave the app target the entitlements file ${appEntPath}`);
  appConfigs = configsOf(text, app.body);

  let widget = targets.find((t) => t.name === TARGET);
  if (!widget) {
    text = addTarget(text, app, appConfigs, appEntitlementsNew && !text.includes(`/* App.entitlements */ = {isa = PBXFileReference`));
    changes.push(`added the ${TARGET} target, embedded in the app`);
    widget = nativeTargets(text).find((t) => t.name === TARGET);
  } else {
    // Already there: bring its signing and version back in line with the app's
    for (const wc of configsOf(text, widget.body)) {
      const ac = appConfigs.find((c) => c.name === wc.name) ?? release;
      const want = buildSettingsFor(ac);
      const o = object(text, wc.id);
      let body = o.body;
      for (const k of [...FOLLOW, 'PRODUCT_BUNDLE_IDENTIFIER']) body = setSetting(body, k, want[k] ?? null);
      if (body !== o.body) {
        text = replaceObject(text, o, body);
        changes.push(`matched the ${TARGET} ${wc.name} settings to the app's`);
      }
    }
  }

  const files = [
    [join(iosDir, appEntPath), 'the app'],
    [join(iosDir, WIDGET_ENTITLEMENTS), 'the widgets'],
  ];
  const writes = [];
  for (const [file, who] of files) {
    const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const next = withGroup(old, group);
    if (next !== old) {
      writes.push([file, next]);
      changes.push(`set the App Group ${group} for ${who}`);
    }
  }

  if (write) {
    if (text !== before) writeFileSync(pbxPath, text);
    for (const [file, content] of writes) writeFileSync(file, content);
  }
  return { changes, appId, group, text };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const iosDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App'));
  try {
    const { changes, appId, group } = setUpWidgets(iosDir);
    if (changes.length === 0) console.log(`Widgets: already set up for ${appId} (App Group ${group}).`);
    else for (const c of changes) console.log(`Widgets: ${c}.`);
  } catch (e) {
    console.error(`Widgets: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
