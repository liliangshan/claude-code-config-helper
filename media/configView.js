/*
 * Vendored from liliangshan.openapi-compatible-copilot assets/configView/configView.js,
 * first-stage migration trimmed for Claude Code Provider/Model configuration.
 */

(function () {
    const vscode = acquireVsCodeApi();

    /** @type {import('../src/types').ConfigViewState | null} */
    let state = null;

    /** 用户配置的语言，auto 表示跟随 VS Code 显示语言。 */
    let configuredLanguage = 'auto';

    /** 当前实际生效的 UI 语言。 */
    let currentLanguage = 'en';

    /** @type {{ type: 'provider' | 'model', providerId?: string, provider?: any, model?: any } | null} */
    let modalState = null;

    /** @type {Set<string>} 默认隐藏模型列表，用户点击查看模型后记录展开的 provider id。 */
    const expandedProviderIds = new Set();

    /**
     * 当前待展示的顶部广告数据。
     *
     * 由扩展宿主通过 `ad` 类型消息推送；首次推送之前为 `null`，每次 `render()`
     * 重建 DOM 后通过 {@link applyPendingAd} 把数据塞回新 DOM 节点。
     *
     * @type {{ image: string, url: string } | null}
     */
    let pendingAd = null;

    /** 发送消息到扩展宿主。 */
    function post(type, payload) {
        vscode.postMessage({ type, payload });
    }

    /** LLS CCAI 设置页首版多语言字典，缺失语言会回落英文。 */
    const translations = {
        en: {
            loading: 'Loading configuration...',
            appTitle: 'LLS CCAI Setting',
            appSubtitle: 'Manage Claude Code relay, upstream providers, models, prompts and task flow settings.',
            languageLabel: 'Language',
            languageAuto: 'Auto (VS Code)',
            languageEnglish: 'English',
            languageChinese: '简体中文',
            languageTraditionalChinese: '繁體中文',
            languageKorean: '한국어',
            languageJapanese: '日本語',
            languageFrench: 'Français',
            languageGerman: 'Deutsch',
            import: 'Import',
            export: 'Export',
            globalPromptTask: 'Global Prompt / Task Flow',
            workspacePrompt: 'Workspace Prompt',
            openSettingsJson: 'Open settings.json',
            relaySetting: 'Claude Code Relay Setting',
            relayDescription: 'Current model, port and environment variables are synced to Claude Code runtime configuration.',
            currentModel: 'Current Model',
            notSelected: 'Not selected',
            relayStatus: 'Relay Status',
            cliPath: 'Claude CLI Path',
            cliPathPlaceholder: 'No CLI path selected',
            selectCliPath: 'Select Path',
            port: 'Port',
            autoStartRelay: 'Auto-start local relay when extension activates',
            taskFlowBypassPermissions: 'Task flow bypass permissions mode',
            taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
            extraEnvVars: 'Extra environment variables (NAME=VALUE per line)',
            operation: 'Operation',
            apply: 'Apply',
            writeClaudeCodeSettings: 'Write Claude Code Settings',
            providerManagement: 'Provider Management',
            providerDescription: 'Configure upstream providers and models for Claude Code Relay.',
            newProvider: '+ New Provider',
            noProviders: 'No providers yet. Click “New Provider” to start.',
            enableProvider: 'Enable provider',
            baseUrlNotConfigured: 'BaseURL not configured',
            savedApiKey: 'Saved key',
            unsavedApiKey: 'No saved key',
            edit: 'Edit',
            hideModels: 'Hide models',
            viewModels: 'View Models ({count})',
            fetchModels: 'Fetch Models',
            addModel: 'Add Model',
            delete: 'Delete',
            noModels: 'No models yet. Click “Add Model” to add one manually.',
            displayName: 'Display Name',
            switch: 'Switch',
            showInModelDropdown: 'Show in top model dropdown',
            editProvider: 'Edit Provider',
            newProviderModal: 'New Provider',
            providerName: 'Name',
            apiKeyKeepSaved: 'API key (leave empty to keep the saved key)',
            apiKeySavedPlaceholder: 'Saved key; leave empty to keep it unchanged',
            apiKeyPlaceholder: 'Enter API Key / Token',
            apiType: 'API Type',
            authMode: 'Auth Mode',
            enabled: 'Enabled',
            autoFetchModels: 'Auto fetch models',
            cancel: 'Cancel',
            save: 'Save',
            editModel: 'Edit Model',
            modelId: 'Model ID',
            contextLength: 'Context Length',
            maxOutputTokens: 'Max Output Tokens',
            samplingMode: 'Sampling Mode',
            vision: 'Vision',
            toolCalling: 'Tool Calling',
            providerNotFound: 'Provider not found',
            modelIdRequired: 'Model ID is required',
            confirmDeleteProvider: 'Delete this provider?',
            adLabel: 'AD',
            cliInstallHint: 'Tip: If you have not installed Claude CLI or do not know its path, ask an AI assistant or search engine:',
            cliInstallQuery: 'How to install Claude CLI and where is the Claude CLI installation path?',
            windowsCliInstallHint: 'Windows install command:',
            windowsCliPathHint: 'Windows executable path after npm global install:',
            copyWindowsCliInstall: 'Copy Windows install command',
            copyWindowsCliPath: 'Copy Windows executable path',
            windowsCliInstallCopied: 'Windows install command copied',
            windowsCliPathCopied: 'Windows executable path copied',
            copyCliInstallQuery: 'Copy search text',
            cliInstallQueryCopied: 'Search text copied'
        },
        'zh-cn': {
            loading: '正在加载配置...',
            appTitle: 'LLS CCAI Setting',
            appSubtitle: '管理 Claude Code 本地中转、上游提供商、模型、提示词与任务流设置。',
            languageLabel: '语言',
            languageAuto: '跟随 VS Code',
            languageEnglish: 'English',
            languageChinese: '简体中文',
            languageTraditionalChinese: '繁體中文',
            languageKorean: '한국어',
            languageJapanese: '日本語',
            languageFrench: 'Français',
            languageGerman: 'Deutsch',
            import: '导入',
            export: '导出',
            globalPromptTask: '全局提示词/任务流',
            workspacePrompt: '工作区提示词',
            openSettingsJson: '打开 settings.json',
            relaySetting: 'Claude Code Relay Setting',
            relayDescription: '当前模型、端口和环境变量会同步到 Claude Code 运行配置。',
            currentModel: '当前使用模型',
            notSelected: '未选择',
            relayStatus: '中转服务状态',
            cliPath: 'Claude CLI 路径',
            cliPathPlaceholder: '尚未选择 CLI 路径',
            selectCliPath: '选择路径',
            port: '端口',
            autoStartRelay: '扩展启动时自动启动本地中转',
            taskFlowBypassPermissions: '任务流启用 bypass permissions 模式',
            taskFlowBypassPermissionsHint: '写入两个 bypass 权限设置，仅限可信沙箱。',
            extraEnvVars: '额外环境变量（每行 NAME=VALUE）',
            operation: '操作',
            apply: '应用',
            writeClaudeCodeSettings: '一键写入 Claude Code 配置',
            providerManagement: 'Provider Management',
            providerDescription: '配置可供 Claude Code Relay 使用的上游提供商与模型。',
            newProvider: '+ 新建提供商',
            noProviders: '暂无提供商，点击“新建提供商”开始。',
            enableProvider: '启用厂商',
            baseUrlNotConfigured: '未配置 BaseURL',
            savedApiKey: '已保存密钥',
            unsavedApiKey: '未保存密钥',
            edit: '编辑',
            hideModels: '隐藏模型',
            viewModels: '查看模型({count})',
            fetchModels: '拉取模型',
            addModel: '添加模型',
            delete: '删除',
            noModels: '暂无模型，可点击“添加模型”手动添加。',
            displayName: '显示名称',
            switch: '开关',
            showInModelDropdown: '显示在顶部模型下拉',
            editProvider: '编辑提供商',
            newProviderModal: '新建提供商',
            providerName: '名称',
            apiKeyKeepSaved: '密钥（留空则继续使用已保存密钥）',
            apiKeySavedPlaceholder: '已保存密钥，留空不修改',
            apiKeyPlaceholder: '请输入 API Key / Token',
            apiType: 'API 类型',
            authMode: '鉴权模式',
            enabled: '启用',
            autoFetchModels: '自动拉取模型',
            cancel: '取消',
            save: '保存',
            editModel: '编辑模型',
            modelId: '模型 ID',
            contextLength: '上下文长度',
            maxOutputTokens: '最大输出 Tokens',
            samplingMode: '采样模式',
            vision: '视觉',
            toolCalling: '工具调用',
            providerNotFound: '提供商不存在',
            modelIdRequired: '模型 ID 必填',
            confirmDeleteProvider: '确定删除该提供商吗？',
            adLabel: '广告',
            cliInstallHint: '提示：如果你还没安装 Claude CLI，或不知道安装路径在哪，请用 AI 或搜索引擎搜索：',
            cliInstallQuery: '如何安装 Claude CLI 及 Claude CLI的安装路径在哪？',
            windowsCliInstallHint: 'Windows 安装方法：',
            windowsCliPathHint: 'Windows npm 全局安装后的可执行文件路径：',
            copyWindowsCliInstall: '复制 Windows 安装命令',
            copyWindowsCliPath: '复制 Windows 可执行文件路径',
            windowsCliInstallCopied: '已复制 Windows 安装命令',
            windowsCliPathCopied: '已复制 Windows 可执行文件路径',
            copyCliInstallQuery: '复制搜索文本',
            cliInstallQueryCopied: '已复制搜索文本'
        }
    };

    translations['zh-tw'] = {
        loading: '正在載入設定...',
        appTitle: 'LLS CCAI Setting',
        appSubtitle: '管理 Claude Code 本機中轉、上游提供商、模型、提示詞與任務流設定。',
        languageLabel: '語言',
        languageAuto: '跟隨 VS Code',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: '匯入',
        export: '匯出',
        globalPromptTask: '全域提示詞 / 任務流',
        workspacePrompt: '工作區提示詞',
        openSettingsJson: '開啟 settings.json',
        relaySetting: 'Claude Code 中轉設定',
        relayDescription: '目前模型、連接埠和環境變數會同步到 Claude Code 執行設定。',
        currentModel: '目前使用模型',
        notSelected: '未選擇',
        relayStatus: '中轉服務狀態',
        cliPath: 'Claude CLI 路徑',
        cliPathPlaceholder: '尚未選擇 CLI 路徑',
        selectCliPath: '選擇路徑',
        port: '連接埠',
        autoStartRelay: '擴充功能啟動時自動啟動本機中轉',
        taskFlowBypassPermissions: 'Task flow bypass permissions mode',
        taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
        extraEnvVars: '額外環境變數（每行 NAME=VALUE）',
        operation: '操作',
        apply: '套用',
        writeClaudeCodeSettings: '一鍵寫入 Claude Code 設定',
        providerManagement: '提供商管理',
        providerDescription: '設定可供 Claude Code Relay 使用的上游提供商與模型。',
        newProvider: '+ 新增提供商',
        noProviders: '尚無提供商，點擊「新增提供商」開始。',
        enableProvider: '啟用提供商',
        baseUrlNotConfigured: '未設定 BaseURL',
        savedApiKey: '已儲存金鑰',
        unsavedApiKey: '未儲存金鑰',
        edit: '編輯',
        hideModels: '隱藏模型',
        viewModels: '查看模型（{count}）',
        fetchModels: '拉取模型',
        addModel: '新增模型',
        delete: '刪除',
        noModels: '尚無模型，可點擊「新增模型」手動新增。',
        displayName: '顯示名稱',
        switch: '開關',
        showInModelDropdown: '顯示在頂部模型下拉選單',
        editProvider: '編輯提供商',
        newProviderModal: '新增提供商',
        providerName: '名稱',
        apiKeyKeepSaved: '金鑰（留空則繼續使用已儲存金鑰）',
        apiKeySavedPlaceholder: '已儲存金鑰，留空不修改',
        apiKeyPlaceholder: '請輸入 API Key / Token',
        apiType: 'API 類型',
        authMode: '鑑權模式',
        enabled: '啟用',
        autoFetchModels: '自動拉取模型',
        cancel: '取消',
        save: '儲存',
        editModel: '編輯模型',
        modelId: '模型 ID',
        contextLength: '上下文長度',
        maxOutputTokens: '最大輸出 Tokens',
        samplingMode: '取樣模式',
        vision: '視覺',
        toolCalling: '工具呼叫',
        providerNotFound: '提供商不存在',
        modelIdRequired: '模型 ID 必填',
        confirmDeleteProvider: '確定刪除此提供商嗎？',
        adLabel: '廣告'
    };
    translations.ko = {
        loading: '설정을 불러오는 중...',
        appTitle: 'LLS CCAI Setting',
        appSubtitle: 'Claude Code 로컬 릴레이, 업스트림 공급자, 모델, 프롬프트 및 작업 흐름 설정을 관리합니다.',
        languageLabel: '언어',
        languageAuto: 'VS Code 따르기',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: '가져오기',
        export: '내보내기',
        globalPromptTask: '전역 프롬프트 / 작업 흐름',
        workspacePrompt: '작업 영역 프롬프트',
        openSettingsJson: 'settings.json 열기',
        relaySetting: 'Claude Code 릴레이 설정',
        relayDescription: '현재 모델, 포트 및 환경 변수가 Claude Code 실행 설정에 동기화됩니다.',
        currentModel: '현재 모델',
        notSelected: '선택되지 않음',
        relayStatus: '릴레이 상태',
        cliPath: 'Claude CLI 경로',
        cliPathPlaceholder: 'CLI 경로가 선택되지 않았습니다',
        selectCliPath: '경로 선택',
        port: '포트',
        autoStartRelay: '확장이 활성화될 때 로컬 릴레이 자동 시작',
        taskFlowBypassPermissions: 'Task flow bypass permissions mode',
        taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
        extraEnvVars: '추가 환경 변수(줄마다 NAME=VALUE)',
        operation: '작업',
        apply: '적용',
        writeClaudeCodeSettings: 'Claude Code 설정 한 번에 쓰기',
        providerManagement: '공급자 관리',
        providerDescription: 'Claude Code Relay에서 사용할 업스트림 공급자와 모델을 구성합니다.',
        newProvider: '+ 새 공급자',
        noProviders: '아직 공급자가 없습니다. “새 공급자”를 클릭하여 시작하세요.',
        enableProvider: '공급자 활성화',
        baseUrlNotConfigured: 'BaseURL이 구성되지 않음',
        savedApiKey: '저장된 키',
        unsavedApiKey: '저장된 키 없음',
        edit: '편집',
        hideModels: '모델 숨기기',
        viewModels: '모델 보기({count})',
        fetchModels: '모델 가져오기',
        addModel: '모델 추가',
        delete: '삭제',
        noModels: '아직 모델이 없습니다. “모델 추가”를 클릭하여 수동으로 추가하세요.',
        displayName: '표시 이름',
        switch: '스위치',
        showInModelDropdown: '상단 모델 드롭다운에 표시',
        editProvider: '공급자 편집',
        newProviderModal: '새 공급자',
        providerName: '이름',
        apiKeyKeepSaved: 'API 키(비워 두면 저장된 키 유지)',
        apiKeySavedPlaceholder: '저장된 키가 있습니다. 비워 두면 변경하지 않습니다',
        apiKeyPlaceholder: 'API Key / Token 입력',
        apiType: 'API 유형',
        authMode: '인증 모드',
        enabled: '활성화',
        autoFetchModels: '모델 자동 가져오기',
        cancel: '취소',
        save: '저장',
        editModel: '모델 편집',
        modelId: '모델 ID',
        contextLength: '컨텍스트 길이',
        maxOutputTokens: '최대 출력 Tokens',
        samplingMode: '샘플링 모드',
        vision: '비전',
        toolCalling: '도구 호출',
        providerNotFound: '공급자를 찾을 수 없습니다',
        modelIdRequired: '모델 ID는 필수입니다',
        confirmDeleteProvider: '이 공급자를 삭제하시겠습니까?',
        adLabel: '광고'
    };
    translations.ja = {
        loading: '設定を読み込んでいます...',
        appTitle: 'LLS CCAI Setting',
        appSubtitle: 'Claude Code のローカルリレー、上流プロバイダー、モデル、プロンプト、タスクフロー設定を管理します。',
        languageLabel: '言語',
        languageAuto: 'VS Code に従う',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: 'インポート',
        export: 'エクスポート',
        globalPromptTask: 'グローバルプロンプト / タスクフロー',
        workspacePrompt: 'ワークスペースプロンプト',
        openSettingsJson: 'settings.json を開く',
        relaySetting: 'Claude Code リレー設定',
        relayDescription: '現在のモデル、ポート、環境変数は Claude Code の実行設定に同期されます。',
        currentModel: '現在のモデル',
        notSelected: '未選択',
        relayStatus: 'リレー状態',
        cliPath: 'Claude CLI パス',
        cliPathPlaceholder: 'CLI パス未選択',
        selectCliPath: 'パスを選択',
        port: 'ポート',
        autoStartRelay: '拡張機能の起動時にローカルリレーを自動起動',
        taskFlowBypassPermissions: 'Task flow bypass permissions mode',
        taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
        extraEnvVars: '追加の環境変数（1 行に NAME=VALUE）',
        operation: '操作',
        apply: '適用',
        writeClaudeCodeSettings: 'Claude Code 設定を一括書き込み',
        providerManagement: 'プロバイダー管理',
        providerDescription: 'Claude Code Relay で使用する上流プロバイダーとモデルを設定します。',
        newProvider: '+ 新しいプロバイダー',
        noProviders: 'プロバイダーはまだありません。「新しいプロバイダー」をクリックして開始してください。',
        enableProvider: 'プロバイダーを有効化',
        baseUrlNotConfigured: 'BaseURL が未設定',
        savedApiKey: '保存済みキー',
        unsavedApiKey: '保存済みキーなし',
        edit: '編集',
        hideModels: 'モデルを非表示',
        viewModels: 'モデルを表示（{count}）',
        fetchModels: 'モデルを取得',
        addModel: 'モデルを追加',
        delete: '削除',
        noModels: 'モデルはまだありません。「モデルを追加」をクリックして手動で追加できます。',
        displayName: '表示名',
        switch: '切り替え',
        showInModelDropdown: '上部のモデルドロップダウンに表示',
        editProvider: 'プロバイダーを編集',
        newProviderModal: '新しいプロバイダー',
        providerName: '名前',
        apiKeyKeepSaved: 'API キー（空欄なら保存済みキーを維持）',
        apiKeySavedPlaceholder: '保存済みキーがあります。空欄なら変更しません',
        apiKeyPlaceholder: 'API Key / Token を入力',
        apiType: 'API タイプ',
        authMode: '認証モード',
        enabled: '有効',
        autoFetchModels: 'モデルを自動取得',
        cancel: 'キャンセル',
        save: '保存',
        editModel: 'モデルを編集',
        modelId: 'モデル ID',
        contextLength: 'コンテキスト長',
        maxOutputTokens: '最大出力 Tokens',
        samplingMode: 'サンプリングモード',
        vision: 'ビジョン',
        toolCalling: 'ツール呼び出し',
        providerNotFound: 'プロバイダーが見つかりません',
        modelIdRequired: 'モデル ID は必須です',
        confirmDeleteProvider: 'このプロバイダーを削除しますか？',
        adLabel: '広告'
    };
    translations.fr = {
        loading: 'Chargement de la configuration...',
        appTitle: 'LLS CCAI Setting',
        appSubtitle: 'Gérez le relais local Claude Code, les fournisseurs amont, les modèles, les prompts et le flux de tâches.',
        languageLabel: 'Langue',
        languageAuto: 'Suivre VS Code',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: 'Importer',
        export: 'Exporter',
        globalPromptTask: 'Prompt global / Flux de tâches',
        workspacePrompt: 'Prompt de l’espace de travail',
        openSettingsJson: 'Ouvrir settings.json',
        relaySetting: 'Paramètres du relais Claude Code',
        relayDescription: 'Le modèle courant, le port et les variables d’environnement sont synchronisés avec la configuration d’exécution de Claude Code.',
        currentModel: 'Modèle courant',
        notSelected: 'Non sélectionné',
        relayStatus: 'État du relais',
        cliPath: 'Chemin Claude CLI',
        cliPathPlaceholder: 'Aucun chemin CLI sélectionné',
        selectCliPath: 'Choisir un chemin',
        port: 'Port',
        autoStartRelay: 'Démarrer automatiquement le relais local à l’activation de l’extension',
        taskFlowBypassPermissions: 'Task flow bypass permissions mode',
        taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
        extraEnvVars: 'Variables d’environnement supplémentaires (NAME=VALUE par ligne)',
        operation: 'Opération',
        apply: 'Appliquer',
        writeClaudeCodeSettings: 'Écrire les paramètres Claude Code en un clic',
        providerManagement: 'Gestion des fournisseurs',
        providerDescription: 'Configurez les fournisseurs amont et les modèles utilisables par Claude Code Relay.',
        newProvider: '+ Nouveau fournisseur',
        noProviders: 'Aucun fournisseur pour le moment. Cliquez sur « Nouveau fournisseur » pour commencer.',
        enableProvider: 'Activer le fournisseur',
        baseUrlNotConfigured: 'BaseURL non configurée',
        savedApiKey: 'Clé enregistrée',
        unsavedApiKey: 'Aucune clé enregistrée',
        edit: 'Modifier',
        hideModels: 'Masquer les modèles',
        viewModels: 'Voir les modèles ({count})',
        fetchModels: 'Récupérer les modèles',
        addModel: 'Ajouter un modèle',
        delete: 'Supprimer',
        noModels: 'Aucun modèle pour le moment. Cliquez sur « Ajouter un modèle » pour en ajouter un manuellement.',
        displayName: 'Nom d’affichage',
        switch: 'Interrupteur',
        showInModelDropdown: 'Afficher dans la liste des modèles en haut',
        editProvider: 'Modifier le fournisseur',
        newProviderModal: 'Nouveau fournisseur',
        providerName: 'Nom',
        apiKeyKeepSaved: 'Clé API (laisser vide pour conserver la clé enregistrée)',
        apiKeySavedPlaceholder: 'Clé enregistrée ; laissez vide pour ne pas la modifier',
        apiKeyPlaceholder: 'Saisir API Key / Token',
        apiType: 'Type d’API',
        authMode: 'Mode d’authentification',
        enabled: 'Activé',
        autoFetchModels: 'Récupérer automatiquement les modèles',
        cancel: 'Annuler',
        save: 'Enregistrer',
        editModel: 'Modifier le modèle',
        modelId: 'ID du modèle',
        contextLength: 'Longueur du contexte',
        maxOutputTokens: 'Tokens de sortie max.',
        samplingMode: 'Mode d’échantillonnage',
        vision: 'Vision',
        toolCalling: 'Appel d’outils',
        providerNotFound: 'Fournisseur introuvable',
        modelIdRequired: 'L’ID du modèle est obligatoire',
        confirmDeleteProvider: 'Supprimer ce fournisseur ?',
        adLabel: 'PUB'
    };
    translations.de = {
        loading: 'Konfiguration wird geladen...',
        appTitle: 'LLS CCAI Setting',
        appSubtitle: 'Verwalten Sie Claude Code Local Relay, Upstream-Anbieter, Modelle, Prompts und Task-Flow-Einstellungen.',
        languageLabel: 'Sprache',
        languageAuto: 'VS Code folgen',
        languageEnglish: 'English',
        languageChinese: '简体中文',
        languageTraditionalChinese: '繁體中文',
        languageKorean: '한국어',
        languageJapanese: '日本語',
        languageFrench: 'Français',
        languageGerman: 'Deutsch',
        import: 'Importieren',
        export: 'Exportieren',
        globalPromptTask: 'Globaler Prompt / Task-Flow',
        workspacePrompt: 'Workspace-Prompt',
        openSettingsJson: 'settings.json öffnen',
        relaySetting: 'Claude Code Relay-Einstellungen',
        relayDescription: 'Aktuelles Modell, Port und Umgebungsvariablen werden mit der Claude Code Laufzeitkonfiguration synchronisiert.',
        currentModel: 'Aktuelles Modell',
        notSelected: 'Nicht ausgewählt',
        relayStatus: 'Relay-Status',
        cliPath: 'Claude CLI-Pfad',
        cliPathPlaceholder: 'Kein CLI-Pfad ausgewählt',
        selectCliPath: 'Pfad auswählen',
        port: 'Port',
        autoStartRelay: 'Lokales Relay beim Aktivieren der Erweiterung automatisch starten',
        taskFlowBypassPermissions: 'Task flow bypass permissions mode',
        taskFlowBypassPermissionsHint: 'Writes both bypass permission settings. Use only in trusted sandboxes.',
        extraEnvVars: 'Zusätzliche Umgebungsvariablen (NAME=VALUE pro Zeile)',
        operation: 'Aktion',
        apply: 'Anwenden',
        writeClaudeCodeSettings: 'Claude Code Einstellungen mit einem Klick schreiben',
        providerManagement: 'Anbieterverwaltung',
        providerDescription: 'Konfigurieren Sie Upstream-Anbieter und Modelle für Claude Code Relay.',
        newProvider: '+ Neuer Anbieter',
        noProviders: 'Noch keine Anbieter. Klicken Sie auf „Neuer Anbieter“, um zu beginnen.',
        enableProvider: 'Anbieter aktivieren',
        baseUrlNotConfigured: 'BaseURL nicht konfiguriert',
        savedApiKey: 'Gespeicherter Schlüssel',
        unsavedApiKey: 'Kein gespeicherter Schlüssel',
        edit: 'Bearbeiten',
        hideModels: 'Modelle ausblenden',
        viewModels: 'Modelle anzeigen ({count})',
        fetchModels: 'Modelle abrufen',
        addModel: 'Modell hinzufügen',
        delete: 'Löschen',
        noModels: 'Noch keine Modelle. Klicken Sie auf „Modell hinzufügen“, um eines manuell hinzuzufügen.',
        displayName: 'Anzeigename',
        switch: 'Schalter',
        showInModelDropdown: 'Im oberen Modell-Dropdown anzeigen',
        editProvider: 'Anbieter bearbeiten',
        newProviderModal: 'Neuer Anbieter',
        providerName: 'Name',
        apiKeyKeepSaved: 'API-Schlüssel (leer lassen, um den gespeicherten Schlüssel beizubehalten)',
        apiKeySavedPlaceholder: 'Schlüssel gespeichert; leer lassen, um ihn nicht zu ändern',
        apiKeyPlaceholder: 'API Key / Token eingeben',
        apiType: 'API-Typ',
        authMode: 'Authentifizierungsmodus',
        enabled: 'Aktiviert',
        autoFetchModels: 'Modelle automatisch abrufen',
        cancel: 'Abbrechen',
        save: 'Speichern',
        editModel: 'Modell bearbeiten',
        modelId: 'Modell-ID',
        contextLength: 'Kontextlänge',
        maxOutputTokens: 'Max. Ausgabe-Tokens',
        samplingMode: 'Sampling-Modus',
        vision: 'Vision',
        toolCalling: 'Tool-Aufruf',
        providerNotFound: 'Anbieter nicht gefunden',
        modelIdRequired: 'Modell-ID ist erforderlich',
        confirmDeleteProvider: 'Diesen Anbieter löschen?',
        adLabel: 'ANZEIGE'
    };

    /** Claude CLI 路径提示文案补丁：多语言统一维护，避免静态翻译对象长行继续膨胀。 */
    Object.assign(translations['zh-tw'], {
        cliInstallHint: '提示：如果你尚未安裝 Claude CLI，或不知道安裝路徑在哪，請用 AI 或搜尋引擎搜尋：',
        cliInstallQuery: '如何安裝 Claude CLI 及 Claude CLI 的安裝路徑在哪？',
        copyCliInstallQuery: '複製搜尋文字',
        cliInstallQueryCopied: '已複製搜尋文字'
    });
    Object.assign(translations.ko, {
        cliInstallHint: '팁: Claude CLI를 아직 설치하지 않았거나 설치 경로를 모른다면 AI 또는 검색 엔진에서 검색하세요:',
        cliInstallQuery: 'Claude CLI 설치 방법 및 Claude CLI 설치 경로는 어디인가요?',
        copyCliInstallQuery: '검색 문구 복사',
        cliInstallQueryCopied: '검색 문구를 복사했습니다'
    });
    Object.assign(translations.ja, {
        cliInstallHint: 'ヒント: Claude CLI をまだインストールしていない、またはインストール先が分からない場合は、AI か検索エンジンで検索してください:',
        cliInstallQuery: 'Claude CLI のインストール方法と Claude CLI のインストールパスはどこですか？',
        copyCliInstallQuery: '検索文をコピー',
        cliInstallQueryCopied: '検索文をコピーしました'
    });
    Object.assign(translations.fr, {
        cliInstallHint: 'Astuce : si vous n’avez pas encore installé Claude CLI ou si vous ne connaissez pas son chemin, demandez à une IA ou recherchez :',
        cliInstallQuery: 'Comment installer Claude CLI et où se trouve le chemin d’installation de Claude CLI ?',
        copyCliInstallQuery: 'Copier le texte de recherche',
        cliInstallQueryCopied: 'Texte de recherche copié'
    });
    Object.assign(translations.de, {
        cliInstallHint: 'Tipp: Wenn Claude CLI noch nicht installiert ist oder Sie den Pfad nicht kennen, fragen Sie eine KI oder suchen Sie nach:',
        cliInstallQuery: 'Wie installiert man Claude CLI und wo befindet sich der Installationspfad von Claude CLI?',
        copyCliInstallQuery: 'Suchtext kopieren',
        cliInstallQueryCopied: 'Suchtext kopiert'
    });

    /** Windows Claude CLI 安装与路径提示文案补丁，未单独翻译的语言回落英文。 */
    Object.keys(translations).forEach((language) => {
        Object.assign(translations[language], {
            windowsCliInstallHint: translations[language].windowsCliInstallHint || translations.en.windowsCliInstallHint,
            windowsCliPathHint: translations[language].windowsCliPathHint || translations.en.windowsCliPathHint,
            copyWindowsCliInstall: translations[language].copyWindowsCliInstall || translations.en.copyWindowsCliInstall,
            copyWindowsCliPath: translations[language].copyWindowsCliPath || translations.en.copyWindowsCliPath,
            windowsCliInstallCopied: translations[language].windowsCliInstallCopied || translations.en.windowsCliInstallCopied,
            windowsCliPathCopied: translations[language].windowsCliPathCopied || translations.en.windowsCliPathCopied
        });
    });

    /** 读取翻译文案，缺失时回落英文，再回落 key 本身。 */
    function t(key) {
        return translations[currentLanguage]?.[key] || translations.en[key] || key;
    }

    /** Windows npm 全局安装 Claude CLI 的命令。 */
    const WINDOWS_CLI_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com/';

    /** 无法从宿主环境读取 APPDATA 时展示的 Windows APPDATA 示例路径。 */
    const FALLBACK_WINDOWS_APP_DATA_PATH = 'C:/Users/用户名/AppData/Roaming';

    /** Windows npm 全局安装后 Claude CLI 可执行文件相对 APPDATA 的路径片段。 */
    const WINDOWS_CLI_EXECUTABLE_SUFFIX = 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

    /** 使用命名值格式化翻译模板。 */
    function tf(key, values) {
        return t(key).replace(/\{(\w+)\}/g, (_, name) => values?.[name] ?? '');
    }

    /** 判断当前扩展宿主系统是否为 Windows。 */
    function isWindowsHost() {
        return state?.hostPlatform === 'win32';
    }

    /** 读取宿主进程 APPDATA 环境变量；读取不到时回落示例路径。 */
    function getWindowsAppDataPath() {
        return state?.windowsAppDataPath || FALLBACK_WINDOWS_APP_DATA_PATH;
    }

    /**
     * 拼接 Windows 路径并统一为单反斜杠内部格式。
     *
     * @param {...string} parts 路径片段。
     * @returns {string} 单反斜杠 Windows 路径。
     */
    function joinWindowsPath(...parts) {
        return parts
            .filter(Boolean)
            .map((part) => String(part).replace(/[\\/]+$/g, '').replace(/^[\\/]+/g, ''))
            .join('\\')
            .replace(/[\\/]+/g, '\\');
    }

    /** 获取 Windows Claude CLI 可执行文件路径，展示和复制时保持单反斜杠。 */
    function getWindowsCliExecutablePath() {
        return joinWindowsPath(getWindowsAppDataPath(), WINDOWS_CLI_EXECUTABLE_SUFFIX);
    }

    /** 渲染仅 Windows 系统显示的 Claude CLI npm 安装命令与可执行文件路径提示。 */
    function renderWindowsCliInstallHint() {
        if (!isWindowsHost()) return '';
        const executablePath = getWindowsCliExecutablePath();
        return `
                            <div class="cli-install-windows" role="note">
                                <div class="cli-install-windows-row">
                                    <span data-i18n="windowsCliInstallHint">${t('windowsCliInstallHint')}</span>
                                    <code>${text(WINDOWS_CLI_INSTALL_COMMAND)}</code>
                                    <button id="btn-copy-windows-cli-install" type="button" class="icon-copy-button" data-i18n-title="copyWindowsCliInstall" data-i18n-aria-label="copyWindowsCliInstall" title="${text(t('copyWindowsCliInstall'))}">
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12a1 1 0 0 1 1 1v8.5A1.5 1.5 0 0 1 11.5 14h-6A1.5 1.5 0 0 1 4 12.5zM5.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V4zM3 11H2.5A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2H9v1H2.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5H3z"/></svg>
                                    </button>
                                </div>
                                <div class="cli-install-windows-row">
                                    <span data-i18n="windowsCliPathHint">${t('windowsCliPathHint')}</span>
                                    <code>${text(executablePath)}</code>
                                    <button id="btn-copy-windows-cli-path" type="button" class="icon-copy-button" data-i18n-title="copyWindowsCliPath" data-i18n-aria-label="copyWindowsCliPath" title="${text(t('copyWindowsCliPath'))}">
                                        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12a1 1 0 0 1 1 1v8.5A1.5 1.5 0 0 1 11.5 14h-6A1.5 1.5 0 0 1 4 12.5zM5.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V4zM3 11H2.5A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2H9v1H2.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5H3z"/></svg>
                                    </button>
                                </div>
                            </div>`;
    }

    /** 对当前 DOM 应用 i18n 文案。 */
    function applyI18n() {
        document.documentElement.lang = currentLanguage;
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-title]').forEach((el) => {
            el.setAttribute('title', t(el.dataset.i18nTitle));
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
            el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
        });
        document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
            el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
        });
    }

    /** 创建安全文本节点，避免 HTML 注入。 */
    function text(value) {
        return String(value == null ? '' : value);
    }

    /** 生成轻量随机 ID。 */
    function createId(prefix) {
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }



    /** 渲染整个应用。 */
    function render() {
        const app = document.getElementById('app');
        if (!app) return;
        if (!state) {
            app.innerHTML = '<div class="app-shell"><div class="empty" data-i18n="loading">正在加载配置...</div></div>';
            applyI18n();
            return;
        }
        app.innerHTML = `
            <main class="app-shell">
                ${renderAdBanner()}
                ${renderHeader()}
                ${renderClaudeCard()}
                ${renderProvidersCard()}
            </main>
            ${renderModal()}
        `;
        bindEvents();
        applyI18n();
        applyPendingAd();
    }

    /**
     * 顶部广告槽位 HTML。
     *
     * 槽位 DOM 始终渲染，初始隐藏；当扩展宿主推送 `ad` 消息且数据合法时，
     * {@link applyPendingAd} 会把图片/链接填进来并显示。这样可以在 render()
     * 重建 DOM 后立刻恢复广告显示，不需要重新请求接口。
     *
     * @returns 广告槽位 HTML 片段。
     */
    function renderAdBanner() {
        return `
            <a id="adBanner" class="ad-banner" style="display:none;" rel="noopener" target="_blank">
                <span class="ad-label" data-i18n="adLabel">AD</span>
                <img id="adBannerImg" class="ad-banner-img" alt="advertisement" />
            </a>
        `;
    }

    /**
     * 把 {@link pendingAd} 的内容写入当前 DOM 中的广告槽位。
     *
     * 设计要点：
     * - 没有数据时槽位保持 `display:none`，避免在设置页留出空白条；
     * - 图片 `onerror` 走 {@link hideAdBanner}，远端图片 404 / 阻断时不显示；
     * - 点击不直接走 `window.open`（webview CSP 默认禁止），改为 `post('openUrl')`
     *   让扩展宿主用 `vscode.env.openExternal` 处理，安全且能弹"在外部打开?"提示。
     */
    function applyPendingAd() {
        const banner = document.getElementById('adBanner');
        const img = document.getElementById('adBannerImg');
        if (!banner || !img) return;
        if (!pendingAd || !pendingAd.image || !pendingAd.url) {
            hideAdBanner();
            return;
        }
        const ad = pendingAd;
        img.onerror = () => hideAdBanner();
        img.onload = () => { banner.style.display = 'block'; };
        // 设置 src 之前先准备好 onload/onerror，避免缓存图片直接命中后未触发显示。
        img.src = ad.image;
        // 兜底：3 秒后图片还没 onload 也不挡视图，强制按当前状态决定显示。
        // （onload/onerror 已经处理大多数情况，这里只是防止极少数浏览器实现差异。）
        banner.onclick = (event) => {
            event.preventDefault();
            post('openUrl', { url: ad.url });
        };
    }

    /** 把广告槽位重置为隐藏状态，清空图片避免下次切换闪烁。 */
    function hideAdBanner() {
        const banner = document.getElementById('adBanner');
        const img = document.getElementById('adBannerImg');
        if (banner) banner.style.display = 'none';
        if (img) img.removeAttribute('src');
    }

    /** 渲染页面头部。 */
    function renderHeader() {
        return `
            <section class="header">
                <div>
                    <h1 data-i18n="appTitle">LLS CCAI Setting</h1>
                    <p data-i18n="appSubtitle">管理 Claude Code 本地中转、上游提供商、模型、提示词与任务流设置。</p>
                    <div class="language-row">
                        <label for="language-select" data-i18n="languageLabel">语言</label>
                        <select id="language-select" class="language-select" data-i18n-aria-label="languageLabel">
                            <option value="auto" data-i18n="languageAuto">跟随 VS Code</option>
                            <option value="en" data-i18n="languageEnglish">English</option>
                            <option value="zh-cn" data-i18n="languageChinese">简体中文</option>
                            <option value="zh-tw" data-i18n="languageTraditionalChinese">繁體中文</option>
                            <option value="ko" data-i18n="languageKorean">한국어</option>
                            <option value="ja" data-i18n="languageJapanese">日本語</option>
                            <option value="fr" data-i18n="languageFrench">Français</option>
                            <option value="de" data-i18n="languageGerman">Deutsch</option>
                        </select>
                    </div>
                </div>
                <div class="toolbar toolbar-actions">
                    <button id="btn-import" class="toolbar-btn" data-i18n-title="import" title="导入">
                        <svg class="toolbar-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5a.5.5 0 0 1 .5.5v7.293l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 9.293V2a.5.5 0 0 1 .5-.5zM2.5 11a.5.5 0 0 1 .5.5V13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5a.5.5 0 0 1 1 0V13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1.5a.5.5 0 0 1 .5-.5z"/></svg>
                        <span class="toolbar-btn-label" data-i18n="import">导入</span>
                    </button>
                    <button id="btn-export" class="toolbar-btn" data-i18n-title="export" title="导出">
                        <svg class="toolbar-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 14.5a.5.5 0 0 1-.5-.5V6.707L5.354 8.854a.5.5 0 1 1-.708-.708l3-3a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 6.707V14a.5.5 0 0 1-.5.5zM2.5 11a.5.5 0 0 1 .5.5V13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5a.5.5 0 0 1 1 0V13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1.5a.5.5 0 0 1 .5-.5z"/></svg>
                        <span class="toolbar-btn-label" data-i18n="export">导出</span>
                    </button>
                    <span class="toolbar-divider" aria-hidden="true"></span>
                    <button id="btn-open-global-shared" class="toolbar-btn toolbar-btn-accent" data-i18n-title="globalPromptTask" title="全局提示词/任务流">
                        <svg class="toolbar-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 0 1 1.05-3.39c.32.43.86 1.05 1.62 1.5.16.1.27.27.27.46v1.07c0 .27.11.53.3.72l1.4 1.4a.5.5 0 0 1 .15.35V12a.5.5 0 0 0 .85.35l.9-.9a.5.5 0 0 0 .15-.36V9.5a.5.5 0 0 1 .5-.5h1.2a.5.5 0 0 0 .35-.85L9.5 7.5h1.2a.5.5 0 0 0 .35-.15l1.05-1.05A6 6 0 0 1 14 8a6 6 0 1 1-12 0z"/></svg>
                        <span class="toolbar-btn-label" data-i18n="globalPromptTask">全局提示词/任务流</span>
                    </button>
                    <button id="btn-open-workspace-shared" class="toolbar-btn toolbar-btn-accent" data-i18n-title="workspacePrompt" title="工作区提示词">
                        <svg class="toolbar-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14.5 3h-5.79L7.6 1.89A1.5 1.5 0 0 0 6.54 1.5H1.5A1.5 1.5 0 0 0 0 3v10a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 16 13V4.5A1.5 1.5 0 0 0 14.5 3zM1.5 2.5h5.04a.5.5 0 0 1 .35.15L8.1 3.85a.5.5 0 0 0 .35.15h6.05a.5.5 0 0 1 .5.5V6H1V3a.5.5 0 0 1 .5-.5zM14.5 13.5h-13A.5.5 0 0 1 1 13V7h14v6a.5.5 0 0 1-.5.5z"/></svg>
                        <span class="toolbar-btn-label" data-i18n="workspacePrompt">工作区提示词</span>
                    </button>
                    <span class="toolbar-divider" aria-hidden="true"></span>
                    <button id="btn-open-settings" class="toolbar-btn" data-i18n-title="openSettingsJson" title="打开 settings.json">
                        <svg class="toolbar-btn-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.988 1.987l.17.311c.518.95.043 2.146-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.988l.311-.17c.95-.518 2.146-.043 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.988-1.987l-.17-.311c-.518-.95-.043-2.146.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.988l-.311.17c-.95.518-2.146.043-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>
                        <span class="toolbar-btn-label" data-i18n="openSettingsJson">打开 settings.json</span>
                    </button>
                </div>
            </section>
        `;
    }

    /** 渲染 Claude Code 顶部配置区。 */
    function renderClaudeCard() {
        const cliPath = state.chatCliPath || '';
        return `
            <section class="card claude-card">
                <div class="card-title">
                    <div>
                        <h2 data-i18n="relaySetting">Claude Code Chat Setting</h2>
                        <p class="provider-meta" data-i18n="relayDescription">当前模型、端口和环境变量会同步到 Claude Code 运行配置。</p>
                    </div>
                </div>
                <div class="grid">
                    <div class="field full">
                        <label for="chat-cli-path" data-i18n="cliPath">Claude CLI 路径</label>
                        <div class="path-picker-row">
                            <input id="chat-cli-path" type="text" readonly value="${text(cliPath)}" data-i18n-placeholder="cliPathPlaceholder" placeholder="尚未选择 CLI 路径" />
                            <button id="btn-select-chat-cli" type="button" class="secondary" data-i18n="selectCliPath">选择路径</button>
                        </div>
                        <div class="cli-install-hint" role="note">
                            <span data-i18n="cliInstallHint">提示：如果你还没安装 Claude CLI，或不知道安装路径在哪，请用 AI 或搜索引擎搜索：</span>
                            <code data-i18n="cliInstallQuery">如何安装 Claude CLI 及 Claude CLI的安装路径在哪？</code>
                            <button id="btn-copy-cli-install-query" type="button" class="icon-copy-button" data-i18n-title="copyCliInstallQuery" data-i18n-aria-label="copyCliInstallQuery" title="复制搜索文本">
                                <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 4.5A1.5 1.5 0 0 1 5.5 3H12a1 1 0 0 1 1 1v8.5A1.5 1.5 0 0 1 11.5 14h-6A1.5 1.5 0 0 1 4 12.5zM5.5 4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V4zM3 11H2.5A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2H9v1H2.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5H3z"/></svg>
                            </button>
                            ${renderWindowsCliInstallHint()}
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    /** 渲染提供商管理卡片。 */
    function renderProvidersCard() {
        return `
            <section class="card">
                <div class="card-title">
                    <div>
                        <h2 data-i18n="providerManagement">Provider Management</h2>
                        <p class="provider-meta" data-i18n="providerDescription">配置可供 Claude Code Relay 使用的上游提供商与模型。</p>
                    </div>
                    <button id="btn-new-provider" data-i18n="newProvider">+ 新建提供商</button>
                </div>
                <div class="provider-list">
                    ${state.providers.length === 0 ? `<div class="empty" data-i18n="noProviders">${t('noProviders')}</div>` : state.providers.map(renderProvider).join('')}
                </div>
            </section>
        `;
    }

    /** 渲染单个提供商卡片。 */
    function renderProvider(provider) {
        return `
            <article class="provider-card" data-provider-id="${text(provider.id)}">
                <div class="provider-head">
                    <div>
                        <div class="title-with-switch">
                            <h3>${text(provider.name)}</h3>
                            ${renderSwitch('js-provider-enabled', provider.enabled, t('enableProvider'))}
                        </div>
                        <div class="provider-meta">${text(provider.baseUrl || t('baseUrlNotConfigured'))} · ${text(provider.apiType)} · ${provider.hasApiKey ? t('savedApiKey') : t('unsavedApiKey')}</div>
                    </div>
                    <div class="card-actions">
                        <button class="secondary js-edit-provider">${t('edit')}</button>
                        <button class="secondary js-toggle-models">${expandedProviderIds.has(provider.id) ? t('hideModels') : tf('viewModels', { count: String((provider.models || []).length) })}</button>
                        <button class="secondary ${provider.autoFetchModels ? 'js-fetch-models' : 'js-add-model'}">${provider.autoFetchModels ? t('fetchModels') : t('addModel')}</button>
                        <button class="danger js-delete-provider">${t('delete')}</button>
                    </div>
                </div>
                ${renderModels(provider)}
            </article>
        `;
    }

    /** 渲染提供商下的模型列表。 */
    function renderModels(provider) {
        if (!expandedProviderIds.has(provider.id)) {
            return '';
        }
        if (!provider.models || provider.models.length === 0) {
            return `<div class="empty">${t('noModels')}</div>`;
        }
        return `
            <table class="model-table">
                <thead><tr><th>${t('displayName')}</th><th>${t('operation')}</th></tr></thead>
                <tbody>
                    ${provider.models.map((model) => `
                        <tr data-model-id="${text(model.modelId)}">
                            <td>${text(model.displayName || model.modelId)}</td>
                            <td class="row-actions">
                                <button class="secondary js-edit-model">${t('edit')}</button>
                                <button class="danger js-delete-model">${t('delete')}</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    /** 渲染参考扩展风格的开关。 */
    function renderSwitch(className, checked, title) {
        return `
            <label class="switch" title="${text(title)}">
                <input class="${className}" type="checkbox" ${checked ? 'checked' : ''} />
                <span class="switch-slider"></span>
            </label>
        `;
    }

    /** 渲染编辑模态框。 */
    function renderModal() {
        if (!modalState) return '';
        if (modalState.type === 'provider') return renderProviderModal();
        return renderModelModal();
    }

    /** 渲染提供商编辑模态框。 */
    function renderProviderModal() {
        const provider = modalState.provider || createDefaultProvider();
        return `
            <div class="modal-backdrop">
                <div class="modal">
                    <h2>${modalState.provider ? t('editProvider') : t('newProviderModal')}</h2>
                    <div class="grid">
                        <div class="field"><label>${t('providerName')}</label><input id="provider-name" value="${text(provider.name)}" /></div>
                        <div class="field full"><label>BaseURL</label><input id="provider-base-url" value="${text(provider.baseUrl)}" /></div>
                        <div class="field full"><label>${t('apiKeyKeepSaved')}</label><input id="provider-api-key" type="password" placeholder="${provider.hasApiKey ? t('apiKeySavedPlaceholder') : t('apiKeyPlaceholder')}" /></div>
                        <div class="field"><label>${t('apiType')}</label><select id="provider-api-type">
                            ${['openai-compatible', 'anthropic', 'v1-response'].map((item) => `<option value="${item}" ${provider.apiType === item ? 'selected' : ''}>${item}</option>`).join('')}
                        </select></div>
                        <div class="field"><label>${t('authMode')}</label><select id="provider-auth-mode">
                            ${['api_key', 'auth_token', 'none'].map((item) => `<option value="${item}" ${provider.authMode === item ? 'selected' : ''}>${item}</option>`).join('')}
                        </select></div>
                        <div class="checkbox-row"><input id="provider-enabled" type="checkbox" ${provider.enabled ? 'checked' : ''} /><label for="provider-enabled">${t('enabled')}</label></div>
                        <div class="checkbox-row"><input id="provider-autofetch" type="checkbox" ${provider.autoFetchModels ? 'checked' : ''} /><label for="provider-autofetch">${t('autoFetchModels')}</label></div>
                    </div>
                    <div class="modal-footer">
                        <button id="btn-cancel-modal" class="secondary">${t('cancel')}</button>
                        <button id="btn-save-provider">${t('save')}</button>
                    </div>
                </div>
            </div>
        `;
    }

    /** 渲染模型编辑模态框。 */
    function renderModelModal() {
        const model = modalState.model || createDefaultModel();
        return `
            <div class="modal-backdrop">
                <div class="modal">
                    <h2>${modalState.model ? t('editModel') : t('addModel')}</h2>
                    <div class="grid">
                        <div class="field"><label>${t('modelId')}</label><input id="model-id" value="${text(model.modelId)}" ${modalState.model ? 'disabled' : ''} /></div>
                        <div class="field"><label>${t('displayName')}</label><input id="model-display" value="${text(model.displayName)}" /></div>
                        <div class="field"><label>${t('contextLength')}</label><input id="model-context" type="number" min="0" value="${text(model.contextLength || 0)}" /></div>
                        <div class="field"><label>${t('maxOutputTokens')}</label><input id="model-max" type="number" min="0" value="${text(model.maxTokens || 0)}" /></div>
                        <div class="field"><label>Temperature</label><input id="model-temperature" type="number" min="0" max="2" step="0.1" value="${text(model.temperature ?? 1)}" /></div>
                        <div class="field"><label>Top P</label><input id="model-top-p" type="number" min="0" max="1" step="0.05" value="${text(model.topP ?? 1)}" /></div>
                        <div class="field full"><label>${t('samplingMode')}</label><select id="model-sampling-mode">
                            ${[
                                ['both', 'Both (temperature + top_p)'],
                                ['temperature', 'Temperature only'],
                                ['top_p', 'Top P only'],
                                ['none', 'None (do not pass)']
                            ].map(([value, label]) => `<option value="${value}" ${model.samplingMode === value ? 'selected' : ''}>${label}</option>`).join('')}
                        </select></div>
                        <div class="checkbox-row"><input id="model-user-selectable" type="checkbox" ${model.isUserSelectable !== false ? 'checked' : ''} /><label for="model-user-selectable">${t('showInModelDropdown')}</label></div>
                        <div class="checkbox-row"><input id="model-vision" type="checkbox" ${model.vision ? 'checked' : ''} /><label for="model-vision">${t('vision')}</label></div>
                        <div class="checkbox-row"><input id="model-tool" type="checkbox" ${model.toolCalling !== false ? 'checked' : ''} /><label for="model-tool">${t('toolCalling')}</label></div>
                        <div class="checkbox-row"><input id="model-transform-think" type="checkbox" ${model.transformThink ? 'checked' : ''} /><label for="model-transform-think">Transform Think Tags (&lt;|im_start|&gt;/♩)</label></div>
                        <div class="checkbox-row"><input id="model-preserve-reasoning" type="checkbox" ${model.preserveReasoningContent ? 'checked' : ''} /><label for="model-preserve-reasoning">Preserve reasoning_content</label></div>
                    </div>
                    <div class="modal-footer">
                        <button id="btn-cancel-modal" class="secondary">${t('cancel')}</button>
                        <button id="btn-save-model">${t('save')}</button>
                    </div>
                </div>
            </div>
        `;
    }

    /** 绑定页面事件。 */
    function bindEvents() {
        byId('btn-import', (el) => el.addEventListener('click', () => post('importConfig')));
        byId('btn-export', (el) => el.addEventListener('click', () => post('exportConfig')));
        byId('btn-open-global-shared', (el) => el.addEventListener('click', () => post('openGlobalSharedSettings')));
        byId('btn-open-workspace-shared', (el) => el.addEventListener('click', () => post('openWorkspaceSharedSettings')));
        byId('btn-open-settings', (el) => el.addEventListener('click', () => post('openSettingsJson')));
        byId('language-select', (el) => {
            el.value = configuredLanguage;
            el.addEventListener('change', () => {
                configuredLanguage = el.value || 'auto';
                post('updateUiLanguage', configuredLanguage);
            });
        });
        byId('btn-select-chat-cli', (el) => el.addEventListener('click', () => post('selectChatCliPath')));
        byId('btn-copy-cli-install-query', (el) => el.addEventListener('click', copyCliInstallQuery));
        byId('btn-copy-windows-cli-install', (el) => el.addEventListener('click', copyWindowsCliInstallCommand));
        byId('btn-copy-windows-cli-path', (el) => el.addEventListener('click', copyWindowsCliExecutablePath));
        byId('btn-new-provider', (el) => el.addEventListener('click', () => openProviderModal()));
        byId('btn-cancel-modal', (el) => el.addEventListener('click', closeModal));
        byId('btn-save-provider', (el) => el.addEventListener('click', saveProviderFromModal));
        byId('btn-save-model', (el) => el.addEventListener('click', saveModelFromModal));

        document.querySelectorAll('.provider-card').forEach((card) => {
            const providerId = card.getAttribute('data-provider-id');
            card.querySelector('.js-provider-enabled')?.addEventListener('change', () => toggleProvider(providerId));
            card.querySelector('.js-edit-provider')?.addEventListener('click', () => openProviderModal(findProvider(providerId)));
            card.querySelector('.js-toggle-models')?.addEventListener('click', () => toggleModels(providerId));
            card.querySelector('.js-add-model')?.addEventListener('click', () => openModelModal(providerId));
            card.querySelector('.js-fetch-models')?.addEventListener('click', () => fetchProviderModels(providerId));
            card.querySelector('.js-delete-provider')?.addEventListener('click', () => deleteProvider(providerId));
            card.querySelectorAll('tr[data-model-id]').forEach((row) => {
                const modelId = row.getAttribute('data-model-id');
                row.querySelector('.js-edit-model')?.addEventListener('click', () => openModelModal(providerId, findModel(providerId, modelId)));
                row.querySelector('.js-delete-model')?.addEventListener('click', () => deleteModel(providerId, modelId));
            });
        });
    }

    /**
     * 复制 Claude CLI 安装路径查询文本。
     *
     * 用户可以把该问题直接粘贴到 AI 助手或搜索引擎中，快速了解 Claude CLI 的
     * 安装方式以及 macOS / Windows / Linux 下常见可执行文件路径。
     */
    function copyCliInstallQuery() {
        copyTextWithToast(t('cliInstallQuery'), 'cliInstallQueryCopied');
    }

    /** 复制 Windows Claude CLI npm 安装命令。 */
    function copyWindowsCliInstallCommand() {
        copyTextWithToast(WINDOWS_CLI_INSTALL_COMMAND, 'windowsCliInstallCopied');
    }

    /** 复制 Windows Claude CLI 可执行文件路径，路径中的反斜杠保持 Windows 单反斜杠格式。 */
    function copyWindowsCliExecutablePath() {
        copyTextWithToast(getWindowsCliExecutablePath(), 'windowsCliPathCopied');
    }

    /**
     * 复制指定文本并显示对应成功提示。
     *
     * @param {string} value 待复制文本。
     * @param {string} successKey 成功提示 i18n key。
     */
    function copyTextWithToast(value, successKey) {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(value).then(
                () => showToast('success', t(successKey)),
                () => fallbackCopyText(value, successKey)
            );
            return;
        }
        fallbackCopyText(value, successKey);
    }

    /**
     * 使用临时 textarea 复制文本，作为 Clipboard API 不可用时的回退方案。
     *
     * @param {string} value 待复制文本。
     * @param {string} successKey 成功提示 i18n key。
     */
    function fallbackCopyText(value, successKey) {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('success', t(successKey));
        } finally {
            textarea.remove();
        }
    }

    /** 按 ID 查找元素并执行回调。 */
    function byId(id, fn) {
        const el = document.getElementById(id);
        if (el) fn(el);
    }

    /** 打开提供商模态框。 */
    function openProviderModal(provider) {
        modalState = { type: 'provider', provider: provider ? clone(provider) : null };
        render();
    }

    /** 打开模型模态框。 */
    function openModelModal(providerId, model) {
        modalState = { type: 'model', providerId, model: model ? clone(model) : null };
        render();
    }

    /** 关闭当前模态框。 */
    function closeModal() {
        modalState = null;
        render();
    }

    /** 从模态框保存提供商。 */
    function saveProviderFromModal() {
        const providers = clone(state.providers);
        const id = modalState.provider?.id || createId('provider');
        const existing = providers.find((item) => item.id === id);
        const provider = existing || createDefaultProvider(id);
        provider.name = document.getElementById('provider-name').value.trim() || id;
        provider.baseUrl = document.getElementById('provider-base-url').value.trim();
        provider.apiType = document.getElementById('provider-api-type').value;
        provider.authMode = document.getElementById('provider-auth-mode').value;
        provider.enabled = document.getElementById('provider-enabled').checked;
        provider.autoFetchModels = document.getElementById('provider-autofetch').checked;
        provider.updatedAt = Date.now();
        if (!existing) providers.push(provider);
        const apiKey = document.getElementById('provider-api-key').value;
        const providerApiKeys = apiKey && apiKey.trim() ? { [id]: apiKey.trim() } : undefined;
        modalState = null;
        post('saveProviders', { providers, providerApiKeys });
    }

    /** 从模态框保存模型。 */
    function saveModelFromModal() {
        const provider = findProvider(modalState.providerId);
        if (!provider) return showToast('error', t('providerNotFound'));
        const modelId = document.getElementById('model-id').value.trim();
        if (!modelId) return showToast('error', t('modelIdRequired'));
        const providers = clone(state.providers);
        const target = providers.find((item) => item.id === modalState.providerId);
        const existing = target.models.find((item) => item.modelId === modelId);
        const model = existing || createDefaultModel(modelId);
        model.displayName = document.getElementById('model-display').value.trim() || modelId;
        model.contextLength = Number(document.getElementById('model-context').value || 0);
        model.maxTokens = Number(document.getElementById('model-max').value || 0);
        model.temperature = Number(document.getElementById('model-temperature').value || 1);
        model.topP = Number(document.getElementById('model-top-p').value || 1);
        model.samplingMode = document.getElementById('model-sampling-mode').value;
        model.isUserSelectable = document.getElementById('model-user-selectable').checked;
        model.vision = document.getElementById('model-vision').checked;
        model.toolCalling = document.getElementById('model-tool').checked;
        model.transformThink = document.getElementById('model-transform-think').checked;
        model.preserveReasoningContent = document.getElementById('model-preserve-reasoning').checked;
        if (!existing) target.models.push(model);
        target.updatedAt = Date.now();
        modalState = null;
        post('saveProviders', providers);
    }

    /** 切换提供商启用状态。 */
    function toggleProvider(providerId) {
        const providers = clone(state.providers);
        const provider = providers.find((item) => item.id === providerId);
        if (provider) provider.enabled = !provider.enabled;
        post('saveProviders', providers);
    }


    /** 展开或隐藏某个提供商的模型列表。 */
    function toggleModels(providerId) {
        if (!providerId) return;
        if (expandedProviderIds.has(providerId)) {
            expandedProviderIds.delete(providerId);
        } else {
            expandedProviderIds.add(providerId);
        }
        render();
    }

    /** 触发扩展宿主用已保存密钥拉取模型列表。 */
    function fetchProviderModels(providerId) {
        if (!providerId) return;
        expandedProviderIds.add(providerId);
        post('fetchProviderModels', { providerId });
    }

    /** 删除提供商。 */
    function deleteProvider(providerId) {
        post('saveProviders', state.providers.filter((item) => item.id !== providerId));
    }

    /** 删除模型。 */
    function deleteModel(providerId, modelId) {
        const providers = clone(state.providers);
        const provider = providers.find((item) => item.id === providerId);
        if (provider) provider.models = provider.models.filter((item) => item.modelId !== modelId);
        post('saveProviders', providers);
    }

    /** 查找提供商。 */
    function findProvider(providerId) {
        return state.providers.find((item) => item.id === providerId);
    }

    /** 查找模型。 */
    function findModel(providerId, modelId) {
        return findProvider(providerId)?.models?.find((item) => item.modelId === modelId);
    }

    /** 创建默认提供商配置。 */
    function createDefaultProvider(id) {
        const now = Date.now();
        return {
            id: id || createId('provider'),
            name: '',
            baseUrl: '',
            apiType: 'openai-compatible',
            models: [],
            enabled: true,
            autoFetchModels: true,
            createdAt: now,
            updatedAt: now,
            hasApiKey: false,
            authMode: 'api_key',
            customHeaders: []
        };
    }

    /** 创建默认模型配置。 */
    function createDefaultModel(modelId) {
        return {
            modelId: modelId || '',
            displayName: modelId || '',
            contextLength: 0,
            maxTokens: 0,
            vision: false,
            toolCalling: true,
            temperature: 1,
            topP: 1,
            samplingMode: 'temperature',
            isUserSelectable: true,
            transformThink: false,
            preserveReasoningContent: false
        };
    }

    /** 深拷贝简单 JSON 数据。 */
    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    /** 显示前端本地 toast。 */
    function showToast(level, message) {
        const old = document.querySelector('.toast');
        old?.remove();
        const el = document.createElement('div');
        el.className = `toast toast-${level}`;
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2600);
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'state') {
            state = message.payload;
            configuredLanguage = state.configuredLanguage || 'auto';
            currentLanguage = state.resolvedLanguage || 'en';
            render();
        } else if (message.type === 'toast') {
            showToast(message.payload.level, message.payload.message);
        } else if (message.type === 'ad') {
            // 扩展宿主已经把数据清洗过；这里只做"是否填充 + 是否显示"的 DOM 操作。
            pendingAd = message.payload || null;
            applyPendingAd();
        }
    });

    render();
    post('ready');
}());
