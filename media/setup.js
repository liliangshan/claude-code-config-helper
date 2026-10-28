/** @file Three-step onboarding UI. Credentials and model editing stay in the existing settings page. */
(() => {
    const api = acquireVsCodeApi(); let state;
    window.llsSetupApi = api;
    const messages = {
        'zh-tw': ['Claude Code 安裝與設定','1. 語言與 CLI 路徑','2. 提供者與模型','3. 確認並開始','尚未設定 CLI','安裝目錄：','選擇既有 CLI 並驗證','下載官方 CLI','安裝目錄','驗證目前路徑','檢查更新','下一步','新增提供者、金鑰及模型後返回此頁。不需要付費測試。','新增 / 管理模型','請選擇預設模型','返回','完成後開啟右側聊天，不會自動傳送訊息。','完成並開啟聊天','取消下載'],
        ja: ['Claude Code の設定','1. 言語と CLI','2. プロバイダーとモデル','3. 設定の完了','CLI 未設定','インストール先：','既存 CLI を選択','公式 CLI をダウンロード','保存先','現在のパスを検証','更新を確認','次へ','設定でプロバイダーとモデルを追加して戻ってください。有料テストは不要です。','モデルを管理','既定モデルを選択','戻る','設定後に右側のチャットを開きます。自動送信しません。','完了してチャットを開く','ダウンロードを中止'],
        ko: ['Claude Code 설정','1. 언어 및 CLI','2. 공급자 및 모델','3. 설정 완료','CLI 미설정','설치 위치: ','기존 CLI 선택','공식 CLI 다운로드','설치 폴더','현재 경로 확인','업데이트 확인','다음','설정에서 공급자와 모델을 추가한 후 돌아오세요. 유료 테스트는 필요하지 않습니다.','모델 관리','기본 모델 선택','뒤로','완료하면 오른쪽 채팅이 열립니다. 메시지는 자동 전송되지 않습니다.','완료하고 채팅 열기','다운로드 취소'],
        fr: ['Configuration Claude Code','1. Langue et CLI','2. Fournisseurs et modèles','3. Terminer','CLI non configuré','Dossier : ','Choisir un CLI existant','Télécharger le CLI officiel','Dossier d’installation','Vérifier le chemin','Vérifier les mises à jour','Suivant','Ajoutez un fournisseur et un modèle dans les paramètres, puis revenez ici. Aucun test payant requis.','Gérer les modèles','Choisir le modèle par défaut','Retour','Le chat s’ouvrira à droite sans envoyer de message.','Terminer et ouvrir le chat','Annuler le téléchargement'],
        de: ['Claude Code einrichten','1. Sprache und CLI','2. Anbieter und Modelle','3. Abschließen','CLI nicht eingerichtet','Installationsordner: ','Vorhandene CLI auswählen','Offizielle CLI herunterladen','Installationsordner','Pfad prüfen','Nach Updates suchen','Weiter','Anbieter und Modelle in den Einstellungen hinzufügen und zurückkehren. Kein kostenpflichtiger Test nötig.','Modelle verwalten','Standardmodell auswählen','Zurück','Danach öffnet sich der Chat rechts. Keine automatische Nachricht.','Abschließen und Chat öffnen','Download abbrechen']
    };
    const english = ['Claude Code setup','1. Language and CLI','2. Providers and models','3. Finish setup','CLI not configured','Install directory: ','Select existing CLI','Download official CLI','Install directory','Verify current path','Check for updates','Next','Add providers, credentials and models in settings, then return here. Paid test requests are not required.','Add / manage models','Select default model','Back','Open the right chat after setup; no message is sent automatically.','Finish and open chat','Cancel download'];
    /** Resolve the current UI language without changing English internal protocol identifiers. */
    const text = (cn, en) => state?.language === 'zh-cn' ? cn : messages[state?.language]?.[english.indexOf(en)] || en;
    const labels = {
        en: ['Language', 'Installation source', 'Official npm', 'China mirror · npmmirror', 'Third-party mirror; versions may sync later. Package integrity is still verified.', 'Advanced options', 'Current CLI', 'Not verified', 'Verified', 'Change directory', 'Download and install', 'Checking version…', 'Waiting for confirmation…', 'Downloading CLI…', 'Verifying and installing…', 'Switching active sessions…', 'Installation complete', 'Cancelled', 'Installation failed', 'Already up to date', 'Use the detected CLI or install a managed version. Next verifies the current path automatically.', 'CLI', 'Models', 'Ready', 'Choose the model you want to start with.'],
        'zh-cn': ['界面语言', '安装源', '官方 npm', '中国镜像 · npmmirror', '第三方镜像，版本同步可能延迟；下载仍进行完整性校验。', '高级选项', '当前 CLI', '待验证', '已验证', '更改目录', '下载安装', '正在检查版本…', '等待确认安装…', '正在下载 CLI…', '正在校验和安装…', '正在切换活动会话…', '安装完成', '已取消', '安装失败', '已是最新版本', '使用检测到的 CLI，或下载托管版本。点击下一步将自动验证当前路径。', 'CLI 配置', '模型配置', '开始使用', '选择开始聊天时使用的默认模型。'],
        'zh-tw': ['介面語言', '安裝來源', '官方 npm', '中國鏡像 · npmmirror', '第三方鏡像，版本同步可能延遲；下載仍進行完整性校驗。', '進階選項', '目前 CLI', '待驗證', '已驗證', '更改目錄', '下載安裝', '正在檢查版本…', '等待確認安裝…', '正在下載 CLI…', '正在校驗與安裝…', '正在切換活動會話…', '安裝完成', '已取消', '安裝失敗', '已是最新版本', '使用偵測到的 CLI，或下載託管版本。按下一步會自動驗證目前路徑。', 'CLI 設定', '模型設定', '開始使用', '選擇開始聊天時使用的預設模型。'],
        ja: ['表示言語', 'インストール元', '公式 npm', '中国ミラー · npmmirror', '第三者ミラーは同期が遅れる場合があります。整合性は検証されます。', '詳細オプション', '現在の CLI', '未検証', '検証済み', '保存先を変更', 'ダウンロードしてインストール', 'バージョンを確認中…', '確認待ち…', 'CLI をダウンロード中…', '検証とインストール中…', 'セッションを切り替え中…', 'インストール完了', 'キャンセル済み', 'インストール失敗', '最新バージョンです', '既存 CLI または管理版を使用できます。「次へ」でパスを検証します。', 'CLI', 'モデル', '開始', '最初に使用するモデルを選択してください。'],
        ko: ['표시 언어', '설치 소스', '공식 npm', '중국 미러 · npmmirror', '타사 미러는 동기화가 지연될 수 있습니다. 무결성 검사는 유지됩니다.', '고급 옵션', '현재 CLI', '확인 필요', '확인됨', '폴더 변경', '다운로드 및 설치', '버전 확인 중…', '확인 대기 중…', 'CLI 다운로드 중…', '확인 및 설치 중…', '세션 전환 중…', '설치 완료', '취소됨', '설치 실패', '최신 버전', '기존 CLI 또는 관리 버전을 사용하세요. 다음 단계에서 경로를 확인합니다.', 'CLI', '모델', '시작', '처음 사용할 모델을 선택하세요.'],
        fr: ['Langue', 'Source d’installation', 'npm officiel', 'Miroir chinois · npmmirror', 'Miroir tiers : synchronisation parfois retardée. L’intégrité est vérifiée.', 'Options avancées', 'CLI actuel', 'À vérifier', 'Vérifié', 'Changer de dossier', 'Télécharger et installer', 'Vérification de version…', 'En attente de confirmation…', 'Téléchargement du CLI…', 'Vérification et installation…', 'Changement des sessions…', 'Installation terminée', 'Annulé', 'Échec de l’installation', 'Déjà à jour', 'Utilisez le CLI détecté ou une version gérée. Suivant vérifie le chemin automatiquement.', 'CLI', 'Modèles', 'Démarrer', 'Choisissez votre modèle par défaut.'],
        de: ['Sprache', 'Installationsquelle', 'Offizielle npm-Quelle', 'China-Spiegel · npmmirror', 'Drittanbieter-Spiegel: Synchronisierung eventuell verzögert. Integrität wird geprüft.', 'Erweiterte Optionen', 'Aktuelle CLI', 'Nicht geprüft', 'Geprüft', 'Ordner ändern', 'Herunterladen und installieren', 'Version wird geprüft…', 'Warte auf Bestätigung…', 'CLI wird heruntergeladen…', 'Prüfung und Installation…', 'Sitzungen werden umgestellt…', 'Installation abgeschlossen', 'Abgebrochen', 'Installation fehlgeschlagen', 'Bereits aktuell', 'Vorhandene CLI oder verwaltete Version verwenden. Weiter prüft den Pfad automatisch.', 'CLI', 'Modelle', 'Starten', 'Wählen Sie Ihr Standardmodell.']
    };
    const providerLabels = {
        en: ['Providers', 'Workspace model', 'Add / manage providers', 'Add providers, credentials and their models here. Choose the workspace model in the next step.', 'No providers configured yet.', 'enabled models', 'Disabled', 'Choose a model for this workspace.'],
        'zh-cn': ['供应商管理', '工作区模型', '添加 / 管理供应商', '先添加供应商、凭据及其模型；下一步再选择当前工作区使用的模型。', '尚未添加供应商。', '个可用模型', '已停用', '选择当前工作区聊天使用的模型。'],
        'zh-tw': ['供應商管理', '工作區模型', '新增 / 管理供應商', '先新增供應商、憑證及其模型；下一步再選擇目前工作區使用的模型。', '尚未新增供應商。', '個可用模型', '已停用', '選擇目前工作區聊天使用的模型。'],
        ja: ['プロバイダー管理', 'ワークスペースモデル', 'プロバイダーを追加 / 管理', 'プロバイダー、認証情報とモデルを追加します。ワークスペースモデルは次のステップで選びます。', 'プロバイダーがありません。', '利用可能なモデル', '無効', 'このワークスペースで使用するモデルを選択してください。'],
        ko: ['공급자 관리', '작업 영역 모델', '공급자 추가 / 관리', '공급자, 인증 정보 및 모델을 추가하세요. 다음 단계에서 작업 영역 모델을 선택합니다.', '공급자가 없습니다.', '사용 가능한 모델', '비활성', '이 작업 영역에서 사용할 모델을 선택하세요.'],
        fr: ['Fournisseurs', 'Modèle de l’espace de travail', 'Ajouter / gérer les fournisseurs', 'Ajoutez les fournisseurs, identifiants et modèles. Le modèle de l’espace de travail se choisit à l’étape suivante.', 'Aucun fournisseur configuré.', 'modèles disponibles', 'Désactivé', 'Choisissez le modèle de cet espace de travail.'],
        de: ['Anbieter verwalten', 'Arbeitsbereichsmodell', 'Anbieter hinzufügen / verwalten', 'Anbieter, Zugangsdaten und Modelle hinzufügen. Das Arbeitsbereichsmodell wird im nächsten Schritt gewählt.', 'Keine Anbieter eingerichtet.', 'verfügbare Modelle', 'Deaktiviert', 'Modell für diesen Arbeitsbereich auswählen.']
    };
    const workspaceLabels = {
        en: ['General task model', 'Task flow model', 'Compaction model', 'Reasoning effort', 'Not configured (use general model)', 'Off (use the CLI default)', 'Auto', 'Low', 'Medium', 'High', 'XHigh', 'Saved to this workspace. Auto adds no reasoning override; model support may vary.'],
        'zh-cn': ['一般任务模型', '任务流模型', '压缩模型', '思考模式', '未设置（沿用一般模型）', '关闭（使用 CLI 默认）', '自动', '低', '中', '高', '极高', '保存到当前工作区。自动不额外指定思考等级，实际支持程度取决于模型。'],
        'zh-tw': ['一般任務模型', '任務流模型', '壓縮模型', '思考模式', '未設定（沿用一般模型）', '關閉（使用 CLI 預設）', '自動', '低', '中', '高', '極高', '儲存至目前工作區。自動不額外指定思考等級，實際支援程度取決於模型。'],
        ja: ['通常タスクモデル', 'タスクフローモデル', '圧縮モデル', '推論レベル', '未設定（通常モデルを使用）', 'オフ（CLI の既定）', '自動', '低', '中', '高', '最高', 'このワークスペースに保存します。自動は推論レベルを上書きしません。対応状況はモデルによります。'],
        ko: ['일반 작업 모델', '작업 흐름 모델', '압축 모델', '추론 수준', '미설정 (일반 모델 사용)', '끄기 (CLI 기본값)', '자동', '낮음', '중간', '높음', '매우 높음', '현재 작업 영역에 저장됩니다. 자동은 추론 수준을 지정하지 않습니다. 지원 범위는 모델에 따라 다릅니다.'],
        fr: ['Modèle général', 'Modèle du flux de tâches', 'Modèle de compression', 'Niveau de raisonnement', 'Non configuré (modèle général)', 'Désactivé (défaut du CLI)', 'Auto', 'Faible', 'Moyen', 'Élevé', 'Très élevé', 'Enregistré dans cet espace de travail. Auto ne force aucun niveau ; la prise en charge dépend du modèle.'],
        de: ['Allgemeines Aufgabenmodell', 'Aufgabenflussmodell', 'Komprimierungsmodell', 'Denktiefe', 'Nicht konfiguriert (allgemeines Modell)', 'Aus (CLI-Standard)', 'Automatisch', 'Niedrig', 'Mittel', 'Hoch', 'Sehr hoch', 'Im aktuellen Arbeitsbereich gespeichert. Automatisch überschreibt keine Denktiefe; Unterstützung ist modellabhängig.']
    };
    /** Resolve the shared model roles and reasoning labels in the selected setup language. */
    const workspaceText = index => (workspaceLabels[state?.language] || workspaceLabels.en)[index];
    /** Resolve provider-management and workspace-selection labels independently from legacy setup text. */
    const providerText = index => (providerLabels[state?.language] || providerLabels.en)[index];
    /** Resolve new setup labels in the current language with an English fallback. */
    const label = index => (labels[state?.language] || labels.en)[index];
    /** Build a text-only DOM element without interpolating paths or model names as HTML. */
    function node(tag, className, value) {
        const element = document.createElement(tag); element.className = className || '';
        if (value !== undefined) element.textContent = value;
        return element;
    }
    /** Build an action control; busy operations block navigation but allow download cancellation. */
    function action(caption, type, className = 'secondary') {
        const element = node('button', className, caption); element.type = 'button';
        element.disabled = state.busy && type !== 'cancelDownload';
        element.onclick = () => api.postMessage({ type }); return element;
    }
    /** Build a translated action using the existing seven-language setup strings. */
    function button(cn, en, type, className) { return action(text(cn, en), type, className); }
    /** Render one labeled value with safe wrapping for long executable paths. */
    function info(caption, value, className = '') {
        const row = node('div', `info-row ${className}`);
        row.append(node('span', 'field-label', caption), node('div', 'info-value', value)); return row;
    }
    /** Build a role-specific model selector with explicit optional fallback and provider-qualified identity. */
    function modelSelector(caption, id, type, current, fallback) {
        const field = node('label', 'model-field'); field.append(node('span', 'field-label', caption));
        const select = node('select'); select.id = id; select.disabled = state.busy;
        const blank = node('option', '', fallback || text('请选择默认模型', 'Select default model')); blank.value = ''; select.append(blank);
        for (const item of state.models) {
            const key = `${item.providerId}/${item.modelId}`;
            const option = node('option', '', item.label); option.value = JSON.stringify({ providerId: item.providerId, modelId: item.modelId });
            option.selected = current === key || (id === 'compaction-model' && current === item.modelId); select.append(option);
        }
        select.onchange = () => {
            if (select.value) api.postMessage({ type, ...JSON.parse(select.value) });
            else if (fallback) api.postMessage({ type, value: '' });
        };
        field.append(select); return field;
    }
    /** Update only the progress region so byte updates preserve focus and expanded advanced options. */
    function renderProgress() {
        const region = document.getElementById('install-progress'); if (!region) return;
        const progress = state.progress; region.hidden = !progress;
        if (!progress) return;
        const phases = { checking: 11, confirming: 12, downloading: 13, verifying: 14, switching: 15, complete: 16, cancelled: 17, error: 18, current: 19 };
        const terminal = ['complete', 'cancelled', 'error', 'current'].includes(progress.phase);
        region.dataset.phase = progress.phase;
        document.getElementById('progress-title').textContent = `${label(phases[progress.phase] ?? 11)}${progress.version ? ` · ${progress.version}` : ''}`;
        const bar = document.getElementById('progress-bar');
        const percent = progress.total > 0 ? Math.min(100, Math.max(0, progress.bytes / progress.total * 100)) : undefined;
        if (progress.phase === 'downloading' && percent !== undefined) bar.value = percent;
        else if (['complete', 'current'].includes(progress.phase)) bar.value = 100;
        else bar.removeAttribute('value');
        bar.hidden = terminal && !['complete', 'current'].includes(progress.phase);
        const size = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
        document.getElementById('progress-detail').textContent = progress.phase === 'downloading'
            ? `${percent === undefined ? '' : `${Math.floor(percent)}% · `}${size(progress.bytes || 0)}${progress.total ? ` / ${size(progress.total)}` : ''}` : progress.error || '';
        document.getElementById('cancel-download').hidden = !state.busy || !['checking', 'confirming', 'downloading', 'verifying'].includes(progress.phase);
    }
    /** Render the responsive wizard, keeping frequent actions separate from advanced path controls. */
    function render() {
        document.documentElement.lang = state.language;
        document.getElementById('title').textContent = text('Claude Code 安装与配置', 'Claude Code setup');
        document.getElementById('environment').textContent = state.state.environmentId;
        document.getElementById('error').textContent = state.error || '';
        const page = document.getElementById('page');
        const expanded = page.querySelector('details')?.open || false;
        page.replaceChildren();
        if (state.canReturnToSettings) {
            const settingsLabels = { en: 'Back to settings', 'zh-cn': '返回设置', 'zh-tw': '返回設定', ja: '設定に戻る', ko: '설정으로 돌아가기', fr: 'Retour aux paramètres', de: 'Zurück zu Einstellungen' };
            page.append(action(settingsLabels[state.language] || settingsLabels.en, 'settings', 'link-button'));
        }
        const step = state.state.lastStep;
        const steps = node('ol', 'steps'); steps.setAttribute('aria-label', text('Claude Code 安装与配置', 'Claude Code setup'));
        [21, 22, 23].forEach((key, index) => {
            const item = node('li', index + 1 === step ? 'active' : index + 1 < step ? 'done' : '');
            if (index + 1 === step) item.setAttribute('aria-current', 'step');
            item.append(node('span', 'step-number', index + 1 < step ? '✓' : String(index + 1)), node('span', '', index === 0 ? label(key) : providerText(index - 1))); steps.append(item);
        });
        page.append(steps);
        if (step === 1) {
            const preferences = node('div', 'preferences');
            const languageField = node('label', 'preference'); languageField.append(node('span', 'field-label', label(0)));
            const language = node('select'); language.id = 'setup-language';
            for (const [value, name] of Object.entries({ auto:'Auto', 'zh-cn':'简体中文', 'zh-tw':'繁體中文', en:'English', ja:'日本語', ko:'한국어', fr:'Français', de:'Deutsch' })) {
                const option = node('option', '', name); option.value = value; option.selected = value === (state.configuredLanguage || state.language); language.append(option);
            }
            language.disabled = state.busy; language.onchange = () => api.postMessage({ type:'language', value:language.value }); languageField.append(language);
            const sourceField = node('label', 'preference'); sourceField.append(node('span', 'field-label', label(1)));
            const source = node('select'); source.id = 'install-source';
            for (const [value, caption] of [['official', label(2)], ['china', label(3)]]) {
                const option = node('option', '', caption); option.value = value; option.selected = value === (state.installSource || 'official'); source.append(option);
            }
            source.disabled = state.busy; source.onchange = () => api.postMessage({ type: 'installSource', value: source.value }); sourceField.append(source);
            preferences.append(languageField, sourceField); page.append(preferences);
            if (state.installSource === 'china') page.append(node('p', 'mirror-note', label(4)));
        }
        const section = node('section', 'setup-card');
        const heading = step === 1 ? text('1. 语言与 CLI 路径', '1. Language and CLI') : providerText(step - 2);
        section.append(node('h2', '', heading.replace(/^\d\.\s*/, '')));
        const footer = node('footer', 'actions');
        if (step === 1) {
            section.append(node('p', 'description', label(20)));
            const verified = state.cliPath && state.state.cli?.path === state.cliPath;
            const cli = info(label(6), state.cliPath || text('尚未配置 CLI', 'CLI not configured'), 'cli-path');
            cli.append(node('span', `status ${verified ? 'verified' : ''}`, verified ? `${label(8)} · ${state.state.cli.version}` : label(7))); section.append(cli);
            section.append(info(text('安装目录：', 'Install directory: ').replace(/[：:]\s*$/, ''), state.installRoot));
            const advanced = node('details', 'advanced'); advanced.open = expanded;
            advanced.append(node('summary', '', label(5)));
            const tools = node('div', 'advanced-actions');
            tools.append(button('选择已有 CLI 并验证', 'Select existing CLI', 'pick'), action(label(9), 'root'));
            if (state.cliPath) tools.append(button('验证当前路径', 'Verify current path', 'verifyCurrent'), action(label(10), 'download'));
            advanced.append(tools); section.append(advanced);
            footer.append(state.cliPath ? button('检查更新', 'Check for updates', 'update') : action(label(10), 'download'));
            const next = button('下一步', 'Next', 'next', 'primary'); next.disabled ||= !state.cliPath; footer.append(next);
        } else if (step === 2) {
            section.append(node('p', 'description', providerText(3)));
            const providers = node('div', 'embedded-providers'); providers.id = 'setup-providers';
            section.append(providers);
            footer.append(button('返回', 'Back', 'back'));
            const next = button('下一步', 'Next', 'review', 'primary'); next.disabled ||= !state.models.length; footer.append(next);
        } else {
            section.append(node('p', 'description', providerText(7)));
            const normal = state.current ? `${state.current.providerId}/${state.current.modelId}` : '';
            section.append(modelSelector(workspaceText(0), 'workspace-model', 'selectModel', normal));
            section.append(modelSelector(workspaceText(1), 'task-flow-model', 'selectTaskFlowModel', state.taskFlowModel || '', workspaceText(4)));
            section.append(modelSelector(workspaceText(2), 'compaction-model', 'selectCompactionModel', state.compactionModel?.enabled ? state.compactionModel.modelId : '', workspaceText(5)));
            const effortField = node('label', 'model-field'); effortField.append(node('span', 'field-label', workspaceText(3)));
            const effort = node('select'); effort.id = 'reasoning-effort'; effort.disabled = state.busy;
            ['auto', 'low', 'medium', 'high', 'xhigh'].forEach((value, index) => {
                const option = node('option', '', workspaceText(index + 6)); option.value = value; option.selected = value === (state.reasoningEffort || 'auto'); effort.append(option);
            });
            effort.onchange = () => api.postMessage({ type: 'reasoningEffort', value: effort.value });
            effortField.append(effort); section.append(effortField, node('p', 'description', workspaceText(11)));
            footer.append(button('返回', 'Back', 'back'));
            const finish = button('完成并打开聊天', 'Finish and open chat', 'finish', 'primary');
            finish.disabled ||= !state.models.some(item => state.current?.providerId === item.providerId && state.current?.modelId === item.modelId); footer.append(finish);
        }
        const progress = node('div', 'install-progress'); progress.id = 'install-progress'; progress.hidden = true; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
        const progressHeader = node('div', 'progress-header'); const title = node('strong'); title.id = 'progress-title';
        const cancel = button('取消下载', 'Cancel download', 'cancelDownload', 'link-button'); cancel.id = 'cancel-download';
        progressHeader.append(title, cancel); const bar = node('progress'); bar.id = 'progress-bar'; bar.max = 100; bar.setAttribute('aria-label', label(13));
        const detail = node('div', 'progress-detail'); detail.id = 'progress-detail'; progress.append(progressHeader, bar, detail);
        section.append(progress, footer); page.append(section); renderProgress();
        if (step === 2) window.dispatchEvent(new Event('setup/providersMount'));
    }
    window.addEventListener('message', event => {
        if (event.data?.type === 'setup') { state = event.data; render(); }
        else if (event.data?.type === 'setup/progress' && state) { state.progress = event.data.progress; renderProgress(); }
    });
    api.postMessage({ type:'ready' });
})();
