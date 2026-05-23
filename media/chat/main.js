/* global acquireVsCodeApi */

/**
 * LLS CCAI Chat Webview 前端脚本。
 *
 * 聊天结果区域采用参考项目（anthropic.claude-code）的解析与渲染方式，
 * 使用 Markdown 解析和结构化 DOM 构建来展示 Assistant 回复，
 * 图标和配色保留 LLS 自定义主题。
 */
(function bootstrapChatWebview() {
    const LONG_TEXT_LIMIT = 12000;
    const LONG_LINE_LIMIT = 220;
    const DEFAULT_CHAT_LANGUAGE = 'en';
    const chatTranslations = {
        en: {
            statusInitializing: 'Initializing…', copySource: 'Copy source', copySourceTitle: 'Copy current Webview body source', restart: 'Restart', restartTitle: 'Restart CLI', clear: 'Clear', clearTitle: 'Clear chat history', dropFilesHere: 'Drop files here as context', contextPanelAria: 'Added context files', defaultCurrentFile: 'Current file shown by default', clearContext: 'Clear context', contextMenu: 'Context menu', composerPlaceholder: 'Ask, edit, or agent…', attachFile: 'Select context files', modelSelectTitle: 'Switch model and automatically restart Chat CLI', modelSelectAria: 'Switch model', modelLoading: 'Loading models…', permissionModeTitle: 'Switch Claude CLI permission mode and automatically restart Chat CLI', permissionModeAria: 'Switch permission mode', sendMessage: 'Send message', stopResponse: 'Stop current response', noModelConfigured: 'No model configured', selectModel: 'Select a model', permissionAcceptEdits: 'Current: acceptEdits (automatically accept edit tools)', permissionBypass: 'Current: bypassPermissions (skip permission checks, fully trust current workspace)', emptyState: 'LLS CLAUDE CHAT - Start a conversation', longTextOutput: 'Long text output', longCodeBlock: 'Long code block', longDiffOutput: 'Long diff output', copy: 'Copy', copyCode: 'Copy code', usageModel: 'Model ', usageInput: 'Input ', usageOutput: 'Output ', usageCacheWrite: 'Cache write ', usageCacheRead: 'Cache read ', assistantNeedsConfirmation: 'Assistant needs your confirmation', askManyQuestions: 'There are {count} questions. You must reply before continuing.', askOneQuestion: 'Choose an option, or write a custom reply below (required).', noQuestionText: '(No question text)', multiSelect: 'Multiple selection', customReplyLabel: 'Other reply (optional): write your thoughts or why you did not choose an option', customReplyPlaceholder: 'For example: I want to use another implementation…', sendReply: 'Send reply', askUserReplyIntro: 'I replied to your question as follows:', askUserPicked: '   Selected: {items}', askUserNoPick: '   Selected: (no option selected)', askUserExtra: 'Additional note:', vscodeDiagnostics: 'VS Code diagnostics', toolRunning: 'Running', toolSuccess: 'Success', toolFailed: 'Failed', toolPermissionDenied: 'Permission required', toolPending: 'Pending', collapsibleSummary: '{label} ({count} characters, click to expand)', truncatedChars: '… truncated {count} characters', resendTitle: 'Resend: delete this message and following context, then send again', resendAria: 'Resend this message', loading: 'Loading', cliNotSelected: 'CLI not selected', cliStatus: 'CLI status: {status}{detail}', unknownError: 'Unknown error', copiedBodySource: 'Copied body source', copyBodySourceFailed: 'Failed to copy body source', removeAttachment: 'Remove {name}', genericFile: 'File'
        },
        'zh-cn': {
            statusInitializing: '正在初始化…', copySource: '复制源码', copySourceTitle: '复制当前 Webview body 源码', restart: '重启', restartTitle: '重启 CLI', clear: '清空', clearTitle: '清空聊天内容', dropFilesHere: '拖放文件到这里作为上下文', contextPanelAria: '已添加的上下文文件', defaultCurrentFile: '默认显示当前文件', clearContext: '清空上下文', contextMenu: '上下文菜单', composerPlaceholder: '询问、编辑或代理…', attachFile: '选择上下文文件', modelSelectTitle: '切换模型，切换后自动重启 Chat CLI', modelSelectAria: '切换模型', modelLoading: '模型加载中…', permissionModeTitle: '切换 Claude CLI 权限模式，切换后自动重启 Chat CLI', permissionModeAria: '切换权限模式', sendMessage: '发送消息', stopResponse: '停止当前响应', noModelConfigured: '未配置模型', selectModel: '请选择模型', permissionAcceptEdits: '当前：acceptEdits（自动接受编辑类工具）', permissionBypass: '当前：bypassPermissions（跳过权限检查，完全信任当前工作区）', emptyState: 'LLS CLAUDE CHAT - 开始对话', longTextOutput: '长文本输出', longCodeBlock: '长代码块', longDiffOutput: '长 diff 输出', copy: '复制', copyCode: '复制代码', usageModel: '模型 ', usageInput: '输入 ', usageOutput: '输出 ', usageCacheWrite: '缓存写 ', usageCacheRead: '缓存读 ', assistantNeedsConfirmation: '助手需要您的确认', askManyQuestions: '共 {count} 个问题，必须回复后才能继续', askOneQuestion: '请选择一个选项，或在下方填写自定义回复（必须回复）', noQuestionText: '(无问题文本)', multiSelect: '可多选', customReplyLabel: '其他回复（可选）：写下你的想法或不选某项的理由', customReplyPlaceholder: '例如：我想换一种实现方式…', sendReply: '发送回复', askUserReplyIntro: '我对你的问题做了如下回复：', askUserPicked: '   选择：{items}', askUserNoPick: '   选择：（未选择任何选项）', askUserExtra: '补充说明：', vscodeDiagnostics: 'VS Code 诊断', toolRunning: '执行中', toolSuccess: '成功', toolFailed: '失败', toolPermissionDenied: '需要授权', toolPending: '等待', collapsibleSummary: '{label}（{count} 字符，点击展开）', truncatedChars: '… 已截断 {count} 字符', resendTitle: '重发：删除此消息及其后续上下文并重新发送', resendAria: '重发此消息', loading: '加载中', cliNotSelected: 'CLI 未选择', cliStatus: 'CLI 状态：{status}{detail}', unknownError: '未知错误', copiedBodySource: '已复制 body 源码', copyBodySourceFailed: '复制 body 源码失败', removeAttachment: '移除 {name}', genericFile: '文件'
        }
    };
    chatTranslations['zh-tw'] = {
        statusInitializing: '正在初始化…', copySource: '複製原始碼', copySourceTitle: '複製目前 Webview body 原始碼', restart: '重新啟動', restartTitle: '重新啟動 CLI', clear: '清除', clearTitle: '清除聊天內容', dropFilesHere: '將檔案拖放到這裡作為上下文', contextPanelAria: '已新增的上下文檔案', defaultCurrentFile: '預設顯示目前檔案', clearContext: '清除上下文', contextMenu: '上下文選單', composerPlaceholder: '提問、編輯或代理…', attachFile: '選擇上下文檔案', modelSelectTitle: '切換模型，切換後會自動重新啟動 Chat CLI', modelSelectAria: '切換模型', modelLoading: '模型載入中…', permissionModeTitle: '切換 Claude CLI 權限模式，切換後會自動重新啟動 Chat CLI', permissionModeAria: '切換權限模式', sendMessage: '傳送訊息', stopResponse: '停止目前回應', noModelConfigured: '尚未設定模型', selectModel: '請選擇模型', permissionAcceptEdits: '目前：acceptEdits（自動接受編輯類工具）', permissionBypass: '目前：bypassPermissions（略過權限檢查，完全信任目前工作區）', emptyState: 'LLS CLAUDE CHAT - 開始對話', longTextOutput: '長文字輸出', longCodeBlock: '長程式碼區塊', longDiffOutput: '長 diff 輸出', copy: '複製', copyCode: '複製程式碼', usageModel: '模型 ', usageInput: '輸入 ', usageOutput: '輸出 ', usageCacheWrite: '快取寫入 ', usageCacheRead: '快取讀取 ', assistantNeedsConfirmation: '助手需要您的確認', askManyQuestions: '共有 {count} 個問題，必須回覆後才能繼續', askOneQuestion: '請選擇一個選項，或在下方填寫自訂回覆（必須回覆）', noQuestionText: '(沒有問題文字)', multiSelect: '可複選', customReplyLabel: '其他回覆（選填）：寫下你的想法或未選某項的理由', customReplyPlaceholder: '例如：我想換一種實作方式…', sendReply: '傳送回覆', askUserReplyIntro: '我對你的問題做了如下回覆：', askUserPicked: '   選擇：{items}', askUserNoPick: '   選擇：（未選擇任何選項）', askUserExtra: '補充說明：', vscodeDiagnostics: 'VS Code 診斷', toolRunning: '執行中', toolSuccess: '成功', toolFailed: '失敗', toolPermissionDenied: '需要授權', toolPending: '等待', collapsibleSummary: '{label}（{count} 個字元，點擊展開）', truncatedChars: '… 已截斷 {count} 個字元', resendTitle: '重送：刪除此訊息及後續上下文並重新傳送', resendAria: '重送此訊息', loading: '載入中', cliNotSelected: '尚未選擇 CLI', cliStatus: 'CLI 狀態：{status}{detail}', unknownError: '未知錯誤', copiedBodySource: '已複製 body 原始碼', copyBodySourceFailed: '複製 body 原始碼失敗', removeAttachment: '移除 {name}', genericFile: '檔案'
    };
    chatTranslations.ko = {
        statusInitializing: '초기화 중…', copySource: '소스 복사', copySourceTitle: '현재 Webview body 소스 복사', restart: '재시작', restartTitle: 'CLI 재시작', clear: '비우기', clearTitle: '채팅 내용 비우기', dropFilesHere: '파일을 여기에 끌어 놓아 컨텍스트로 추가', contextPanelAria: '추가된 컨텍스트 파일', defaultCurrentFile: '기본적으로 현재 파일 표시', clearContext: '컨텍스트 지우기', contextMenu: '컨텍스트 메뉴', composerPlaceholder: '질문, 편집 또는 에이전트…', attachFile: '컨텍스트 파일 선택', modelSelectTitle: '모델 전환, 전환 후 Chat CLI 자동 재시작', modelSelectAria: '모델 전환', modelLoading: '모델 로드 중…', permissionModeTitle: 'Claude CLI 권한 모드 전환, 전환 후 Chat CLI 자동 재시작', permissionModeAria: '권한 모드 전환', sendMessage: '메시지 보내기', stopResponse: '현재 응답 중지', noModelConfigured: '설정된 모델 없음', selectModel: '모델 선택', permissionAcceptEdits: '현재: acceptEdits(편집 도구 자동 승인)', permissionBypass: '현재: bypassPermissions(권한 확인 건너뛰기, 현재 작업 영역 완전 신뢰)', emptyState: 'LLS CLAUDE CHAT - 대화 시작', longTextOutput: '긴 텍스트 출력', longCodeBlock: '긴 코드 블록', longDiffOutput: '긴 diff 출력', copy: '복사', copyCode: '코드 복사', usageModel: '모델 ', usageInput: '입력 ', usageOutput: '출력 ', usageCacheWrite: '캐시 쓰기 ', usageCacheRead: '캐시 읽기 ', assistantNeedsConfirmation: '어시스턴트가 확인을 요청합니다', askManyQuestions: '질문이 {count}개 있습니다. 계속하려면 답변해야 합니다.', askOneQuestion: '옵션을 선택하거나 아래에 사용자 지정 답변을 입력하세요(필수).', noQuestionText: '(질문 텍스트 없음)', multiSelect: '다중 선택 가능', customReplyLabel: '기타 답변(선택): 생각이나 선택하지 않은 이유를 적어 주세요', customReplyPlaceholder: '예: 다른 구현 방식으로 바꾸고 싶습니다…', sendReply: '답변 보내기', askUserReplyIntro: '질문에 대해 다음과 같이 답변했습니다:', askUserPicked: '   선택: {items}', askUserNoPick: '   선택: (선택한 옵션 없음)', askUserExtra: '추가 설명:', vscodeDiagnostics: 'VS Code 진단', toolRunning: '실행 중', toolSuccess: '성공', toolFailed: '실패', toolPermissionDenied: '권한 필요', toolPending: '대기 중', collapsibleSummary: '{label}({count}자, 클릭하여 펼치기)', truncatedChars: '… {count}자 잘림', resendTitle: '다시 보내기: 이 메시지와 이후 컨텍스트를 삭제하고 다시 전송', resendAria: '이 메시지 다시 보내기', loading: '로드 중', cliNotSelected: 'CLI가 선택되지 않음', cliStatus: 'CLI 상태: {status}{detail}', unknownError: '알 수 없는 오류', copiedBodySource: 'body 소스를 복사했습니다', copyBodySourceFailed: 'body 소스 복사 실패', removeAttachment: '{name} 제거', genericFile: '파일'
    };
    chatTranslations.ja = {
        statusInitializing: '初期化中…', copySource: 'ソースをコピー', copySourceTitle: '現在の Webview body ソースをコピー', restart: '再起動', restartTitle: 'CLI を再起動', clear: 'クリア', clearTitle: 'チャット内容をクリア', dropFilesHere: 'ファイルをここにドロップしてコンテキストに追加', contextPanelAria: '追加済みのコンテキストファイル', defaultCurrentFile: '既定で現在のファイルを表示', clearContext: 'コンテキストをクリア', contextMenu: 'コンテキストメニュー', composerPlaceholder: '質問、編集、またはエージェント…', attachFile: 'コンテキストファイルを選択', modelSelectTitle: 'モデルを切り替え、切り替え後に Chat CLI を自動再起動', modelSelectAria: 'モデルを切り替え', modelLoading: 'モデルを読み込み中…', permissionModeTitle: 'Claude CLI 権限モードを切り替え、切り替え後に Chat CLI を自動再起動', permissionModeAria: '権限モードを切り替え', sendMessage: 'メッセージを送信', stopResponse: '現在の応答を停止', noModelConfigured: 'モデルが設定されていません', selectModel: 'モデルを選択してください', permissionAcceptEdits: '現在: acceptEdits（編集系ツールを自動承認）', permissionBypass: '現在: bypassPermissions（権限チェックをスキップし、現在のワークスペースを完全に信頼）', emptyState: 'LLS CLAUDE CHAT - 会話を開始', longTextOutput: '長いテキスト出力', longCodeBlock: '長いコードブロック', longDiffOutput: '長い diff 出力', copy: 'コピー', copyCode: 'コードをコピー', usageModel: 'モデル ', usageInput: '入力 ', usageOutput: '出力 ', usageCacheWrite: 'キャッシュ書き込み ', usageCacheRead: 'キャッシュ読み取り ', assistantNeedsConfirmation: 'アシスタントが確認を求めています', askManyQuestions: '{count} 件の質問があります。続行するには回答が必要です。', askOneQuestion: '選択肢を選ぶか、下にカスタム返信を入力してください（必須）。', noQuestionText: '(質問テキストなし)', multiSelect: '複数選択可', customReplyLabel: 'その他の返信（任意）：考えや選択しない理由を書いてください', customReplyPlaceholder: '例：別の実装方法に変更したいです…', sendReply: '返信を送信', askUserReplyIntro: '質問に対して次のように回答しました:', askUserPicked: '   選択: {items}', askUserNoPick: '   選択:（選択された項目はありません）', askUserExtra: '補足説明:', vscodeDiagnostics: 'VS Code 診断', toolRunning: '実行中', toolSuccess: '成功', toolFailed: '失敗', toolPermissionDenied: '権限が必要', toolPending: '待機中', collapsibleSummary: '{label}（{count} 文字、クリックして展開）', truncatedChars: '… {count} 文字を切り詰めました', resendTitle: '再送信: このメッセージと後続のコンテキストを削除して再送信', resendAria: 'このメッセージを再送信', loading: '読み込み中', cliNotSelected: 'CLI が未選択', cliStatus: 'CLI 状態: {status}{detail}', unknownError: '不明なエラー', copiedBodySource: 'body ソースをコピーしました', copyBodySourceFailed: 'body ソースのコピーに失敗しました', removeAttachment: '{name} を削除', genericFile: 'ファイル'
    };
    chatTranslations.fr = {
        statusInitializing: 'Initialisation…', copySource: 'Copier la source', copySourceTitle: 'Copier la source du body Webview actuel', restart: 'Redémarrer', restartTitle: 'Redémarrer le CLI', clear: 'Effacer', clearTitle: 'Effacer le contenu du chat', dropFilesHere: 'Déposez les fichiers ici comme contexte', contextPanelAria: 'Fichiers de contexte ajoutés', defaultCurrentFile: 'Afficher le fichier actuel par défaut', clearContext: 'Effacer le contexte', contextMenu: 'Menu de contexte', composerPlaceholder: 'Demander, modifier ou agent…', attachFile: 'Sélectionner des fichiers de contexte', modelSelectTitle: 'Changer de modèle et redémarrer automatiquement Chat CLI', modelSelectAria: 'Changer de modèle', modelLoading: 'Chargement des modèles…', permissionModeTitle: 'Changer le mode d’autorisation Claude CLI et redémarrer automatiquement Chat CLI', permissionModeAria: 'Changer le mode d’autorisation', sendMessage: 'Envoyer le message', stopResponse: 'Arrêter la réponse actuelle', noModelConfigured: 'Aucun modèle configuré', selectModel: 'Sélectionner un modèle', permissionAcceptEdits: 'Actuel : acceptEdits (accepter automatiquement les outils d’édition)', permissionBypass: 'Actuel : bypassPermissions (ignorer les contrôles d’autorisation, faire pleinement confiance à l’espace de travail actuel)', emptyState: 'LLS CLAUDE CHAT - Commencer une conversation', longTextOutput: 'Sortie texte longue', longCodeBlock: 'Bloc de code long', longDiffOutput: 'Sortie diff longue', copy: 'Copier', copyCode: 'Copier le code', usageModel: 'Modèle ', usageInput: 'Entrée ', usageOutput: 'Sortie ', usageCacheWrite: 'Écriture cache ', usageCacheRead: 'Lecture cache ', assistantNeedsConfirmation: 'L’assistant a besoin de votre confirmation', askManyQuestions: 'Il y a {count} questions. Vous devez répondre avant de continuer.', askOneQuestion: 'Choisissez une option ou saisissez une réponse personnalisée ci-dessous (obligatoire).', noQuestionText: '(Aucun texte de question)', multiSelect: 'Sélection multiple', customReplyLabel: 'Autre réponse (facultatif) : indiquez vos pensées ou pourquoi vous n’avez pas choisi une option', customReplyPlaceholder: 'Par exemple : je veux utiliser une autre implémentation…', sendReply: 'Envoyer la réponse', askUserReplyIntro: 'J’ai répondu à votre question comme suit :', askUserPicked: '   Sélection : {items}', askUserNoPick: '   Sélection : (aucune option sélectionnée)', askUserExtra: 'Note complémentaire :', vscodeDiagnostics: 'Diagnostics VS Code', toolRunning: 'En cours', toolSuccess: 'Succès', toolFailed: 'Échec', toolPermissionDenied: 'Autorisation requise', toolPending: 'En attente', collapsibleSummary: '{label} ({count} caractères, cliquez pour développer)', truncatedChars: '… {count} caractères tronqués', resendTitle: 'Renvoyer : supprimer ce message et le contexte suivant, puis renvoyer', resendAria: 'Renvoyer ce message', loading: 'Chargement', cliNotSelected: 'CLI non sélectionné', cliStatus: 'État CLI : {status}{detail}', unknownError: 'Erreur inconnue', copiedBodySource: 'Source body copiée', copyBodySourceFailed: 'Échec de la copie de la source body', removeAttachment: 'Supprimer {name}', genericFile: 'Fichier'
    };
    chatTranslations.de = {
        statusInitializing: 'Initialisierung…', copySource: 'Quelle kopieren', copySourceTitle: 'Quelle des aktuellen Webview-Body kopieren', restart: 'Neu starten', restartTitle: 'CLI neu starten', clear: 'Leeren', clearTitle: 'Chatinhalt leeren', dropFilesHere: 'Dateien hierher ziehen, um sie als Kontext zu verwenden', contextPanelAria: 'Hinzugefügte Kontextdateien', defaultCurrentFile: 'Aktuelle Datei standardmäßig anzeigen', clearContext: 'Kontext leeren', contextMenu: 'Kontextmenü', composerPlaceholder: 'Fragen, bearbeiten oder Agent…', attachFile: 'Kontextdateien auswählen', modelSelectTitle: 'Modell wechseln und Chat CLI danach automatisch neu starten', modelSelectAria: 'Modell wechseln', modelLoading: 'Modelle werden geladen…', permissionModeTitle: 'Claude-CLI-Berechtigungsmodus wechseln und Chat CLI danach automatisch neu starten', permissionModeAria: 'Berechtigungsmodus wechseln', sendMessage: 'Nachricht senden', stopResponse: 'Aktuelle Antwort stoppen', noModelConfigured: 'Kein Modell konfiguriert', selectModel: 'Modell auswählen', permissionAcceptEdits: 'Aktuell: acceptEdits (Bearbeitungswerkzeuge automatisch akzeptieren)', permissionBypass: 'Aktuell: bypassPermissions (Berechtigungsprüfungen überspringen, aktuellen Arbeitsbereich vollständig vertrauen)', emptyState: 'LLS CLAUDE CHAT - Unterhaltung starten', longTextOutput: 'Lange Textausgabe', longCodeBlock: 'Langer Codeblock', longDiffOutput: 'Lange diff-Ausgabe', copy: 'Kopieren', copyCode: 'Code kopieren', usageModel: 'Modell ', usageInput: 'Eingabe ', usageOutput: 'Ausgabe ', usageCacheWrite: 'Cache schreiben ', usageCacheRead: 'Cache lesen ', assistantNeedsConfirmation: 'Der Assistent benötigt Ihre Bestätigung', askManyQuestions: 'Es gibt {count} Fragen. Sie müssen antworten, bevor es weitergeht.', askOneQuestion: 'Wählen Sie eine Option oder geben Sie unten eine eigene Antwort ein (erforderlich).', noQuestionText: '(Kein Fragetext)', multiSelect: 'Mehrfachauswahl', customReplyLabel: 'Andere Antwort (optional): Schreiben Sie Ihre Gedanken oder warum Sie eine Option nicht gewählt haben', customReplyPlaceholder: 'Zum Beispiel: Ich möchte eine andere Implementierung verwenden…', sendReply: 'Antwort senden', askUserReplyIntro: 'Ich habe auf Ihre Frage wie folgt geantwortet:', askUserPicked: '   Auswahl: {items}', askUserNoPick: '   Auswahl: (keine Option ausgewählt)', askUserExtra: 'Zusätzlicher Hinweis:', vscodeDiagnostics: 'VS Code-Diagnose', toolRunning: 'Wird ausgeführt', toolSuccess: 'Erfolgreich', toolFailed: 'Fehlgeschlagen', toolPermissionDenied: 'Berechtigung erforderlich', toolPending: 'Warten', collapsibleSummary: '{label} ({count} Zeichen, zum Erweitern klicken)', truncatedChars: '… {count} Zeichen abgeschnitten', resendTitle: 'Erneut senden: diese Nachricht und folgenden Kontext löschen und erneut senden', resendAria: 'Diese Nachricht erneut senden', loading: 'Wird geladen', cliNotSelected: 'CLI nicht ausgewählt', cliStatus: 'CLI-Status: {status}{detail}', unknownError: 'Unbekannter Fehler', copiedBodySource: 'Body-Quelle kopiert', copyBodySourceFailed: 'Kopieren der Body-Quelle fehlgeschlagen', removeAttachment: '{name} entfernen', genericFile: 'Datei'
    };
    const vscode = acquireVsCodeApi();
    const messagesEl = document.querySelector('[data-role="messages"]');
    const composerShellEl = document.querySelector('[data-role="composer-shell"]');
    const composerEl = document.querySelector('[data-role="composer"]');
    const sendEl = document.querySelector('[data-role="send"]');
    const attachFileEl = document.querySelector('[data-role="attach-file"]');
    const contextPanelEl = document.querySelector('[data-role="context-panel"]');
    const toastEl = document.querySelector('[data-role="chat-toast"]');
    const contextCountEl = document.querySelector('[data-role="context-count"]');
    const contextClearEl = document.querySelector('[data-role="context-clear"]');
    const attachmentsEl = document.querySelector('[data-role="attachments"]');
    const dropOverlayEl = document.querySelector('[data-role="drop-overlay"]');
    const modelSelectEl = document.querySelector('[data-role="model-select"]');
    const permissionModeSelectEl = document.querySelector('[data-role="permission-mode-select"]');
    const statusEl = document.querySelector('[data-role="cli-status"]');
    const restartCliEl = document.querySelector('[data-role="restart-cli"]');
    const clearSessionEl = document.querySelector('[data-role="clear-session"]');
    const copyBodySourceEl = document.querySelector('[data-role="copy-body-source"]');
    const composerState = {
        attachments: [],
        modelOptions: [],
        currentModelKey: '',
        permissionMode: 'acceptEdits',
        defaultAttachmentPaths: new Set(),
        dragDepth: 0,
        chatRunning: false
    };
    let toastTimer = 0;
    let currentLanguage = DEFAULT_CHAT_LANGUAGE;
    let currentCliPath = '';
    let currentCliStatus = '';
    let currentCliDetail = '';

    /** 读取当前语言的文案，缺失时回落英文。 */
    function t(key) {
        return (chatTranslations[currentLanguage] && chatTranslations[currentLanguage][key]) || chatTranslations.en[key] || key;
    }

    /** 使用命名值格式化翻译模板。 */
    function tf(key, values) {
        return t(key).replace(/\{(\w+)\}/g, function (_, name) { return values && values[name] != null ? String(values[name]) : ''; });
    }

    /** 对聊天页静态 DOM 应用当前语言。 */
    function applyI18n() {
        document.documentElement.lang = currentLanguage;
        document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.dataset.i18nTitle)); });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
        document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
    }

    /** 更新当前聊天页语言，并按需重绘动态 DOM。 */
    function setChatLanguage(language) {
        const next = chatTranslations[language] ? language : DEFAULT_CHAT_LANGUAGE;
        if (next === currentLanguage) {
            applyI18n();
            return;
        }
        currentLanguage = next;
        applyI18n();
        rerenderLocalizedChatUi();
    }

    /** 语言变化后重新渲染所有由 JavaScript 动态生成的聊天 UI。 */
    function rerenderLocalizedChatUi() {
        updateCliStatusText();
        renderModelOptions();
        renderPermissionModeSelect();
        setChatRunning(composerState.chatRunning);
        rerenderMessagesFromDom();
    }

    /** 根据当前缓存的 CLI 状态刷新状态栏文案。 */
    function updateCliStatusText() {
        if (!statusEl) return;
        if (currentCliPath) {
            statusEl.textContent = 'CLI: ' + currentCliPath;
            return;
        }
        if (currentCliStatus) {
            statusEl.textContent = tf('cliStatus', {
                status: currentCliStatus,
                detail: currentCliDetail ? ' · ' + currentCliDetail : ''
            });
            return;
        }
        statusEl.textContent = t('cliNotSelected');
    }

    /**
     * 发送消息给扩展宿主。
     *
     * @param {unknown} message WebviewToExtension 消息对象。
     */
    function post(message) {
        vscode.postMessage(message);
    }

    /**
     * 生成适合前端状态使用的轻量随机 ID。
     *
     * @returns {string} 前端附件 ID。
     */
    function createClientId() {
        return 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    /**
     * 从文件路径中提取展示名称。
     *
     * @param {string} filePath 文件绝对路径、相对路径或 URI。
     * @returns {string} 文件名。
     */
    function basename(filePath) {
        const normalized = String(filePath || '').replace(/\\/g, '/').replace(/\/$/, '');
        return normalized.split('/').pop() || normalized || t('genericFile');
    }

    /**
     * 根据文件名生成短类型标识，模拟 VS Code Chat 附件 pill 左侧的语言标签。
     *
     * @param {string} fileName 文件名。
     * @returns {string} 两到四个字符的文件类型标签。
     */
    function fileBadge(fileName) {
        const name = String(fileName || '').toLowerCase();
        const ext = name.includes('.') ? name.split('.').pop() : '';
        const aliases = {
            ts: 'TS',
            tsx: 'TSX',
            js: 'JS',
            jsx: 'JSX',
            json: '{}',
            md: 'MD',
            css: 'CSS',
            html: 'HTML',
            py: 'PY'
        };
        return aliases[ext] || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE');
    }

    /**
     * 将 file:// URI 或 VS Code 资源 URI 尽量转换为本地路径。
     *
     * @param {string} value 拖放数据中的原始路径或 URI。
     * @returns {string} 可作为上下文引用的本地路径或原始值。
     */
    function normalizeDroppedPath(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        if (text.startsWith('file://')) {
            try {
                return decodeURIComponent(new URL(text).pathname);
            } catch {
                return decodeURIComponent(text.replace(/^file:\/\//, ''));
            }
        }
        return text;
    }

    /**
     * 从 VS Code 拖放 JSON 数据中递归提取 URI 或路径字段。
     *
     * @param {unknown} value 拖放 JSON 解析后的任意值。
     * @param {string[]} paths 输出路径数组。
     */
    function collectPathsFromJson(value, paths) {
        if (!value) return;
        if (typeof value === 'string') {
            const normalized = normalizeDroppedPath(value);
            if (normalized) paths.push(normalized);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) collectPathsFromJson(item, paths);
            return;
        }
        if (typeof value === 'object') {
            const record = value;
            for (const key of ['resourceUri', 'uri', 'fsPath', 'path', 'external']) {
                if (typeof record[key] === 'string') {
                    const normalized = normalizeDroppedPath(record[key]);
                    if (normalized) paths.push(normalized);
                }
            }
            for (const nestedKey of ['resources', 'files', 'items']) collectPathsFromJson(record[nestedKey], paths);
        }
    }

    /**
     * 从 DataTransfer 的文本/自定义格式中解析 VS Code 拖放文件 URI。
     *
     * VS Code 资源管理器拖拽时通常会带上 `application/vnd.code.uri-list`、
     * `text/uri-list` 或形如 `application/vnd.code.tree.*` 的 JSON 列表。
     *
     * @param {DataTransfer} transfer 浏览器拖放数据对象。
     * @returns {{ paths: string[]; debug: Record<string, string> }} 解析出的路径以及原始数据快照。
     */
    function extractDroppedTextPaths(transfer) {
        const paths = [];
        const debug = {};
        const seenTypes = new Set();
        const candidateTypes = [
            'application/vnd.code.uri-list',
            'text/uri-list',
            'text/plain',
            'CodeFiles',
            'application/vnd.code.copy-metadata',
            'application/vnd.code.tree.explorerResourceUrl'
        ];
        for (const type of Array.from(transfer.types || [])) candidateTypes.push(type);
        for (const type of candidateTypes) {
            if (!type || seenTypes.has(type)) continue;
            seenTypes.add(type);
            let data = '';
            try {
                data = transfer.getData(type);
            } catch {
                continue;
            }
            if (!data) continue;
            debug[type] = data.length > 500 ? data.slice(0, 500) + '…' : data;
            let parsedJson = false;
            try {
                const parsed = JSON.parse(data);
                if (parsed && (typeof parsed === 'object' || Array.isArray(parsed))) {
                    collectPathsFromJson(parsed, paths);
                    parsedJson = true;
                }
            } catch {
                // 非 JSON 数据，跳过。
            }
            if (parsedJson) continue;
            for (const line of data.split(/\r?\n/)) {
                const value = line.trim();
                if (!value || value.startsWith('#')) continue;
                const normalized = normalizeDroppedPath(value);
                if (normalized) paths.push(normalized);
            }
        }
        return { paths, debug };
    }

    /**
     * 尝试从拖拽 DataTransfer 中提取本地文件路径。
     *
     * @param {DataTransferItem} item 拖拽条目。
     * @param {File | undefined} file 浏览器 File 对象。
     * @returns {string} 可发送给扩展宿主的路径。
     */
    function extractDroppedFilePath(item, file) {
        const possiblePath = file?.path || item?.getAsFile?.()?.path;
        if (possiblePath) return possiblePath;
        const uriList = item?.type === 'text/uri-list' ? undefined : '';
        void uriList;
        return file?.name || '';
    }

    /**
     * 规范化扩展宿主或前端传入的附件对象。
     *
     * @param {string | Record<string, unknown>} value 文件路径或附件对象。
    * @param {{ source?: 'default' | 'manual' | 'drop' | 'paste' }} options 附件来源选项。
     * @returns {Record<string, unknown> | undefined} 可渲染和发送的附件对象。
     */
    function normalizeAttachment(value, options = {}) {
        const record = typeof value === 'object' && value ? value : { path: value };
        const filePath = String(record.path || '').trim();
        if (!filePath) return undefined;
        return {
            id: createClientId(),
            path: filePath,
            name: String(record.name || basename(filePath)),
            source: options.source || record.source || 'manual',
            startLine: typeof record.startLine === 'number' ? record.startLine : undefined,
            endLine: typeof record.endLine === 'number' ? record.endLine : undefined,
            startColumn: typeof record.startColumn === 'number' ? record.startColumn : undefined,
            endColumn: typeof record.endColumn === 'number' ? record.endColumn : undefined,
            selectedText: typeof record.selectedText === 'string' ? record.selectedText : undefined
        };
    }

    /**
     * 生成附件行号或选区展示后缀。
     *
     * @param {Record<string, unknown>} item 附件对象。
     * @returns {string} 展示用的行号文本。
     */
    function attachmentRangeLabel(item) {
        if (typeof item.startLine !== 'number') return '';
        if (typeof item.endLine === 'number' && item.endLine !== item.startLine) return ':' + item.startLine + '-' + item.endLine;
        return ':' + item.startLine;
    }

    /**
     * 根据路径数组或附件对象数组添加上下文附件并刷新展示。
     *
     * @param {Array<string | Record<string, unknown>>} attachments 待添加附件列表。
    * @param {{ source?: 'default' | 'manual' | 'drop' | 'paste' }} options 附件来源选项。
     */
    function addAttachments(attachments, options = {}) {
        const existing = new Set(composerState.attachments.map((item) => item.path));
        for (const rawItem of attachments || []) {
            const item = normalizeAttachment(rawItem, options);
            if (!item || existing.has(item.path)) continue;
            composerState.attachments.push(item);
            existing.add(item.path);
            if (item.source === 'default') composerState.defaultAttachmentPaths.add(item.path);
        }
        renderAttachments();
    }

    /**
     * 用扩展宿主传来的当前活动编辑器文件刷新默认上下文附件。
     *
     * @param {string | Record<string, unknown> | undefined} attachment 当前活动编辑器文件或选区附件。
     */
    function setDefaultAttachment(attachment) {
        composerState.attachments = composerState.attachments.filter((item) => item.source !== 'default');
        composerState.defaultAttachmentPaths.clear();
        if (attachment) addAttachments([attachment], { source: 'default' });
        else renderAttachments();
    }

    /**
     * 用扩展宿主保存后的真实文件路径替换上传中的附件占位。
     *
     * @param {string} clientId 前端生成的 pending 附件 ID。
     * @param {Record<string, unknown>} attachment 扩展宿主返回的真实附件。
     */
    function replaceAttachment(clientId, attachment) {
        const next = normalizeAttachment(attachment, { source: 'manual' });
        if (!next) return;
        next.id = clientId || next.id;
        const index = composerState.attachments.findIndex((item) => item.id === clientId);
        if (index >= 0) composerState.attachments[index] = next;
        else addAttachments([next], { source: 'manual' });
        renderAttachments();
    }

    /**
     * 删除指定上下文附件。
     *
     * @param {string} id 附件 ID。
     */
    function removeAttachment(id) {
        composerState.attachments = composerState.attachments.filter((item) => item.id !== id);
        renderAttachments();
    }

    /**
     * 清空当前输入框中的所有上下文附件。
     */
    function clearAttachments() {
        composerState.attachments = [];
        composerState.defaultAttachmentPaths.clear();
        renderAttachments();
    }

    /**
     * 渲染 Copilot Chat 风格的附件 pill 列表。
     */
    function renderAttachments() {
        if (!attachmentsEl) return;
        attachmentsEl.innerHTML = '';
        attachmentsEl.classList.toggle('attachment-bar--empty', composerState.attachments.length === 0);
        contextPanelEl?.classList.toggle('context-panel--empty', composerState.attachments.length === 0);
        if (contextCountEl) contextCountEl.textContent = composerState.attachments.length ? '(' + composerState.attachments.length + '/5)' : '';
        for (const item of composerState.attachments) {
            const pill = document.createElement('span');
            pill.className = 'attachment-pill';
            pill.title = item.path;

            const icon = document.createElement('span');
            icon.className = 'attachment-pill__icon';
            icon.textContent = fileBadge(item.name || item.path);

            const label = document.createElement('span');
            label.className = 'attachment-pill__label';
            label.textContent = item.name + attachmentRangeLabel(item);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'attachment-pill__remove';
            remove.textContent = '×';
            remove.title = tf('removeAttachment', { name: item.name });
            remove.addEventListener('click', () => removeAttachment(item.id));

            pill.appendChild(icon);
            pill.appendChild(label);
            pill.appendChild(remove);
            attachmentsEl.appendChild(pill);
        }
    }

    /**
     * 渲染输入框工具栏中的模型切换下拉框。
     */
    function renderModelOptions() {
        if (!(modelSelectEl instanceof HTMLSelectElement)) return;
        modelSelectEl.innerHTML = '';
        const models = composerState.modelOptions || [];
        if (models.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = t('noModelConfigured');
            modelSelectEl.appendChild(option);
            modelSelectEl.disabled = true;
            return;
        }
        modelSelectEl.disabled = false;
        if (!composerState.currentModelKey) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = t('selectModel');
            placeholder.selected = true;
            modelSelectEl.appendChild(placeholder);
        }
        for (const model of models) {
            const option = document.createElement('option');
            option.value = model.providerId + '/' + model.modelId;
            option.textContent = model.providerName + ': ' + model.displayName;
            option.title = option.value;
            option.selected = option.value === composerState.currentModelKey || model.selected;
            modelSelectEl.appendChild(option);
        }
    }

    /**
     * 渲染输入框工具栏中的 Claude CLI 权限模式下拉框。
     *
     * 当前只暴露常用的 `acceptEdits` 与 `bypassPermissions` 两项，避免把 CLI 的
     * default/auto/plan 等高级模式放到聊天快捷入口里造成误选。
     */
    function renderPermissionModeSelect() {
        if (!(permissionModeSelectEl instanceof HTMLSelectElement)) return;
        const mode = composerState.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
        permissionModeSelectEl.value = mode;
        permissionModeSelectEl.title = mode === 'bypassPermissions' ? t('permissionBypass') : t('permissionAcceptEdits');
    }

    /**
     * 在 Chat Webview 内展示轻量提示，不触发 VS Code 系统通知。
     *
     * @param {'info' | 'success' | 'warn' | 'error'} level 提示级别。
     * @param {string} text 提示文本。
     */
    function showToast(level, text) {
        if (!toastEl) return;
        if (toastTimer) window.clearTimeout(toastTimer);
        toastEl.textContent = text || '';
        toastEl.dataset.level = level || 'info';
        toastEl.classList.add('chat-toast--visible');
        toastEl.setAttribute('aria-hidden', 'false');
        toastTimer = window.setTimeout(() => {
            toastEl.classList.remove('chat-toast--visible');
            toastEl.setAttribute('aria-hidden', 'true');
            toastEl.textContent = '';
        }, 5000);
    }

    /**
     * 切换输入框右下角动作按钮：生成中显示方块用于停止，空闲时显示向上箭头用于发送。
     *
     * @param {boolean} running 当前聊天是否正在生成响应。
     */
    function setChatRunning(running) {
        composerState.chatRunning = !!running;
        if (!(sendEl instanceof HTMLButtonElement)) return;
        sendEl.textContent = composerState.chatRunning ? '■' : '↑';
        sendEl.title = composerState.chatRunning ? t('stopResponse') : t('sendMessage');
        sendEl.setAttribute('aria-label', composerState.chatRunning ? t('stopResponse') : t('sendMessage'));
        sendEl.dataset.mode = composerState.chatRunning ? 'stop' : 'send';
    }

    /**
     * 根据 textarea 内容自动调整输入框高度。
     */
    function autoResizeComposer() {
        if (!(composerEl instanceof HTMLTextAreaElement)) return;
        composerEl.style.height = 'auto';
        composerEl.style.height = Math.min(Math.max(composerEl.scrollHeight, 72), 260) + 'px';
    }

    /**
     * 设置拖拽文件进入/离开输入区的视觉反馈。
     *
     * @param {boolean} active 是否显示拖放覆盖层。
     */
    function setDropActive(active) {
        composerShellEl?.classList.toggle('chat-input--dragging', active);
        dropOverlayEl?.setAttribute('aria-hidden', active ? 'false' : 'true');
    }

    /**
     * 从 drop 事件中收集文件路径并添加为上下文。
     *
     * 兼容三种来源：
     *   1. VS Code 内部拖拽：从 text/uri-list 等 MIME 解析 URI。
     *   2. OS 文件管理器拖拽（Electron < 32）：file.path 直接可用。
     *   3. OS 文件管理器拖拽（Electron >= 32 或 Web）：file.path 为空，
     *      读取 ArrayBuffer 转 base64 发送给扩展宿主，由宿主写到临时目录。
     *
     * @param {DragEvent} event 浏览器拖放事件。
     */
    async function handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        composerState.dragDepth = 0;
        setDropActive(false);
        const paths = [];
        const transfer = event.dataTransfer;
        if (!transfer) {
            post({ type: 'log', level: 'warn', message: '[drop] 没有 dataTransfer' });
            return;
        }
        const { paths: textPaths, debug } = extractDroppedTextPaths(transfer);
        paths.push(...textPaths);
        const itemSnapshot = [];
        for (const item of Array.from(transfer.items || [])) {
            itemSnapshot.push({ kind: item.kind, type: item.type });
            if (item.kind === 'file') {
                const file = item.getAsFile();
                const filePath = extractDroppedFilePath(item, file || undefined);
                if (filePath) paths.push(filePath);
            }
        }
        const fileSnapshot = [];
        /** @type {File[]} 没有 path 的真实 File 对象，需要走 ArrayBuffer 上传通道。 */
        const filesNeedingUpload = [];
        for (const file of Array.from(transfer.files || [])) {
            fileSnapshot.push({ name: file.name, path: file.path || '', type: file.type, size: file.size });
            const filePath = file.path || '';
            if (filePath) {
                if (!paths.includes(filePath)) paths.push(filePath);
            } else if (file.name) {
                filesNeedingUpload.push(file);
            }
        }
        const types = Array.from(transfer.types || []);
        post({
            type: 'log',
            level: 'info',
            message: '[drop] types=' + JSON.stringify(types)
                + ' items=' + JSON.stringify(itemSnapshot)
                + ' files=' + JSON.stringify(fileSnapshot)
                + ' parsedPaths=' + JSON.stringify(paths)
                + ' needUpload=' + JSON.stringify(filesNeedingUpload.map((f) => f.name))
                + ' rawData=' + JSON.stringify(debug)
        });
        if (paths.length > 0) addAttachments(paths);
        if (filesNeedingUpload.length > 0) {
            await uploadDroppedFiles(filesNeedingUpload);
        }
        if (paths.length === 0 && filesNeedingUpload.length === 0) {
            post({ type: 'log', level: 'warn', message: '[drop] 未解析到任何文件，请反馈 rawData 给开发者' });
            return;
        }
        composerEl?.focus();
    }

    /**
     * 将拖入的浏览器 File 列表通过 ArrayBuffer 上传给扩展宿主，
     * 宿主负责写入临时目录后返回真实路径。
     *
     * @param {File[]} files 浏览器 File 对象列表。
     */
    async function uploadDroppedFiles(files) {
        await uploadBlobFiles(files, 'drop');
    }

    /**
     * 根据剪贴板图片 MIME 和当前时间生成稳定可读的临时文件名。
     *
     * @param {File} file 剪贴板中的图片 File 对象。
     * @param {number} index 当前粘贴批次内的图片序号。
     * @returns {string} 用于上传和展示的图片文件名。
     */
    function createPastedImageName(file, index) {
        const mime = String(file?.type || '').toLowerCase();
        const name = String(file?.name || '').trim();
        if (name && name !== 'image.png') return name;
        const extensionMap = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/tiff': 'tiff'
        };
        const extension = extensionMap[mime] || 'png';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return 'pasted-image-' + stamp + '-' + (index + 1) + '.' + extension;
    }

    /**
     * 生成粘贴图片在附件栏里的展示名，只显示文件类型，不暴露临时文件名。
     *
     * @param {File} file 剪贴板中的图片 File 对象。
     * @returns {string} 文件类型展示名。
     */
    function pastedImageDisplayName(file) {
        const mime = String(file?.type || '').trim();
        if (mime) return mime.replace(/^image\//i, '').toUpperCase();
        return 'IMAGE';
    }

    /**
     * 将粘贴或拖放得到的浏览器 File 上传给扩展宿主，并先插入 pending 附件占位。
     *
     * @param {File[]} files 浏览器 File 对象列表。
     * @param {'drop' | 'paste'} source 文件来源。
     */
    async function uploadBlobFiles(files, source) {
        let index = 0;
        for (const file of files) {
            try {
                const uploadName = source === 'paste' ? createPastedImageName(file, index) : (file.name || createPastedImageName(file, index));
                index += 1;
                const buffer = await file.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) binary += String.fromCharCode(bytes[byteIndex]);
                const base64 = btoa(binary);
                const placeholderId = createClientId();
                composerState.attachments.push({ id: placeholderId, path: '__pending__/' + uploadName, name: source === 'paste' ? pastedImageDisplayName(file) : uploadName, source });
                renderAttachments();
                post({
                    type: 'file/uploadBlob',
                    clientId: placeholderId,
                    name: uploadName,
                    displayName: source === 'paste' ? pastedImageDisplayName(file) : undefined,
                    size: file.size,
                    mime: file.type || 'application/octet-stream',
                    base64
                });
            } catch (err) {
                post({ type: 'log', level: 'error', message: '[' + source + '] 读取文件失败：' + (err instanceof Error ? err.message : String(err)) });
            }
        }
    }

    /**
     * 从 paste 事件中收集图片文件，覆盖 Ctrl+V 和右键菜单粘贴两种入口。
     *
     * @param {ClipboardEvent} event 浏览器剪贴板粘贴事件。
     */
    async function handlePaste(event) {
        const transfer = event.clipboardData;
        if (!transfer) return;
        const imageFiles = [];
        for (const item of Array.from(transfer.items || [])) {
            if (item.kind !== 'file' || !String(item.type || '').startsWith('image/')) continue;
            const file = item.getAsFile();
            if (file) imageFiles.push(file);
        }
        for (const file of Array.from(transfer.files || [])) {
            if (!String(file.type || '').startsWith('image/')) continue;
            if (!imageFiles.includes(file)) imageFiles.push(file);
        }
        if (imageFiles.length === 0) return;
        const latestImage = imageFiles[imageFiles.length - 1];
        event.preventDefault();
        event.stopPropagation();
        post({
            type: 'log',
            level: 'info',
            message: '[paste] latestImage=' + JSON.stringify({ name: latestImage.name, type: latestImage.type, size: latestImage.size, ignored: imageFiles.length - 1 })
        });
        await uploadBlobFiles([latestImage], 'paste');
        composerEl?.focus();
    }

    /**
     * 清空消息列表并显示空状态提示（参考项目风格）。
     */
    function renderEmptyState() {
        if (!messagesEl) return;
        messagesEl.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'emptyState_07S1Yg';
        var content = document.createElement('div');
        content.className = 'emptyStateContent_07S1Yg';
        var text = document.createElement('p');
        text.className = 'emptyStateText_07S1Yg';
        text.textContent = t('emptyState');
        content.appendChild(text);
        empty.appendChild(content);
        messagesEl.appendChild(empty);
    }

    /**
     * 判断消息列表当前是否处于"已经看到底部"的状态。
     *
     * 用户主动向上滚动查看历史时不应被新消息强行拉回底部；只有用户已经
     * 在底部附近（与底部距离小于阈值）才"跟随滚动"。
     *
     * @returns {boolean} 是否应该跟随滚动到底部。
     */
    function isScrolledNearBottom() {
        if (!messagesEl) return true;
        var threshold = 80;
        return (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) <= threshold;
    }

    /**
     * 一次性"强制下次渲染时滚到底部"标志。
     *
     * 在用户主动触发"重发"等动作时由扩展端发送的 `messages/truncate` 设置，
     * 紧随其后的第一次 append/patch 会消费它并把视图拉到底部，之后恢复
     * "智能跟随"逻辑。
     */
    var forceScrollToBottomOnce = false;

    /**
     * 是否等待下一条 pending assistant 消息渲染完成后再强制滚动到底部。
     *
     * 用户点击发送时，扩展端会先 append user 消息，再创建 pending assistant 占位。
     * 如果在 user 消息渲染后立即滚到底部，随后 pending 动画追加会把底部再次撑高，
     * 视觉上就像没有真正贴到底。因此这里由发送动作设置标记，等 pending indicator
     * 实际进入 DOM 后再滚动一次，保证最终停在加载动画下方。
     */
    var scrollAfterNextPendingAssistant = false;

    /**
     * 智能滚动到底部：仅当用户视图已经接近底部时才跟随，否则保留当前位置，
     * 避免向上查看历史时被新到达的 patch 强行拉到底部。
     *
     * 若 {@link forceScrollToBottomOnce} 为真，则无论当前位置如何都强制
     * 拉到底，并在消费后复位。
     *
     * @param {boolean} wasAtBottom 调用渲染逻辑**之前**是否已在底部。
     */
    function scrollToBottomIfNeeded(wasAtBottom) {
        if (!messagesEl) return;
        if (forceScrollToBottomOnce) {
            forceScrollToBottomOnce = false;
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
        }
        if (!wasAtBottom) return;
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    /**
     * 局部截断消息：从指定 index 起（含自身）的所有 .message_07S1Yg 节点一并移除。
     *
     * 不动 messages 容器本身、不动 scrollTop，避免触发"先到顶再到底"闪滚。
     * 若目标节点不存在则静默忽略。
     *
     * 这里按 `data-index`（在 {@link appendMessage} 中写入的消息位置坐标）寻址，
     * 比按消息 id 更稳定：扩展端只需传一个简单的整数索引，前端按位置直接命中。
     *
     * @param {number} fromIndex 起始消息索引（基于扩展端 chatMessages 数组的下标）。
     */
    function truncateMessagesFromIndex(fromIndex) {
        if (!messagesEl) return;
        if (typeof fromIndex !== 'number' || !isFinite(fromIndex) || fromIndex < 0) return;
        var startNode = messagesEl.querySelector('.message_07S1Yg[data-index="' + String(fromIndex) + '"]');
        if (!(startNode instanceof HTMLElement)) {
            // 兜底：找不到精确 index 时，删除所有 data-index >= fromIndex 的节点。
            var allNodes = messagesEl.querySelectorAll('.message_07S1Yg[data-index]');
            for (var n = 0; n < allNodes.length; n++) {
                var node = allNodes[n];
                var idx = parseInt(node.dataset.index || '-1', 10);
                if (isFinite(idx) && idx >= fromIndex) node.remove();
            }
            return;
        }
        // 一次性收集起始节点及其所有后续兄弟，避免边删边遍历。
        var toRemove = [];
        var cur = startNode;
        while (cur) {
            toRemove.push(cur);
            cur = cur.nextElementSibling instanceof HTMLElement ? cur.nextElementSibling : null;
        }
        for (var i = 0; i < toRemove.length; i++) toRemove[i].remove();
    }

    /**
     * 参考项目风格的 Markdown 渲染器。
     * 将 Markdown 文本解析为 DOM 节点并追加到容器中，使用参考项目的 CSS 类名。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {string} markdownText 原始 Markdown 文本。
     */
    function renderMarkdown(container, markdownText) {
        if (!markdownText) return;
        if (isLongOutput(markdownText)) {
            appendCollapsibleText(container, markdownText, t('longTextOutput'));
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'root_-a7MRw markdownRoot_07S1Yg';
        // 按行分割，执行简易 Markdown 解析
        const lines = markdownText.split('\n');
        let i = 0;
        let inCodeBlock = false;
        let codeBlockLang = '';
        let codeBlockLines = [];
        let inTable = false;
        let tableData = [];
        let listStack = []; // 用于嵌套列表

        function flushCodeBlock() {
            if (codeBlockLines.length === 0) return;
            const codeWrapper = document.createElement('div');
            codeWrapper.className = 'codeBlockWrapper_-a7MRw';
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            if (codeBlockLang) code.dataset.language = codeBlockLang;
            code.textContent = codeBlockLines.join('\n');
            pre.appendChild(code);
            codeWrapper.appendChild(pre);
            // 添加复制按钮（参考项目风格）
            const copyBtn = createCopyButton(code.textContent);
            copyBtn.className = 'copyButton_CEmTFw copyButton_-a7MRw';
            codeWrapper.appendChild(copyBtn);
            wrapper.appendChild(codeWrapper);
            codeBlockLang = '';
            codeBlockLines = [];
        }

        function flushTable() {
            if (tableData.length === 0) return;
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const tbody = document.createElement('tbody');
            // 表头（第一行）
            if (tableData.length > 0) {
                const headerRow = document.createElement('tr');
                const headerCells = tableData[0].map(function (cell) {
                    const th = document.createElement('th');
                    th.textContent = cell.trim();
                    return th;
                });
                headerCells.forEach(function (th) { headerRow.appendChild(th); });
                thead.appendChild(headerRow);
            }
            // 数据行（从第三行开始，第二行是分隔符）
            for (var t = 2; t < tableData.length; t++) {
                var dataRow = document.createElement('tr');
                var dataCells = tableData[t].map(function (cell) {
                    var td = document.createElement('td');
                    td.textContent = cell.trim();
                    return td;
                });
                dataCells.forEach(function (td) { dataRow.appendChild(td); });
                tbody.appendChild(dataRow);
            }
            table.appendChild(thead);
            table.appendChild(tbody);
            wrapper.appendChild(table);
            tableData = [];
        }

        function closeLists(untilDepth) {
            var depth = typeof untilDepth === 'number' ? untilDepth : 0;
            while (listStack.length > depth) {
                var entry = listStack.pop();
                wrapper.appendChild(entry.list);
            }
        }

        function getListItemPrefix(line) {
            var m = line.match(/^(\s*)([-*+]\s|(\d+)[.)]\s)/);
            if (m) {
                var indent = m[1].length;
                var ordered = !!m[3];
                return { indent: indent, ordered: ordered, prefix: m[2], match: m[0] };
            }
            return null;
        }

        while (i < lines.length) {
            var line = lines[i];
            var trimmed = line.trim();

            // 处理代码块结束
            if (inCodeBlock) {
                if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
                    flushCodeBlock();
                    inCodeBlock = false;
                    i++;
                    continue;
                }
                codeBlockLines.push(line);
                i++;
                continue;
            }

            // 处理代码块开始
            if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
                flushTable();
                closeLists(0);
                var langMatch = trimmed.match(/^```(\w*)/);
                codeBlockLang = langMatch ? langMatch[1] : '';
                inCodeBlock = true;
                i++;
                continue;
            }

            // 空行
            if (!trimmed) {
                closeLists(0);
                flushTable();
                i++;
                continue;
            }

            // 表格行
            if (trimmed.startsWith('|')) {
                var cells = trimmed.split('|').filter(Boolean);
                if (cells.length > 0) {
                    tableData.push(cells);
                    inTable = true;
                    i++;
                    continue;
                }
            } else if (inTable) {
                flushTable();
            }

            // 水平线
            if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
                closeLists(0);
                var hr = document.createElement('hr');
                wrapper.appendChild(hr);
                i++;
                continue;
            }

            // 标题
            var headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                closeLists(0);
                var level = headingMatch[1].length;
                var h = document.createElement('h' + Math.min(level, 6));
                h.textContent = headingMatch[2];
                wrapper.appendChild(h);
                i++;
                continue;
            }

            // 引用块
            if (trimmed.startsWith('> ')) {
                closeLists(0);
                var blockquote = document.createElement('blockquote');
                var quoteContent = trimmed.substring(2);
                // 收集所有连续引用行
                var quoteLines = [quoteContent];
                i++;
                while (i < lines.length && lines[i].trim().startsWith('> ')) {
                    quoteLines.push(lines[i].trim().substring(2));
                    i++;
                }
                var bp = document.createElement('p');
                bp.textContent = quoteLines.join('\n');
                blockquote.appendChild(bp);
                wrapper.appendChild(blockquote);
                continue;
            }

            // 列表项
            var listPrefix = getListItemPrefix(line);
            if (listPrefix) {
                var indentLevel = Math.floor(listPrefix.indent / 2);
                closeLists(indentLevel + 1);
                // 确保列表容器存在
                while (listStack.length < indentLevel + 1) {
                    var newList = document.createElement(listPrefix.ordered ? 'ol' : 'ul');
                    listStack.push({ list: newList, ordered: listPrefix.ordered });
                }
                // 修正有序列表的 start 属性
                var listEntry = listStack[listStack.length - 1];
                // 收集列表项内容（支持多行）
                var itemText = line.substring(listPrefix.match.length);
                i++;
                while (i < lines.length) {
                    var nextLine = lines[i];
                    var trimmedNext = nextLine.trim();
                    var nextPrefix = getListItemPrefix(nextLine);
                    if (!trimmedNext || nextPrefix) break;
                    if (trimmedNext.startsWith('```')) break;
                    itemText += '\n' + nextLine;
                    i++;
                }
                // 使用内联渲染来处理加粗、斜体、行内代码等
                var li = createListItem(itemText.trim());
                listEntry.list.appendChild(li);
                continue;
            }

            // 普通段落
            closeLists(0);
            var p = document.createElement('p');
            p.innerHTML = inlineMarkdownToHtml(trimmed);
            wrapper.appendChild(p);
            i++;
        }

        // 清理未关闭的块
        if (inCodeBlock) { flushCodeBlock(); }
        closeLists(0);
        if (inTable) { flushTable(); }

        container.appendChild(wrapper);
    }

    /**
     * 将行内 Markdown（加粗、斜体、行内代码、链接等）转换为 HTML。
     * 参考项目使用 marked 库，这里用轻量级正则实现核心功能。
     *
     * @param {string} text 行内 Markdown 文本。
     * @returns {string} 转换后的 HTML 字符串。
     */
    function inlineMarkdownToHtml(text) {
        // 转义 HTML 特殊字符（先处理）
        var escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        // 行内代码 `code`
        escaped = escaped.replace(/`([^`]+)`/g, function (_, code) {
            return '<code>' + code + '</code>';
        });
        // 加粗 **text** 或 __text__
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/__(.+?)__/g, '<strong>$1</strong>');
        // 斜体 *text* 或 _text_
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/_(.+?)_/g, '<em>$1</em>');
        // 删除线 ~~text~~
        escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');
        // 链接 [text](url)
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        // 图片 ![alt](url)
        escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
        return escaped;
    }

    /**
     * 创建带内联格式支持的列表项。
     *
     * @param {string} itemText 列表项文本（可能含内联 Markdown）。
     * @returns {HTMLLIElement} 列表项 DOM 元素。
     */
    function createListItem(itemText) {
        var li = document.createElement('li');
        li.innerHTML = inlineMarkdownToHtml(itemText);
        return li;
    }

    /**
     * 创建复制按钮（参考项目风格）。
     *
     * @param {string} textContent 要复制的文本内容。
     * @returns {HTMLElement} 复制按钮 DOM 元素。
     */
    function createCopyButton(textContent) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copyButton_CEmTFw';
        btn.title = t('copy');
        btn.setAttribute('aria-label', t('copyCode'));
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4L12 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4 7L10 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4 10L8 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="2" y="1" width="11" height="13" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
        btn.addEventListener('click', function () {
            navigator.clipboard.writeText(textContent).then(function () {
                var original = btn.innerHTML;
                btn.innerHTML = '✓';
                setTimeout(function () { btn.innerHTML = original; }, 1500);
            }).catch(function () {
                // fallback
                var ta = document.createElement('textarea');
                ta.value = textContent;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                var original = btn.innerHTML;
                btn.innerHTML = '✓';
                setTimeout(function () { btn.innerHTML = original; }, 1500);
            });
        });
        return btn;
    }

    /**
     * 将文本作为安全文本节点追加到消息容器，内容会经过 Markdown 渲染。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {string} text 待追加文本。
     */
    function appendText(container, text) {
        if (isLongOutput(text)) {
            appendCollapsibleText(container, text, t('longTextOutput'));
            return;
        }
        renderMarkdown(container, text);
    }

    /**
     * 以参考项目风格渲染一个 ChatSegment。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment ChatSegment 对象。
     */
    function appendSegment(container, segment) {
        if (!segment) return;
        if (segment.kind === 'code') {
            appendCode(container, segment);
            return;
        }
        if (segment.kind === 'fileRef') {
            appendFileRef(container, segment);
            return;
        }
        if (segment.kind === 'diff') {
            appendDiff(container, segment);
            return;
        }
        if (segment.kind === 'image') {
            appendImageSegment(container, segment);
            return;
        }
        if (segment.kind === 'tool') {
            // AskUserQuestion 工具不在聊天流中渲染卡片，改为弹出模态对话框，
            // 用户作答后会把答案作为一条新的 user 消息发送回上游。
            if (segment.tool && segment.tool.name === 'AskUserQuestion') {
                showAskUserQuestionModal(segment);
                return;
            }
            appendToolCard(container, segment);
            return;
        }
        if (segment.kind === 'usage') {
            appendUsageFooter(container, segment);
            return;
        }
        // 文本内容走 Markdown 渲染（参考项目方式）
        appendText(container, segment.text || segment.sourceText || '');
    }

    /**
     * 把数字格式化为千分位字符串；未提供时返回 '-'。
     *
     * @param {number|undefined} value token 数值。
     * @returns {string} 显示文本。
     */
    function formatUsageNumber(value) {
        if (typeof value !== 'number' || !isFinite(value) || value < 0) return '-';
        try {
            return value.toLocaleString();
        } catch (_err) {
            return String(value);
        }
    }

    /**
     * 连续多帧强制滚动到底部。
     *
     * 历史会话打开时，消息 DOM 虽然已经 append 完成，但 Markdown、代码块、图片、
     * 字体度量与 VS Code Webview 布局可能还会在后续几个 frame 内继续改变高度。
     * 如果只滚一次，scrollHeight 后续变大就会留下"距离底部还有一点"的空隙。
     * 因此这里用 requestAnimationFrame + 少量 setTimeout 兜底，多次按最新
     * scrollHeight 写入 scrollTop，确保最终贴到真实底部。
     */
    function forceScrollToBottomSettled() {
        if (!messagesEl) return;
        const scroll = function () {
            if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
        };
        scroll();
        requestAnimationFrame(function () {
            scroll();
            requestAnimationFrame(scroll);
        });
        setTimeout(scroll, 50);
        setTimeout(scroll, 150);
        setTimeout(scroll, 300);
    }

    /**
     * 在 assistant 消息底部渲染一行 token usage 摘要。
     *
     * 字段顺序：模型 · 输入 · 输出 · 缓存写 · 缓存读。每项前缀为简短中文标签，
     * 数字使用千分位；缺失字段显示 '-'。
     *
     * 节点带 `data-segment-id`，外层 patch 逻辑会按 id 做原地替换，因此同一条
     * assistant 消息上的 usage 不会重复追加。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment usage 片段，包含 segment.usage。
     */
    function appendUsageFooter(container, segment) {
        var usage = segment && segment.usage ? segment.usage : {};
        var footer = document.createElement('div');
        footer.className = 'assistantUsageFooter_07S1Yg';
        if (segment && segment.id) footer.dataset.segmentId = segment.id;
        var parts = [];
        if (usage.model) parts.push(t('usageModel') + String(usage.model));
        parts.push(t('usageInput') + formatUsageNumber(usage.inputTokens));
        parts.push(t('usageOutput') + formatUsageNumber(usage.outputTokens));
        parts.push(t('usageCacheWrite') + formatUsageNumber(usage.cacheCreationInputTokens));
        parts.push(t('usageCacheRead') + formatUsageNumber(usage.cacheReadInputTokens));
        footer.textContent = parts.join(' · ');
        container.appendChild(footer);
    }

    /**
     * 渲染用户发送的图片片段。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment image 片段，包含 imageUrl/mediaType/alt/filePath。
     */
    function appendImageSegment(container, segment) {
        if (!segment || !segment.imageUrl) return;
        var wrap = document.createElement('figure');
        wrap.className = 'chatImageSegment_07S1Yg';
        var img = document.createElement('img');
        img.className = 'chatImageSegment__img_07S1Yg';
        img.src = String(segment.imageUrl);
        img.alt = segment.alt || segment.filePath || 'image';
        img.loading = 'lazy';
        wrap.appendChild(img);
        var captionText = segment.alt || segment.filePath || segment.mediaType || '';
        if (captionText) {
            var caption = document.createElement('figcaption');
            caption.className = 'chatImageSegment__caption_07S1Yg';
            caption.textContent = captionText;
            wrap.appendChild(caption);
        }
        container.appendChild(wrap);
    }

    /**
     * 渲染代码块片段（参考项目风格：带代码块包装和复制按钮）。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment code 片段。
     */
    function appendCode(container, segment) {
        if (isLongOutput(segment.text || '')) {
            appendCollapsibleText(container, segment.text || '', segment.language ? t('longCodeBlock') + ' · ' + segment.language : t('longCodeBlock'));
            return;
        }
        var codeWrapper = document.createElement('div');
        codeWrapper.className = 'codeBlockWrapper_-a7MRw';
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        if (segment.language) code.dataset.language = segment.language;
        code.textContent = segment.text || '';
        pre.appendChild(code);
        codeWrapper.appendChild(pre);
        // 添加参考项目风格的复制按钮
        var copyBtn = createCopyButton(code.textContent);
        copyBtn.className += ' copyButton_CEmTFw copyButton_-a7MRw';
        codeWrapper.appendChild(copyBtn);
        container.appendChild(codeWrapper);
    }

    /**
     * 渲染可点击文件引用片段。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment fileRef 片段。
     */
    function appendFileRef(container, segment) {
        if (!segment.filePath) return;
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'file-ref';
        link.textContent = segment.text || segment.filePath;
        link.addEventListener('click', () => {
            post({
                type: 'file/open',
                path: segment.filePath,
                line: segment.startLine,
                endLine: segment.endLine
            });
        });
        container.appendChild(link);
    }

    /**
     * 渲染 unified diff 片段（使用 diff 编辑器的 CSS 变量）。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment diff 片段。
     */
    function appendDiff(container, segment) {
        if (isLongOutput(segment.text || '')) {
            appendCollapsibleText(container, segment.text || '', t('longDiffOutput'));
            return;
        }
        var pre = document.createElement('pre');
        pre.style.cssText = 'overflow-x: auto; white-space: pre; box-sizing: border-box; border-radius: 4px; max-width: 100%; margin: 8px 0; padding: 8px; background-color: var(--vscode-textCodeBlock-background, #1e1e1e);';
        for (var _i = 0, _lines = String(segment.text || '').split('\n'); _i < _lines.length; _i++) {
            var line = _lines[_i];
            var row = document.createElement('span');
            row.style.display = 'block';
            if (line.startsWith('+') && !line.startsWith('+++')) {
                row.style.cssText += 'background-color: var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,0.2)); color: var(--vscode-diffEditor-insertedTextBorder, #89D185);';
            }
            if (line.startsWith('-') && !line.startsWith('---')) {
                row.style.cssText += 'background-color: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.2)); color: var(--vscode-diffEditor-removedTextBorder, #f14c4c);';
            }
            if (line.startsWith('@@')) {
                row.style.cssText += 'color: var(--vscode-editorInfo-foreground, #3794FF);';
            }
            row.textContent = line + '\n';
            pre.appendChild(row);
        }
        container.appendChild(pre);
    }

    // =========================================================================
    // AskUserQuestion 模态弹窗
    // =========================================================================

    /** 记录已经处理过的 AskUserQuestion tool_use_id，防止流式增量重复弹窗。 */
    var askUserQuestionShown = Object.create(null);

    /**
     * 历史回放模式标志：当 `session/init` 在批量渲染历史消息时为 true。
     * 在该阶段遇到的 AskUserQuestion 不立即弹窗，而是暂存到
     * {@link lastHistoryAskUserSegment}，等回放结束后由
     * {@link finalizeHistoryReplayAskUser} 判断是否还需要弹。
     */
    var historyReplayMode = false;

    /** 历史回放中遇到的最后一个 AskUserQuestion segment（如果存在）。 */
    var lastHistoryAskUserSegment = null;

    /**
     * 最近一次 session/init 的消息指纹。
     *
     * 扩展宿主在 Webview ready、选择 CLI、清空会话等场景会发送 session/init。
     * 但 Webview ready 可能因为焦点/可见性变化被重复触发，如果每次都清空
     * messagesEl 再全量 append，用户会看到滚动条先跳到顶部再回到底部。
     * 这里记录消息 ID 序列，收到完全相同的 init 时只更新状态，不重绘消息列表。
     */
    var lastSessionInitSignature = '';
    /** 最近一次宿主同步后的消息缓存，用于语言切换时重绘动态文案。 */
    var renderedMessagesCache = [];

    /** 深拷贝消息数组，避免重绘缓存被后续增量修改污染。 */
    function cloneMessagesForCache(messages) {
        try {
            return JSON.parse(JSON.stringify(messages || []));
        } catch (_err) {
            return (messages || []).slice();
        }
    }

    /** 将新追加消息写入本地缓存。 */
    function cacheAppendedMessage(message) {
        if (!message) return;
        renderedMessagesCache.push(cloneMessagesForCache([message])[0]);
    }

    /** 将 patch 片段合并进本地缓存，确保语言切换可重绘最新内容。 */
    function cachePatchedMessage(id, segments, pending) {
        var target = renderedMessagesCache.find(function (item) { return item && item.id === id; });
        if (!target) return;
        if (typeof pending === 'boolean') target.pending = pending;
        if (!Array.isArray(segments) || segments.length === 0) return;
        target.segments = Array.isArray(target.segments) ? target.segments : [];
        segments.forEach(function (segment) {
            if (segment && segment.id) {
                var index = target.segments.findIndex(function (item) { return item && item.id === segment.id; });
                if (index >= 0) {
                    target.segments[index] = cloneMessagesForCache([segment])[0];
                    return;
                }
            }
            target.segments.push(cloneMessagesForCache([segment])[0]);
        });
    }

    /** 从指定位置截断本地消息缓存。 */
    function cacheTruncatedMessages(fromIndex) {
        if (typeof fromIndex !== 'number' || !isFinite(fromIndex) || fromIndex < 0) return;
        renderedMessagesCache = renderedMessagesCache.slice(0, fromIndex);
    }

    /** 按缓存完整重绘消息区，同时保留用户当前滚动意图。 */
    function rerenderMessagesFromDom() {
        if (!messagesEl) return;
        var messages = cloneMessagesForCache(renderedMessagesCache);
        var wasAtBottom = isScrolledNearBottom();
        renderEmptyState();
        historyReplayMode = true;
        lastHistoryAskUserSegment = null;
        try {
            messages.forEach(function (message) { appendMessage(message); });
        } finally {
            historyReplayMode = false;
            lastHistoryAskUserSegment = null;
        }
        lastSessionInitSignature = buildSessionInitSignature(messages);
        if (wasAtBottom) forceScrollToBottomSettled();
    }

    /**
     * 在历史回放阶段，每收到一条用户消息时调用——表示之前所有
     * AskUserQuestion 均已被回答，清空待弹队列。
     */
    function notifyHistoryUserMessage() {
        lastHistoryAskUserSegment = null;
    }

    /**
     * 历史回放结束钩子：若仍有未应答的 AskUserQuestion，则真正弹出。
     * 否则什么也不做。
     */
    function finalizeHistoryReplayAskUser() {
        historyReplayMode = false;
        var pending = lastHistoryAskUserSegment;
        lastHistoryAskUserSegment = null;
        if (pending) {
            // 走实时路径再次调用即可弹出
            showAskUserQuestionModal(pending);
        }
    }

    /**
     * 构造 session/init 消息列表指纹。
     *
    * 只使用消息 id 与角色，避免把完整消息内容 stringify 导致大会话卡顿。
    * 实时内容更新走 message/append 或 message/patch，不应该依赖重复
    * session/init 来刷新；因此只要消息队列身份没变，就跳过全量重绘。
     *
     * @param {any[]} messages session/init 携带的消息数组。
     * @returns 可比较的轻量指纹字符串。
     */
    function buildSessionInitSignature(messages) {
        return (messages || []).map(function (item) {
            return [item && item.id, item && item.role].join(':');
        }).join('|');
    }

    /**
     * 根据当前 DOM 中已渲染的消息节点重建 session/init 指纹。
     *
     * message/append 与 messages/truncate 都是增量 DOM 操作；操作完成后同步指纹，
     * 后续若宿主再次发送内容相同的 session/init，就能正确识别为重复初始化而跳过
     * 清空重绘，避免滚动条跳顶。
     *
     * @returns 当前 DOM 消息队列指纹。
     */
    function buildRenderedMessagesSignatureFromDom() {
        if (!messagesEl) return '';
        return Array.from(messagesEl.querySelectorAll('.message_07S1Yg')).map(function (item) {
            return [item.getAttribute('data-id') || '', item.getAttribute('data-role') || ''].join(':');
        }).join('|');
    }

    /**
     * 同步当前 DOM 消息队列指纹到 session/init 去重缓存。
     */
    function syncSessionInitSignatureFromDom() {
        lastSessionInitSignature = buildRenderedMessagesSignatureFromDom();
    }

    /**
     * 当助手调用 AskUserQuestion 工具时，弹出一个模态对话框让用户作答。
     *
     * 行为说明：
     * 1. 每个 question 渲染为一组选项按钮（multiSelect=true 时为多选，否则单选）。
     * 2. 弹窗底部固定提供一个"自定义回复"多行输入框，用户可以填写不在选项中的
     *    理由 / 补充说明，提交时与选中项一起发送。
     * 3. 用户选择并提交后，构造一条易读的中文 user 消息（包含每个问题的选择
     *    与补充说明）通过 `user/send` 协议发回扩展，让上游模型继续推进。
     * 4. 同一个 tool_use_id 只弹一次（防止 stream 增量重复触发），关闭时不会
     *    重新打开。
     * 5. 历史回放时（session/init 批量渲染），不立即弹窗，先记录到 pending
     *    集合；回放结束后再判断"最后一条消息"是否仍是未答复的 AskUserQuestion，
     *    只有此时才弹窗——避免重新打开 webview 时旧问询再次弹出。
     *
     * @param {any} segment 工具 segment，应满足 segment.tool.name === 'AskUserQuestion'。
     */
    function showAskUserQuestionModal(segment) {
        var tool = (segment && segment.tool) || {};
        var toolUseId = tool.toolUseId || segment.id || ('ask-' + Date.now());
        if (askUserQuestionShown[toolUseId]) return;

        // 历史回放阶段：先暂存，等回放结束后由 finalizeHistoryReplayAskUser 统一判断
        if (historyReplayMode) {
            lastHistoryAskUserSegment = segment;
            return;
        }

        askUserQuestionShown[toolUseId] = true;

        var input = tool.input || tryParseJSON(tool.detail) || {};
        var questions = Array.isArray(input.questions) ? input.questions : [];
        if (questions.length === 0) {
            // 没有可解析的问题：回退到工具卡片渲染，避免静默丢失
            delete askUserQuestionShown[toolUseId];
            var fallbackContainer = document.querySelector('.message_07S1Yg[data-role="assistant"]:last-of-type > div')
                || document.querySelector('[data-role="messages"]');
            if (fallbackContainer) appendToolCard(fallbackContainer, segment);
            return;
        }

        // ---------- 构造遮罩 + 弹窗 ----------
        var overlay = document.createElement('div');
        overlay.className = 'ask-modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        var modal = document.createElement('div');
        modal.className = 'ask-modal';
        overlay.appendChild(modal);

        var header = document.createElement('div');
        header.className = 'ask-modal__header';
        var title = document.createElement('h2');
        title.className = 'ask-modal__title';
        title.textContent = t('assistantNeedsConfirmation');
        header.appendChild(title);
        var subtitle = document.createElement('p');
        subtitle.className = 'ask-modal__subtitle';
        subtitle.textContent = questions.length > 1
            ? tf('askManyQuestions', { count: questions.length })
            : t('askOneQuestion');
        header.appendChild(subtitle);
        modal.appendChild(header);

        var body = document.createElement('div');
        body.className = 'ask-modal__body';
        modal.appendChild(body);

        /** 每个 question 的当前用户选择：{ questionIndex: Set<optionLabel> } */
        var selections = Object.create(null);

        questions.forEach(function (q, idx) {
            selections[idx] = new Set();
            var qWrap = document.createElement('section');
            qWrap.className = 'ask-modal__question';
            qWrap.dataset.qIndex = String(idx);

            var qHeader = document.createElement('div');
            qHeader.className = 'ask-modal__question-header';

            if (q.header) {
                var chip = document.createElement('span');
                chip.className = 'ask-modal__chip';
                chip.textContent = String(q.header);
                qHeader.appendChild(chip);
            }

            var qText = document.createElement('div');
            qText.className = 'ask-modal__question-text';
            qText.textContent = String(q.question || t('noQuestionText'));
            qHeader.appendChild(qText);
            qWrap.appendChild(qHeader);

            if (q.multiSelect) {
                var hint = document.createElement('p');
                hint.className = 'ask-modal__hint';
                hint.textContent = t('multiSelect');
                qWrap.appendChild(hint);
            }

            var optsList = document.createElement('div');
            optsList.className = 'ask-modal__options';
            var options = Array.isArray(q.options) ? q.options : [];
            options.forEach(function (opt) {
                if (!opt || !opt.label) return;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ask-modal__option';
                btn.dataset.label = String(opt.label);

                var labelEl = document.createElement('div');
                labelEl.className = 'ask-modal__option-label';
                labelEl.textContent = String(opt.label);
                btn.appendChild(labelEl);

                if (opt.description) {
                    var descEl = document.createElement('div');
                    descEl.className = 'ask-modal__option-desc';
                    descEl.textContent = String(opt.description);
                    btn.appendChild(descEl);
                }

                btn.addEventListener('click', function () {
                    var set = selections[idx];
                    if (q.multiSelect) {
                        if (set.has(opt.label)) {
                            set.delete(opt.label);
                            btn.classList.remove('is-selected');
                        } else {
                            set.add(opt.label);
                            btn.classList.add('is-selected');
                        }
                    } else {
                        // 单选：清空其他按钮高亮
                        optsList.querySelectorAll('.ask-modal__option').forEach(function (b) {
                            b.classList.remove('is-selected');
                        });
                        set.clear();
                        set.add(opt.label);
                        btn.classList.add('is-selected');
                    }
                    updateSubmitState();
                });

                optsList.appendChild(btn);
            });
            qWrap.appendChild(optsList);

            body.appendChild(qWrap);
        });

        // ---------- 底部自定义输入区 ----------
        var customWrap = document.createElement('div');
        customWrap.className = 'ask-modal__custom';
        var customLabel = document.createElement('label');
        customLabel.className = 'ask-modal__custom-label';
        customLabel.textContent = t('customReplyLabel');
        customWrap.appendChild(customLabel);
        var customInput = document.createElement('textarea');
        customInput.className = 'ask-modal__custom-input';
        customInput.rows = 3;
        customInput.placeholder = t('customReplyPlaceholder');
        customWrap.appendChild(customInput);
        modal.appendChild(customWrap);

        // ---------- 底部操作按钮 ----------
        // 注意：AskUserQuestion 是助手的强问询，必须回复，因此不提供"取消"按钮。
        var footer = document.createElement('div');
        footer.className = 'ask-modal__footer';

        var submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'ask-modal__btn ask-modal__btn--primary';
        submitBtn.textContent = t('sendReply');
        footer.appendChild(submitBtn);

        modal.appendChild(footer);

        /**
         * 校验"至少有一个问题选了选项 或 自定义输入非空"才允许提交。
         */
        function updateSubmitState() {
            var anySelected = false;
            for (var k in selections) {
                if (selections[k] && selections[k].size > 0) {
                    anySelected = true;
                    break;
                }
            }
            var hasCustom = customInput.value.trim().length > 0;
            submitBtn.disabled = !(anySelected || hasCustom);
        }
        customInput.addEventListener('input', updateSubmitState);

        /**
         * 关闭并清理弹窗 DOM。
         * 仅在提交成功后调用——用户无法主动取消。
         */
        function closeModal() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            document.removeEventListener('keydown', onKeydown);
        }

        /**
         * 键盘事件：
         * - Ctrl/⌘+Enter 提交（如可提交）
         * - Esc 被显式屏蔽，因为本弹窗为强问询，不允许取消
         */
        function onKeydown(ev) {
            if (ev.key === 'Escape') {
                // 屏蔽 Esc，防止误关
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                if (!submitBtn.disabled) submitBtn.click();
            }
        }

        // 屏蔽遮罩点击关闭：必须回复
        overlay.addEventListener('mousedown', function (ev) {
            if (ev.target === overlay) {
                ev.preventDefault();
                ev.stopPropagation();
            }
        });

        submitBtn.addEventListener('click', function () {
            if (submitBtn.disabled) return;
            // 构造用户回复文本：每个问题列出选择，末尾附上自定义补充
            var lines = [t('askUserReplyIntro')];
            questions.forEach(function (q, idx) {
                var picked = selections[idx] ? Array.from(selections[idx]) : [];
                var header = q.header ? '[' + q.header + '] ' : '';
                var qText = String(q.question || '').trim();
                lines.push('');
                lines.push((idx + 1) + '. ' + header + qText);
                if (picked.length > 0) {
                    lines.push(tf('askUserPicked', { items: picked.join(currentLanguage === 'zh-cn' || currentLanguage === 'zh-tw' ? '、' : ', ') }));
                } else {
                    lines.push(t('askUserNoPick'));
                }
            });
            var custom = customInput.value.trim();
            if (custom) {
                lines.push('');
                lines.push(t('askUserExtra'));
                lines.push(custom);
            }
            var replyText = lines.join('\n');
            post({ type: 'user/send', text: replyText, attachments: [] });
            closeModal();
        });

        updateSubmitState();
        document.addEventListener('keydown', onKeydown);
        document.body.appendChild(overlay);

        // 自动聚焦自定义输入框，避免用户被迫先点
        setTimeout(function () { customInput.focus(); }, 30);
    }

    /**
     * 渲染工具调用卡片（参考项目风格 + 按工具名差异化展示）。
     *
     * 渲染流程：
     * 1. 构造摘要行：图标 + 工具名 + 按工具名定制的摘要文本（如 Bash 显示命令、Read 显示路径）
     * 2. 构造主体：调用对应工具的渲染器（renderBashTool / renderReadTool / renderEditTool / ...）
     * 3. 若已有结果（resultText），追加 Output 区
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment tool 片段。
     */
    function appendToolCard(container, segment) {
        var tool = segment.tool || {};
        var name = tool.name || 'Tool';
        var status = tool.status || 'pending';
        var input = tool.input || tryParseJSON(tool.detail);
        var resultText = tool.resultText || '';
        var isError = !!tool.isError;

        var root = document.createElement('div');
        root.className = 'root_ZUQaOA tool-status-' + status + ' tool-name-' + sanitizeToolClassName(name);
        if (segment.id) root.dataset.segmentId = segment.id;
        root.dataset.toolStatus = status;
        root.dataset.toolName = name;

        // 摘要行
        var summary = document.createElement('div');
        summary.className = 'toolSummary_ZUQaOA';

        var iconSpan = document.createElement('span');
        iconSpan.className = 'toolStatusIcon_ZUQaOA';
        iconSpan.textContent = pickToolStatusIcon(status);
        iconSpan.setAttribute('aria-hidden', 'true');
        summary.appendChild(iconSpan);

        var toolIcon = document.createElement('span');
        toolIcon.className = 'toolKindIcon_ZUQaOA';
        toolIcon.textContent = pickToolKindIcon(name);
        toolIcon.setAttribute('aria-hidden', 'true');
        summary.appendChild(toolIcon);

        var nameSpan = document.createElement('span');
        nameSpan.className = 'toolNameText_ZUQaOA';
        nameSpan.textContent = buildToolSummaryText(name, input) || name;
        summary.appendChild(nameSpan);

        var badge = document.createElement('span');
        badge.className = 'toolStatusBadge_ZUQaOA toolStatusBadge-' + status;
        badge.textContent = pickToolStatusLabel(status);
        summary.appendChild(badge);

        root.appendChild(summary);

        // 主体：按工具名分派渲染器
        var body = document.createElement('div');
        body.className = 'toolBody_ZUQaOA';
        renderToolBody(body, name, input, resultText, isError, tool, segment);
        root.appendChild(body);

        container.appendChild(root);
    }

    /**
     * 把工具名转换为安全的 CSS class 后缀（去除空格 / 非字母数字字符）。
     *
     * @param {string} name 工具名。
     * @returns {string} 安全的 class 片段。
     */
    function sanitizeToolClassName(name) {
        return String(name || 'tool').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }

    /**
     * 选择工具名对应的视觉图标。仅作装饰，渲染失败可降级为通用图标。
     *
     * @param {string} name 工具名。
     * @returns {string} Unicode 图标字符。
     */
    function pickToolKindIcon(name) {
        switch (name) {
            case 'Bash': return '$_';
            case 'Read': return '📖';
            case 'Edit': return '✏️';
            case 'Write': return '📝';
            case 'NotebookEdit': return '📓';
            case 'TodoWrite': return '📋';
            case 'WebFetch': return '🌐';
            case 'WebSearch': return '🔎';
            case 'Agent': return '🤖';
            case 'Skill': return '🧩';
            case 'AskUserQuestion': return '❓';
            case 'EnterPlanMode':
            case 'ExitPlanMode': return '🗺️';
            case 'EnterWorktree':
            case 'ExitWorktree': return '🌳';
            case 'CronCreate':
            case 'CronDelete':
            case 'CronList':
            case 'ScheduleWakeup': return '⏰';
            case 'TaskOutput':
            case 'TaskStop': return '🛠️';
            case 'get_llsccai_vscode_diagnostics': return '🩺';
            default: return '🔧';
        }
    }

    /**
     * 根据工具名与输入参数构造摘要行的紧凑文案。
     *
     * 例如：
     * - Bash → `$ npm install`
     * - Read → `Read src/foo.ts:1-200`
     * - Edit → `Edit src/foo.ts`
     * - Write → `Write src/foo.ts`
     * - TodoWrite → `TodoWrite · 5 todos`
     * - WebFetch → `WebFetch https://example.com`
     * - WebSearch → `WebSearch "latest react"`
     * - Agent → `Agent (general-purpose) · description`
     *
     * 工具名未识别或 input 缺失时返回原始工具名。
     *
     * @param {string} name 工具名。
     * @param {any} input 工具入参对象。
     * @returns {string} 摘要文案。
     */
    function buildToolSummaryText(name, input) {
        if (!input || typeof input !== 'object') return name;
        try {
            switch (name) {
                case 'Bash': {
                    var cmd = String(input.command || '').replace(/\s+/g, ' ').trim();
                    if (input.run_in_background) return 'Bash (bg) · ' + truncateInline(cmd, 80);
                    return 'Bash · ' + truncateInline(cmd, 80);
                }
                case 'Read': {
                    var p = input.file_path || '';
                    var range = '';
                    if (input.offset || input.limit) {
                        var start = input.offset || 1;
                        var end = (input.offset || 1) + (input.limit || 0) - 1;
                        range = ':' + start + (input.limit ? '-' + end : '');
                    }
                    if (input.pages) range = ' pages=' + input.pages;
                    return 'Read · ' + shortenPath(p) + range;
                }
                case 'Edit': {
                    var label = input.replace_all ? 'Edit (all)' : 'Edit';
                    return label + ' · ' + shortenPath(input.file_path || '');
                }
                case 'Write':
                    return 'Write · ' + shortenPath(input.file_path || '');
                case 'NotebookEdit': {
                    var mode = input.edit_mode || 'replace';
                    return 'Notebook ' + mode + ' · ' + shortenPath(input.notebook_path || '');
                }
                case 'TodoWrite': {
                    var todos = Array.isArray(input.todos) ? input.todos : [];
                    return 'TodoWrite · ' + todos.length + ' todos';
                }
                case 'WebFetch':
                    return 'WebFetch · ' + truncateInline(String(input.url || ''), 80);
                case 'WebSearch':
                    return 'WebSearch · "' + truncateInline(String(input.query || ''), 80) + '"';
                case 'Agent': {
                    var sub = input.subagent_type ? '(' + input.subagent_type + ') ' : '';
                    return 'Agent ' + sub + '· ' + truncateInline(String(input.description || input.prompt || ''), 80);
                }
                case 'Skill':
                    return 'Skill · /' + (input.skill || '');
                case 'AskUserQuestion': {
                    var qs = Array.isArray(input.questions) ? input.questions : [];
                    return 'AskUserQuestion · ' + qs.length + ' question' + (qs.length === 1 ? '' : 's');
                }
                case 'CronCreate':
                    return 'CronCreate · ' + (input.cron || '') + (input.recurring === false ? ' (once)' : '');
                case 'CronDelete':
                    return 'CronDelete · ' + (input.id || '');
                case 'CronList':
                    return 'CronList';
                case 'ScheduleWakeup':
                    return 'ScheduleWakeup · ' + (input.delaySeconds || '?') + 's';
                case 'EnterPlanMode': return 'EnterPlanMode';
                case 'ExitPlanMode': return 'ExitPlanMode';
                case 'EnterWorktree': return 'EnterWorktree' + (input.name ? ' · ' + input.name : '');
                case 'ExitWorktree': return 'ExitWorktree · ' + (input.action || '');
                case 'TaskOutput': return 'TaskOutput · ' + (input.task_id || '');
                case 'TaskStop': return 'TaskStop · ' + (input.task_id || input.shell_id || '');
                case 'get_llsccai_vscode_diagnostics':
                    return t('vscodeDiagnostics') + (Array.isArray(input.filePaths) && input.filePaths.length ? ' · ' + input.filePaths.length + ' path(s)' : '');
                default:
                    return name;
            }
        } catch (_e) {
            return name;
        }
    }

    /**
     * 按工具名分派详情渲染逻辑。
     *
     * 注意：每个分支自行决定是否展示 input、是否展示 result，以及它们的呈现方式。
     * 例如 Read 只展示 output（因为参数已在摘要中体现），Edit 用 unified diff 展示
     * old → new，TodoWrite 用列表渲染 todos。
     *
     * @param {HTMLElement} body 工具卡片主体容器。
     * @param {string} name 工具名。
     * @param {any} input 工具入参。
     * @param {string} resultText 工具结果文本。
     * @param {boolean} isError 是否错误结果。
     * @param {any} tool 原始 tool 对象（用于回退展示）。
     * @param {any} segment 原始 segment（用于回退展示）。
     */
    function renderToolBody(body, name, input, resultText, isError, tool, segment) {
        switch (name) {
            case 'Bash':
                return renderBashTool(body, input, resultText, isError);
            case 'Read':
                return renderReadTool(body, input, resultText, isError);
            case 'Edit':
                return renderEditTool(body, input, resultText, isError);
            case 'Write':
                return renderWriteTool(body, input, resultText, isError);
            case 'NotebookEdit':
                return renderNotebookEditTool(body, input, resultText, isError);
            case 'TodoWrite':
                return renderTodoWriteTool(body, input, resultText, isError);
            case 'WebFetch':
            case 'WebSearch':
                return renderWebTool(body, name, input, resultText, isError);
            case 'Agent':
                return renderAgentTool(body, input, resultText, isError);
            case 'AskUserQuestion':
                return renderAskUserQuestionTool(body, input, resultText, isError);
            default:
                return renderGenericTool(body, input, resultText, isError, tool, segment);
        }
    }

    /**
     * 渲染 Bash 工具：上方展示 `$ command`，下方展示输出（已折叠长文本）。
     */
    function renderBashTool(body, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            appendToolRow(inputWrap, '$', String(input.command || ''));
            if (input.description) appendToolRow(inputWrap, 'desc', String(input.description));
            if (input.timeout) appendToolRow(inputWrap, 'timeout', String(input.timeout) + 'ms');
            if (input.run_in_background) appendToolRow(inputWrap, 'mode', 'background');
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 Read 工具：摘要里已经展示路径，因此主体只显示输出。
     */
    function renderReadTool(body, input, resultText, isError) {
        if (input && input.file_path) {
            var inputWrap = makeToolGrid();
            appendToolFileRow(inputWrap, 'file', String(input.file_path), input.offset);
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 Edit 工具：上方展示路径，中部展示 unified diff（old vs new）。
     */
    function renderEditTool(body, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            if (input.file_path) appendToolFileRow(inputWrap, 'file', String(input.file_path));
            if (input.replace_all) appendToolRow(inputWrap, 'mode', 'replace_all');
            body.appendChild(inputWrap);

            if (input.old_string || input.new_string) {
                var diffWrap = document.createElement('div');
                diffWrap.className = 'toolDiffWrap_ZUQaOA';
                diffWrap.appendChild(buildDiffBlock('-', String(input.old_string || ''), 'removed'));
                diffWrap.appendChild(buildDiffBlock('+', String(input.new_string || ''), 'inserted'));
                body.appendChild(diffWrap);
            }
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 Write 工具：路径 + 写入内容预览（折叠长文本）。
     */
    function renderWriteTool(body, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            if (input.file_path) appendToolFileRow(inputWrap, 'file', String(input.file_path));
            if (typeof input.content === 'string') {
                var lines = input.content.split('\n').length;
                appendToolRow(inputWrap, 'size', lines + ' line' + (lines === 1 ? '' : 's'));
                appendToolRow(inputWrap, 'preview', truncateLongText(input.content));
            }
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 NotebookEdit 工具：notebook 路径 + cell 信息 + 新源码预览。
     */
    function renderNotebookEditTool(body, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            if (input.notebook_path) appendToolFileRow(inputWrap, 'notebook', String(input.notebook_path));
            if (input.cell_id) appendToolRow(inputWrap, 'cell_id', String(input.cell_id));
            if (input.cell_type) appendToolRow(inputWrap, 'cell_type', String(input.cell_type));
            if (input.edit_mode) appendToolRow(inputWrap, 'edit_mode', String(input.edit_mode));
            if (typeof input.new_source === 'string') appendToolRow(inputWrap, 'new_source', truncateLongText(input.new_source));
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 TodoWrite 工具：以列表形式显示每条 todo 的 status / content / activeForm。
     */
    function renderTodoWriteTool(body, input, resultText, isError) {
        var todos = input && Array.isArray(input.todos) ? input.todos : [];
        if (todos.length > 0) {
            var list = document.createElement('ul');
            list.className = 'toolTodoList_ZUQaOA';
            for (var i = 0; i < todos.length; i++) {
                var t = todos[i] || {};
                var li = document.createElement('li');
                li.className = 'toolTodoItem_ZUQaOA toolTodo-' + (t.status || 'pending');
                var icon = document.createElement('span');
                icon.className = 'toolTodoIcon_ZUQaOA';
                icon.textContent = pickTodoIcon(t.status);
                li.appendChild(icon);
                var text = document.createElement('span');
                text.className = 'toolTodoText_ZUQaOA';
                text.textContent = t.status === 'in_progress' ? (t.activeForm || t.content || '') : (t.content || t.activeForm || '');
                li.appendChild(text);
                list.appendChild(li);
            }
            body.appendChild(list);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 WebFetch / WebSearch 工具：URL/query + prompt + 结果摘要。
     */
    function renderWebTool(body, name, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            if (input.url) appendToolRow(inputWrap, 'url', String(input.url));
            if (input.query) appendToolRow(inputWrap, 'query', String(input.query));
            if (input.prompt) appendToolRow(inputWrap, 'prompt', truncateLongText(String(input.prompt)));
            if (Array.isArray(input.allowed_domains) && input.allowed_domains.length) {
                appendToolRow(inputWrap, 'allowed', input.allowed_domains.join(', '));
            }
            if (Array.isArray(input.blocked_domains) && input.blocked_domains.length) {
                appendToolRow(inputWrap, 'blocked', input.blocked_domains.join(', '));
            }
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 Agent 工具：subagent_type + description + prompt + 结果。
     */
    function renderAgentTool(body, input, resultText, isError) {
        if (input) {
            var inputWrap = makeToolGrid();
            if (input.subagent_type) appendToolRow(inputWrap, 'agent', String(input.subagent_type));
            if (input.description) appendToolRow(inputWrap, 'desc', String(input.description));
            if (input.model) appendToolRow(inputWrap, 'model', String(input.model));
            if (input.run_in_background) appendToolRow(inputWrap, 'mode', 'background');
            if (input.isolation) appendToolRow(inputWrap, 'isolation', String(input.isolation));
            if (input.prompt) appendToolRow(inputWrap, 'prompt', truncateLongText(String(input.prompt)));
            body.appendChild(inputWrap);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 渲染 AskUserQuestion 工具：以列表形式渲染问题。
     */
    function renderAskUserQuestionTool(body, input, resultText, isError) {
        var qs = input && Array.isArray(input.questions) ? input.questions : [];
        if (qs.length) {
            var list = document.createElement('ol');
            list.className = 'toolAskQuestionList_ZUQaOA';
            for (var i = 0; i < qs.length; i++) {
                var q = qs[i] || {};
                var li = document.createElement('li');
                var qHeader = document.createElement('div');
                qHeader.className = 'toolAskQuestionHeader_ZUQaOA';
                qHeader.textContent = q.question || q.header || ('Q' + (i + 1));
                li.appendChild(qHeader);
                if (Array.isArray(q.options) && q.options.length) {
                    var optList = document.createElement('ul');
                    optList.className = 'toolAskQuestionOptions_ZUQaOA';
                    for (var j = 0; j < q.options.length; j++) {
                        var opt = q.options[j] || {};
                        var oli = document.createElement('li');
                        oli.textContent = '• ' + (opt.label || '');
                        optList.appendChild(oli);
                    }
                    li.appendChild(optList);
                }
                list.appendChild(li);
            }
            body.appendChild(list);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 通用渲染：input pretty JSON + result。未识别工具的兜底显示。
     */
    function renderGenericTool(body, input, resultText, isError, tool, segment) {
        var detailText = '';
        var fileRows = collectToolFileRows(input);
        if (fileRows.length > 0) {
            var fileGrid = makeToolGrid();
            for (var i = 0; i < fileRows.length; i++) {
                appendToolFileRow(fileGrid, fileRows[i].label, fileRows[i].path);
            }
            body.appendChild(fileGrid);
        }
        if (input && typeof input === 'object') {
            try { detailText = JSON.stringify(input, null, 2); } catch (_e) { detailText = String(tool && tool.detail || ''); }
        } else {
            detailText = String(tool && tool.detail || segment && segment.sourceText || '');
        }
        if (detailText) {
            var grid = makeToolGrid();
            appendToolRow(grid, 'input', detailText);
            body.appendChild(grid);
        }
        if (resultText) appendToolResult(body, resultText, isError);
    }

    /**
     * 创建一个工具主体的 grid 容器。
     *
     * @returns {HTMLElement} grid 容器。
     */
    function makeToolGrid() {
        var grid = document.createElement('div');
        grid.className = 'toolBodyGrid_ZUQaOA';
        return grid;
    }

    /**
     * 在工具主体 grid 中追加一行 `label : value`。长 value 会自动折叠。
     *
     * @param {HTMLElement} grid grid 容器。
     * @param {string} labelText 行左侧标签。
     * @param {string} valueText 行右侧内容。
     */
    function appendToolRow(grid, labelText, valueText) {
        var row = document.createElement('div');
        row.className = 'toolBodyRow_ZUQaOA';
        var label = document.createElement('div');
        label.className = 'toolBodyRowLabel_ZUQaOA';
        label.textContent = labelText;
        var content = document.createElement('div');
        content.className = 'toolBodyRowContent_ZUQaOA';
        var pre = document.createElement('pre');
        pre.textContent = truncateLongText(valueText || '');
        content.appendChild(pre);
        row.appendChild(label);
        row.appendChild(content);
        grid.appendChild(row);
    }

    /**
     * 在工具主体 grid 中追加文件字段行，右侧渲染为可点击链接。
     * 点击后通过 `file/open` 协议请求扩展宿主在编辑区打开文件。
     *
     * @param {HTMLElement} grid grid 容器。
     * @param {string} labelText 行左侧标签。
     * @param {string} filePath 原始文件路径。
     * @param {unknown} lineLike 可选行号或 Read.offset。
     */
    function appendToolFileRow(grid, labelText, filePath, lineLike) {
        var row = document.createElement('div');
        row.className = 'toolBodyRow_ZUQaOA toolBodyFileRow_ZUQaOA';
        var label = document.createElement('div');
        label.className = 'toolBodyRowLabel_ZUQaOA';
        label.textContent = labelText;
        var content = document.createElement('div');
        content.className = 'toolBodyRowContent_ZUQaOA';
        content.appendChild(createToolFileLink(filePath, lineLike));
        row.appendChild(label);
        row.appendChild(content);
        grid.appendChild(row);
    }

    /**
     * 创建工具文件路径链接元素。
     *
     * @param {string} filePath 原始文件路径。
     * @param {unknown} lineLike 可选行号或 Read.offset。
     * @returns {HTMLAnchorElement} 文件链接节点。
     */
    function createToolFileLink(filePath, lineLike) {
        var pathText = String(filePath || '');
        var link = document.createElement('a');
        link.className = 'toolFileLink_ZUQaOA';
        link.href = '#';
        link.title = pathText;
        link.textContent = shortenPath(pathText);
        link.dataset.path = pathText;
        var line = normalizeToolLine(lineLike);
        if (line) link.dataset.line = String(line);
        link.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            post({ type: 'file/open', path: pathText, line: line || undefined });
        });
        return link;
    }

    /**
     * 从工具 input 中收集明显的文件路径字段，用于通用工具兜底展示。
     *
     * @param {unknown} input 工具输入。
     * @returns {Array<{ label: string; path: string }>} 文件字段列表。
     */
    function collectToolFileRows(input) {
        if (!input || typeof input !== 'object') return [];
        var rows = [];
        var record = input;
        var fileFieldNames = ['file_path', 'notebook_path', 'path', 'file', 'filename'];
        for (var i = 0; i < fileFieldNames.length; i++) {
            var key = fileFieldNames[i];
            if (typeof record[key] === 'string' && isLikelyLocalFilePath(record[key])) {
                rows.push({ label: key, path: record[key] });
            }
        }
        return rows;
    }

    /**
     * 判断字符串是否看起来像本地文件路径，避免把 URL / 普通描述误渲染为文件链接。
     *
     * @param {string} value 待判断字符串。
     * @returns {boolean} 看起来像本地文件路径时返回 true。
     */
    function isLikelyLocalFilePath(value) {
        var text = String(value || '').trim();
        if (!text || /^https?:\/\//i.test(text)) return false;
        return text.startsWith('/') || text.startsWith('~') || /^\.{1,2}[\\/]/.test(text) || /^[A-Za-z]:[\\/]/.test(text);
    }

    /**
     * 归一化工具里传来的行号，支持 Read.offset 这类数值字段。
     *
     * @param {unknown} value 行号候选值。
     * @returns {number | undefined} 有效 1-based 行号。
     */
    function normalizeToolLine(value) {
        var n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    }

    /**
     * 追加工具输出区。
     *
     * @param {HTMLElement} body 工具卡片主体容器。
     * @param {string} resultText 输出文本。
     * @param {boolean} isError 是否错误结果。
     */
    function appendToolResult(body, resultText, isError) {
        var wrap = document.createElement('div');
        wrap.className = 'toolResultWrap_ZUQaOA' + (isError ? ' toolResult-error' : '');
        var label = document.createElement('div');
        label.className = 'toolResultLabel_ZUQaOA';
        label.textContent = isError ? 'Error' : 'Output';
        wrap.appendChild(label);
        var pre = document.createElement('pre');
        pre.className = 'toolResultPre_ZUQaOA';
        pre.textContent = truncateLongText(resultText);
        wrap.appendChild(pre);
        body.appendChild(wrap);
    }

    /**
     * 构造 unified diff 风格的 +/- 块。
     *
     * @param {string} prefix `+` 或 `-`。
     * @param {string} text 内容文本。
     * @param {'removed' | 'inserted'} kind 块类型。
     * @returns {HTMLElement} diff 块。
     */
    function buildDiffBlock(prefix, text, kind) {
        var pre = document.createElement('pre');
        pre.className = 'toolDiffBlock_ZUQaOA toolDiff-' + kind;
        var lines = String(text || '').split('\n');
        var rendered = lines.map(function (line) { return prefix + ' ' + line; }).join('\n');
        pre.textContent = truncateLongText(rendered);
        return pre;
    }

    /**
     * 根据 todo 的 status 选择前缀图标。
     *
     * @param {string} status TodoWrite 中的状态值。
     * @returns {string} 图标字符。
     */
    function pickTodoIcon(status) {
        switch (status) {
            case 'completed': return '☑';
            case 'in_progress': return '▶';
            case 'pending':
            default: return '☐';
        }
    }

    /**
     * 在保持原始字符串语义的前提下做单行截断。
     *
     * @param {string} text 待截断字符串。
     * @param {number} max 最大长度。
     * @returns {string} 截断后的字符串。
     */
    function truncateInline(text, max) {
        var s = String(text || '').replace(/\s+/g, ' ').trim();
        if (s.length <= max) return s;
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    /**
     * 把长路径以省略号方式缩短显示（保留头部目录和文件名）。
     *
     * @param {string} path 文件路径。
     * @param {number} [max] 最大长度，默认 64。
     * @returns {string} 缩短后的路径。
     */
    function shortenPath(path, max) {
        var limit = max || 64;
        var s = String(path || '');
        if (s.length <= limit) return s;
        var parts = s.split('/');
        if (parts.length <= 3) return s;
        return parts[0] + '/.../' + parts.slice(-2).join('/');
    }

    /**
     * 尝试把字符串解析为 JSON 对象；失败时返回 undefined。
     *
     * @param {string} raw 待解析字符串。
     * @returns {any} 解析结果或 undefined。
     */
    function tryParseJSON(raw) {
        if (!raw || typeof raw !== 'string') return undefined;
        try { return JSON.parse(raw); } catch (_e) { return undefined; }
    }

    /**
     * 根据工具状态选择前缀图标。
     *
     * @param {string} status 工具状态。`permission_denied` 使用 🔒 表示权限拦截。
     * @returns {string} 图标字符。
     */
    function pickToolStatusIcon(status) {
        switch (status) {
            case 'running': return '⏳';
            case 'success': return '✓';
            case 'failed': return '✗';
            case 'permission_denied': return '🔒';
            case 'pending':
            default: return '○';
        }
    }

    /**
     * 根据工具状态选择中文标签文字。
     *
     * @param {string} status 工具状态。`permission_denied` 显示"需要授权"提醒用户调整 permissionMode 配置。
     * @returns {string} 状态标签。
     */
    function pickToolStatusLabel(status) {
        switch (status) {
            case 'running': return t('toolRunning');
            case 'success': return t('toolSuccess');
            case 'failed': return t('toolFailed');
            case 'permission_denied': return t('toolPermissionDenied');
            case 'pending':
            default: return t('toolPending');
        }
    }

    /**
     * 判断文本是否超过折叠阈值。
     *
     * @param {string} text 待判断文本。
     * @returns 文本过长时返回 true。
     */
    function isLongOutput(text) {
        return String(text || '').length > LONG_TEXT_LIMIT || String(text || '').split('\n').length > LONG_LINE_LIMIT;
    }

    /**
     * 渲染可折叠长文本，默认仅展示截断预览。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {string} text 完整文本。
     * @param {string} label 折叠摘要标题。
     */
    function appendCollapsibleText(container, text, label) {
        const details = document.createElement('details');
        details.className = 'long-output';
        const summary = document.createElement('summary');
        summary.textContent = tf('collapsibleSummary', { label: label, count: text.length });
        const pre = document.createElement('pre');
        pre.textContent = text;
        details.appendChild(summary);
        details.appendChild(pre);
        container.appendChild(details);
    }

    /**
     * 对工具详情做保护性截断，避免卡片展开时渲染超大 JSON。
     *
     * @param {string} text 原始详情文本。
     * @returns 截断后的详情文本。
     */
    function truncateLongText(text) {
        const value = String(text || '');
        if (value.length <= LONG_TEXT_LIMIT) return value;
        return value.slice(0, LONG_TEXT_LIMIT) + '\n\n' + tf('truncatedChars', { count: value.length - LONG_TEXT_LIMIT });
    }

    /**
     * 将用户输入的纯文本以"普通 div"方式追加到容器中：
     * - 不依赖 CSS 的 white-space: pre-wrap
     * - 段内换行（`\n`）转为 `<br>` 元素以保留视觉换行
     * - 连续空白由浏览器默认行为自动塌缩
     *
     * @param {HTMLElement} container 用户气泡容器。
     * @param {string} text 原始用户文本。
     */
    function appendUserText(container, text) {
        if (!text) return;
        var lines = String(text).split('\n');
        while (lines.length > 1 && lines[lines.length - 1] === '') {
            lines.pop();
        }
        for (var i = 0; i < lines.length; i++) {
            if (i > 0) container.appendChild(document.createElement('br'));
            if (lines[i].length > 0) {
                container.appendChild(document.createTextNode(lines[i]));
            }
        }
    }

    /**
     * 构建 user 消息下方的操作按钮栏。
     *
     * 目前只包含一个"重发"按钮：点击时通过 post 向扩展端发送 `user/resend`
     * 消息，由扩展端负责截断该消息及其之后的所有上下文，并用原文重新发送。
     *
     * @param {any} message 对应的 ChatMessage 对象（需要其 id）。
     * @returns {HTMLElement} 操作按钮栏 DOM。
     */
    function buildUserActionsBar(message) {
        var actions = document.createElement('div');
        actions.className = 'userMessageActions_07S1Yg';

        var resendBtn = document.createElement('button');
        resendBtn.type = 'button';
        resendBtn.className = 'userMessageActionBtn_07S1Yg';
        resendBtn.title = t('resendTitle');
        resendBtn.setAttribute('aria-label', t('resendAria'));
        // 使用 VS Code Codicon 风格的 inline SVG（"refresh" 形状），保证在 WebView 中
        // 即使未加载 codicon 字体也能正常显示。
        resendBtn.innerHTML = ''
            + '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
            + '<path fill="currentColor" d="M13.5 2.5v4h-4l1.45-1.45a4 4 0 1 0 1.27 4.2l1.4.5A5.5 5.5 0 1 1 11.95 4l1.55-1.5z"/>'
            + '</svg>';
        resendBtn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (!message || !message.id) return;
            if (resendBtn.disabled) return;
            resendBtn.disabled = true;
            post({ type: 'user/resend', id: message.id });
        });
        actions.appendChild(resendBtn);

        return actions;
    }

    /**
     * 渲染一条 Chat 消息（参考项目风格）。
     *
     * @param {any} message ChatMessage 对象。
     */
    function appendMessage(message) {
        if (!messagesEl) return;
        var empty = messagesEl.querySelector('.emptyState_07S1Yg');
        if (empty) empty.remove();

        // 历史回放期间：每出现一条 user 消息，意味着之前的 AskUserQuestion
        // 已被回答，无需补弹
        if (historyReplayMode && message && message.role === 'user') {
            notifyHistoryUserMessage();
        }

        var item = document.createElement('div');
        item.className = 'message_07S1Yg' + (message.role === 'user' ? ' userMessageContainer_07S1Yg' : '');
        item.dataset.id = message.id;
        item.dataset.role = message.role;
        // 每条消息节点写入位置坐标 dataset.index：
        // 取追加之前的 .message_07S1Yg 兄弟数量（emptyState 已在前面被移除）作为
        // 当前消息的下标。该索引与扩展端 chatMessages 数组的下标一一对应，是
        // `messages/truncate` 协议按位置寻址的依据。
        item.dataset.index = String(messagesEl.querySelectorAll('.message_07S1Yg').length);

        // 用户消息使用气泡样式
        if (message.role === 'user') {
            var userMsg = document.createElement('div');
            userMsg.className = 'userMessage_07S1Yg';
            if (message.text) {
                // 直接按原文渲染，不做 trim 过滤
                appendUserText(userMsg, String(message.text));
            } else if (message.segments) {
                for (var _s = 0; _s < message.segments.length; _s++) {
                    var seg = message.segments[_s];
                    if (seg.kind === 'text' || !seg.kind) {
                        // 原样保留每段文本内容，不做尾部空白裁剪
                        var rawText = seg.text || seg.sourceText || '';
                        appendUserText(userMsg, rawText);
                    } else {
                        appendSegment(userMsg, seg);
                    }
                }
            }
            item.appendChild(userMsg);
            // 在 user 消息下方追加"重发"操作按钮：点击后扩展端会截断该消息
            // 及其之后所有上下文，再以同样文本作为新一轮 user 消息重新发送。
            item.appendChild(buildUserActionsBar(message));
            messagesEl.appendChild(item);
            // 若当前发送动作正在等待 pending assistant 占位，则不要在 user 消息阶段
            // 抢先滚动；最终滚动交给 pending 动画渲染后的 assistant 分支处理。
            if (!scrollAfterNextPendingAssistant) {
                // user 消息是用户刚刚发出的：无论之前在哪儿，都强制滚到底让用户
                // 立即看到自己刚发的内容（重发场景也走这条路径，因此不需要额外
                // 依赖 forceScrollToBottomOnce flag）。
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if (message.role === 'assistant') setChatRunning(!!message.pending);
            return;
        }

        // Assistant 消息内容
        var content = document.createElement('div');
        content.className = 'assistantMessage_07S1Yg';
        if (message.segments) {
            for (var _s2 = 0; _s2 < message.segments.length; _s2++) {
                var _seg = message.segments[_s2];
                appendSegment(content, _seg);
            }
        }
        renderPendingIndicator(content, message);
        item.appendChild(content);
        ensureAssistantMessageContainer(item);
        var _wasAtBottomAsst = isScrolledNearBottom();
        messagesEl.appendChild(item);
        if (message.role === 'assistant' && message.pending && scrollAfterNextPendingAssistant) {
            scrollAfterNextPendingAssistant = false;
            messagesEl.scrollTop = messagesEl.scrollHeight;
        } else {
            scrollToBottomIfNeeded(_wasAtBottomAsst);
        }
        if (message.role === 'assistant') setChatRunning(!!message.pending);
    }

    /**
     * 根据消息状态渲染或移除 assistant 加载动画。
     *
     * 判定"是否已有真正内容"时会过滤掉 `kind:'usage'` 这类纯统计 segment：
     * Relay 在收到上游 `message_start` 时就能拿到 input/cache 等 token 数并
     * 立即上报 usage，但此刻模型回复的文本/工具调用尚未开始。若把 usage 也
     * 算作"已有内容"，等待动画就会被过早移除并不再恢复，UI 上会看到"刚发完
     * 就没动画了，但其实还在等模型"。
     *
     * 兼容两种 segments 形态：
     * - `appendMessage` 调用时是原始 ChatSegment 对象数组（按 `seg.kind` 判定）；
     * - `patchMessage` 调用时是 DOM Node 数组（按 `.assistantUsageFooter_07S1Yg` 判定）。
     *
     * @param {HTMLElement} content 消息内容容器。
     * @param {any} message ChatMessage 对象或同形态轻量对象。
     */
    function renderPendingIndicator(content, message) {
        const existing = content.querySelector('.chat-pending-indicator');
        const hasSegments = Array.isArray(message.segments) && message.segments.some(function (item) {
            // ChatSegment 对象形态：直接读 kind。
            if (item && typeof item === 'object' && 'kind' in item) {
                return item.kind !== 'usage';
            }
            // DOM Node 形态：usage 段对应 .assistantUsageFooter_07S1Yg；其它任何节点都算内容。
            if (item instanceof HTMLElement) {
                return !item.classList.contains('assistantUsageFooter_07S1Yg');
            }
            // 其它（text node、注释等）保守按"算作内容"处理。
            return !!item;
        });
        const shouldShow = message.role === 'assistant' && message.pending && !hasSegments;
        if (!shouldShow) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const indicator = document.createElement('div');
        indicator.className = 'chat-pending-indicator';
        indicator.setAttribute('aria-label', t('loading'));
        indicator.innerHTML = '<span></span><span></span><span></span>';
        content.appendChild(indicator);
    }

    /**
     * 把片段增量追加到已有消息容器。
     *
     * @param {string} id 消息 ID。
     * @param {any[]} segments 需要追加的 ChatSegment 数组。
     * @param {boolean | undefined} pending 最新 pending 状态。
     */
    function patchMessage(id, segments, pending) {
        if (!messagesEl) return;
        var item = messagesEl.querySelector('.message_07S1Yg[data-id="' + CSS.escape(id) + '"]');
        if (!(item instanceof HTMLElement)) {
            post({
                type: 'log',
                level: 'warn',
                message: '[chat] patch target missing id=' + id + ', segments=' + (segments?.length || 0)
            });
            return;
        }
        // 记录渲染前的滚动状态：只有用户已经在底部附近时才跟随。
        var wasAtBottom = isScrolledNearBottom();
        // 更新 pending 状态
        if (item.dataset.role === 'assistant') setChatRunning(!!pending);
        // 获取内容容器（如果是用户消息，不更新）
        if (item.dataset.role === 'user') return;
        var content = ensureAssistantMessageContainer(item);
        var pendingIndicator = content.querySelector('.chat-pending-indicator');
        if (pendingIndicator) pendingIndicator.remove();
        for (var _idx = 0; _idx < (segments || []).length; _idx++) {
            var segment = segments[_idx];
            // 如果 segment 带稳定 id 且已有对应 DOM，则原地替换（典型场景：工具卡片在
            // tool_use 启动、input_json_delta 累积、tool_result 回填等时机被反复更新）
            if (segment && segment.id) {
                var existing = content.querySelector('[data-segment-id="' + CSS.escape(segment.id) + '"]');
                if (existing && existing.parentNode === content) {
                    var replacement = document.createElement('div');
                    replacement.style.display = 'contents';
                    appendSegment(replacement, segment);
                    var newNode = replacement.firstChild;
                    if (newNode) {
                        content.replaceChild(newNode, existing);
                        continue;
                    }
                }
            }
            appendSegment(content, segment);
        }
        renderPendingIndicator(content, {
            role: item.dataset.role || 'assistant',
            pending: pending,
            segments: Array.from(content.childNodes).filter(function (node) {
                return !(node instanceof HTMLElement && node.classList.contains('chat-pending-indicator'));
            })
        });
        scrollToBottomIfNeeded(wasAtBottom);
    }

    /**
     * 确保 assistant 消息的所有可渲染子节点都归入 .assistantMessage_07S1Yg 容器。
     *
     * 早期实时 patch 曾把 markdown/tool 节点直接追加到 .message_07S1Yg 下，导致
     * `.assistantMessage_07S1Yg > .markdownRoot_07S1Yg` 等样式无法命中。这里在每次
     * patch 前做一次归一化，把旧结构搬回正确容器，同时避免重复创建空容器。
     *
     * @param {HTMLElement} item assistant 消息根节点。
     * @returns {HTMLElement} assistant 内容容器。
     */
    function ensureAssistantMessageContainer(item) {
        var content = item.querySelector(':scope > .assistantMessage_07S1Yg');
        if (!(content instanceof HTMLElement)) {
            content = document.createElement('div');
            content.className = 'assistantMessage_07S1Yg';
            item.insertBefore(content, item.firstChild);
        }
        var siblings = Array.from(item.childNodes);
        for (var _i = 0; _i < siblings.length; _i++) {
            var node = siblings[_i];
            if (node === content) continue;
            if (node instanceof HTMLElement && node.classList.contains('assistantMessage_07S1Yg')) {
                while (node.firstChild) content.appendChild(node.firstChild);
                node.remove();
                continue;
            }
            if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
                node.remove();
                continue;
            }
            content.appendChild(node);
        }
        return content;
    }

    /**
     * 归一化当前消息列表里的所有 assistant 消息 DOM。
     *
     * 该函数用于修复历史 DOM 或隐藏插入路径造成的结构漂移，确保每条 assistant 消息
     * 都满足：`.message_07S1Yg[data-role="assistant"] > .assistantMessage_07S1Yg > 可渲染节点`。
     */
    function normalizeAllAssistantMessages() {
        if (!messagesEl) return;
        messagesEl.querySelectorAll('.message_07S1Yg[data-role="assistant"]').forEach(function (item) {
            if (item instanceof HTMLElement) ensureAssistantMessageContainer(item);
        });
    }

    /**
     * 安装 assistant 消息 DOM 归一化观察器。
     *
     * 如果后续还有未覆盖的渲染路径把 markdown/tool 节点直接插到 `.message_07S1Yg`
     * 下面，观察器会在下一帧统一搬回 `.assistantMessage_07S1Yg`，避免新生成 DOM
     * 再出现空 assistantMessage 容器 + 外层 markdownRoot 的结构。
     */
    function installAssistantMessageNormalizer() {
        if (!messagesEl || typeof MutationObserver !== 'function') return;
        var scheduled = false;
        var observer = new MutationObserver(function () {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(function () {
                scheduled = false;
                normalizeAllAssistantMessages();
            });
        });
        observer.observe(messagesEl, { childList: true, subtree: true });
        normalizeAllAssistantMessages();
    }

    /**
     * 从输入框读取文本并发送 user/send 消息。
     */
    function sendComposerText() {
        if (!(composerEl instanceof HTMLTextAreaElement)) return;
        const text = composerEl.value.trim();
        const attachments = composerState.attachments.map((item) => ({ path: item.path, name: item.name }));
        if (!text && attachments.length === 0) return;
        scrollAfterNextPendingAssistant = true;
        post({ type: 'user/send', text, attachments });
        composerEl.value = '';
        composerState.attachments = [];
        renderAttachments();
        autoResizeComposer();
    }

    /**
     * 处理右下角单一动作按钮点击：运行中发送取消，空闲时发送输入内容。
     */
    function handleComposerAction() {
        if (composerState.chatRunning) {
            post({ type: 'user/cancel' });
            return;
        }
        sendComposerText();
    }

    /**
     * 处理扩展宿主发来的消息。
     *
     * 协议解包说明：
     * 出于与参考项目（React 前端）协议对齐的需要，宿主 `ChatViewHost.postMessage`
     * 会把真实消息包装为 `{ type: 'from-extension', message: <real> }` 后再投递。
     * 本前端虽然是 vanilla JS，但消息通道沿用了同一份契约，因此入口处需要先
     * 解包出真实消息，再走 switch 分发；同时保留对未包装消息（旧路径或调试
     * 注入）的兼容。
     *
     * @param {MessageEvent} event 浏览器 message 事件。
     */
    function handleExtensionMessage(event) {
        let message = event.data;
        if (!message || typeof message !== 'object') return;
        // 解包参考项目协议 { type: 'from-extension', message: <real> }
        if (message.type === 'from-extension' && message.message && typeof message.message === 'object') {
            message = message.message;
        }
        if (typeof message.type !== 'string') return;
        // 调试日志：在浏览器开发者工具中追踪每一条到达 Webview 的扩展消息。
        // 出现"宿主发了消息但聊天区不渲染"时，可立刻定位是消息根本没到、type 不识别、
        // 还是 segments 列表为空。
        try {
            // eslint-disable-next-line no-console
            console.log('[chat] handleExtensionMessage', message.type, message);
        } catch (_logErr) { /* noop */ }
        switch (message.type) {
            case 'i18n/update':
                setChatLanguage(message.language || DEFAULT_CHAT_LANGUAGE);
                break;
            case 'session/init':
                setChatRunning(false);
                currentCliPath = message.cliPath || '';
                currentCliStatus = '';
                currentCliDetail = '';
                updateCliStatusText();
                var initMessages = message.messages || [];
                var initSignature = buildSessionInitSignature(initMessages);
                renderedMessagesCache = cloneMessagesForCache(initMessages);
                if (initSignature === lastSessionInitSignature && messagesEl && messagesEl.querySelector('.message_07S1Yg')) {
                    // 重复 init 不清空、不重绘。其它伴随状态（model/options、权限、默认附件）
                    // 会由独立 postMessage 更新，这里只跳过消息列表重建，避免滚动闪跳。
                    break;
                }
                lastSessionInitSignature = initSignature;
                renderEmptyState();
                // 批量渲染历史消息——进入历史回放模式，期间 AskUserQuestion
                // 不立即弹窗，留到回放结束后再判断是否仍未应答
                historyReplayMode = true;
                lastHistoryAskUserSegment = null;
                try {
                    var historyMessages = initMessages;
                    for (var _mIdx = 0; _mIdx < historyMessages.length; _mIdx++) {
                        appendMessage(historyMessages[_mIdx]);
                    }
                } finally {
                    finalizeHistoryReplayAskUser();
                }
                // 历史会话载入完成后需要以完整 DOM 高度为准滚到底部。
                // 不能依赖 appendMessage 内部的滚动逻辑：历史中最后一条 user 消息
                // 会在渲染时先滚一次，但随后 assistant 消息可能因为 wasAtBottom
                // 判定失败而不再跟随，导致打开时停在最后一条用户消息附近。
                forceScrollToBottomSettled();
                break;
            case 'message/append':
                cacheAppendedMessage(message.message);
                appendMessage(message.message);
                syncSessionInitSignatureFromDom();
                break;
            case 'message/patch':
                cachePatchedMessage(message.id, message.segments || [], message.pending);
                patchMessage(message.id, message.segments || [], message.pending);
                break;
            case 'messages/truncate':
                // 局部截断：只移除从 fromIndex 起的消息节点，不重建容器。
                // 处理完成后立即把 scrollTop 拉到底（此时 DOM 已经少了被删的
                // 那一段，scrollHeight 也对应缩小），并设置一次性 flag 让紧随
                // 而来的 message/append（重发的新 user 消息）保持在底部。
                cacheTruncatedMessages(message.fromIndex);
                truncateMessagesFromIndex(message.fromIndex);
                if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
                forceScrollToBottomOnce = true;
                syncSessionInitSignatureFromDom();
                break;
            case 'cli/status':
                currentCliPath = '';
                currentCliStatus = message.status || '';
                currentCliDetail = message.detail || '';
                updateCliStatusText();
                break;
            case 'toast':
                showToast(message.level || 'info', message.text || '');
                break;
            case 'composer/fill':
                if (composerEl instanceof HTMLTextAreaElement) {
                    composerEl.value = message.text || '';
                    if (message.focus) composerEl.focus();
                    autoResizeComposer();
                }
                break;
            case 'composer/defaultAttachment':
                setDefaultAttachment(message.attachment || (message.path ? { path: message.path, name: message.name } : undefined));
                break;
            case 'composer/addAttachments':
                addAttachments(message.attachments || [], { source: 'manual' });
                if (composerEl instanceof HTMLTextAreaElement && message.focus) composerEl.focus();
                break;
            case 'composer/replaceAttachment':
                replaceAttachment(message.clientId, message.attachment);
                if (composerEl instanceof HTMLTextAreaElement && message.focus) composerEl.focus();
                break;
            case 'model/options':
                composerState.modelOptions = message.models || [];
                composerState.currentModelKey = message.current ? message.current.providerId + '/' + message.current.modelId : '';
                renderModelOptions();
                break;
            case 'permissionMode/current':
                composerState.permissionMode = message.mode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
                renderPermissionModeSelect();
                break;
            case 'message/error':
                setChatRunning(false);
                showToast('error', message.detail ? (message.error || t('unknownError')) + ': ' + message.detail : (message.error || t('unknownError')));
                break;
            default:
                break;
        }
    }

    applyI18n();
    setChatRunning(false);

    /**
     * 复制当前 Webview 的 body 源码，便于调试真实 DOM 结构和样式命中情况。
     * 优先使用 Clipboard API；若不可用，则退回到临时 textarea + execCommand。
     */
    function copyBodySource() {
        document.querySelectorAll('.message_07S1Yg[data-role="assistant"]').forEach(function (item) {
            if (item instanceof HTMLElement) ensureAssistantMessageContainer(item);
        });
        const source = document.body ? document.body.outerHTML : '';
        if (!source) return;
        const onCopied = () => showToast('info', t('copiedBodySource'));
        const onFailed = () => showToast('error', t('copyBodySourceFailed'));
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(source).then(onCopied, function () {
                fallbackCopyText(source, onCopied, onFailed);
            });
            return;
        }
        fallbackCopyText(source, onCopied, onFailed);
    }

    /**
     * 使用临时 textarea 执行复制，作为 Clipboard API 不可用时的兜底方案。
     *
     * @param {string} text 要复制的文本。
     * @param {() => void} onCopied 复制成功回调。
     * @param {() => void} onFailed 复制失败回调。
     */
    function fallbackCopyText(text, onCopied, onFailed) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'readonly');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            if (document.execCommand('copy')) onCopied();
            else onFailed();
        } catch (_err) {
            onFailed();
        } finally {
            textarea.remove();
        }
    }

    sendEl?.addEventListener('click', handleComposerAction);
    attachFileEl?.addEventListener('click', () => post({ type: 'file/pick' }));
    modelSelectEl?.addEventListener('change', () => {
        if (!(modelSelectEl instanceof HTMLSelectElement)) return;
        const value = modelSelectEl.value;
        const separator = value.indexOf('/');
        if (!value || separator <= 0) return;
        composerState.currentModelKey = value;
        post({ type: 'model/select', providerId: value.slice(0, separator), modelId: value.slice(separator + 1) });
    });
    permissionModeSelectEl?.addEventListener('change', () => {
        if (!(permissionModeSelectEl instanceof HTMLSelectElement)) return;
        const mode = permissionModeSelectEl.value === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
        composerState.permissionMode = mode;
        renderPermissionModeSelect();
        post({ type: 'permissionMode/select', mode });
    });
    restartCliEl?.addEventListener('click', () => post({ type: 'cli/restart' }));
    clearSessionEl?.addEventListener('click', () => post({ type: 'session/clear' }));
    copyBodySourceEl?.addEventListener('click', copyBodySource);
    contextClearEl?.addEventListener('click', clearAttachments);
    installAssistantMessageNormalizer();
    composerEl?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendComposerText();
        }
    });
    composerEl?.addEventListener('input', autoResizeComposer);
            renderPermissionModeSelect();
    document.addEventListener('paste', (event) => {
        void handlePaste(event);
    }, true);

    // 拖放监听挂在 document.body 上：在整个 webview 区域里都能接收文件拖入，
    // 同时整片区域都给出"可投放"的视觉提示，避免目标元素过小造成事件丢失。
    /**
     * dragenter / dragover 通用处理：阻止默认行为并把 dropEffect 设为 copy。
     *
     * @param {DragEvent} event 浏览器拖放事件。
     */
    function onBodyDragOver(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
    }

    /**
     * 离开 body 视口时关闭视觉提示。
     *
     * @param {DragEvent} event 浏览器拖放事件。
     */
    function onBodyDragLeave(event) {
        event.preventDefault();
        // 只有当离开点真正落在 webview 外部（relatedTarget 为空）时才关掉提示。
        if (!event.relatedTarget) setDropActive(false);
    }

    /**
     * body 收到的 drop 事件，记录调试日志并交给 handleDrop 解析。
     *
     * @param {DragEvent} event 浏览器拖放事件。
     */
    function onBodyDrop(event) {
        post({ type: 'log', level: 'info', message: '[drag] body drop fired' });
        handleDrop(event);
    }

    let dragEnterLogged = false;
    /**
     * 仅记录一次 dragenter 调试信息，便于查看拖入时 DataTransfer 携带的 MIME 类型。
     *
     * @param {DragEvent} event 浏览器拖放事件。
     */
    function onBodyDragEnter(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
        if (!dragEnterLogged) {
            dragEnterLogged = true;
            const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
            post({ type: 'log', level: 'info', message: '[drag] body dragenter types=' + JSON.stringify(types) });
        }
    }

    document.body.addEventListener('dragenter', onBodyDragEnter);
    document.body.addEventListener('dragover', onBodyDragOver);
    document.body.addEventListener('dragleave', onBodyDragLeave);
    document.body.addEventListener('drop', onBodyDrop);

    window.addEventListener('message', handleExtensionMessage);
    renderAttachments();
    renderModelOptions();
    autoResizeComposer();
    renderEmptyState();
    post({ type: 'webview/ready' });
    post({ type: 'log', level: 'info', message: '[boot] chat webview script loaded, drop handlers attached (v2)' });
}());
