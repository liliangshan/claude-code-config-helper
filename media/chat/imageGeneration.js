/** @file Compact global image connection editor shared by main, parallel and editor chats. */
(function () {
    'use strict';
    const keys = ['image', 'title', 'globalHint', 'enabled', 'source', 'providerMode', 'customMode', 'provider', 'model', 'baseUrl', 'key', 'keySaved', 'keyEmpty', 'deleteKey', 'noAuth', 'cancel', 'check', 'save', 'refresh', 'tasks', 'open', 'notConfigured', 'disabled', 'invalid', 'checked', 'conflict', 'empty', 'queued', 'running', 'succeeded', 'partially_failed', 'failed', 'interrupted', 'unverified', 'error', 'close', 'storage', 'sizeHint'];
    const translations = {};
    const rows = {
        en: ['Image', 'Image generation', 'Global connection · shared by all chats', 'Enable image tools', 'Connection', 'Existing provider', 'Independent connection', 'Provider', 'Model', 'Base URL', 'API Key', 'Key saved · leave blank to keep', 'No key saved', 'Remove saved key', 'No authentication', 'Cancel', 'Check locally', 'Save configuration', 'Reload configuration', 'Image tasks in this chat', 'Open image', 'Not configured', 'Disabled', 'Invalid configuration', 'Local checks passed. The image API has not been tested.', 'Configuration changed elsewhere. Reload before saving.', 'No image tasks yet', 'Queued', 'Running', 'Succeeded', 'Partially failed', 'Failed', 'Interrupted', 'Select an Images-compatible model. Missing models can be added in provider settings.', 'Operation failed. Check configuration, permissions and storage. Do not automatically repeat a paid request.', 'Close', 'Images and tasks are saved in the workspace', 'The model submits the image size for each request. Requests may incur charges; editing sends source images to the provider.'],
        'zh-cn': ['图片', '图片生成', '全局连接 · 所有聊天会话共用', '启用图片工具', '连接方式', '已有提供商', '独立配置', '提供商', '模型', 'Base URL', 'API Key', '密钥已保存 · 留空即可保留', '尚未保存密钥', '移除已保存密钥', '无需鉴权', '取消', '本地检查', '保存配置', '重新加载配置', '当前会话的图片任务', '打开图片', '未配置', '已关闭', '配置失效', '本地检查通过，尚未测试真实图片接口。', '配置已在其他入口更新，请重新加载后保存。', '暂无图片任务', '排队中', '执行中', '已完成', '部分失败', '失败', '已中断', '请选择支持图片接口的模型，缺少的模型可在提供商设置中添加。', '操作失败，请检查配置、权限和存储，不要自动重复计费请求。', '关闭', '图片和任务保存在当前工作区', '图片尺寸由模型每次调用时提交。请求可能计费，编辑原图会发送给所选服务商。'],
        'zh-tw': ['圖片', '圖片生成', '全域連線 · 所有聊天會話共用', '啟用圖片工具', '連線方式', '既有提供商', '獨立設定', '提供商', '模型', 'Base URL', 'API Key', '金鑰已儲存 · 留空即可保留', '尚未儲存金鑰', '移除已儲存金鑰', '無需驗證', '取消', '本機檢查', '儲存設定', '重新載入設定', '目前會話的圖片任務', '開啟圖片', '未設定', '已關閉', '設定失效', '本機檢查通過，尚未測試實際圖片介面。', '設定已在其他入口更新，請重新載入後儲存。', '尚無圖片任務', '排隊中', '執行中', '已完成', '部分失敗', '失敗', '已中斷', '請選擇支援圖片介面的模型，缺少的模型可在提供商設定中新增。', '操作失敗，請檢查設定、權限與儲存，不要自動重複計費請求。', '關閉', '圖片與任務儲存在目前工作區', '圖片尺寸由模型每次呼叫時提交。請求可能計費，編輯原圖會傳送給所選服務商。'],
        ja: ['画像', '画像生成', '共通接続 · すべての会話で共有', '画像ツールを有効化', '接続方法', '既存プロバイダー', '独立した接続', 'プロバイダー', 'モデル', 'Base URL', 'API Key', 'キー保存済み · 空欄で保持', '保存済みキーなし', '保存キーを削除', '認証なし', 'キャンセル', 'ローカル確認', '設定を保存', '設定を再読込', 'この会話の画像タスク', '画像を開く', '未設定', '無効', '設定エラー', 'ローカル確認済み。画像 API は未検証です。', '別の画面で変更されました。再読込してください。', '画像タスクなし', '待機中', '実行中', '完了', '一部失敗', '失敗', '中断', '画像 API 対応モデルを選択してください。モデルはプロバイダー設定で追加できます。', '設定、権限、保存先を確認し、有料リクエストを自動再実行しないでください。', '閉じる', '画像とタスクはワークスペースに保存', '画像サイズはモデルがリクエストごとに指定します。料金が発生する場合があり、編集元画像はプロバイダーに送信されます。'],
        ko: ['이미지', '이미지 생성', '전역 연결 · 모든 대화에서 공유', '이미지 도구 활성화', '연결 방식', '기존 제공자', '독립 연결', '제공자', '모델', 'Base URL', 'API Key', '키 저장됨 · 비우면 유지', '저장된 키 없음', '저장된 키 삭제', '인증 없음', '취소', '로컬 확인', '설정 저장', '설정 새로고침', '현재 대화의 이미지 작업', '이미지 열기', '미설정', '비활성', '설정 오류', '로컬 확인 완료. 이미지 API는 미검증입니다.', '다른 곳에서 설정이 변경되었습니다. 새로고침하세요.', '이미지 작업 없음', '대기 중', '실행 중', '완료', '부분 실패', '실패', '중단됨', '이미지 API 지원 모델을 선택하세요. 제공자 설정에서 모델을 추가할 수 있습니다.', '설정, 권한, 저장소를 확인하고 유료 요청을 자동 반복하지 마세요.', '닫기', '이미지와 작업은 작업 공간에 저장', '이미지 크기는 모델이 요청마다 제출합니다. 요금이 발생할 수 있으며 편집 원본은 제공자에게 전송됩니다.'],
        fr: ['Image', 'Génération d’images', 'Connexion globale · partagée entre tous les chats', 'Activer les outils image', 'Connexion', 'Fournisseur existant', 'Connexion indépendante', 'Fournisseur', 'Modèle', 'Base URL', 'API Key', 'Clé enregistrée · vide pour conserver', 'Aucune clé enregistrée', 'Supprimer la clé', 'Sans authentification', 'Annuler', 'Vérifier localement', 'Enregistrer', 'Recharger', 'Tâches image de ce chat', 'Ouvrir l’image', 'Non configuré', 'Désactivé', 'Configuration invalide', 'Vérifications locales réussies. API image non testée.', 'Configuration modifiée ailleurs. Rechargez avant d’enregistrer.', 'Aucune tâche image', 'En attente', 'En cours', 'Terminé', 'Échec partiel', 'Échec', 'Interrompu', 'Choisissez un modèle compatible Images. Ajoutez les modèles manquants dans les paramètres du fournisseur.', 'Vérifiez configuration, autorisations et stockage. Ne répétez pas automatiquement une requête payante.', 'Fermer', 'Images et tâches enregistrées dans le projet', 'Le modèle précise la taille à chaque requête. Des frais peuvent s’appliquer ; les sources sont envoyées au fournisseur pour l’édition.'],
        de: ['Bild', 'Bilderzeugung', 'Globale Verbindung · für alle Chats', 'Bildwerkzeuge aktivieren', 'Verbindung', 'Vorhandener Anbieter', 'Separate Verbindung', 'Anbieter', 'Modell', 'Base URL', 'API Key', 'Schlüssel gespeichert · leer lassen zum Beibehalten', 'Kein Schlüssel gespeichert', 'Schlüssel entfernen', 'Keine Authentifizierung', 'Abbrechen', 'Lokal prüfen', 'Speichern', 'Neu laden', 'Bildaufgaben dieses Chats', 'Bild öffnen', 'Nicht konfiguriert', 'Deaktiviert', 'Ungültige Konfiguration', 'Lokale Prüfung erfolgreich. Bild-API nicht getestet.', 'Konfiguration wurde anderswo geändert. Bitte neu laden.', 'Keine Bildaufgaben', 'Wartend', 'Läuft', 'Erfolgreich', 'Teilweise fehlgeschlagen', 'Fehlgeschlagen', 'Unterbrochen', 'Images-kompatibles Modell wählen. Fehlende Modelle in den Anbietereinstellungen ergänzen.', 'Konfiguration, Berechtigungen und Speicher prüfen. Kostenpflichtige Anfragen nicht automatisch wiederholen.', 'Schließen', 'Bilder und Aufgaben werden im Arbeitsbereich gespeichert', 'Die Bildgröße wird bei jeder Anfrage vom Modell angegeben. Kosten können entstehen; Quellbilder werden zur Bearbeitung an den Anbieter gesendet.']
    };
    Object.entries(rows).forEach(([language, values]) => { translations[language] = Object.fromEntries(keys.map((key, index) => [key, values[index]])); });

    /** Install isolated image UI using the existing acquired VS Code API, never acquiring another instance. */
    window.createImageGenerationUi = function (post) {
        let language = 'en', state, draftRevision = 0, openingId = '', operationId = '', tasksId = '', scopeId = '', tasks = [];
        const chip = document.querySelector('[data-role="composer-image-chip"]');
        const chipName = document.querySelector('[data-role="composer-image-chip-name"]');
        const dialog = document.createElement('dialog'); dialog.className = 'image-picker'; dialog.dataset.role = 'image-picker';
        const form = document.createElement('form'); form.className = 'image-picker__form'; dialog.append(form); document.body.append(dialog);
        const fields = {}, labels = [];
        /** Resolve bundled labels; provider names and task data never become HTML. */
        function t(key) { return translations[language]?.[key] || translations.en[key] || key; }
        /** Create a localizable text node and retain it for live language changes. */
        function label(tag, key, parent, className) {
            const element = document.createElement(tag); if (className) element.className = className;
            labels.push({ element, key }); element.textContent = t(key); parent.append(element); return element;
        }
        /** Create a keyboard-accessible action with an explicit non-submit button type. */
        function button(key, parent, action, className = 'image-picker__button') {
            const control = label('button', key, parent, className); control.type = 'button'; control.addEventListener('click', action); return control;
        }
        const header = document.createElement('header'); header.className = 'image-picker__header'; form.append(header);
        const heading = document.createElement('div'); header.append(heading);
        const title = label('h2', 'title', heading); title.id = 'image-picker-title'; dialog.setAttribute('aria-labelledby', title.id);
        label('p', 'globalHint', heading, 'image-picker__subtitle');
        const close = button('close', header, () => dialog.close(), 'image-picker__close'); close.textContent = '×';
        const body = document.createElement('div'); body.className = 'image-picker__body'; form.append(body);
        /** Create an associated input/select field; checkbox layout is styled independently of text fields. */
        function field(key, caption, type, parent = body) {
            const wrapper = document.createElement('label'); wrapper.className = 'image-picker__field' + (type === 'checkbox' ? ' image-picker__toggle' : '');
            const input = document.createElement(type === 'select' ? 'select' : 'input');
            if (type !== 'select') input.type = type;
            input.name = key; input.autocomplete = 'off'; fields[key] = input;
            if (type === 'checkbox') { wrapper.append(input); label('span', caption, wrapper); }
            else { label('span', caption, wrapper); wrapper.append(input); }
            parent.append(wrapper); return input;
        }
        const enableRow = document.createElement('div'); enableRow.className = 'image-picker__enable-row'; body.append(enableRow);
        field('enabled', 'enabled', 'checkbox', enableRow).setAttribute('role', 'switch');
        const reload = button('refresh', enableRow, load, 'image-picker__reload'); reload.textContent = '↻';
        const connection = document.createElement('section'); connection.className = 'image-picker__connection'; body.append(connection);
        label('h3', 'source', connection, 'image-picker__section-title');
        const sourceControl = document.createElement('div'); sourceControl.className = 'image-picker__source'; connection.append(sourceControl);
        sourceControl.setAttribute('role', 'radiogroup'); sourceControl.setAttribute('aria-label', t('source'));
        /** Add a source radio with a clear label instead of a second, redundant filter control. */
        function sourceOption(value, key) {
            const wrapper = document.createElement('label'); wrapper.className = 'image-picker__source-option';
            const input = document.createElement('input'); input.type = 'radio'; input.name = 'source'; input.value = value;
            input.addEventListener('change', mode); wrapper.append(input); label('span', key, wrapper); sourceControl.append(wrapper); return input;
        }
        const providerRadio = sourceOption('provider', 'providerMode'); const customRadio = sourceOption('custom', 'customMode'); customRadio.checked = true;
        const providerSection = document.createElement('fieldset'); providerSection.className = 'image-picker__fields'; connection.append(providerSection);
        field('providerId', 'provider', 'select', providerSection);
        field('providerModel', 'model', 'select', providerSection);
        const providerSummary = document.createElement('p'); providerSummary.className = 'image-picker__summary'; providerSection.append(providerSummary);
        label('p', 'unverified', providerSection, 'image-picker__hint');
        const customSection = document.createElement('fieldset'); customSection.className = 'image-picker__fields'; connection.append(customSection);
        field('baseUrl', 'baseUrl', 'url', customSection).placeholder = 'https://images.example.com/v1';
        const customModel = field('customModel', 'model', 'text', customSection); customModel.setAttribute('list', 'image-model-candidates');
        const candidates = document.createElement('datalist'); candidates.id = 'image-model-candidates'; customSection.append(candidates);
        field('apiKey', 'key', 'password', customSection).autocomplete = 'new-password';
        const keyRow = document.createElement('div'); keyRow.className = 'image-picker__key-row'; customSection.append(keyRow);
        const keyStatus = document.createElement('p'); keyStatus.className = 'image-picker__hint'; keyStatus.id = 'image-key-status'; keyRow.append(keyStatus);
        fields.apiKey.setAttribute('aria-describedby', keyStatus.id);
        const removeKey = button('deleteKey', keyRow, () => { deleteKey = !deleteKey; updateKey(); }, 'image-picker__text-button');
        let deleteKey = false;
        field('noAuth', 'noAuth', 'checkbox', customSection);
        const note = document.createElement('aside'); note.className = 'image-picker__note'; body.append(note);
        label('p', 'sizeHint', note);
        label('p', 'storage', note, 'image-picker__hint');
        const storage = document.createElement('code'); storage.textContent = '.LLSOAI/openapi-image-generation/'; note.append(storage);
        const feedback = document.createElement('p'); feedback.className = 'image-picker__feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); body.append(feedback);
        const taskSection = document.createElement('details'); taskSection.className = 'image-picker__tasks'; body.append(taskSection); label('summary', 'tasks', taskSection);
        const taskList = document.createElement('div'); taskSection.append(taskList);
        button('refresh', taskSection, loadTasks, 'image-picker__text-button');
        const footer = document.createElement('footer'); footer.className = 'image-picker__footer'; form.append(footer);
        const check = button('check', footer, () => submit(true));
        const actions = document.createElement('div'); actions.className = 'image-picker__actions'; footer.append(actions);
        button('cancel', actions, () => dialog.close());
        const save = button('save', actions, () => submit(false), 'image-picker__button image-picker__button--primary');
        /** Read only the current source radio; source is a global selection, not a per-chat setting. */
        function source() { return providerRadio.checked ? 'provider' : 'custom'; }
        /** Reflect explicit credential removal without erasing the stored key until save succeeds. */
        function updateKey() {
            keyStatus.textContent = t(state?.hasApiKey && !deleteKey ? 'keySaved' : 'keyEmpty');
            removeKey.hidden = !state?.hasApiKey; removeKey.setAttribute('aria-pressed', String(deleteKey));
            fields.apiKey.disabled = deleteKey || fields.noAuth.checked; fields.apiKey.placeholder = t(state?.hasApiKey && !deleteKey ? 'keySaved' : 'keyEmpty');
        }
        /** Switch connection groups without discarding the unsaved form or sending a key. */
        function mode() {
            providerSection.hidden = source() !== 'provider'; providerSection.disabled = providerSection.hidden;
            customSection.hidden = source() !== 'custom'; customSection.disabled = customSection.hidden; updateKey();
        }
        /** Populate the existing model dropdown safely; no separate “filter models” input is needed. */
        function modelOptions(selected) {
            const provider = state?.providers.find(item => item.id === fields.providerId.value);
            const select = fields.providerModel; const previous = selected ?? select.value; select.replaceChildren();
            for (const model of provider?.models || []) {
                const item = document.createElement('option'); item.value = model.modelId;
                item.textContent = model.displayName && model.displayName !== model.modelId ? model.displayName + ' · ' + model.modelId : model.modelId; select.append(item);
            }
            if (previous && [...select.options].some(item => item.value === previous)) select.value = previous;
            providerSummary.textContent = provider?.baseUrl || '';
        }
        /** Fill only an explicitly refreshed form so background broadcasts cannot replace unsaved inputs. */
        function fill() {
            if (!state) return; draftRevision = state.config.revision;
            for (const [key, input] of Object.entries(fields)) if (Object.prototype.hasOwnProperty.call(state.config, key)) {
                if (input.type === 'checkbox') input.checked = state.config[key]; else input.value = String(state.config[key] ?? '');
            }
            providerRadio.checked = state.config.source === 'provider'; customRadio.checked = !providerRadio.checked;
            fields.providerId.replaceChildren();
            for (const provider of state.providers) { const item = document.createElement('option'); item.value = provider.id; item.textContent = provider.name; fields.providerId.append(item); }
            if (state.config.providerId) fields.providerId.value = state.config.providerId;
            modelOptions(state.config.modelId);
            fields.customModel.value = state.config.modelId; fields.apiKey.value = ''; deleteKey = false; fields.noAuth.checked = state.config.authMode === 'none';
            candidates.replaceChildren();
            for (const model of new Set([state.config.modelId, ...state.providers.flatMap(provider => provider.models.map(item => item.modelId))].filter(Boolean))) {
                const item = document.createElement('option'); item.value = model; candidates.append(item);
            }
            feedback.textContent = state.error ? t('invalid') + ' · ' + state.error : '';
            mode(); save.disabled = false; check.disabled = false;
        }
        /** Request the latest revision, discarding a password only for an explicit refresh/open. */
        function load() {
            fields.apiKey.value = ''; openingId = crypto.randomUUID(); save.disabled = true; check.disabled = true;
            post({ type: 'imageGeneration/configGet', requestId: openingId });
        }
        /** Query task history separately from shared configuration and without generating images. */
        function loadTasks() { tasksId = crypto.randomUUID(); post({ type: 'imageGeneration/tasksList', requestId: tasksId }); }
        /** Submit connection fields only; dimensions and operational limits are not user settings. */
        function submit(checked) {
            if (!state || !form.reportValidity()) return;
            if (state.config.revision !== draftRevision) { feedback.textContent = t('conflict'); return; }
            const config = { enabled: fields.enabled.checked, source: source(), providerId: fields.providerId.value,
                modelId: source() === 'provider' ? fields.providerModel.value : fields.customModel.value.trim(),
                baseUrl: fields.baseUrl.value.trim(), authMode: fields.noAuth.checked ? 'none' : 'bearer' };
            const keyAction = source() === 'provider' ? 'keep' : deleteKey ? 'delete' : fields.apiKey.value && !fields.noAuth.checked ? 'replace' : 'keep';
            operationId = crypto.randomUUID(); save.disabled = true; check.disabled = true; feedback.textContent = '';
            post({ type: checked ? 'imageGeneration/configCheck' : 'imageGeneration/configSave', requestId: operationId,
                input: { expectedRevision: draftRevision, config, keyAction, ...(!checked && keyAction === 'replace' ? { apiKey: fields.apiKey.value } : {}) } });
            if (!checked) fields.apiKey.value = '';
        }
        /** Render only local task metadata and host-validated open actions, never remote image URLs. */
        function renderTasks() {
            taskList.replaceChildren();
            if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'image-picker__hint'; empty.textContent = t('empty'); taskList.append(empty); return; }
            for (const task of tasks) {
                const card = document.createElement('article'); card.className = 'image-picker__task';
                const heading = document.createElement('strong'); heading.textContent = t(task.status) + ' · ' + task.model + ' · ' + task.size;
                const text = document.createElement('p'); text.textContent = task.prompt; card.append(heading, text);
                if (task.error) { const error = document.createElement('p'); error.textContent = t('error') + ' · ' + task.error; card.append(error); }
                for (const image of task.images || []) {
                    const open = document.createElement('button'); open.type = 'button'; open.className = 'image-picker__button'; open.textContent = t('open') + ' · ' + image.bytes + ' B';
                    open.addEventListener('click', () => post({ type: 'imageGeneration/imageOpen', requestId: crypto.randomUUID(), taskId: task.taskId, imageId: image.id })); card.append(open);
                    const location = document.createElement('p'); location.className = 'image-picker__hint'; location.textContent = image.relativePath; card.append(location);
                }
                taskList.append(card);
            }
        }
        /** Update a localized global model chip without modifying the composer or ordinary models. */
        function updateChip() {
            chip.title = t('title'); chip.setAttribute('aria-label', t('title')); chip.querySelector('[data-image-label]').textContent = t('image') + ':';
            chipName.textContent = !state ? t('notConfigured') : state.error ? t('invalid') : !state.config.modelId ? t('notConfigured') : !state.config.enabled ? t('disabled') : state.config.modelId;
        }
        fields.providerId.addEventListener('change', () => modelOptions('')); fields.noAuth.addEventListener('change', updateKey);
        form.addEventListener('submit', event => { event.preventDefault(); submit(false); });
        chip.addEventListener('click', () => { document.querySelector('[data-role="model-picker"]')?.close(); load(); loadTasks(); if (!dialog.open) dialog.showModal(); });
        dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); } });
        dialog.addEventListener('close', () => { fields.apiKey.value = ''; openingId = ''; operationId = ''; chip.focus(); });
        updateChip(); mode(); renderTasks(); load();
        return {
            /** Apply all seven locales, including tooltips for compact close/reload icons. */
            language(value) {
                language = translations[value] ? value : 'en'; for (const item of labels) item.element.textContent = t(item.key);
                close.textContent = '×'; close.title = t('close'); close.setAttribute('aria-label', t('close'));
                reload.textContent = '↻'; reload.title = t('refresh'); reload.setAttribute('aria-label', t('refresh'));
                sourceControl.setAttribute('aria-label', t('source')); updateKey(); updateChip(); renderTasks();
            },
            /** Consume global state without overwriting drafts and display only the active conversation's tasks. */
            receive(message) {
                if (message.type === 'imageGeneration/state') {
                    if (state && !message.state.error && message.state.config.revision < state.config.revision) return;
                    state = message.state; updateChip();
                    if (message.requestId === openingId) { fill(); openingId = ''; }
                    else if (dialog.open && draftRevision !== state.config.revision) feedback.textContent = t('conflict');
                } else if (message.type === 'imageGeneration/saveResult') {
                    if (message.requestId !== operationId) { if (!message.ok && dialog.open) feedback.textContent = t('error') + ' · ' + message.error; return; }
                    save.disabled = false; check.disabled = false; operationId = '';
                    if (message.ok && !message.checked) dialog.close();
                    else feedback.textContent = message.ok ? t('checked') : t(message.error === 'IMAGE_CONFIG_CONFLICT' ? 'conflict' : 'error') + ' · ' + message.error;
                } else if (message.type === 'imageGeneration/taskUpdate') {
                    if (message.requestId === tasksId) { scopeId = message.scopeId; tasksId = ''; }
                    else if (!scopeId || message.scopeId !== scopeId) return;
                    tasks = message.tasks; renderTasks();
                } else if (message.type === 'session/init' || message.type === 'session/title') {
                    scopeId = ''; tasks = []; renderTasks(); loadTasks();
                }
            }
        };
    };
})();
