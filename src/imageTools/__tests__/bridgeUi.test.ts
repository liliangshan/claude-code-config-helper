/** @file Image bridge, global UI and scope identity regressions without VS Code or billable APIs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { IMAGE_TOOL_SCHEMAS } from '../tools';

/** Minimal DOM for exercising the real file-reference renderer without duplicating its routing logic. */
class FileButton {
    public type = ''; public className = ''; public textContent = '';
    public click?: () => void;
    /** Capture the native click callback attached by appendFileRef. */
    public addEventListener(_type: string, callback: () => void): void { this.click = callback; }
}


const root = resolve(__dirname, '../../..');
/** Read source assets from the same installation layout used by production Webviews. */
function asset(file: string): string { return readFileSync(resolve(root, file), 'utf8'); }

test('image chip follows task flow and every chat loader includes both image assets', () => {
    const html = asset('media/chat/index.html');
    assert.ok(html.indexOf('composer-taskflow-chip') < html.indexOf('composer-image-chip'));
    assert.ok(html.indexOf('composer-image-chip') < html.indexOf('reasoning-effort-select'));
    for (const file of ['src/chat/chatViewHost.ts', 'src/editorChat/leftView.ts', 'src/editorChat/manager.ts']) {
        const source = asset(file); assert.ok(source.includes('imageGeneration.js'), file); assert.ok(source.includes('imageGeneration.css'), file);
    }
    assert.ok(!asset('src/editorChat/store.ts').includes('imageGeneration:'));
    assert.ok(!asset('src/editorChat/defaults.ts').includes('imageGeneration:'));
});

test('all seven image translations contain every nonempty label and render untrusted names as text', () => {
    const source = asset('media/chat/imageGeneration.js'); const end = source.indexOf('    /** Install isolated image UI');
    const translations = runInNewContext(source.slice(0, end) + '\nreturn { keys, translations };\n})();') as { keys: string[]; translations: Record<string, Record<string, string>> };
    assert.equal(Object.keys(translations.translations).length, 7);
    for (const [language, labels] of Object.entries(translations.translations)) for (const key of translations.keys) assert.ok(typeof labels[key] === 'string' && labels[key].length, `${language}.${key}`);
    assert.ok(!source.includes('innerHTML')); assert.ok(!source.includes('localStorage')); assert.ok(!source.includes('setState('));
    assert.ok(source.includes('expectedRevision: draftRevision')); assert.ok(source.includes('if (!checked) fields.apiKey.value'));
    assert.ok(!source.includes('models/applyPair')); assert.ok(!source.includes('cli/restart'));
});

test('image schemas expose six closed tools and never accept address, credentials, model or ownership overrides', () => {
    assert.equal(IMAGE_TOOL_SCHEMAS.length, 6);
    for (const schema of IMAGE_TOOL_SCHEMAS) {
        assert.equal(schema.inputSchema.additionalProperties, false);
        for (const forbidden of ['apiKey', 'baseUrl', 'model', 'cwd', 'conversationId']) assert.ok(!(forbidden in schema.inputSchema.properties));
        assert.equal(schema.annotations.readOnlyHint, !['openapi_generate_image', 'openapi_edit_image'].includes(schema.name));
    }
});

test('image dialog only edits connection settings and generation tools require a model-submitted size', () => {
    const source = asset('media/chat/imageGeneration.js');
    for (const removed of ["field('filter'", "field('defaultSize'", "field('generationEndpointOverride'", "field('editEnabled'", "field('timeoutMs'", "'advanced'"]) assert.ok(!source.includes(removed), removed);
    assert.ok(source.includes('.LLSOAI/openapi-image-generation/'));
    assert.ok(!source.includes('const config = { ...state.config }'), 'Removed advanced values must not be resubmitted');
    for (const schema of IMAGE_TOOL_SCHEMAS.filter(item => ['openapi_generate_image', 'openapi_edit_image'].includes(item.name))) assert.ok(schema.inputSchema.required.includes('size'));
});

