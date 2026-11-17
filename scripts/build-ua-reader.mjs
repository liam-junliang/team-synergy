#!/usr/bin/env node
/** Build the pinned upstream viewer in an isolated shadow; never mutate its runtime. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFlag = process.argv.indexOf('--source');
if (sourceFlag < 0 || !process.argv[sourceFlag + 1]) throw new Error('Usage: node scripts/build-ua-reader.mjs --source <installed-UA-tool-root>');
const source = realpathSync(process.argv[sourceFlag + 1]);
const plugin = path.join(source, 'understand-anything-plugin');
const sourceDashboard = path.join(plugin, 'packages/dashboard');
const version = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8')).version;
if (version !== '2.9.8') throw new Error(`UA ${version} needs a reviewed reader adapter; supported: 2.9.8`);
if (!existsSync(path.join(sourceDashboard, 'node_modules/vite'))) throw new Error('Install upstream dependencies separately before building this adapter');
const adapter = path.join(repository, 'apps/web/ua-reader');
const outputDirectory = path.join(repository, `apps/web/public/vendor/ua-reader/${version}`);
const shadow = path.join(repository, 'tmp', `ua-reader-shadow-${Date.now()}-${process.pid}`);
if (!shadow.startsWith(`${path.join(repository, 'tmp')}${path.sep}`) || shadow.startsWith(`${source}${path.sep}`)) throw new Error('Unsafe shadow build path');
mkdirSync(shadow, { recursive: true });
cpSync(path.join(sourceDashboard, 'src'), path.join(shadow, 'src'), { recursive: true, filter: value => !value.includes('__tests__') });
cpSync(path.join(sourceDashboard, 'index.html'), path.join(shadow, 'index.html'));
cpSync(path.join(sourceDashboard, 'package.json'), path.join(shadow, 'package.json'));
symlinkSync(path.join(sourceDashboard, 'node_modules'), path.join(shadow, 'node_modules'), 'junction');

function patch(relative, search, replacement) {
  const target = path.join(shadow, relative);
  const text = readFileSync(target, 'utf8');
  const matches = typeof search === 'string' ? text.split(search).length - 1 : [...text.matchAll(new RegExp(search.source, `${search.flags.replace('g', '')}g`))].length;
  if (matches !== 1) throw new Error(`Expected one upstream seam in ${relative}; found ${matches}`);
  writeFileSync(target, text.replace(search, replacement));
}

patch('src/App.tsx', 'function DashboardContent({', 'export function DashboardContent({');
patch('src/App.tsx', /function shouldShowOnboarding\(\): boolean \{[\s\S]*?\n\}/, 'function shouldShowOnboarding(): boolean { return false; }');
patch('src/App.tsx', 'window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");', '// Embedded reader has no persistent browser storage.');
patch('src/App.tsx', '          <ExportMenu />', '          {/* Downloads are owned by the parent platform. */}');
patch('src/components/MobileDrawer.tsx', '              <ExportMenu />', '              {/* Downloads are owned by the parent platform. */}');
patch('src/store.ts', /toggleExportMenu: \(\) => set\(\(state\) => \(\{[\s\S]*?\n  \}\)\),/, 'toggleExportMenu: () => set({ exportMenuOpen: false }),');
patch('src/store.ts', /  startTour: \(\) => \{\r?\n    const \{ graph, nodeIdToLayerId, activeLayerId \} = get\(\);/, '  startTour: () => {\n    get().setViewMode("structural");\n    const { graph, nodeIdToLayerId, activeLayerId } = get();');
patch('src/themes/ThemeContext.tsx', /function loadFromLocalStorage\(\): ThemeConfig \| null \{[\s\S]*?\n\}/, 'function loadFromLocalStorage(): ThemeConfig | null { return null; }');
patch('src/themes/ThemeContext.tsx', /function saveToLocalStorage\(config: ThemeConfig\): void \{[\s\S]*?\n\}/, 'function saveToLocalStorage(_config: ThemeConfig): void { /* Per-iframe memory only. */ }');
// The full-system graph carries useful business metadata on files/modules as well
// as domains. Reuse upstream's existing text renderer for every node with metadata.
const metadataPattern = /        \{Array\.isArray\(meta\?\.entities\)[\s\S]*?(?=        \{flows\.length > 0 && \()/;
const metadataBlock = readFileSync(path.join(shadow, 'src/components/NodeInfo.tsx'), 'utf8').match(metadataPattern)?.[0];
if (!metadataBlock) throw new Error('Expected the pinned UA domain metadata renderer');
const platformMetadataBlock = `
        {Array.isArray(meta?.userPurposes) && meta.userPurposes.length > 0 ? (
          <div data-tsp-user-purposes>
            <h4 className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{localeKey.startsWith("zh") ? "用途" : "Purposes"}</h4>
            <ul className="text-[11px] text-text-secondary space-y-1">
              {meta.userPurposes.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
        ) : null}
        {Array.isArray(meta?.unknowns) && meta.unknowns.length > 0 ? (
          <div data-tsp-open-questions>
            <h4 className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{localeKey.startsWith("zh") ? "未决事项" : "Open questions"}</h4>
            <ul className="text-[11px] text-text-secondary space-y-1">
              {meta.unknowns.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
        ) : null}
`;
patch('src/components/NodeInfo.tsx', metadataPattern, '');
const domainDetailsDeclaration = 'function DomainNodeDetails({ node, graph }: { node: GraphNode; graph: KnowledgeGraph }) {';
patch('src/components/NodeInfo.tsx', domainDetailsDeclaration,
  `function DomainMetadataDetails({ node }: { node: GraphNode }) {\n  const { t, localeKey } = useI18n();\n  const meta = node.domainMeta as NonNullable<GraphNode['domainMeta']> & { userPurposes?: string[]; unknowns?: string[] };\n  return <div className="mb-4 space-y-3" data-tsp-domain-meta>\n${metadataBlock}${platformMetadataBlock}  </div>;\n}\n\n${domainDetailsDeclaration}`);
patch('src/components/NodeInfo.tsx', '      {/* Domain-specific details */}',
  '      {node.domainMeta && <DomainMetadataDetails node={node} />}\n\n      {/* Domain-specific details */}');
// Source links can select a lazy child before its container has expanded. Keep
// legacy navigation intact; the full-system reader reveals only the real target
// container and waits for React Flow's measured child before positioning it.
patch('src/components/GraphView.tsx', 'import CustomNode from "./CustomNode";', 'import { selectedNodeContainer, waitForSelectedNode } from "../readerSelection";\nimport CustomNode from "./CustomNode";');
const selectedFitPattern = /function SelectedNodeFitView\(\) \{[\s\S]*?\n\}/;
const legacySelectedFit = readFileSync(path.join(shadow, 'src/components/GraphView.tsx'), 'utf8').match(selectedFitPattern)?.[0];
if (!legacySelectedFit) throw new Error('Expected the pinned UA selected-node viewport helper');
patch('src/components/GraphView.tsx', selectedFitPattern, `${legacySelectedFit.replace('function SelectedNodeFitView()', 'function LegacySelectedNodeFitView()')}

function FullSystemSelectedNodeFitView() {
  const graph = useDashboardStore((s) => s.graph);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const activeLayerId = useDashboardStore((s) => s.activeLayerId);
  const tourActive = useDashboardStore((s) => s.tourActive);
  const nodes = useNodes();
  const { fitView, getInternalNode } = useReactFlow();
  const fittedRef = useRef<{ graph: typeof graph; layer: string | null; node: string } | null>(null);
  useEffect(() => {
    if (!selectedNodeId) { fittedRef.current = null; return; }
    if (tourActive) return;
    const fitted = fittedRef.current;
    if (fitted?.graph === graph && fitted.layer === activeLayerId && fitted.node === selectedNodeId) return;
    return waitForSelectedNode({
      nodeId: selectedNodeId, getNode: getInternalNode,
      fit: () => {
        fitView({ nodes: [{ id: selectedNodeId }], duration: 500, padding: 0.3, maxZoom: 1.2, minZoom: 0.01 });
        fittedRef.current = { graph, layer: activeLayerId, node: selectedNodeId };
      },
      requestFrame: action => requestAnimationFrame(action), cancelFrame: id => cancelAnimationFrame(id),
      schedule: (action, delay) => window.setTimeout(action, delay), cancelScheduled: id => window.clearTimeout(id),
    });
  }, [selectedNodeId, activeLayerId, graph, tourActive, nodes, fitView, getInternalNode]);
  return null;
}

function SelectedNodeFitView() {
  const graph = useDashboardStore((s) => s.graph);
  return graph && document.documentElement.dataset.tspReaderProfile === 'full_system'
    ? <FullSystemSelectedNodeFitView /> : <LegacySelectedNodeFitView />;
}`);
patch('src/components/GraphView.tsx', 'function GraphViewInner() {', 'function GraphViewInner() {\n  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);');
patch('src/components/GraphView.tsx', '  // Tour: expand containers needed for the current step, and release any', `  useEffect(() => {
    const container = selectedNodeContainer(document.documentElement.dataset.tspReaderProfile, selectedNodeId, nodeToContainer);
    if (container) expandContainer(container);
  }, [selectedNodeId, nodeToContainer, expandContainer, graph]);

  // Tour: expand containers needed for the current step, and release any`);
cpSync(path.join(adapter, 'bridge.tsx'), path.join(shadow, 'src/bridge.tsx'));
cpSync(path.join(adapter, 'selection.ts'), path.join(shadow, 'src/readerSelection.ts'));
cpSync(path.join(adapter, 'CodeViewer.tsx'), path.join(shadow, 'src/components/CodeViewer.tsx'));
writeFileSync(path.join(shadow, 'src/components/KnowledgeGraphView.tsx'), 'export { default } from "./GraphView";\n');

const require = createRequire(path.join(sourceDashboard, 'package.json'));
const vite = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const tailwind = (await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)).default;
const result = await vite.build({
  configFile: false,
  root: shadow,
  cacheDir: path.join(shadow, '.vite-cache'),
  plugins: [react(), tailwind()],
  resolve: { alias: {
    '@understand-anything/core/schema': path.join(plugin, 'packages/core/dist/schema.js'),
    '@understand-anything/core/search': path.join(plugin, 'packages/core/dist/search.js'),
    '@understand-anything/core/types': path.join(plugin, 'packages/core/dist/types.js'),
  } },
  define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true'), 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, sourcemap: false, cssCodeSplit: false, minify: 'esbuild', target: 'es2022',
    lib: { entry: path.join(shadow, 'src/bridge.tsx'), name: 'TeamSynergyUaReader', formats: ['iife'], fileName: () => 'reader.js', cssFileName: 'reader' },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: item => item.name?.endsWith('.css') ? 'reader.css' : '[name][extname]' } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
const unexpected = outputs.filter(item => !['reader.js', 'reader.css'].includes(item.fileName));
if (unexpected.length || !outputs.some(item => item.fileName === 'reader.js') || !outputs.some(item => item.fileName === 'reader.css')) throw new Error(`Reader must be self-contained; unexpected assets: ${unexpected.map(item => item.fileName).join(', ')}`);
const javascript = outputs.find(item => item.type === 'chunk' && item.fileName === 'reader.js').code;
for (const forbidden of ['/file-content.json', '/knowledge-graph.json', 'understand-anything-token', 'localStorage', 'sessionStorage', 'fetch(']) {
  if (javascript.includes(forbidden)) throw new Error(`The isolated reader still contains an unsupported loader/storage seam: ${forbidden}`);
}
mkdirSync(outputDirectory, { recursive: true });
for (const item of outputs) writeFileSync(path.join(outputDirectory, item.fileName), item.type === 'chunk' ? item.code : item.source);

const packages = new Map();
for (const chunk of outputs.filter(item => item.type === 'chunk')) {
  for (const moduleId of Object.keys(chunk.modules)) {
    const clean = moduleId.replace(/^\0/, '').split('?')[0];
    if (!path.isAbsolute(clean) || !existsSync(clean)) continue;
    let directory = statSync(clean).isDirectory() ? clean : path.dirname(clean);
    while (directory !== path.dirname(directory)) {
      const manifestPath = path.join(directory, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (directory.includes('node_modules') && manifest.name && manifest.version) packages.set(`${manifest.name}@${manifest.version}`, { directory, manifest });
        break;
      }
      directory = path.dirname(directory);
    }
  }
}
let notices = '# Bundled UA reader licenses\n\nUA upstream: https://github.com/Egonex-AI/Understand-Anything\nPinned engine: 2.9.8. Local adapter: 1.0.0.\n\nThe viewer is a derivative of the upstream dashboard; adapter sources and guarded build patches are in apps/web/ua-reader and scripts/build-ua-reader.mjs.\n\n## Understand Anything\n\n' + readFileSync(path.join(source, 'LICENSE'), 'utf8') + '\n';
const bundledPackages = [];
for (const [identity, { directory, manifest }] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
  const license = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? 'See package license');
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null;
  bundledPackages.push({ name: manifest.name, version: manifest.version, license, repository: repositoryUrl });
  notices += `\n## ${identity}\n\nLicense: ${license}\nSource: ${repositoryUrl ?? manifest.homepage ?? `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}\n\n`;
  const files = readdirSync(directory).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name) && statSync(path.join(directory, name)).isFile());
  for (const file of files) notices += `### ${file}\n\n${readFileSync(path.join(directory, file), 'utf8')}\n`;
  if (!files.length) notices += `Package metadata declares ${license}; original source is linked above.\n`;
  if (manifest.name === 'elkjs') notices += '\nELK is distributed under Eclipse Public License 2.0. The unmodified bundled ELK source is available at https://github.com/kieler/elkjs/tree/v0.9.3 and https://www.npmjs.com/package/elkjs/v/0.9.3 .\n';
}
if (!bundledPackages.some(item => item.name === 'elkjs' && item.license === 'EPL-2.0')) throw new Error('Missing bundled ELK license provenance');
writeFileSync(path.join(outputDirectory, 'THIRD-PARTY-NOTICES.md'), notices);
const hash = value => createHash('sha256').update(value).digest('hex');
let sourceCommit = null;
try { sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* Installed package may have no Git metadata. */ }
const assets = Object.fromEntries(outputs.map(item => { const bytes = readFileSync(path.join(outputDirectory, item.fileName)); return [item.fileName, { sha256: hash(bytes), bytes: bytes.length }]; }));
const adapterInputs = ['apps/web/ua-reader/bridge.tsx', 'apps/web/ua-reader/CodeViewer.tsx', 'apps/web/ua-reader/selection.ts', 'scripts/build-ua-reader.mjs'];
const manifest = { schema_version: 1, engine: 'understand-anything', engine_version: version, adapter_version: '1.0.0', protocol_version: 1, source_repository: 'https://github.com/Egonex-AI/Understand-Anything', source_commit: sourceCommit, adapter_sources: Object.fromEntries(adapterInputs.map(file => [file, hash(readFileSync(path.join(repository, file)))])), entry: 'reader.js', stylesheet: 'reader.css', assets, bundled_packages: bundledPackages, license_notices: 'THIRD-PARTY-NOTICES.md', isolation: 'opaque-origin iframe, no credentials or direct source requests' };
writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output: path.relative(repository, outputDirectory).split(path.sep).join('/'), engine_version: version, assets, bundled_packages: bundledPackages.length }, null, 2));