test('generated image links use checked task identities and result replay does not duplicate chat messages', () => {
    const source = asset('media/chat/main.js'), sent: any[] = [], elements: FileButton[] = [];
    const start = source.indexOf('    function appendFileRef('), end = source.indexOf('\n    /**', start);
    const render = runInNewContext(source.slice(start, end) + '\nappendFileRef;', {
        document: { createElement: () => new FileButton() }, crypto: { randomUUID: () => 'open-request' }, post: (value: unknown) => sent.push(value)
    });
    render({ appendChild: (element: FileButton) => elements.push(element) }, { filePath: '.LLSOAI/openapi-image-generation/images/test.png', text: 'Open image', generatedImage: { taskId: 'task', imageId: 'image', scopeId: 'scope' } });
    elements[0].click!(); assert.equal(sent[0].type, 'imageGeneration/imageOpen'); assert.equal(sent[0].scopeId, 'scope'); assert.equal(sent[0].path, undefined);
    assert.ok(elements[0].textContent.includes('.LLSOAI/openapi-image-generation/'));
    const branchStart = source.indexOf("            case 'message/append':"), branchEnd = source.indexOf("            case 'message/patch':", branchStart);
    const branch = source.slice(branchStart + "            case 'message/append':".length, branchEnd);
    let appends = 0; const context = { message: { message: { id: 'image-result-task', role: 'system', segments: [] } }, renderedMessagesCache: [] as any[],
        cacheAppendedMessage(message: any) { context.renderedMessagesCache.push(message); }, appendMessage() { appends++; }, syncSessionInitSignatureFromDom() {} };
    runInNewContext('do {' + branch + '} while(false);', context); runInNewContext('do {' + branch + '} while(false);', context);
    assert.equal(appends, 1);
    assert.ok(asset('media/chat/imageGeneration.js').includes("tasks = []; renderTasks(); loadTasks();"), 'History init checks tasks even when the configuration dialog is closed');
});

test('image tool schemas advertise automatic completion instead of task polling', () => {
    const generate = IMAGE_TOOL_SCHEMAS.filter(schema => ['openapi_generate_image', 'openapi_edit_image'].includes(schema.name));
    for (const schema of generate) { assert.match(schema.description, /automatically sent.*user message/); assert.match(schema.description, /no polling is required/); }
    assert.match(IMAGE_TOOL_SCHEMAS.find(schema => schema.name === 'openapi_get_image_task')!.description, /do not use this tool for routine polling/);
});

test('image tools and completion UI never rewrite file URLs, expand resource roots or install preview hooks', () => {
    const imageUi = asset('media/chat/imageGeneration.js'), mainUi = asset('media/chat/main.js');
    for (const removed of ['imageGeneration/resources', 'imageMarkup', 'linkMarkup', 'appendPreview', 'setResources', 'refreshPreviews']) {
        assert.ok(!imageUi.includes(removed), removed); assert.ok(!mainUi.includes(`imageGenerationUi?.${removed}`), removed);
    }
    for (const file of ['src/chat/chatViewHost.ts', 'src/editorChat/runtime.ts', 'src/editorChat/leftSession.ts', 'src/imageTools/imageToolHost.ts']) {
        const source = asset(file);
        for (const removed of ['generatedImageWebviewUrl', 'resetGeneratedImageResources', 'resourceUrl:', 'resetResources:', 'publishResources']) assert.ok(!source.includes(removed), `${file}: ${removed}`);
    }
});

test('image stdio process starts without vscode and lists tools without receiving a secret or relay', async () => {
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(resolve(root, 'out/imageTools/imageMcpServer'))}).startImageMcpServer()`], {
        env: { ...process.env, LLS_IMAGE_TOOL_RELAY_PORT: '', LLS_IMAGE_TOOL_CAPABILITY: '' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '', errors = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    assert.equal(code, 0, errors); assert.equal(JSON.parse(output).result.tools.length, 6);
});
