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
            statusInitializing: 'Initializing…', newSession: 'New chat', newSessionTitle: 'Start a new conversation', restart: 'Restart', restartTitle: 'Restart CLI', clear: 'Clear', clearTitle: 'Clear chat history', sessions: 'Sessions', sessionsTitle: 'Past conversations', sessionsLoading: 'Loading…', sessionsEmpty: 'No past conversations found.', dropFilesHere: 'Drop files here as context', contextPanelAria: 'Added context files', defaultCurrentFile: 'Current file shown by default', clearContext: 'Clear context', contextMenu: 'Context menu', composerPlaceholder: 'Ask, edit, or agent…', attachFile: 'Select context files', modelSelectTitle: 'Switch model and automatically restart Chat CLI', modelSelectAria: 'Switch model', modelLoading: 'Loading models…', permissionModeTitle: 'Switch Claude CLI permission mode and automatically restart Chat CLI', permissionModeAria: 'Switch permission mode', sendMessage: 'Send message', stopResponse: 'Stop current response', noModelConfigured: 'No model configured', selectModel: 'Select a model', permissionAcceptEdits: 'Current: acceptEdits (automatically accept edit tools)', permissionBypass: 'Current: bypassPermissions (skip permission checks, fully trust current workspace)', emptyState: 'LLS CLAUDE CHAT - Start a conversation', longTextOutput: 'Long text output', longCodeBlock: 'Long code block', longDiffOutput: 'Long diff output', copy: 'Copy', copyCode: 'Copy code', usageModel: 'Model ', usageInput: 'Input ', usageOutput: 'Output ', usageCacheWrite: 'Cache write ', usageCacheRead: 'Cache read ', assistantNeedsConfirmation: 'Assistant needs your confirmation', askManyQuestions: 'There are {count} questions. You must reply before continuing.', askOneQuestion: 'Choose an option, or write a custom reply below (required).', noQuestionText: '(No question text)', multiSelect: 'Multiple selection', customReplyLabel: 'Other reply (optional): write your thoughts or why you did not choose an option', customReplyPlaceholder: 'For example: I want to use another implementation…', sendReply: 'Send reply', askUserReplyIntro: 'I replied to your question as follows:', askUserPicked: '   Selected: {items}', askUserNoPick: '   Selected: (no option selected)', askUserExtra: 'Additional note:', toolRunning: 'Running', toolSuccess: 'Success', toolFailed: 'Failed', toolPermissionDenied: 'Permission required', toolPending: 'Pending', collapsibleSummary: '{label} ({count} characters, click to expand)', truncatedChars: '… truncated {count} characters', resendTitle: 'Resend: delete this message and following context, then send again', resendAria: 'Resend this message', loading: 'Loading', cliNotSelected: 'CLI not selected', cliStatus: 'CLI status: {status}{detail}', unknownError: 'Unknown error', copiedBodySource: 'Copied body source', copyBodySourceFailed: 'Failed to copy body source', removeAttachment: 'Remove {name}', genericFile: 'File', closeExpert: 'Disable expert', expertModelSelectTitle: 'Select project expert model', expertModelSelectAria: 'Select project expert model', ccTaskFlow: 'CC task flow', expertPanelTitle: 'Expert run', expertPanelStatusRunning: 'running…', expertPanelStatusDone: 'completed', expertPanelStatusError: 'failed', expertPanelStatusCancelled: 'cancelled', expertPanelToggleAria: 'Toggle expert panel', expertEventStart: 'Start', expertEventAnalysis: 'Analysis', expertEventToolCall: 'Tool call', expertEventToolResult: 'Tool result', expertEventFinal: 'Final answer', expertEventError: 'Error', expertEventCancelled: 'Cancelled'
        },
        'zh-cn': {
            statusInitializing: '正在初始化…', newSession: '新建会话', newSessionTitle: '开启全新会话', restart: '重启', restartTitle: '重启 CLI', clear: '清空', clearTitle: '清空聊天内容', sessions: '历史会话', sessionsTitle: '历史对话', sessionsLoading: '加载中…', sessionsEmpty: '未找到历史会话。', dropFilesHere: '拖放文件到这里作为上下文', contextPanelAria: '已添加的上下文文件', defaultCurrentFile: '默认显示当前文件', clearContext: '清空上下文', contextMenu: '上下文菜单', composerPlaceholder: '询问、编辑或代理…', attachFile: '选择上下文文件', modelSelectTitle: '切换模型，切换后自动重启 Chat CLI', modelSelectAria: '切换模型', modelLoading: '模型加载中…', permissionModeTitle: '切换 Claude CLI 权限模式，切换后自动重启 Chat CLI', permissionModeAria: '切换权限模式', sendMessage: '发送消息', stopResponse: '停止当前响应', noModelConfigured: '未配置模型', selectModel: '请选择模型', permissionAcceptEdits: '当前：acceptEdits（自动接受编辑类工具）', permissionBypass: '当前：bypassPermissions（跳过权限检查，完全信任当前工作区）', emptyState: 'LLS CLAUDE CHAT - 开始对话', longTextOutput: '长文本输出', longCodeBlock: '长代码块', longDiffOutput: '长 diff 输出', copy: '复制', copyCode: '复制代码', usageModel: '模型 ', usageInput: '输入 ', usageOutput: '输出 ', usageCacheWrite: '缓存写 ', usageCacheRead: '缓存读 ', assistantNeedsConfirmation: '助手需要您的确认', askManyQuestions: '共 {count} 个问题，必须回复后才能继续', askOneQuestion: '请选择一个选项，或在下方填写自定义回复（必须回复）', noQuestionText: '(无问题文本)', multiSelect: '可多选', customReplyLabel: '其他回复（可选）：写下你的想法或不选某项的理由', customReplyPlaceholder: '例如：我想换一种实现方式…', sendReply: '发送回复', askUserReplyIntro: '我对你的问题做了如下回复：', askUserPicked: '   选择：{items}', askUserNoPick: '   选择：（未选择任何选项）', askUserExtra: '补充说明：', toolRunning: '执行中', toolSuccess: '成功', toolFailed: '失败', toolPermissionDenied: '需要授权', toolPending: '等待', collapsibleSummary: '{label}（{count} 字符，点击展开）', truncatedChars: '… 已截断 {count} 字符', resendTitle: '重发：删除此消息及其后续上下文并重新发送', resendAria: '重发此消息', loading: '加载中', cliNotSelected: 'CLI 未选择', cliStatus: 'CLI 状态：{status}{detail}', unknownError: '未知错误', copiedBodySource: '已复制 body 源码', copyBodySourceFailed: '复制 body 源码失败', removeAttachment: '移除 {name}', genericFile: '文件', closeExpert: '关闭专家', expertModelSelectTitle: '选择项目专家模型', expertModelSelectAria: '选择项目专家模型', ccTaskFlow: 'CC任务流', expertPanelTitle: '专家运行', expertPanelStatusRunning: '运行中…', expertPanelStatusDone: '已完成', expertPanelStatusError: '失败', expertPanelStatusCancelled: '已取消', expertPanelToggleAria: '展开/折叠专家面板', expertEventStart: '开始', expertEventAnalysis: '分析', expertEventToolCall: '工具调用', expertEventToolResult: '工具结果', expertEventFinal: '最终答案', expertEventError: '错误', expertEventCancelled: '已取消'
        }
    };
    chatTranslations['zh-tw'] = {
        statusInitializing: '正在初始化…', newSession: '新增會話', newSessionTitle: '開啟全新會話', restart: '重新啟動', restartTitle: '重新啟動 CLI', clear: '清除', clearTitle: '清除聊天內容', dropFilesHere: '將檔案拖放到這裡作為上下文', contextPanelAria: '已新增的上下文檔案', defaultCurrentFile: '預設顯示目前檔案', clearContext: '清除上下文', contextMenu: '上下文選單', composerPlaceholder: '提問、編輯或代理…', attachFile: '選擇上下文檔案', modelSelectTitle: '切換模型，切換後會自動重新啟動 Chat CLI', modelSelectAria: '切換模型', modelLoading: '模型載入中…', permissionModeTitle: '切換 Claude CLI 權限模式，切換後會自動重新啟動 Chat CLI', permissionModeAria: '切換權限模式', sendMessage: '傳送訊息', stopResponse: '停止目前回應', noModelConfigured: '尚未設定模型', selectModel: '請選擇模型', permissionAcceptEdits: '目前：acceptEdits（自動接受編輯類工具）', permissionBypass: '目前：bypassPermissions（略過權限檢查，完全信任目前工作區）', emptyState: 'LLS CLAUDE CHAT - 開始對話', longTextOutput: '長文字輸出', longCodeBlock: '長程式碼區塊', longDiffOutput: '長 diff 輸出', copy: '複製', copyCode: '複製程式碼', usageModel: '模型 ', usageInput: '輸入 ', usageOutput: '輸出 ', usageCacheWrite: '快取寫入 ', usageCacheRead: '快取讀取 ', assistantNeedsConfirmation: '助手需要您的確認', askManyQuestions: '共有 {count} 個問題，必須回覆後才能繼續', askOneQuestion: '請選擇一個選項，或在下方填寫自訂回覆（必須回覆）', noQuestionText: '(沒有問題文字)', multiSelect: '可複選', customReplyLabel: '其他回覆（選填）：寫下你的想法或未選某項的理由', customReplyPlaceholder: '例如：我想換一種實作方式…', sendReply: '傳送回覆', askUserReplyIntro: '我對你的問題做了如下回覆：', askUserPicked: '   選擇：{items}', askUserNoPick: '   選擇：（未選擇任何選項）', askUserExtra: '補充說明：', toolRunning: '執行中', toolSuccess: '成功', toolFailed: '失敗', toolPermissionDenied: '需要授權', toolPending: '等待', collapsibleSummary: '{label}（{count} 個字元，點擊展開）', truncatedChars: '… 已截斷 {count} 個字元', resendTitle: '重送：刪除此訊息及後續上下文並重新傳送', resendAria: '重送此訊息', loading: '載入中', cliNotSelected: '尚未選擇 CLI', cliStatus: 'CLI 狀態：{status}{detail}', unknownError: '未知錯誤', copiedBodySource: '已複製 body 原始碼', copyBodySourceFailed: '複製 body 原始碼失敗', removeAttachment: '移除 {name}', genericFile: '檔案', expertPanelTitle: '專家執行', expertPanelStatusRunning: '執行中…', expertPanelStatusDone: '已完成', expertPanelStatusError: '失敗', expertPanelStatusCancelled: '已取消', expertPanelToggleAria: '展開/收合專家面板', expertEventStart: '開始', expertEventAnalysis: '分析', expertEventToolCall: '工具呼叫', expertEventToolResult: '工具結果', expertEventFinal: '最終回答', expertEventError: '錯誤', expertEventCancelled: '已取消'
    };
    chatTranslations.ko = {
        statusInitializing: '초기화 중…', newSession: '새 대화', newSessionTitle: '새 대화 시작', restart: '재시작', restartTitle: 'CLI 재시작', clear: '비우기', clearTitle: '채팅 내용 비우기', dropFilesHere: '파일을 여기에 끌어 놓아 컨텍스트로 추가', contextPanelAria: '추가된 컨텍스트 파일', defaultCurrentFile: '기본적으로 현재 파일 표시', clearContext: '컨텍스트 지우기', contextMenu: '컨텍스트 메뉴', composerPlaceholder: '질문, 편집 또는 에이전트…', attachFile: '컨텍스트 파일 선택', modelSelectTitle: '모델 전환, 전환 후 Chat CLI 자동 재시작', modelSelectAria: '모델 전환', modelLoading: '모델 로드 중…', permissionModeTitle: 'Claude CLI 권한 모드 전환, 전환 후 Chat CLI 자동 재시작', permissionModeAria: '권한 모드 전환', sendMessage: '메시지 보내기', stopResponse: '현재 응답 중지', noModelConfigured: '설정된 모델 없음', selectModel: '모델 선택', permissionAcceptEdits: '현재: acceptEdits(편집 도구 자동 승인)', permissionBypass: '현재: bypassPermissions(권한 확인 건너뛰기, 현재 작업 영역 완전 신뢰)', emptyState: 'LLS CLAUDE CHAT - 대화 시작', longTextOutput: '긴 텍스트 출력', longCodeBlock: '긴 코드 블록', longDiffOutput: '긴 diff 출력', copy: '복사', copyCode: '코드 복사', usageModel: '모델 ', usageInput: '입력 ', usageOutput: '출력 ', usageCacheWrite: '캐시 쓰기 ', usageCacheRead: '캐시 읽기 ', assistantNeedsConfirmation: '어시스턴트가 확인을 요청합니다', askManyQuestions: '질문이 {count}개 있습니다. 계속하려면 답변해야 합니다.', askOneQuestion: '옵션을 선택하거나 아래에 사용자 지정 답변을 입력하세요(필수).', noQuestionText: '(질문 텍스트 없음)', multiSelect: '다중 선택 가능', customReplyLabel: '기타 답변(선택): 생각이나 선택하지 않은 이유를 적어 주세요', customReplyPlaceholder: '예: 다른 구현 방식으로 바꾸고 싶습니다…', sendReply: '답변 보내기', askUserReplyIntro: '질문에 대해 다음과 같이 답변했습니다:', askUserPicked: '   선택: {items}', askUserNoPick: '   선택: (선택한 옵션 없음)', askUserExtra: '추가 설명:', toolRunning: '실행 중', toolSuccess: '성공', toolFailed: '실패', toolPermissionDenied: '권한 필요', toolPending: '대기 중', collapsibleSummary: '{label}({count}자, 클릭하여 펼치기)', truncatedChars: '… {count}자 잘림', resendTitle: '다시 보내기: 이 메시지와 이후 컨텍스트를 삭제하고 다시 전송', resendAria: '이 메시지 다시 보내기', loading: '로드 중', cliNotSelected: 'CLI가 선택되지 않음', cliStatus: 'CLI 상태: {status}{detail}', unknownError: '알 수 없는 오류', copiedBodySource: 'body 소스를 복사했습니다', copyBodySourceFailed: 'body 소스 복사 실패', removeAttachment: '{name} 제거', genericFile: '파일', expertPanelTitle: '전문가 실행', expertPanelStatusRunning: '실행 중…', expertPanelStatusDone: '완료됨', expertPanelStatusError: '실패', expertPanelStatusCancelled: '취소됨', expertPanelToggleAria: '전문가 패널 토글', expertEventStart: '시작', expertEventAnalysis: '분석', expertEventToolCall: '도구 호출', expertEventToolResult: '도구 결과', expertEventFinal: '최종 답변', expertEventError: '오류', expertEventCancelled: '취소됨'
    };
    chatTranslations.ja = {
        statusInitializing: '初期化中…', newSession: '新しいチャット', newSessionTitle: '新しい会話を開始', restart: '再起動', restartTitle: 'CLI を再起動', clear: 'クリア', clearTitle: 'チャット内容をクリア', dropFilesHere: 'ファイルをここにドロップしてコンテキストに追加', contextPanelAria: '追加済みのコンテキストファイル', defaultCurrentFile: '既定で現在のファイルを表示', clearContext: 'コンテキストをクリア', contextMenu: 'コンテキストメニュー', composerPlaceholder: '質問、編集、またはエージェント…', attachFile: 'コンテキストファイルを選択', modelSelectTitle: 'モデルを切り替え、切り替え後に Chat CLI を自動再起動', modelSelectAria: 'モデルを切り替え', modelLoading: 'モデルを読み込み中…', permissionModeTitle: 'Claude CLI 権限モードを切り替え、切り替え後に Chat CLI を自動再起動', permissionModeAria: '権限モードを切り替え', sendMessage: 'メッセージを送信', stopResponse: '現在の応答を停止', noModelConfigured: 'モデルが設定されていません', selectModel: 'モデルを選択してください', permissionAcceptEdits: '現在: acceptEdits（編集系ツールを自動承認）', permissionBypass: '現在: bypassPermissions（権限チェックをスキップし、現在のワークスペースを完全に信頼）', emptyState: 'LLS CLAUDE CHAT - 会話を開始', longTextOutput: '長いテキスト出力', longCodeBlock: '長いコードブロック', longDiffOutput: '長い diff 出力', copy: 'コピー', copyCode: 'コードをコピー', usageModel: 'モデル ', usageInput: '入力 ', usageOutput: '出力 ', usageCacheWrite: 'キャッシュ書き込み ', usageCacheRead: 'キャッシュ読み取り ', assistantNeedsConfirmation: 'アシスタントが確認を求めています', askManyQuestions: '{count} 件の質問があります。続行するには回答が必要です。', askOneQuestion: '選択肢を選ぶか、下にカスタム返信を入力してください（必須）。', noQuestionText: '(質問テキストなし)', multiSelect: '複数選択可', customReplyLabel: 'その他の返信（任意）：考えや選択しない理由を書いてください', customReplyPlaceholder: '例：別の実装方法に変更したいです…', sendReply: '返信を送信', askUserReplyIntro: '質問に対して次のように回答しました:', askUserPicked: '   選択: {items}', askUserNoPick: '   選択:（選択された項目はありません）', askUserExtra: '補足説明:', toolRunning: '実行中', toolSuccess: '成功', toolFailed: '失敗', toolPermissionDenied: '権限が必要', toolPending: '待機中', collapsibleSummary: '{label}（{count} 文字、クリックして展開）', truncatedChars: '… {count} 文字を切り詰めました', resendTitle: '再送信: このメッセージと後続のコンテキストを削除して再送信', resendAria: 'このメッセージを再送信', loading: '読み込み中', cliNotSelected: 'CLI が未選択', cliStatus: 'CLI 状態: {status}{detail}', unknownError: '不明なエラー', copiedBodySource: 'body ソースをコピーしました', copyBodySourceFailed: 'body ソースのコピーに失敗しました', removeAttachment: '{name} を削除', genericFile: 'ファイル', expertPanelTitle: 'エキスパート実行', expertPanelStatusRunning: '実行中…', expertPanelStatusDone: '完了', expertPanelStatusError: '失敗', expertPanelStatusCancelled: 'キャンセル', expertPanelToggleAria: 'エキスパートパネル切り替え', expertEventStart: '開始', expertEventAnalysis: '分析', expertEventToolCall: 'ツール呼び出し', expertEventToolResult: 'ツール結果', expertEventFinal: '最終回答', expertEventError: 'エラー', expertEventCancelled: 'キャンセル'
    };
    chatTranslations.fr = {
        statusInitializing: 'Initialisation…', newSession: 'Nouvelle conversation', newSessionTitle: 'Démarrer une nouvelle conversation', restart: 'Redémarrer', restartTitle: 'Redémarrer le CLI', clear: 'Effacer', clearTitle: 'Effacer le contenu du chat', dropFilesHere: 'Déposez les fichiers ici comme contexte', contextPanelAria: 'Fichiers de contexte ajoutés', defaultCurrentFile: 'Afficher le fichier actuel par défaut', clearContext: 'Effacer le contexte', contextMenu: 'Menu de contexte', composerPlaceholder: 'Demander, modifier ou agent…', attachFile: 'Sélectionner des fichiers de contexte', modelSelectTitle: 'Changer de modèle et redémarrer automatiquement Chat CLI', modelSelectAria: 'Changer de modèle', modelLoading: 'Chargement des modèles…', permissionModeTitle: 'Changer le mode d’autorisation Claude CLI et redémarrer automatiquement Chat CLI', permissionModeAria: 'Changer le mode d’autorisation', sendMessage: 'Envoyer le message', stopResponse: 'Arrêter la réponse actuelle', noModelConfigured: 'Aucun modèle configuré', selectModel: 'Sélectionner un modèle', permissionAcceptEdits: 'Actuel : acceptEdits (accepter automatiquement les outils d’édition)', permissionBypass: 'Actuel : bypassPermissions (ignorer les contrôles d’autorisation, faire pleinement confiance à l’espace de travail actuel)', emptyState: 'LLS CLAUDE CHAT - Commencer une conversation', longTextOutput: 'Sortie texte longue', longCodeBlock: 'Bloc de code long', longDiffOutput: 'Sortie diff longue', copy: 'Copier', copyCode: 'Copier le code', usageModel: 'Modèle ', usageInput: 'Entrée ', usageOutput: 'Sortie ', usageCacheWrite: 'Écriture cache ', usageCacheRead: 'Lecture cache ', assistantNeedsConfirmation: 'L’assistant a besoin de votre confirmation', askManyQuestions: 'Il y a {count} questions. Vous devez répondre avant de continuer.', askOneQuestion: 'Choisissez une option ou saisissez une réponse personnalisée ci-dessous (obligatoire).', noQuestionText: '(Aucun texte de question)', multiSelect: 'Sélection multiple', customReplyLabel: 'Autre réponse (facultatif) : indiquez vos pensées ou pourquoi vous n’avez pas choisi une option', customReplyPlaceholder: 'Par exemple : je veux utiliser une autre implémentation…', sendReply: 'Envoyer la réponse', askUserReplyIntro: 'J’ai répondu à votre question comme suit :', askUserPicked: '   Sélection : {items}', askUserNoPick: '   Sélection : (aucune option sélectionnée)', askUserExtra: 'Note complémentaire :', toolRunning: 'En cours', toolSuccess: 'Succès', toolFailed: 'Échec', toolPermissionDenied: 'Autorisation requise', toolPending: 'En attente', collapsibleSummary: '{label} ({count} caractères, cliquez pour développer)', truncatedChars: '… {count} caractères tronqués', resendTitle: 'Renvoyer : supprimer ce message et le contexte suivant, puis renvoyer', resendAria: 'Renvoyer ce message', loading: 'Chargement', cliNotSelected: 'CLI non sélectionné', cliStatus: 'État CLI : {status}{detail}', unknownError: 'Erreur inconnue', copiedBodySource: 'Source body copiée', copyBodySourceFailed: 'Échec de la copie de la source body', removeAttachment: 'Supprimer {name}', genericFile: 'Fichier', expertPanelTitle: 'Exécution experte', expertPanelStatusRunning: 'en cours…', expertPanelStatusDone: 'terminé', expertPanelStatusError: 'échec', expertPanelStatusCancelled: 'annulé', expertPanelToggleAria: 'Basculer le panneau expert', expertEventStart: 'Début', expertEventAnalysis: 'Analyse', expertEventToolCall: 'Appel d’outil', expertEventToolResult: 'Résultat d’outil', expertEventFinal: 'Réponse finale', expertEventError: 'Erreur', expertEventCancelled: 'Annulé'
    };
    chatTranslations.de = {
        statusInitializing: 'Initialisierung…', newSession: 'Neuer Chat', newSessionTitle: 'Neue Unterhaltung starten', restart: 'Neu starten', restartTitle: 'CLI neu starten', clear: 'Leeren', clearTitle: 'Chatinhalt leeren', dropFilesHere: 'Dateien hierher ziehen, um sie als Kontext zu verwenden', contextPanelAria: 'Hinzugefügte Kontextdateien', defaultCurrentFile: 'Aktuelle Datei standardmäßig anzeigen', clearContext: 'Kontext leeren', contextMenu: 'Kontextmenü', composerPlaceholder: 'Fragen, bearbeiten oder Agent…', attachFile: 'Kontextdateien auswählen', modelSelectTitle: 'Modell wechseln und Chat CLI danach automatisch neu starten', modelSelectAria: 'Modell wechseln', modelLoading: 'Modelle werden geladen…', permissionModeTitle: 'Claude-CLI-Berechtigungsmodus wechseln und Chat CLI danach automatisch neu starten', permissionModeAria: 'Berechtigungsmodus wechseln', sendMessage: 'Nachricht senden', stopResponse: 'Aktuelle Antwort stoppen', noModelConfigured: 'Kein Modell konfiguriert', selectModel: 'Modell auswählen', permissionAcceptEdits: 'Aktuell: acceptEdits (Bearbeitungswerkzeuge automatisch akzeptieren)', permissionBypass: 'Aktuell: bypassPermissions (Berechtigungsprüfungen überspringen, aktuellen Arbeitsbereich vollständig vertrauen)', emptyState: 'LLS CLAUDE CHAT - Unterhaltung starten', longTextOutput: 'Lange Textausgabe', longCodeBlock: 'Langer Codeblock', longDiffOutput: 'Lange diff-Ausgabe', copy: 'Kopieren', copyCode: 'Code kopieren', usageModel: 'Modell ', usageInput: 'Eingabe ', usageOutput: 'Ausgabe ', usageCacheWrite: 'Cache schreiben ', usageCacheRead: 'Cache lesen ', assistantNeedsConfirmation: 'Der Assistent benötigt Ihre Bestätigung', askManyQuestions: 'Es gibt {count} Fragen. Sie müssen antworten, bevor es weitergeht.', askOneQuestion: 'Wählen Sie eine Option oder geben Sie unten eine eigene Antwort ein (erforderlich).', noQuestionText: '(Kein Fragetext)', multiSelect: 'Mehrfachauswahl', customReplyLabel: 'Andere Antwort (optional): Schreiben Sie Ihre Gedanken oder warum Sie eine Option nicht gewählt haben', customReplyPlaceholder: 'Zum Beispiel: Ich möchte eine andere Implementierung verwenden…', sendReply: 'Antwort senden', askUserReplyIntro: 'Ich habe auf Ihre Frage wie folgt geantwortet:', askUserPicked: '   Auswahl: {items}', askUserNoPick: '   Auswahl: (keine Option ausgewählt)', askUserExtra: 'Zusätzlicher Hinweis:', toolRunning: 'Wird ausgeführt', toolSuccess: 'Erfolgreich', toolFailed: 'Fehlgeschlagen', toolPermissionDenied: 'Berechtigung erforderlich', toolPending: 'Warten', collapsibleSummary: '{label} ({count} Zeichen, zum Erweitern klicken)', truncatedChars: '… {count} Zeichen abgeschnitten', resendTitle: 'Erneut senden: diese Nachricht und folgenden Kontext löschen und erneut senden', resendAria: 'Diese Nachricht erneut senden', loading: 'Wird geladen', cliNotSelected: 'CLI nicht ausgewählt', cliStatus: 'CLI-Status: {status}{detail}', unknownError: 'Unbekannter Fehler', copiedBodySource: 'Body-Quelle kopiert', copyBodySourceFailed: 'Kopieren der Body-Quelle fehlgeschlagen', removeAttachment: '{name} entfernen', genericFile: 'Datei', expertPanelTitle: 'Experten-Lauf', expertPanelStatusRunning: 'läuft…', expertPanelStatusDone: 'abgeschlossen', expertPanelStatusError: 'fehlgeschlagen', expertPanelStatusCancelled: 'abgebrochen', expertPanelToggleAria: 'Experten-Panel umschalten', expertEventStart: 'Start', expertEventAnalysis: 'Analyse', expertEventToolCall: 'Werkzeugaufruf', expertEventToolResult: 'Werkzeugergebnis', expertEventFinal: 'Endgültige Antwort', expertEventError: 'Fehler', expertEventCancelled: 'Abgebrochen'
    };

    Object.assign(chatTranslations.ko, {
        planNotConfigured: '(플랜 모델 없음)',
        reviewNotConfigured: '(리뷰 모델 없음)'
    });
    Object.assign(chatTranslations.ja, {
        planNotConfigured: '（プランモデル未設定）',
        reviewNotConfigured: '（レビューモデル未設定）'
    });
    Object.assign(chatTranslations.fr, {
        planNotConfigured: '(Aucun modèle de plan)',
        reviewNotConfigured: '(Aucun modèle de révision)'
    });
    Object.assign(chatTranslations.de, {
        planNotConfigured: '(Kein Plan-Modell)',
        reviewNotConfigured: '(Kein Review-Modell)'
    });

    /** 补齐重发编辑态动态文案，避免静态翻译长行继续膨胀。 */
    Object.assign(chatTranslations.en, {
        resendConfirm: 'Send edited message',
        resendCancel: 'Cancel resend editing',
        resendEditorAria: 'Edit message before resending'
    });
    Object.assign(chatTranslations['zh-cn'], {
        resendConfirm: '发送修改后的消息',
        resendCancel: '取消重发编辑',
        resendEditorAria: '编辑后重发消息'
    });
    /** 补齐会话标题编辑弹窗文案。 */
    Object.assign(chatTranslations.en, {
        sessionTitleEditLabel: 'Edit conversation title', confirm: 'OK', cancel: 'Cancel'
    });
    Object.assign(chatTranslations['zh-cn'], {
        sessionTitleEditLabel: '修改会话标题', confirm: '确定', cancel: '取消'
    });
    Object.assign(chatTranslations['zh-tw'], {
        sessionTitleEditLabel: '修改會話標題', confirm: '確定', cancel: '取消'
    });
    Object.assign(chatTranslations.ko, {
        sessionTitleEditLabel: '대화 제목 편집', confirm: '확인', cancel: '취소'
    });
    Object.assign(chatTranslations.ja, {
        sessionTitleEditLabel: '会話タイトルを編集', confirm: 'OK', cancel: 'キャンセル'
    });
    Object.assign(chatTranslations.fr, {
        sessionTitleEditLabel: 'Modifier le titre de la conversation', confirm: 'OK', cancel: 'Annuler'
    });
    Object.assign(chatTranslations.de, {
        sessionTitleEditLabel: 'Gesprächstitel bearbeiten', confirm: 'OK', cancel: 'Abbrechen'
    });
    /** 补齐任务流顶部 Todo 状态卡片文案，避免静态翻译长行继续膨胀。 */
    Object.assign(chatTranslations.en, {
        taskTodoTitle: 'Todos',
        taskTodoToggleAria: 'Toggle CC task flow todos',
        taskTodoOpen: 'Open CC task flow',
        taskTodoStatusPending: 'Pending',
        taskTodoStatusInProgress: 'In progress',
        taskTodoStatusCompleted: 'Completed',
        taskTodoStatusBlocked: 'Blocked'
    });
    Object.assign(chatTranslations['zh-cn'], {
        taskTodoTitle: '待办事项',
        taskTodoToggleAria: '展开/折叠 CC 任务流待办事项',
        taskTodoOpen: '打开 CC 任务流',
        taskTodoStatusPending: '待处理',
        taskTodoStatusInProgress: '进行中',
        taskTodoStatusCompleted: '已完成',
        taskTodoStatusBlocked: '已阻塞'
    });
    Object.assign(chatTranslations['zh-tw'], {
        taskTodoTitle: '待辦事項',
        taskTodoToggleAria: '展開/收合 CC 任務流待辦事項',
        taskTodoOpen: '開啟 CC 任務流',
        taskTodoStatusPending: '待處理',
        taskTodoStatusInProgress: '進行中',
        taskTodoStatusCompleted: '已完成',
        taskTodoStatusBlocked: '已阻塞'
    });
    Object.assign(chatTranslations.ko, {
        taskTodoTitle: '할 일',
        taskTodoToggleAria: 'CC 작업 흐름 할 일 접기/펼치기',
        taskTodoOpen: 'CC 작업 흐름 열기',
        taskTodoStatusPending: '대기 중',
        taskTodoStatusInProgress: '진행 중',
        taskTodoStatusCompleted: '완료됨',
        taskTodoStatusBlocked: '차단됨'
    });
    Object.assign(chatTranslations.ja, {
        taskTodoTitle: 'Todo',
        taskTodoToggleAria: 'CC タスクフローの Todo を展開/折りたたみ',
        taskTodoOpen: 'CC タスクフローを開く',
        taskTodoStatusPending: '保留中',
        taskTodoStatusInProgress: '進行中',
        taskTodoStatusCompleted: '完了',
        taskTodoStatusBlocked: 'ブロック中'
    });
    Object.assign(chatTranslations.fr, {
        taskTodoTitle: 'Tâches',
        taskTodoToggleAria: 'Déplier/replier les tâches du flux CC',
        taskTodoOpen: 'Ouvrir le flux de tâches CC',
        taskTodoStatusPending: 'En attente',
        taskTodoStatusInProgress: 'En cours',
        taskTodoStatusCompleted: 'Terminé',
        taskTodoStatusBlocked: 'Bloqué'
    });
    Object.assign(chatTranslations.de, {
        taskTodoTitle: 'Aufgaben',
        taskTodoToggleAria: 'CC-Aufgabenfluss-Todos ein-/ausklappen',
        taskTodoOpen: 'CC-Aufgabenfluss öffnen',
        taskTodoStatusPending: 'Ausstehend',
        taskTodoStatusInProgress: 'In Bearbeitung',
        taskTodoStatusCompleted: 'Abgeschlossen',
        taskTodoStatusBlocked: 'Blockiert'
    });

    /** 补齐 Claude 原生 TodoWrite footer 面板文案。 */
    Object.assign(chatTranslations.en, {
        claudeTodoTitle: 'Claude Todos',
        claudeTodoToggleAria: 'Toggle Claude TodoWrite todos'
    });
    Object.assign(chatTranslations['zh-cn'], {
        claudeTodoTitle: 'Claude 待办',
        claudeTodoToggleAria: '展开/折叠 Claude TodoWrite 待办'
    });
    Object.assign(chatTranslations['zh-tw'], {
        claudeTodoTitle: 'Claude 待辦',
        claudeTodoToggleAria: '展開/收合 Claude TodoWrite 待辦'
    });
    Object.assign(chatTranslations.ko, {
        claudeTodoTitle: 'Claude 할 일',
        claudeTodoToggleAria: 'Claude TodoWrite 할 일 접기/펼치기'
    });
    Object.assign(chatTranslations.ja, {
        claudeTodoTitle: 'Claude Todo',
        claudeTodoToggleAria: 'Claude TodoWrite の Todo を展開/折りたたみ'
    });
    Object.assign(chatTranslations.fr, {
        claudeTodoTitle: 'Tâches Claude',
        claudeTodoToggleAria: 'Déplier/replier les tâches TodoWrite de Claude'
    });
    Object.assign(chatTranslations.de, {
        claudeTodoTitle: 'Claude-Aufgaben',
        claudeTodoToggleAria: 'Claude TodoWrite-Todos ein-/ausklappen'
    });

    /** 浏览器自动放行提示：点击后开启 chat.tools.global.autoApprove，免去每次「Open Browser Page?」确认。 */
    Object.assign(chatTranslations.en, {
        browserAutoApproveHint: 'Skip browser confirmation',
        browserAutoApproveHintTitle: 'Enabling this turns on workbench.browser.enableChatTools and chat.tools.global.autoApprove so VS Code stops asking to confirm every browser page. Note: this auto-approves ALL agent tools (including writing files and running commands) — only enable on a trusted local machine.',
        browserAutoApproveConfirmTitle: 'Skip browser confirmation?',
        browserAutoApproveConfirmOk: 'Enable',
        browserAutoApproveConfirmCancel: 'Cancel'
    });
    Object.assign(chatTranslations['zh-cn'], {
        browserAutoApproveHint: '免去浏览器确认',
        browserAutoApproveHintTitle: '开启后会打开 workbench.browser.enableChatTools 和 chat.tools.global.autoApprove，免去每次打开浏览器页面的「Open Browser Page?」确认。注意：会自动放行所有 agent 工具（含写文件、执行命令），建议仅在信任的本机环境开启。',
        browserAutoApproveConfirmTitle: '免去浏览器确认弹窗？',
        browserAutoApproveConfirmOk: '开启',
        browserAutoApproveConfirmCancel: '取消'
    });
    Object.assign(chatTranslations['zh-tw'], {
        browserAutoApproveHint: '免去瀏覽器確認',
        browserAutoApproveHintTitle: '開啟後會打開 workbench.browser.enableChatTools 和 chat.tools.global.autoApprove，免去每次開啟瀏覽器頁面的「Open Browser Page?」確認。注意：會自動放行所有 agent 工具（含寫檔案、執行命令），建議僅在信任的本機環境開啟。',
        browserAutoApproveConfirmTitle: '免去瀏覽器確認彈窗？',
        browserAutoApproveConfirmOk: '開啟',
        browserAutoApproveConfirmCancel: '取消'
    });
    Object.assign(chatTranslations.ko, {
        browserAutoApproveHint: '브라우저 확인 생략',
        browserAutoApproveHintTitle: '활성화하면 workbench.browser.enableChatTools와 chat.tools.global.autoApprove가 켜져 VS Code가 매번 브라우저 페이지 열기를 확인하지 않습니다. 주의: 모든 에이전트 도구(파일 쓰기, 명령 실행 포함)를 자동 승인하므로 신뢰할 수 있는 로컬 환경에서만 켜세요.',
        browserAutoApproveConfirmTitle: '브라우저 확인을 생략할까요?',
        browserAutoApproveConfirmOk: '켜기',
        browserAutoApproveConfirmCancel: '취소'
    });
    Object.assign(chatTranslations.ja, {
        browserAutoApproveHint: 'ブラウザ確認を省略',
        browserAutoApproveHintTitle: '有効にすると workbench.browser.enableChatTools と chat.tools.global.autoApprove がオンになり、ブラウザページを開くたびの確認が省略されます。注意: すべてのエージェントツール（ファイル書き込みやコマンド実行を含む）が自動承認されるため、信頼できるローカル環境でのみ有効にしてください。',
        browserAutoApproveConfirmTitle: 'ブラウザ確認を省略しますか？',
        browserAutoApproveConfirmOk: '有効化',
        browserAutoApproveConfirmCancel: 'キャンセル'
    });
    Object.assign(chatTranslations.fr, {
        browserAutoApproveHint: 'Ignorer la confirmation du navigateur',
        browserAutoApproveHintTitle: 'L’activation active workbench.browser.enableChatTools et chat.tools.global.autoApprove afin que VS Code cesse de demander confirmation à chaque page du navigateur. Remarque : cela approuve automatiquement TOUS les outils agent (y compris l’écriture de fichiers et l’exécution de commandes) — à activer uniquement sur une machine locale de confiance.',
        browserAutoApproveConfirmTitle: 'Ignorer la confirmation du navigateur ?',
        browserAutoApproveConfirmOk: 'Activer',
        browserAutoApproveConfirmCancel: 'Annuler'
    });
    Object.assign(chatTranslations.de, {
        browserAutoApproveHint: 'Browser-Bestätigung überspringen',
        browserAutoApproveHintTitle: 'Beim Aktivieren werden workbench.browser.enableChatTools und chat.tools.global.autoApprove eingeschaltet, damit VS Code nicht jede Browser-Seite bestätigen lässt. Hinweis: Dadurch werden ALLE Agent-Werkzeuge automatisch genehmigt (einschließlich Dateien schreiben und Befehle ausführen) — nur auf einem vertrauenswürdigen lokalen Rechner aktivieren.',
        browserAutoApproveConfirmTitle: 'Browser-Bestätigung überspringen?',
        browserAutoApproveConfirmOk: 'Aktivieren',
        browserAutoApproveConfirmCancel: 'Abbrechen'
    });

    /** 补齐任务流恢复对话框文案：继续/清除/稍后三按钮。 */
    Object.assign(chatTranslations.en, {
        restoreTitle: 'Resume unfinished task flow?',
        restoreDesc: 'An unfinished task flow was found in this workspace. Continue it, or clear it.',
        restoreContinue: 'Continue',
        restoreClear: 'Clear',
        restoreDismiss: 'Later'
    });
    Object.assign(chatTranslations['zh-cn'], {
        restoreTitle: '恢复未完成的任务流？',
        restoreDesc: '在当前工作区发现一个未完成的任务流，可以继续推进，或清除它。',
        restoreContinue: '继续',
        restoreClear: '清除',
        restoreDismiss: '稍后'
    });
    Object.assign(chatTranslations['zh-tw'], {
        restoreTitle: '恢復未完成的任務流？',
        restoreDesc: '在目前工作區發現一個未完成的任務流，可以繼續推進，或清除它。',
        restoreContinue: '繼續',
        restoreClear: '清除',
        restoreDismiss: '稍後'
    });
    Object.assign(chatTranslations.ko, {
        restoreTitle: '완료되지 않은 작업 흐름을 재개할까요?',
        restoreDesc: '이 작업 영역에서 완료되지 않은 작업 흐름을 발견했습니다. 계속하거나 지울 수 있습니다.',
        restoreContinue: '계속',
        restoreClear: '지우기',
        restoreDismiss: '나중에'
    });
    Object.assign(chatTranslations.ja, {
        restoreTitle: '未完了のタスクフローを再開しますか？',
        restoreDesc: 'このワークスペースに未完了のタスクフローが見つかりました。続行するか、クリアできます。',
        restoreContinue: '続行',
        restoreClear: 'クリア',
        restoreDismiss: '後で'
    });
    Object.assign(chatTranslations.fr, {
        restoreTitle: 'Reprendre le flux de tâches inachevé ?',
        restoreDesc: 'Un flux de tâches inachevé a été trouvé dans cet espace de travail. Continuez-le ou effacez-le.',
        restoreContinue: 'Continuer',
        restoreClear: 'Effacer',
        restoreDismiss: 'Plus tard'
    });
    Object.assign(chatTranslations.de, {
        restoreTitle: 'Unfertigen Aufgabenfluss fortsetzen?',
        restoreDesc: 'In diesem Arbeitsbereich wurde ein unfertiger Aufgabenfluss gefunden. Fortsetzen oder löschen.',
        restoreContinue: 'Fortsetzen',
        restoreClear: 'Löschen',
        restoreDismiss: 'Später'
    });

    /** 补齐顶部模型条、模型选择弹窗 UI 文案（按需专家方案下已无路由徽章）。 */
    Object.assign(chatTranslations.en, {
        modelsBarNormal: 'Normal:', modelsBarExpert: 'Expert:', openModelPicker: 'Choose models',
        pickerTitle: 'Select Chat models', pickerNormalSection: 'Normal task model', pickerExpertSection: 'Expert task model', pickerPlanSection: 'Plan task model', pickerReviewSection: 'Review task model', pickerCompactionSection: 'Compaction model',
        pickerCacheTtlSection: 'Prompt cache TTL', pickerCacheTtlDefault: 'Default (follow client)', pickerCacheTtl5m: '5 minutes', pickerCacheTtl1h: '1 hour', pickerCacheTtlHint: 'If requests error, switch back to Default.',
        pickerSave: 'Save and restart CLI', pickerCancel: 'Cancel',
        expertNotConfigured: 'Disable expert', expertNotConfiguredToast: 'Expert model is not configured. Open the model picker to select one.',
        expertUnavailable: 'Not configured',
        planNotConfigured: '(Plan model not configured)', reviewNotConfigured: '(Review model not configured)', compactionNotConfigured: '(Use normal model for compaction)'
    });
    Object.assign(chatTranslations['zh-cn'], {
        modelsBarNormal: '普通：', modelsBarExpert: '专家：', openModelPicker: '选择模型',
        pickerTitle: '选择 Chat 模型', pickerNormalSection: '普通任务模型', pickerExpertSection: '专家任务模型', pickerPlanSection: '方案任务模型', pickerReviewSection: '审查任务模型', pickerCompactionSection: '压缩模型',
        pickerCacheTtlSection: '提示词缓存时长', pickerCacheTtlDefault: '默认（沿用客户端）', pickerCacheTtl5m: '5 分钟', pickerCacheTtl1h: '1 小时', pickerCacheTtlHint: '如果请求报错，切回默认。',
        pickerSave: '保存并重启 CLI', pickerCancel: '取消',
        expertNotConfigured: '关闭专家', expertNotConfiguredToast: '尚未配置专家模型，请在「选择模型」弹窗中选择。',
        expertUnavailable: '未配置',
        planNotConfigured: '（未配置方案模型）', reviewNotConfigured: '（未配置审查模型）', compactionNotConfigured: '（压缩时使用普通模型）'
    });
    Object.assign(chatTranslations['zh-tw'], {
        modelsBarNormal: '一般：', modelsBarExpert: '專家：', openModelPicker: '選擇模型',
        pickerTitle: '選擇 Chat 模型', pickerNormalSection: '一般任務模型', pickerExpertSection: '專家任務模型', pickerPlanSection: '方案任務模型', pickerReviewSection: '審查任務模型', pickerCompactionSection: '壓縮模型',
        pickerCacheTtlSection: '提示詞快取時長', pickerCacheTtlDefault: '預設（沿用用戶端）', pickerCacheTtl5m: '5 分鐘', pickerCacheTtl1h: '1 小時', pickerCacheTtlHint: '若請求發生錯誤，請切回預設。',
        pickerSave: '儲存並重新啟動 CLI', pickerCancel: '取消',
        expertNotConfigured: '關閉專家', expertNotConfiguredToast: '尚未設定專家模型，請在「選擇模型」對話框中選擇。',
        expertUnavailable: '未設定',
        planNotConfigured: '（未設定方案模型）', reviewNotConfigured: '（未設定審查模型）', compactionNotConfigured: '（壓縮時使用一般模型）'
    });
    Object.assign(chatTranslations.ko, {
        modelsBarNormal: '일반:', modelsBarExpert: '전문가:', openModelPicker: '모델 선택',
        pickerTitle: 'Chat 모델 선택', pickerNormalSection: '일반 작업 모델', pickerExpertSection: '전문가 작업 모델', pickerPlanSection: '계획 작업 모델', pickerReviewSection: '검토 작업 모델', pickerCompactionSection: '압축 모델',
        pickerCacheTtlSection: '프롬프트 캐시 TTL', pickerCacheTtlDefault: '기본값(클라이언트 따름)', pickerCacheTtl5m: '5분', pickerCacheTtl1h: '1시간', pickerCacheTtlHint: '요청이 오류가 나면 기본값으로 되돌리세요.',
        pickerSave: '저장 후 CLI 재시작', pickerCancel: '취소',
        expertNotConfigured: '전문가 비활성화', expertNotConfiguredToast: '전문가 모델이 설정되지 않았습니다. 모델 선택 대화 상자에서 선택하세요.',
        expertUnavailable: '미설정',
        planNotConfigured: '(계획 모델 미설정)', reviewNotConfigured: '(검토 모델 미설정)', compactionNotConfigured: '(압축 시 일반 모델 사용)'
    });
    Object.assign(chatTranslations.ja, {
        modelsBarNormal: '通常:', modelsBarExpert: 'エキスパート:', openModelPicker: 'モデルを選択',
        pickerTitle: 'Chat モデルを選択', pickerNormalSection: '通常タスクモデル', pickerExpertSection: 'エキスパートタスクモデル', pickerPlanSection: 'プランタスクモデル', pickerReviewSection: 'レビ��ータスクモデル', pickerCompactionSection: '圧縮モデル',
        pickerCacheTtlSection: 'プロンプトキャッシュ TTL', pickerCacheTtlDefault: 'デフォルト（クライアントに従う）', pickerCacheTtl5m: '5 分', pickerCacheTtl1h: '1 時間', pickerCacheTtlHint: 'リクエストがエラーになる場合はデフォルトに戻してください。',
        pickerSave: '保存して CLI を再起動', pickerCancel: 'キャンセル',
        expertNotConfigured: 'エキスパートを無効化', expertNotConfiguredToast: 'エキスパートモデルが設定されていません。モデル選択ダイアログで選択してください。',
        expertUnavailable: '未設定',
        planNotConfigured: '（プランモデル未設定）', reviewNotConfigured: '（レビューモデル未設定）', compactionNotConfigured: '（圧縮時は通常モデルを使用）'
    });
    Object.assign(chatTranslations.fr, {
        modelsBarNormal: 'Normal :', modelsBarExpert: 'Expert :', openModelPicker: 'Choisir les modèles',
        pickerTitle: 'Sélectionner les modèles Chat', pickerNormalSection: 'Modèle de tâche normal', pickerExpertSection: 'Modèle de tâche expert', pickerPlanSection: 'Modèle de tâche plan', pickerReviewSection: 'Modèle de tâche revue',
        pickerCacheTtlSection: 'TTL du cache de prompt', pickerCacheTtlDefault: 'Par défaut (suivre le client)', pickerCacheTtl5m: '5 minutes', pickerCacheTtl1h: '1 heure', pickerCacheTtlHint: 'En cas d’erreur de requête, revenez à Par défaut.',
        pickerSave: 'Enregistrer et redémarrer le CLI', pickerCancel: 'Annuler',
        expertNotConfigured: 'Désactiver l’expert', expertNotConfiguredToast: 'Le modèle expert n’est pas configuré. Choisissez-en un dans le sélecteur de modèles.',
        expertUnavailable: 'Non configuré',
        planNotConfigured: '(Modèle de plan non configuré)', reviewNotConfigured: '(Modèle de revue non configuré)'
    });
    Object.assign(chatTranslations.de, {
        modelsBarNormal: 'Normal:', modelsBarExpert: 'Experte:', openModelPicker: 'Modelle wählen',
        pickerTitle: 'Chat-Modelle auswählen', pickerNormalSection: 'Normales Aufgabenmodell', pickerExpertSection: 'Experten-Aufgabenmodell', pickerPlanSection: 'Plan-Aufgabenmodell', pickerReviewSection: 'Review-Aufgabenmodell',
        pickerCacheTtlSection: 'Prompt-Cache-TTL', pickerCacheTtlDefault: 'Standard (Client folgen)', pickerCacheTtl5m: '5 Minuten', pickerCacheTtl1h: '1 Stunde', pickerCacheTtlHint: 'Bei Anfragefehlern auf Standard zurückschalten.',
        pickerSave: 'Speichern und CLI neu starten', pickerCancel: 'Abbrechen',
        routeAutoSwitched: 'Die nächste Nachricht wird über die Experten-Route gesendet',
        expertNotConfigured: 'Experte deaktivieren', expertNotConfiguredToast: 'Das Expertenmodell ist nicht konfiguriert. Bitte wählen Sie eines im Modell-Auswahldialog.',
        expertUnavailable: 'Nicht konfiguriert',
        planNotConfigured: '(Planmodell nicht konfiguriert)', reviewNotConfigured: '(Review-Modell nicht konfiguriert)'
    });

    /** 补齐上下文窗口弹层文案。 */
    Object.assign(chatTranslations.en, {
        contextWindowTitle: 'Context window',
        contextWindowReserved: 'Reserved for response',
        contextWindowCompact: 'Compact conversation'
    });
    Object.assign(chatTranslations['zh-cn'], {
        contextWindowTitle: '上下文窗口',
        contextWindowReserved: '保留用于响应',
        contextWindowCompact: '压缩对话'
    });
    Object.assign(chatTranslations['zh-tw'], {
        contextWindowTitle: '上下文視窗',
        contextWindowReserved: '保留給回應',
        contextWindowCompact: '壓縮對話'
    });
    Object.assign(chatTranslations.ko, {
        contextWindowTitle: '컨텍스트 창',
        contextWindowReserved: '응답용 예약',
        contextWindowCompact: '대화 압축'
    });
    Object.assign(chatTranslations.ja, {
        contextWindowTitle: 'コンテキストウィンドウ',
        contextWindowReserved: '応答用に予約',
        contextWindowCompact: '会話を圧縮'
    });
    Object.assign(chatTranslations.fr, {
        contextWindowTitle: 'Fenêtre de contexte',
        contextWindowReserved: 'Réservé pour la réponse',
        contextWindowCompact: 'Compacter la conversation'
    });
    Object.assign(chatTranslations.de, {
        contextWindowTitle: 'Kontextfenster',
        contextWindowReserved: 'Für Antwort reserviert',
        contextWindowCompact: 'Konversation komprimieren'
    });
    const vscode = acquireVsCodeApi();
    const messagesEl = document.querySelector('[data-role="messages"]');
    const composerShellEl = document.querySelector('[data-role="composer-shell"]');
    const composerEl = document.querySelector('[data-role="composer"]');
    const sendEl = document.querySelector('[data-role="send"]');
    const globalPendingEl = document.querySelector('[data-role="global-pending"]');
    const attachFileEl = document.querySelector('[data-role="attach-file"]');
    const contextPanelEl = document.querySelector('[data-role="context-panel"]');
    const toastEl = document.querySelector('[data-role="chat-toast"]');
    const contextCountEl = document.querySelector('[data-role="context-count"]');
    const contextClearEl = document.querySelector('[data-role="context-clear"]');
    const attachmentsEl = document.querySelector('[data-role="attachments"]');
    const dropOverlayEl = document.querySelector('[data-role="drop-overlay"]');
    const modelsBarEl = document.querySelector('[data-role="models-bar"]');
    const normalModelNameEl = document.querySelector('[data-role="normal-model-name"]');
    const expertModelNameEl = document.querySelector('[data-role="expert-model-name"]');
    const openModelPickerEl = document.querySelector('[data-role="open-model-picker"]');
    const modelPickerDialogEl = document.querySelector('[data-role="model-picker"]');
    const modelPickerFormEl = document.querySelector('[data-role="model-picker-form"]');
    const modelPickerNormalSelectEl = document.querySelector('[data-role="model-picker-normal-select"]');
    const modelPickerExpertSelectEl = document.querySelector('[data-role="model-picker-expert-select"]');
    const modelPickerPlanSelectEl = document.querySelector('[data-role="model-picker-plan-select"]');
    const modelPickerReviewSelectEl = document.querySelector('[data-role="model-picker-review-select"]');
    const modelPickerCompactionSelectEl = document.querySelector('[data-role="model-picker-compaction-select"]');
    const modelPickerCacheTtlSelectEl = document.querySelector('[data-role="model-picker-cache-ttl-select"]');
    const modelPickerCancelEls = Array.prototype.slice.call(
        document.querySelectorAll('[data-role="model-picker-cancel"], [data-role="model-picker-cancel-btn"]')
    );
    const taskRestoreDialogEl = document.querySelector('[data-role="task-restore"]');
    const taskRestoreSummaryEl = document.querySelector('[data-role="task-restore-summary"]');
    const taskRestoreNameEl = document.querySelector('[data-role="task-restore-name"]');
    const taskRestoreProgressEl = document.querySelector('[data-role="task-restore-progress"]');
    const taskRestoreContinueEl = document.querySelector('[data-role="task-restore-continue"]');
    const taskRestoreClearEl = document.querySelector('[data-role="task-restore-clear"]');
    const taskRestoreDismissEl = document.querySelector('[data-role="task-restore-dismiss"]');
    const browserAutoApproveDialogEl = document.querySelector('[data-role="browser-auto-approve-confirm"]');
    const browserAutoApproveOkEl = document.querySelector('[data-role="browser-auto-approve-confirm-ok"]');
    const browserAutoApproveCancelEl = document.querySelector('[data-role="browser-auto-approve-cancel"]');
    const routeBadgeEl = document.querySelector('[data-role="route-badge"]');
    const routeBadgeTextEl = document.querySelector('[data-role="route-badge-text"]');
    const composerNormalChipEl = document.querySelector('[data-role="composer-normal-chip"]');
    const composerExpertChipEl = document.querySelector('[data-role="composer-expert-chip"]');
    const composerNormalChipNameEl = document.querySelector('[data-role="composer-normal-chip-name"]');
    const composerExpertChipNameEl = document.querySelector('[data-role="composer-expert-chip-name"]');
    const permissionModeSelectEl = document.querySelector('[data-role="permission-mode-select"]');
    const tokenMeterEl = document.querySelector('[data-role="token-meter"]');
    const tokenMeterWrapEl = document.querySelector('[data-role="token-meter-wrap"]');
    const tokenMeterPopoverEl = document.querySelector('[data-role="token-meter-popover"]');
    const tokenMeterCompactEl = document.querySelector('[data-role="token-meter-compact"]');
    const tokenMeterUsedEl = document.querySelector('[data-role="token-meter-used"]');
    const tokenMeterPctEl = document.querySelector('[data-role="token-meter-pct"]');
    const tokenMeterBarUsedEl = document.querySelector('[data-role="token-meter-bar-used"]');
    const tokenMeterBarReservedEl = document.querySelector('[data-role="token-meter-bar-reserved"]');
    const statusEl = document.querySelector('[data-role="cli-status"]');
    const sessionTitleEl = document.querySelector('[data-role="session-title"]');
    /** 当前会话标题的完整文本（未截断），用于内联编辑时回填。 */
    let currentSessionTitleFull = '';
    /** 当前会话 ID，内联编辑标题写回时随消息回传给扩展宿主。 */
    let currentSessionTitleId = '';
    /** 标题是否正处于内联编辑态，避免编辑期间被 session/title 推送覆盖。 */
    let sessionTitleEditing = false;
    const restartCliEl = document.querySelector('[data-role="restart-cli"]');
    const newSessionEl = document.querySelector('[data-role="new-session"]');
    const openSessionsEl = document.querySelector('[data-role="open-sessions"]');
    const sessionListDialogEl = document.querySelector('[data-role="session-list"]');
    const sessionListContentEl = document.querySelector('[data-role="session-list-content"]');
    const sessionListCloseEls = document.querySelectorAll('[data-role="session-list-close"]');
    const composerState = {
        attachments: [],
        modelOptions: [],
        currentModelKey: '',
        expertModelOptions: [],
        expertModelId: '',
        expertEnabled: false,
        planModelOptions: [],
        planModelId: '',
        planEnabled: false,
        reviewModelOptions: [],
        reviewModelId: '',
        reviewEnabled: false,
        compactionModelOptions: [],
        compactionModelId: '',
        compactionEnabled: false,
        // 按需专家方案：扩展侧通过 expert/availability 广播专家是否配置好，
        // 仅用于 header 文案展示（无路由激活态）。
        expertAvailable: false,
        expertAvailableModelName: '',
        permissionMode: 'acceptEdits',
        cacheTtl: 'default',
        defaultAttachmentPaths: new Set(),
        dragDepth: 0,
        chatRunning: false,
        backendRunning: false,
        compacting: false,
        renderedCompactions: new Set()
    };
    const taskFlowTodoState = {
        snapshot: null,
        collapsed: false
    };
    const claudeTodoState = {
        todos: [],
        collapsed: false
    };
    // 浏览器自动放行提示态：宿主端在浏览器工具可用且 chat.tools.global.autoApprove
    // 关闭时推送 { supported:true, enabled:false }，前端据此在 CC 任务流按钮后展示提示。
    const browserAutoApproveState = {
        supported: false,
        enabled: false
    };
    let activeResendEditor = null;
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
        ensureComposerShortcutBar();
        renderExpertModelOptions();
        renderModelPickerPlanList();
        renderModelPickerReviewList();
        renderModelPickerCompactionList();
        renderClaudeTodoPanel();
        setChatRunning(composerState.chatRunning);
        rerenderMessagesFromDom();
    }

    /**
     * 把任务状态映射为本地化文案。
     *
     * @param {string} status 任务流状态。
     * @returns {string} 状态展示文本。
     */
    function getTaskFlowStatusLabel(status) {
        var map = {
            pending: 'taskTodoStatusPending',
            in_progress: 'taskTodoStatusInProgress',
            completed: 'taskTodoStatusCompleted',
            blocked: 'taskTodoStatusBlocked'
        };
        return t(map[status] || 'taskTodoStatusPending');
    }

    /**
     * 获取任务流 Todo 卡片 DOM；不存在时自动创建。
     *
     * 卡片被挂载在底部 footer（composer-shell）内、context-panel 之上，
     * 这样无论消息列表是否被清空、滚动到哪里，Todo 状态卡片都会固定
     * 显示在输入框上方。
     *
     * @returns {HTMLElement | null} Todo 卡片根节点。
     */
    function ensureTaskFlowTodoPanel() {
        if (!(composerShellEl instanceof HTMLElement)) return null;
        var existing = composerShellEl.querySelector('[data-role="task-flow-todo-panel"]');
        if (existing instanceof HTMLElement) return existing;
        var panel = document.createElement('section');
        panel.className = 'taskFlowTodoPanel_07S1Yg';
        panel.dataset.role = 'task-flow-todo-panel';
        // 优先插在 context-panel 之前；如果上下文面板已被移除，则插在 footer
        // 的最前面，确保位置稳定。
        var anchor = composerShellEl.querySelector('[data-role="context-panel"]');
        if (anchor && anchor.parentNode === composerShellEl) {
            composerShellEl.insertBefore(panel, anchor);
        } else {
            composerShellEl.insertBefore(panel, composerShellEl.firstChild);
        }
        return panel;
    }

    /**
     * 判断任务流快照是否存在可展示的任务列表。
     *
     * @param {any} snapshot 扩展端推送的任务流快照。
     * @returns {boolean} 是否有可展示的任务。
     */
    function hasRenderableTaskFlowTodos(snapshot) {
        return !!snapshot && !!snapshot.workflow && Array.isArray(snapshot.workflow.tasks) && snapshot.workflow.tasks.length > 0;
    }

    /**
     * 渲染或移除 Chat 输入框上方的任务流 Todo 状态卡片。
     *
     * 卡片挂载在 footer（composer-shell）中，不会随消息列表滚动；只在
     * 任务流快照存在且至少包含一个任务时才显示，否则会从 DOM 中移除。
     */
    function renderTaskFlowTodoPanel() {
        if (!(composerShellEl instanceof HTMLElement)) return;
        var snapshot = taskFlowTodoState.snapshot;
        if (!hasRenderableTaskFlowTodos(snapshot)) {
            var old = composerShellEl.querySelector('[data-role="task-flow-todo-panel"]');
            if (old) old.remove();
            return;
        }

        var workflow = snapshot.workflow;
        var tasks = workflow.tasks;
        var completed = tasks.filter(function (task) { return task.status === 'completed'; }).length;
        var panel = ensureTaskFlowTodoPanel();
        if (!panel) return;
        panel.textContent = '';
        panel.dataset.collapsed = taskFlowTodoState.collapsed ? 'true' : 'false';

        var header = document.createElement('button');
        header.type = 'button';
        header.className = 'taskFlowTodoHeader_07S1Yg';
        header.setAttribute('aria-expanded', String(!taskFlowTodoState.collapsed));
        header.setAttribute('aria-label', t('taskTodoToggleAria'));
        header.addEventListener('click', function () {
            taskFlowTodoState.collapsed = !taskFlowTodoState.collapsed;
            renderTaskFlowTodoPanel();
        });

        var chevron = document.createElement('span');
        chevron.className = 'taskFlowTodoChevron_07S1Yg';
        chevron.textContent = '›';
        var title = document.createElement('span');
        title.className = 'taskFlowTodoTitle_07S1Yg';
        title.textContent = t('taskTodoTitle') + '(' + completed + '/' + tasks.length + ')';
        var spacer = document.createElement('span');
        spacer.className = 'taskFlowTodoHeaderSpacer_07S1Yg';
        var openIcon = document.createElement('span');
        openIcon.className = 'taskFlowTodoOpenIcon_07S1Yg';
        openIcon.title = t('taskTodoOpen');
        openIcon.textContent = '☷';
        header.append(chevron, title, spacer, openIcon);
        panel.appendChild(header);

        if (taskFlowTodoState.collapsed) return;

        var list = document.createElement('div');
        list.className = 'taskFlowTodoList_07S1Yg';
        tasks.forEach(function (task) {
            var item = document.createElement('div');
            item.className = 'taskFlowTodoItem_07S1Yg taskFlowTodoItem_07S1Yg--' + (task.status || 'pending');
            var dot = document.createElement('span');
            dot.className = 'taskFlowTodoStatusDot_07S1Yg';
            dot.setAttribute('aria-label', getTaskFlowStatusLabel(task.status));
            // in_progress 用纯 CSS 旋转动画代替原来的"圆圈+实心点"占位，
            // completed 显示对勾，其它（pending/blocked）保持空。
            dot.textContent = task.status === 'completed' ? '✓' : '';
            var textWrap = document.createElement('span');
            textWrap.className = 'taskFlowTodoText_07S1Yg';
            var text = document.createElement('span');
            text.className = 'taskFlowTodoItemTitle_07S1Yg';
            text.textContent = task.title || task.id || '';
            textWrap.appendChild(text);
            if (task.description) {
                var desc = document.createElement('span');
                desc.className = 'taskFlowTodoItemDesc_07S1Yg';
                desc.textContent = task.description;
                textWrap.appendChild(desc);
            }
            item.append(dot, textWrap);
            list.appendChild(item);
        });
        panel.appendChild(list);
    }

    /**
     * 保存扩展端推送的任务流快照并刷新顶部 Todo 状态卡片。
     *
     * @param {any} snapshot 任务流快照。
     */
    function updateTaskFlowTodoStatus(snapshot) {
        try {
            // eslint-disable-next-line no-console
            console.log('[chat] taskFlow/status received', snapshot && snapshot.workflow ? {
                title: snapshot.workflow.title,
                tasks: snapshot.workflow.tasks ? snapshot.workflow.tasks.length : 0,
                hasComposerShell: !!composerShellEl
            } : 'no workflow');
        } catch (_e) { /* noop */ }
        taskFlowTodoState.snapshot = snapshot || null;
        renderTaskFlowTodoPanel();
        try {
            var panel = composerShellEl && composerShellEl.querySelector('[data-role="task-flow-todo-panel"]');
            // eslint-disable-next-line no-console
            console.log('[chat] taskFlow/status rendered panel?', !!panel);
        } catch (_e2) { /* noop */ }
    }

    /**
     * 获取 Claude TodoWrite footer 面板 DOM；不存在时自动创建。
     *
     * 面板独立于 CC 任务流 Todo 面板，允许两者同时展示。存在 CC 面板时插在其后，
     * 否则插在 context-panel 之前。
     *
     * @returns {HTMLElement | null} Claude Todo 面板根节点。
     */
    function ensureClaudeTodoPanel() {
        if (!(composerShellEl instanceof HTMLElement)) return null;
        var existing = composerShellEl.querySelector('[data-role="claude-todo-panel"]');
        if (existing instanceof HTMLElement) return existing;
        var panel = document.createElement('section');
        panel.className = 'claudeTodoPanel_07S1Yg';
        panel.dataset.role = 'claude-todo-panel';
        var taskFlowPanel = composerShellEl.querySelector('[data-role="task-flow-todo-panel"]');
        if (taskFlowPanel && taskFlowPanel.parentNode === composerShellEl) {
            taskFlowPanel.insertAdjacentElement('afterend', panel);
            return panel;
        }
        var anchor = composerShellEl.querySelector('[data-role="context-panel"]');
        if (anchor && anchor.parentNode === composerShellEl) {
            composerShellEl.insertBefore(panel, anchor);
        } else {
            composerShellEl.insertBefore(panel, composerShellEl.firstChild);
        }
        return panel;
    }

    /**
     * 判断 Claude TodoWrite 列表是否有可展示项。
     *
     * @param {any[]} todos TodoWrite 输入中的 todos 数组。
     * @returns {boolean} 是否可展示。
     */
    function hasRenderableClaudeTodos(todos) {
        return Array.isArray(todos) && todos.length > 0;
    }

    /**
     * 渲染或移除 Claude TodoWrite footer 面板。
     */
    function renderClaudeTodoPanel() {
        if (!(composerShellEl instanceof HTMLElement)) return;
        var todos = claudeTodoState.todos || [];
        if (!hasRenderableClaudeTodos(todos)) {
            var old = composerShellEl.querySelector('[data-role="claude-todo-panel"]');
            if (old) old.remove();
            return;
        }
        var completed = todos.filter(function (todo) { return todo && todo.status === 'completed'; }).length;
        var panel = ensureClaudeTodoPanel();
        if (!panel) return;
        panel.textContent = '';
        panel.dataset.collapsed = claudeTodoState.collapsed ? 'true' : 'false';

        var header = document.createElement('button');
        header.type = 'button';
        header.className = 'claudeTodoHeader_07S1Yg';
        header.setAttribute('aria-expanded', String(!claudeTodoState.collapsed));
        header.setAttribute('aria-label', t('claudeTodoToggleAria'));
        header.addEventListener('click', function () {
            claudeTodoState.collapsed = !claudeTodoState.collapsed;
            renderClaudeTodoPanel();
        });

        var chevron = document.createElement('span');
        chevron.className = 'claudeTodoChevron_07S1Yg';
        chevron.textContent = '›';
        var title = document.createElement('span');
        title.className = 'claudeTodoTitle_07S1Yg';
        title.textContent = t('claudeTodoTitle') + '(' + completed + '/' + todos.length + ')';
        var spacer = document.createElement('span');
        spacer.className = 'claudeTodoHeaderSpacer_07S1Yg';
        var icon = document.createElement('span');
        icon.className = 'claudeTodoOpenIcon_07S1Yg';
        icon.textContent = '☑';
        header.append(chevron, title, spacer, icon);
        panel.appendChild(header);

        if (claudeTodoState.collapsed) return;

        var list = document.createElement('div');
        list.className = 'claudeTodoList_07S1Yg';
        todos.forEach(function (todo) {
            var item = document.createElement('div');
            var status = (todo && todo.status) || 'pending';
            item.className = 'claudeTodoItem_07S1Yg claudeTodoItem_07S1Yg--' + status;
            var dot = document.createElement('span');
            dot.className = 'claudeTodoStatusDot_07S1Yg';
            dot.setAttribute('aria-label', getTaskFlowStatusLabel(status));
            dot.textContent = status === 'completed' ? '✓' : '';
            var textWrap = document.createElement('span');
            textWrap.className = 'claudeTodoText_07S1Yg';
            var text = document.createElement('span');
            text.className = 'claudeTodoItemTitle_07S1Yg';
            text.textContent = status === 'in_progress'
                ? ((todo && (todo.activeForm || todo.content)) || '')
                : ((todo && (todo.content || todo.activeForm)) || '');
            textWrap.appendChild(text);
            item.append(dot, textWrap);
            list.appendChild(item);
        });
        panel.appendChild(list);
    }

    /**
     * 保存最新 TodoWrite todos 并刷新 Claude TodoWrite footer 面板。
     *
     * @param {any[]} todos TodoWrite 工具输入中的 todos 数组。
     */
    function updateClaudeTodoStatus(todos) {
        claudeTodoState.todos = Array.isArray(todos) ? todos.map(function (todo) { return Object.assign({}, todo); }) : [];
        renderClaudeTodoPanel();
    }

    /**
     * 从消息列表中提取最后一次 TodoWrite 工具输入并同步到 Claude TodoWrite footer。
     *
     * @param {any[]} messages 当前可见/缓存消息。
     */
    function syncClaudeTodoFromMessages(messages) {
        var latest = [];
        function visitSegment(segment) {
            if (segment && segment.kind === 'tool' && segment.tool && segment.tool.name === 'TodoWrite') {
                var input = segment.tool.input || tryParseJSON(segment.tool.detail);
                if (input && Array.isArray(input.todos)) latest = input.todos;
            }
        }
        (messages || []).forEach(function (message) {
            (message.segments || []).forEach(visitSegment);
        });
        updateClaudeTodoStatus(latest);
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
     * 创建一个输入框下方快捷操作按钮。
     *
     * @param {string} i18nKey 按钮文案与标题使用的翻译键。
     * @param {() => void} onClick 点击后的处理函数。
     * @returns {HTMLButtonElement} 已绑定事件的按钮元素。
     */
    function createComposerShortcutButton(i18nKey, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'composer-shortcut-button';
        button.dataset.i18n = i18nKey;
        button.dataset.i18nTitle = i18nKey;
        button.textContent = t(i18nKey);
        button.title = t(i18nKey);
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * 确保蓝色输入框下方存在 CC 任务流快捷按钮（专家模型下拉已迁移到顶部模型条 + 弹窗）。
     *
     * 该区域通过运行时脚本动态注入，避免直接修改静态 index.html 结构。
     */
    function ensureComposerShortcutBar() {
        const composerBox = document.querySelector('.composer-box');
        if (!composerBox || document.querySelector('[data-role="composer-shortcut-bar"]')) return;

        const shortcutBar = document.createElement('div');
        shortcutBar.className = 'composer-shortcut-bar';
        shortcutBar.dataset.role = 'composer-shortcut-bar';

        shortcutBar.append(
            createComposerShortcutButton('ccTaskFlow', () => post({ type: 'taskFlow/open' }))
        );
        if (tokenMeterWrapEl instanceof HTMLElement) {
            shortcutBar.appendChild(tokenMeterWrapEl);
        }

        composerBox.insertAdjacentElement('afterend', shortcutBar);
        renderBrowserAutoApproveHint();
        applyI18n();
        // 如果在运行中创建/重建此栏，立刻同步禁用态。
        applyRunningDisabledControls(composerState.chatRunning);
    }

    /**
     * 在 CC 任务流按钮之后渲染/移除「免去浏览器确认」提示按钮。
     *
     * 仅在宿主端报告浏览器工具可用（supported）且 chat.tools.global.autoApprove
     * 关闭（!enabled）时显示；点击后请求宿主开启该设置。
     */
    function renderBrowserAutoApproveHint() {
        const shortcutBar = document.querySelector('[data-role="composer-shortcut-bar"]');
        if (!(shortcutBar instanceof HTMLElement)) return;
        const ccButton = shortcutBar.querySelector('[data-i18n="ccTaskFlow"]');
        let hint = shortcutBar.querySelector('[data-role="browser-auto-approve-hint"]');
        const shouldShow = browserAutoApproveState.supported && !browserAutoApproveState.enabled;
        if (!shouldShow) {
            if (hint) hint.remove();
            return;
        }
        if (!(hint instanceof HTMLElement)) {
            hint = document.createElement('button');
            hint.type = 'button';
            hint.className = 'composer-shortcut-button composer-shortcut-button--hint';
            hint.dataset.role = 'browser-auto-approve-hint';
            hint.dataset.i18n = 'browserAutoApproveHint';
            hint.dataset.i18nTitle = 'browserAutoApproveHintTitle';
            hint.addEventListener('click', openBrowserAutoApproveConfirm);
            if (ccButton && ccButton.parentNode === shortcutBar) {
                ccButton.insertAdjacentElement('afterend', hint);
            } else {
                shortcutBar.insertBefore(hint, shortcutBar.firstChild);
            }
        }
        hint.textContent = t('browserAutoApproveHint');
        hint.title = t('browserAutoApproveHintTitle');
    }

    /** 弹出「免去浏览器确认」二次确认对话框，说明开启原因后再由用户确认。 */
    function openBrowserAutoApproveConfirm() {
        if (!(browserAutoApproveDialogEl instanceof HTMLDialogElement)) {
            // 兜底：对话框不可用时退回直接开启，避免功能完全不可达。
            post({ type: 'browser/enableAutoApprove' });
            return;
        }
        applyI18n();
        if (!browserAutoApproveDialogEl.open) browserAutoApproveDialogEl.showModal();
    }

    /** 关闭「免去浏览器确认」对话框；confirmed 为真时请求宿主开启相关设置。 */
    function closeBrowserAutoApproveConfirm(confirmed) {
        if (browserAutoApproveDialogEl instanceof HTMLDialogElement && browserAutoApproveDialogEl.open) {
            browserAutoApproveDialogEl.close();
        }
        if (confirmed) post({ type: 'browser/enableAutoApprove' });
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
     * 将默认上下文附件（仅展示、不实际发送）转换为已激活的真实附件。
     *
     * 默认（source === 'default'）的当前活动编辑器附件以虚线 + 加号 pill 形式预览，
     * 不会进入发送 payload。用户点击该 pill 后调用本函数，把它提升为 manual，
     * 此时 pill 转为实线、显示移除按钮，并随下一次 user/send 一起发送。
     *
     * @param {string} id 附件 ID。
     */
    function activateDefaultAttachment(id) {
        const item = composerState.attachments.find((entry) => entry.id === id);
        if (!item || item.source !== 'default') return;
        item.source = 'manual';
        composerState.defaultAttachmentPaths.delete(item.path);
        renderAttachments();
    }

    /**
     * 渲染 Copilot Chat 风格的附件 pill 列表。
     *
     * 视觉规则：
     * - source === 'default'：虚线边框 + 前置 “+” 图标，整体手型光标，
     *   不渲染右侧 × 按钮，点击/Enter/Space 触发 activateDefaultAttachment。
     * - 其它来源（manual / drop / paste）：实线 pill，显示 × 移除按钮。
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
            const isDefault = item.source === 'default';
            if (isDefault) {
                pill.classList.add('attachment-pill--pending');
                pill.setAttribute('role', 'button');
                pill.tabIndex = 0;
            }

            if (isDefault) {
                const prefix = document.createElement('span');
                prefix.className = 'attachment-pill__prefix';
                prefix.textContent = '+';
                prefix.setAttribute('aria-hidden', 'true');
                pill.appendChild(prefix);
            }

            const icon = document.createElement('span');
            icon.className = 'attachment-pill__icon';
            icon.textContent = fileBadge(item.name || item.path);
            pill.appendChild(icon);

            const label = document.createElement('span');
            label.className = 'attachment-pill__label';
            label.textContent = item.name + attachmentRangeLabel(item);
            pill.appendChild(label);

            if (isDefault) {
                const activate = () => activateDefaultAttachment(item.id);
                pill.addEventListener('click', () => {
                    activate();
                });
                pill.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activate();
                    }
                });
            } else {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'attachment-pill__remove';
                remove.textContent = '×';
                remove.title = tf('removeAttachment', { name: item.name });
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    removeAttachment(item.id);
                });
                pill.appendChild(remove);
            }

            attachmentsEl.appendChild(pill);
        }
    }

    /**
     * 在普通 / 专家模型可选项列表中查找指定 key（providerId/modelId）的显示名称。
     *
     * 顶部模型条只展示 displayName 一栏，没有 provider 名前缀，避免顶部信息条太挤。
     *
     * @param {{ providerId: string; modelId: string; displayName: string }[]} list 模型列表。
     * @param {string} key 形如 `providerId/modelId` 的 key。
     * @returns {string} 显示名称；未匹配到时返回 key 本身。
     */
    function findModelDisplayNameByKey(list, key) {
        if (!key) return '';
        for (const m of list || []) {
            if (m.providerId + '/' + m.modelId === key) return m.displayName || key;
        }
        return key;
    }

    /**
     * 渲染顶部模型条上的「普通：xxx · 专家：yyy」名称。
     *
     * 数据来自 composerState.modelOptions / expertModelOptions 与 currentModelKey /
     * expertEnabled+expertModelId；任何一项变化时都应调用本函数刷新展示。
     */
    function renderModelsBar() {
        const normalName = findModelDisplayNameByKey(composerState.modelOptions, composerState.currentModelKey) || t('noModelConfigured');
        const normalTitle = composerState.currentModelKey || '';
        if (normalModelNameEl instanceof HTMLElement) {
            normalModelNameEl.textContent = normalName;
            normalModelNameEl.title = normalTitle;
        }
        if (composerNormalChipNameEl instanceof HTMLElement) {
            composerNormalChipNameEl.textContent = normalName;
        }
        if (composerNormalChipEl instanceof HTMLElement) {
            composerNormalChipEl.title = normalTitle || t('openModelPicker');
        }

        let expertLabel = '—';
        let expertTitle = '';
        let expertOff = true;
        if (composerState.expertEnabled && composerState.expertModelId) {
            expertLabel = composerState.expertModelId;
            for (const m of composerState.expertModelOptions || []) {
                const key = m.providerId + '/' + m.modelId;
                if (key === composerState.expertModelId || m.modelId === composerState.expertModelId) {
                    expertLabel = m.displayName || m.modelId;
                    break;
                }
            }
            expertTitle = composerState.expertModelId;
            expertOff = false;
        } else if (composerState.expertAvailable) {
            // 配置快照尚未到达、但扩展端已广播专家可用时，退回到 availability 报来的名字。
            expertLabel = composerState.expertAvailableModelName || expertLabel;
            expertTitle = composerState.expertAvailableModelName || '';
            expertOff = !composerState.expertAvailableModelName;
        }
        if (expertOff) {
            // 专家未配置：header 显示「未配置」占位，标题给出引导文案。
            expertLabel = t('expertUnavailable');
            expertTitle = t('expertNotConfiguredToast');
        }
        if (expertModelNameEl instanceof HTMLElement) {
            expertModelNameEl.textContent = expertLabel;
            expertModelNameEl.title = expertTitle;
            expertModelNameEl.classList.toggle('chat-models__name--off', expertOff);
        }
        if (composerExpertChipNameEl instanceof HTMLElement) {
            composerExpertChipNameEl.textContent = expertLabel;
            composerExpertChipNameEl.classList.toggle('composer-model-chip__name--off', expertOff);
        }
        if (composerExpertChipEl instanceof HTMLElement) {
            composerExpertChipEl.title = expertTitle || t('openModelPicker');
        }
    }

    /**
     * 渲染模型选择弹窗中「普通任务模型」radio 列表。
     *
     * 由 models/snapshot 或 model/options 协议触发；选中项与 composerState.currentModelKey
     * 一致，未选中时所有 radio 都不选。
     */
    function renderModelPickerNormalList() {
        if (!(modelPickerNormalSelectEl instanceof HTMLSelectElement)) return;
        modelPickerNormalSelectEl.innerHTML = '';
        const models = composerState.modelOptions || [];
        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('noModelConfigured');
            opt.disabled = true;
            opt.selected = true;
            modelPickerNormalSelectEl.appendChild(opt);
            return;
        }
        for (const model of models) {
            const key = model.providerId + '/' + model.modelId;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = model.providerName + ': ' + model.displayName;
            opt.title = key;
            if (key === composerState.currentModelKey) opt.selected = true;
            modelPickerNormalSelectEl.appendChild(opt);
        }
    }

    /**
     * 渲染模型选择弹窗中「专家任务模型」radio 列表。
     *
     * 第一项固定为「关闭专家」（value 为空字符串），其余项使用 modelId 作为 value，
     * 选中规则与 composerState.expertEnabled + expertModelId 一致。
     */
    function renderModelPickerPlanList() {
        if (!(modelPickerPlanSelectEl instanceof HTMLSelectElement)) return;
        modelPickerPlanSelectEl.innerHTML = '';

        const closeOpt = document.createElement('option');
        closeOpt.value = '';
        closeOpt.textContent = t('planNotConfigured');
        if (!composerState.planEnabled || !composerState.planModelId) closeOpt.selected = true;
        modelPickerPlanSelectEl.appendChild(closeOpt);

        for (const model of composerState.planModelOptions || []) {
            const key = model.providerId + '/' + model.modelId;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = model.providerName + ': ' + model.displayName;
            opt.title = key;
            if (composerState.planEnabled && (key === composerState.planModelId || model.modelId === composerState.planModelId)) {
                opt.selected = true;
            }
            modelPickerPlanSelectEl.appendChild(opt);
        }
    }

    function renderModelPickerReviewList() {
        if (!(modelPickerReviewSelectEl instanceof HTMLSelectElement)) return;
        modelPickerReviewSelectEl.innerHTML = '';

        const closeOpt = document.createElement('option');
        closeOpt.value = '';
        closeOpt.textContent = t('reviewNotConfigured');
        if (!composerState.reviewEnabled || !composerState.reviewModelId) closeOpt.selected = true;
        modelPickerReviewSelectEl.appendChild(closeOpt);

        for (const model of composerState.reviewModelOptions || []) {
            const key = model.providerId + '/' + model.modelId;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = model.providerName + ': ' + model.displayName;
            opt.title = key;
            if (composerState.reviewEnabled && (key === composerState.reviewModelId || model.modelId === composerState.reviewModelId)) {
                opt.selected = true;
            }
            modelPickerReviewSelectEl.appendChild(opt);
        }
    }

    function renderModelPickerCompactionList() {
        if (!(modelPickerCompactionSelectEl instanceof HTMLSelectElement)) return;
        modelPickerCompactionSelectEl.innerHTML = '';

        const closeOpt = document.createElement('option');
        closeOpt.value = '';
        closeOpt.textContent = t('compactionNotConfigured');
        if (!composerState.compactionEnabled || !composerState.compactionModelId) closeOpt.selected = true;
        modelPickerCompactionSelectEl.appendChild(closeOpt);

        for (const model of composerState.compactionModelOptions || []) {
            const key = model.providerId + '/' + model.modelId;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = model.providerName + ': ' + model.displayName;
            opt.title = key;
            if (composerState.compactionEnabled && (key === composerState.compactionModelId || model.modelId === composerState.compactionModelId)) {
                opt.selected = true;
            }
            modelPickerCompactionSelectEl.appendChild(opt);
        }
    }

    function renderModelPickerExpertList() {
        if (!(modelPickerExpertSelectEl instanceof HTMLSelectElement)) return;
        modelPickerExpertSelectEl.innerHTML = '';

        const closeOpt = document.createElement('option');
        closeOpt.value = '';
        closeOpt.textContent = t('expertNotConfigured');
        if (!composerState.expertEnabled || !composerState.expertModelId) closeOpt.selected = true;
        modelPickerExpertSelectEl.appendChild(closeOpt);

        for (const model of composerState.expertModelOptions || []) {
            const key = model.providerId + '/' + model.modelId;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = model.providerName + ': ' + model.displayName;
            opt.title = key;
            if (composerState.expertEnabled && (key === composerState.expertModelId || model.modelId === composerState.expertModelId)) {
                opt.selected = true;
            }
            modelPickerExpertSelectEl.appendChild(opt);
        }
    }

    /**
     * 顶部模型条与模型选择弹窗的统一刷新入口。
     *
     * 取代旧的 renderModelOptions / renderExpertModelOptions（基于下拉 select 的版本）。
     */
    function renderModelOptions() {
        renderModelsBar();
        renderModelPickerNormalList();
    }

    /**
     * 顶部模型条与模型选择弹窗的专家栏刷新入口。
     */
    function renderExpertModelOptions() {
        renderModelsBar();
        renderModelPickerExpertList();
    }

    /**
     * 解析弹窗中已选中的普通 + 专家 radio，提取要下发的 providerId/modelId 对。
     *
     * 专家 value 为空字符串时返回 null（语义为「关闭专家」）。
     *
     * @returns {{ normal: { providerId: string; modelId: string } | null; expert: { providerId: string; modelId: string } | null }}
     */
    function readModelPickerSelection() {
        let normal = null;
        if (modelPickerNormalSelectEl instanceof HTMLSelectElement && modelPickerNormalSelectEl.value) {
            const value = modelPickerNormalSelectEl.value;
            const separator = value.indexOf('/');
            if (separator > 0) {
                normal = { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
            }
        }
        let expert = null;
        if (modelPickerExpertSelectEl instanceof HTMLSelectElement && modelPickerExpertSelectEl.value) {
            const value = modelPickerExpertSelectEl.value;
            const separator = value.indexOf('/');
            if (separator > 0) {
                expert = { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
            }
        }
        let plan = null;
        if (modelPickerPlanSelectEl instanceof HTMLSelectElement && modelPickerPlanSelectEl.value) {
            const value = modelPickerPlanSelectEl.value;
            const separator = value.indexOf('/');
            if (separator > 0) {
                plan = { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
            }
        }
        let review = null;
        if (modelPickerReviewSelectEl instanceof HTMLSelectElement && modelPickerReviewSelectEl.value) {
            const value = modelPickerReviewSelectEl.value;
            const separator = value.indexOf('/');
            if (separator > 0) {
                review = { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
            }
        }
        let compaction = null;
        if (modelPickerCompactionSelectEl instanceof HTMLSelectElement && modelPickerCompactionSelectEl.value) {
            const value = modelPickerCompactionSelectEl.value;
            const separator = value.indexOf('/');
            if (separator > 0) {
                compaction = { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
            }
        }
        return { normal, expert, plan, review, compaction };
    }

    /**
     * 打开模型选择弹窗：先刷新两栏 radio 列表，再调用原生 dialog.showModal。
     */
    function openModelPicker() {
        if (!(modelPickerDialogEl instanceof HTMLDialogElement)) return;
        renderModelPickerNormalList();
        renderModelPickerExpertList();
        renderModelPickerPlanList();
        renderModelPickerReviewList();
        renderModelPickerCompactionList();
        if (!modelPickerDialogEl.open) modelPickerDialogEl.showModal();
    }

    /**
     * 弹出任务流恢复对话框，展示恢复出的标题/摘要/进度。
     *
     * 由扩展端在 webview/ready 后下发 taskFlow/restorePrompt 触发；用户三选一
     * （继续 / 清除 / 稍后）后通过 taskFlow/restoreChoice 回传扩展。
     *
     * @param {{title?: string, summary?: string, progress?: string}} payload 恢复出的任务流信息。
     */
    function showTaskRestoreDialog(payload) {
        if (!(taskRestoreDialogEl instanceof HTMLDialogElement)) return;
        var info = payload || {};
        if (taskRestoreSummaryEl) taskRestoreSummaryEl.textContent = info.summary || t('restoreDesc');
        if (taskRestoreNameEl) taskRestoreNameEl.textContent = info.title || '';
        if (taskRestoreProgressEl) taskRestoreProgressEl.textContent = info.progress || '';
        if (!taskRestoreDialogEl.open) taskRestoreDialogEl.showModal();
    }

    /**
     * 关闭任务流恢复对话框并回传用户选择。
     *
     * @param {'continue' | 'clear' | 'dismiss'} choice 用户选择。
     */
    function resolveTaskRestore(choice) {
        if (taskRestoreDialogEl instanceof HTMLDialogElement && taskRestoreDialogEl.open) {
            taskRestoreDialogEl.close();
        }
        post({ type: 'taskFlow/restoreChoice', choice: choice });
    }

    /**
     * 关闭模型选择弹窗。原生 dialog.close 同时会处理键盘焦点归还。
     */
    function closeModelPicker() {
        if (modelPickerDialogEl instanceof HTMLDialogElement && modelPickerDialogEl.open) {
            modelPickerDialogEl.close();
        }
    }

    function openSessions() {
        if (!(sessionListDialogEl instanceof HTMLElement)) return;
        if (sessionListContentEl) {
            sessionListContentEl.innerHTML = '<p class="session-panel__loading" data-i18n="sessionsLoading">Loading…</p>';
        }
        sessionListDialogEl.setAttribute('aria-hidden', 'false');
        post({ type: 'sessions/list' });
    }

    function closeSessionList() {
        if (sessionListDialogEl instanceof HTMLElement) {
            sessionListDialogEl.setAttribute('aria-hidden', 'true');
        }
    }

    function renderSessionList(sessions) {
        if (!sessionListContentEl) return;
        if (!sessions || sessions.length === 0) {
            sessionListContentEl.innerHTML = '<p class="session-list__empty">No past conversations found.</p>';
            return;
        }
        var now = Date.now();
        var groups = [];
        var groupMap = {};
        sessions.forEach(function (s) {
            var label = getSessionDateGroup(s.lastModified, now);
            if (!groupMap[label]) {
                groupMap[label] = [];
                groups.push(label);
            }
            groupMap[label].push(s);
        });
        var html = '';
        groups.forEach(function (label) {
            html += '<div class="session-list__group"><div class="session-list__group-label">' + escapeHtml(label) + '</div>';
            groupMap[label].forEach(function (s) {
                var timeAgo = formatTimeAgo(s.lastModified, now);
                var branch = s.gitBranch ? '<span class="session-list__branch">' + escapeHtml(s.gitBranch) + '</span>' : '';
                html += '<button type="button" class="session-list__item" data-session-id="' + escapeHtml(s.sessionId) + '">'
                    + '<span class="session-list__dot"></span>'
                    + '<span class="session-list__summary">' + escapeHtml(s.summary) + '</span>'
                    + '<span class="session-list__meta">' + branch + '<span class="session-list__time">' + escapeHtml(timeAgo) + '</span></span>'
                    + '</button>';
            });
            html += '</div>';
        });
        sessionListContentEl.innerHTML = html;
        sessionListContentEl.querySelectorAll('.session-list__item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var sid = btn.getAttribute('data-session-id');
                if (sid) {
                    post({ type: 'session/resume', sessionId: sid });
                    closeSessionList();
                }
            });
        });
    }

    function getSessionDateGroup(ts, now) {
        var d = new Date(ts);
        var n = new Date(now);
        var dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var nDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
        var diff = nDay - dDay;
        if (diff === 0) return 'Today';
        if (diff === 86400000) return 'Yesterday';
        if (diff < 7 * 86400000) return 'This week';
        if (diff < 30 * 86400000) return 'This month';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function formatTimeAgo(ts, now) {
        var diff = Math.floor((now - ts) / 1000);
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function submitModelPicker() {
        const selection = readModelPickerSelection();
        if (selection.normal) {
            composerState.currentModelKey = selection.normal.providerId + '/' + selection.normal.modelId;
        }
        composerState.expertEnabled = !!selection.expert;
        composerState.expertModelId = selection.expert ? (selection.expert.providerId + '/' + selection.expert.modelId) : '';
        composerState.planEnabled = !!selection.plan;
        composerState.planModelId = selection.plan ? (selection.plan.providerId + '/' + selection.plan.modelId) : '';
        composerState.reviewEnabled = !!selection.review;
        composerState.reviewModelId = selection.review ? (selection.review.providerId + '/' + selection.review.modelId) : '';
        composerState.compactionEnabled = !!selection.compaction;
        composerState.compactionModelId = selection.compaction ? (selection.compaction.providerId + '/' + selection.compaction.modelId) : '';
        renderModelsBar();
        post({ type: 'models/applyPair', normal: selection.normal, expert: selection.expert, plan: selection.plan, review: selection.review, compaction: selection.compaction });
        closeModelPicker();
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
     * 将模型弹窗里的缓存时长下拉框同步为 composerState.cacheTtl 当前值。
     */
    function renderCacheTtlSelect() {
        if (!(modelPickerCacheTtlSelectEl instanceof HTMLSelectElement)) return;
        const ttl = composerState.cacheTtl === '5m' || composerState.cacheTtl === '1h' ? composerState.cacheTtl : 'default';
        modelPickerCacheTtlSelectEl.value = ttl;
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
    * 同时驱动输入区上方的全局生成中指示器 (.chat-global-pending) 与输入框自身
    * 的运行中动效：借鉴 VS Code/Copilot Chat 在请求执行期间让输入框边缘保持
    * 轻量动态高亮的交互反馈，用户无需盯着消息区也能知道当前回合仍在运行。
    *
     * 模型从开始响应到完成期间持续显示三点动画；模型输出过程中也不会消失，
     * 完全由 pending → !pending 状态切换控制。
     *
     * @param {boolean} running 当前聊天是否正在生成响应。
     */
    function setChatRunning(running) {
        composerState.chatRunning = !!running;
        const composerBox = document.querySelector('.composer-box');
        if (composerShellEl instanceof HTMLElement) {
            composerShellEl.classList.toggle('chat-input--running', composerState.chatRunning);
            composerShellEl.dataset.running = composerState.chatRunning ? 'true' : 'false';
        }
        if (composerBox instanceof HTMLElement) {
            composerBox.classList.toggle('composer-box--running', composerState.chatRunning);
            composerBox.dataset.running = composerState.chatRunning ? 'true' : 'false';
        }
        if (globalPendingEl instanceof HTMLElement) {
            globalPendingEl.classList.toggle('chat-global-pending--visible', composerState.chatRunning);
            globalPendingEl.setAttribute('aria-hidden', composerState.chatRunning ? 'false' : 'true');
            globalPendingEl.setAttribute('aria-label', t('loading'));
        }
        // 运行中禁用：顶部模型选择 / 权限模式选择，以及输入框下方的专家模型
        // 选择和 CC 任务流按钮，避免在响应过程中误触发切换/重启或弹出面板。
        applyRunningDisabledControls(composerState.chatRunning);
        if (tokenMeterWrapEl instanceof HTMLElement) {
            tokenMeterWrapEl.classList.toggle('is-disabled', composerState.chatRunning || composerState.compacting);
            if (composerState.chatRunning || composerState.compacting) closeTokenMeterPopover();
        }
        if (!(sendEl instanceof HTMLButtonElement)) return;
        sendEl.textContent = composerState.chatRunning ? '■' : '↑';
        sendEl.title = composerState.chatRunning ? t('stopResponse') : t('sendMessage');
        sendEl.setAttribute('aria-label', composerState.chatRunning ? t('stopResponse') : t('sendMessage'));
        sendEl.dataset.mode = composerState.chatRunning ? 'stop' : 'send';
    }

    function setChatPendingFromMessage(pending) {
        setChatRunning(composerState.backendRunning || !!pending);
    }

    /**
     * 运行中禁用底部交互控件：模型选择、权限模式选择、专家模型选择、CC 任务流按钮。
     *
     * 通过原生 `disabled` 属性禁止点击和聚焦，同时给容器加 `is-running-disabled`
     * 标记，便于 CSS 在需要时进一步降低视觉强度。
     *
     * @param {boolean} running 是否运行中。
     */
    function applyRunningDisabledControls(running) {
        const selectors = [
            '[data-role="model-select"]',
            '[data-role="permission-mode-select"]',
            '[data-role="expert-model-select"]',
            '[data-role="composer-shortcut-bar"] .composer-shortcut-button'
        ];
        for (const sel of selectors) {
            const nodes = document.querySelectorAll(sel);
            nodes.forEach(node => {
                if (node instanceof HTMLButtonElement || node instanceof HTMLSelectElement || node instanceof HTMLInputElement) {
                    node.disabled = !!running;
                }
                if (node instanceof HTMLElement) {
                    node.classList.toggle('is-running-disabled', !!running);
                }
            });
        }
    }

    /**
     * 为文本输入元素安装「回车发送」护栏，规避 Mac 中文输入用回车选字时误发送。
     *
     * 背景：macOS 简体拼音等输入法会逐字提交（compositionend 提前触发），候选词窗口仍
     * 可能开着，但 DOM 与 isComposing 都给不出「候选窗开启」信号，单看合成态无法区分
     * 「选字回车」与「发送回车」。实测用户翻页选字的操作序列是：先按方向键移动候选高亮、
     * 再按回车确认。据此用方向键状态机识别：按过方向键后紧跟的回车判为「选字确认」，
     * 不发送并复位；按下任何非方向键则复位状态，使后续回车恢复正常发送语义。
     *
     * @param {Element|null} el 目标输入元素（textarea/input）。
     * @param {() => void} onSend 判定为真实发送意图时执行的回调。
     * @returns {(event: KeyboardEvent) => void} 传入 keydown 事件进行处理。
     */
    function installImeEnterGuard(el, onSend) {
        // 最近一次 keydown 是否为方向键：用于识别「方向键选字 → 回车确认」序列。
        let arrowPressed = false;
        const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        return (event) => {
            // 合成态内的回车始终用于选字/确认，直接放行默认行为、不发送。
            if (event.isComposing || event.keyCode === 229) return;
            if (arrowKeys.indexOf(event.key) !== -1) {
                // 记录方向键，等待其后是否紧跟回车（典型的翻页选字动作）。
                arrowPressed = true;
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                if (arrowPressed) {
                    // 紧跟方向键的回车判为「选字确认」：不发送，并复位状态。
                    arrowPressed = false;
                    return;
                }
                event.preventDefault();
                onSend();
                return;
            }
            // 其它任意按键都复位方向键状态，使后续回车恢复正常发送语义。
            arrowPressed = false;
        };
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
        renderTaskFlowTodoPanel();
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
     * 判断任意可滚动元素当前是否处于"贴近自身底部"状态。
     *
     * 用于工具卡片内部的滚动容器（例如 .toolResultMarkdown_ZUQaOA、
     * .toolResultPre_ZUQaOA、.expertToolStream_07S1Yg、ExpertPanel 事件列表），
     * 它们各自有独立的 max-height + overflow:auto。在追加新内容前调用，
     * 记录用户当前是否在跟随；追加后再据此决定是否把 scrollTop 写到 scrollHeight。
     *
     * 若元素未启用滚动（scrollHeight 不超出 clientHeight），同样视为"在底部"，
     * 这样后续追加超出范围时自然进入跟随模式。
     *
     * @param {HTMLElement | null | undefined} el 目标可滚动容器。
     * @param {number} [threshold] 距离底部的像素阈值，默认 32px。
     * @returns {boolean} 是否处于贴近底部状态；元素为空时返回 true（默认跟随）。
     */
    function isElementScrolledNearBottom(el, threshold) {
        if (!(el instanceof HTMLElement)) return true;
        var th = typeof threshold === 'number' ? threshold : 32;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) <= th;
    }

    /**
     * 仅在用户原本就贴近底部时，将容器的 scrollTop 拉到 scrollHeight，
     * 实现"跟随尾部"的滚动体验，避免向上回看时被新内容打断。
     *
     * @param {HTMLElement | null | undefined} el 目标可滚动容器。
     * @param {boolean} wasAtBottom 追加内容**之前**该容器是否贴近底部。
     */
    function scrollElementToBottomIfNeeded(el, wasAtBottom) {
        if (!(el instanceof HTMLElement)) return;
        if (!wasAtBottom) return;
        el.scrollTop = el.scrollHeight;
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
        return wrapper;
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

        // 占位符保护：行内代码、Markdown 链接/图片、纯文本 URL 都先抽出来，
        // 避免随后强调/斜体等正则吞掉 URL 里的下划线、星号等字符。
        var placeholders = [];
        function stash(html) {
            var key = ' PH' + placeholders.length + ' ';
            placeholders.push(html);
            return key;
        }

        // 行内代码 `code`
        // 若整段 code 就是一个 URL，则外层再包一层 <a>，保留 code 样式同时支持点击。
        escaped = escaped.replace(/`([^`]+)`/g, function (_, code) {
            var trimmed = code.trim();
            var m = trimmed.match(/^(https?:\/\/[^\s<]+|www\.[^\s<]+)$/i);
            if (m) {
                var raw = m[1];
                var href = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
                return stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer"><code>' + code + '</code></a>');
            }
            return stash('<code>' + code + '</code>');
        });
        // 图片 ![alt](url)
        escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_, alt, url) {
            return stash('<img src="' + url + '" alt="' + alt + '">');
        });
        // 链接 [text](url)
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, url) {
            return stash('<a href="' + url + '">' + t + '</a>');
        });
        // 纯文本 URL 自动识别（http/https 以及裸 www.）
        escaped = escaped.replace(/(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/gi, function (raw) {
            var url = raw;
            var trail = '';
            // 句末常见标点不应是 URL 的一部分；) 仅在不成对时剥离，兼容 Wikipedia 式链接
            while (url.length > 0) {
                var last = url.charAt(url.length - 1);
                if (last === '.' || last === ',' || last === '!' || last === '?') {
                    trail = last + trail;
                    url = url.slice(0, -1);
                    continue;
                }
                if (last === ')') {
                    var opens = (url.match(/\(/g) || []).length;
                    var closes = (url.match(/\)/g) || []).length;
                    if (closes > opens) {
                        trail = last + trail;
                        url = url.slice(0, -1);
                        continue;
                    }
                }
                break;
            }
            var href = /^https?:\/\//i.test(url) ? url : 'http://' + url;
            return stash('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + '</a>') + trail;
        });

        // 加粗 **text** 或 __text__
        // 注意：__ 仅在两侧非单词字符时才识别为强调，避免吞掉 snake_case 等标识符里的下划线
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/(^|[^A-Za-z0-9_])__(?=\S)([\s\S]+?\S)__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>');
        // 斜体 *text* 或 _text_
        escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/(^|[^A-Za-z0-9_])_(?=\S)([\s\S]+?\S)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');
        // 删除线 ~~text~~
        escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');

        // 还原占位符
        escaped = escaped.replace(/ PH(\d+) /g, function (_, idx) {
            return placeholders[Number(idx)];
        });
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
            return undefined;
        }
        return renderMarkdown(container, text);
    }

    function isHiddenChatToolSegment(segment) {
        if (!segment || segment.kind !== 'tool') return false;
        var name = (segment.tool && segment.tool.name) || segment.text || '';
        return name === 'Agent' || name === 'Task' || name === 'EnterPlanMode' || name === 'ExitPlanMode';
    }

    /** 以参考项目风格渲染一个 ChatSegment。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment ChatSegment 对象。
     */
    function appendSegment(container, segment) {
        if (!segment || isHiddenChatToolSegment(segment)) return;
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
        if (segment.kind === 'task') {
            appendTaskCard(container, segment);
            return;
        }
        // 文本内容走 Markdown 渲染（参考项目方式）
        appendText(container, segment.text || segment.sourceText || '');
    }

    /**
     * 渲染上游 CLI 任务事件（taskstarted / tasknotification）为一行紧凑卡片。
     *
     * 通过 segment.id（task:<taskid>）在 patchMessage 中合并同任务的两条事件，
     * 状态在 started → completed/failed/cancelled 间切换。
     *
     * @param {HTMLElement} container 消息内容容器。
     * @param {any} segment kind === 'task' 的 ChatSegment。
     */
    function appendTaskCard(container, segment) {
        var task = (segment && segment.task) || {};
        var status = task.status || 'unknown';
        var description = task.description || '';
        var taskType = task.taskType || '';

        var root = document.createElement('div');
        root.className = 'taskCard_07S1Yg taskCard-status-' + status;
        if (segment.id) root.dataset.segmentId = segment.id;
        root.dataset.taskStatus = status;

        var icon = document.createElement('span');
        icon.className = 'taskCardIcon_07S1Yg';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = pickTaskStatusIcon(status);

        var text = document.createElement('span');
        text.className = 'taskCardText_07S1Yg';
        text.textContent = description;

        var badge = document.createElement('span');
        badge.className = 'taskCardBadge_07S1Yg taskCardBadge-' + status;
        badge.textContent = pickTaskStatusLabel(status);

        root.appendChild(icon);
        root.appendChild(text);
        if (taskType) {
            var typeTag = document.createElement('span');
            typeTag.className = 'taskCardType_07S1Yg';
            typeTag.textContent = taskType;
            root.appendChild(typeTag);
        }
        root.appendChild(badge);

        container.appendChild(root);
    }

    /**
     * 选择任务状态对应的视觉图标。
     *
     * @param {string} status 任务状态。
     * @returns {string} 单字符图标。
     */
    function pickTaskStatusIcon(status) {
        switch (status) {
            case 'started': return '⏳';
            case 'completed': return '✓';
            case 'failed': return '✗';
            case 'cancelled': return '⊘';
            default: return '•';
        }
    }

    /**
     * 选择任务状态对应的可读标签。
     *
     * @param {string} status 任务状态。
     * @returns {string} 显示文本。
     */
    function pickTaskStatusLabel(status) {
        switch (status) {
            case 'started': return t('toolRunning');
            case 'completed': return t('toolSuccess');
            case 'failed': return t('toolFailed');
            case 'cancelled': return t('expertPanelStatusCancelled') || 'cancelled';
            default: return status;
        }
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
        var cachedMessage = cloneMessagesForCache([message])[0];
        if (cachedMessage && Array.isArray(cachedMessage.segments)) {
            cachedMessage.segments = cachedMessage.segments.filter(function (segment) { return !isHiddenChatToolSegment(segment); });
        }
        renderedMessagesCache.push(cachedMessage);
    }

    /** 将 patch 片段合并进本地缓存，确保语言切换可重绘最新内容。 */
    function cachePatchedMessage(id, segments, pending) {
        var target = renderedMessagesCache.find(function (item) { return item && item.id === id; });
        if (!target) return;
        if (typeof pending === 'boolean') target.pending = pending;
        var visibleSegments = Array.isArray(segments)
            ? segments.filter(function (segment) { return !isHiddenChatToolSegment(segment); })
            : [];
        if (!Array.isArray(visibleSegments) || visibleSegments.length === 0) return;
        target.segments = Array.isArray(target.segments) ? target.segments : [];
        visibleSegments.forEach(function (segment) {
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
        // 默认折叠：通过 is-collapsed class 控制
        root.className = 'root_ZUQaOA tool-status-' + status + ' tool-name-' + sanitizeToolClassName(name) + ' is-collapsed';
        if (segment.id) root.dataset.segmentId = segment.id;
        root.dataset.toolStatus = status;
        root.dataset.toolName = name;

        // 摘要行：作为按钮，点击切换展开/折叠
        var summary = document.createElement('button');
        summary.type = 'button';
        summary.className = 'toolSummary_ZUQaOA';
        summary.setAttribute('aria-expanded', 'false');

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

        // 展开/折叠指示箭头
        var chevron = document.createElement('span');
        chevron.className = 'toolChevron_ZUQaOA';
        chevron.textContent = '▸';
        chevron.setAttribute('aria-hidden', 'true');
        summary.appendChild(chevron);

        root.appendChild(summary);

        // 主体：按工具名分派渲染器
        var body = document.createElement('div');
        body.className = 'toolBody_ZUQaOA';
        renderToolBody(body, name, input, resultText, isError, tool, segment);
        if (name === 'TodoWrite' && input && Array.isArray(input.todos)) {
            updateClaudeTodoStatus(input.todos);
        }
        root.appendChild(body);

        // 点击摘要行切换展开/折叠
        summary.addEventListener('click', function () {
            var collapsed = root.classList.toggle('is-collapsed');
            summary.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });

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
        appendToolResultContent(wrap, resultText, isError);
        body.appendChild(wrap);
    }

    /**
     * 追加工具输出内容。
     *
     * 普通输出优先按 Markdown 渲染，让专家工具返回的标题、列表、表格、代码块等
     * 能和助手正文保持一致；错误输出仍保留纯文本 `pre`，避免错误栈或 XML 风格
     * 错误消息被 Markdown 规则误解析。
     *
     * 滚动行为：`.toolResultMarkdown_ZUQaOA` 自身有 `max-height + overflow:auto`，
     * 在流式 patch 阶段每次都会被整段 replaceChild 重建（新节点 scrollTop 默认 0，
     * 即"停在最顶"）。这里在挂载后将其 scrollTop 直接拉到 scrollHeight，让用户
     * 始终先看到最新输出，与终端 / 控制台跟随尾部的体验一致。
     *
     * @param {HTMLElement} wrap 工具输出外层容器。
     * @param {string} resultText 工具输出文本。
     * @param {boolean} isError 是否错误输出。
     */
    function appendToolResultContent(wrap, resultText, isError) {
        var text = String(resultText || '');
        if (isError) {
            appendToolResultPre(wrap, text);
            return;
        }
        var content = document.createElement('div');
        content.className = 'toolResultMarkdown_ZUQaOA';
        renderMarkdown(content, truncateLongText(text));
        wrap.appendChild(content);
        // 新节点默认 scrollTop=0；这里同步 + 下一帧再各拉一次到底，覆盖
        // Markdown 内异步内容（高亮、图片等）撑高布局后的二次跟随。
        content.scrollTop = content.scrollHeight;
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(function () {
                content.scrollTop = content.scrollHeight;
            });
        }
    }

    /**
     * 以纯文本 `pre` 追加工具输出，主要用于错误结果。
     *
     * 滚动行为：与 {@link appendToolResultContent} 相同——`.toolResultPre_ZUQaOA`
     * 有独立 `max-height + overflow:auto`，新建后跟随尾部更贴合用户期望
     * （错误日志最关键的一般是最后几行）。
     *
     * @param {HTMLElement} wrap 工具输出外层容器。
     * @param {string} text 待展示文本。
     */
    function appendToolResultPre(wrap, text) {
        var pre = document.createElement('pre');
        pre.className = 'toolResultPre_ZUQaOA';
        pre.textContent = truncateLongText(text);
        wrap.appendChild(pre);
        pre.scrollTop = pre.scrollHeight;
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(function () {
                pre.scrollTop = pre.scrollHeight;
            });
        }
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
            // running 用空字符串：实际的旋转 spinner 由 CSS 在
            // .tool-status-running .toolStatusIcon_ZUQaOA::before 上画
            case 'running': return '';
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
                appendLineWithLinks(container, lines[i]);
            }
        }
    }

    /**
     * 把一行用户原文按"纯文本 + 自动链接"的方式追加到容器里。
     * 仅识别 URL，不做其他 markdown 渲染，避免破坏用户输入的可视格式；
     * 全程通过 DOM API 设置 href / textContent，避免 HTML 注入。
     *
     * @param {HTMLElement} container 目标容器。
     * @param {string} line 单行文本（不含换行符）。
     */
    function appendLineWithLinks(container, line) {
        var urlRe = /(\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+)/gi;
        var lastIndex = 0;
        var match;
        while ((match = urlRe.exec(line)) !== null) {
            var raw = match[0];
            var trail = '';
            // 句末标点不应是 URL 的一部分；) 仅在不成对时剥离，兼容 Wikipedia 式链接
            while (raw.length > 0) {
                var last = raw.charAt(raw.length - 1);
                if (last === '.' || last === ',' || last === '!' || last === '?' || last === '；' || last === '，' || last === '。') {
                    trail = last + trail;
                    raw = raw.slice(0, -1);
                    continue;
                }
                if (last === ')') {
                    var opens = (raw.match(/\(/g) || []).length;
                    var closes = (raw.match(/\)/g) || []).length;
                    if (closes > opens) {
                        trail = last + trail;
                        raw = raw.slice(0, -1);
                        continue;
                    }
                }
                break;
            }
            if (match.index > lastIndex) {
                container.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
            }
            var a = document.createElement('a');
            a.href = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
            a.textContent = raw;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            container.appendChild(a);
            if (trail) container.appendChild(document.createTextNode(trail));
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < line.length) {
            container.appendChild(document.createTextNode(line.slice(lastIndex)));
        }
    }

    /**
     * 从 user 消息对象中提取可编辑的原始文本。
     *
     * 重发编辑框应尽量使用 `message.text` 中保存的完整 prompt；如果历史数据缺少
     * 该字段，则回退到 segments 内的文本内容，保证旧会话也能进入编辑态。
     *
     * @param {any} message 对应的 ChatMessage 对象。
     * @returns {string} 可放入 textarea 的原始文本。
     */
    function getUserMessageEditableText(message) {
        if (!message) return '';
        if (typeof message.text === 'string') return message.text;
        if (!Array.isArray(message.segments)) return '';
        var parts = [];
        for (var i = 0; i < message.segments.length; i++) {
            var segment = message.segments[i];
            var text = segment && (typeof segment.text === 'string' ? segment.text : segment.sourceText);
            if (typeof text === 'string' && text) parts.push(text);
        }
        return parts.join('\n');
    }

    /**
     * 调整重发编辑 textarea 高度，使多行文本直接展开显示。
     *
     * @param {HTMLTextAreaElement} textarea 重发编辑框。
     */
    function autoResizeResendEditor(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 88), 320) + 'px';
    }

    /**
     * 退出当前重发编辑态并恢复原消息气泡。
     */
    function closeActiveResendEditor() {
        if (!activeResendEditor) return;
        activeResendEditor.item.classList.remove('userMessageContainer_07S1Yg--editing');
        activeResendEditor.editor.remove();
        activeResendEditor.messageBubble.hidden = false;
        activeResendEditor.actions.hidden = false;
        activeResendEditor = null;
    }

    /**
     * 提交重发编辑框内容。
     *
     * 扩展端会按 id 截断该 user 消息及其后的上下文，再用这里提交的编辑文本开启
     * 新一轮发送；空白内容不提交，避免误删上下文。
     *
     * @param {any} message 待重发的 user 消息。
     * @param {HTMLTextAreaElement} textarea 重发编辑框。
     */
    function submitResendEditor(message, textarea) {
        var text = textarea.value.trim();
        if (!message || !message.id || !text) return;
        scrollAfterNextPendingAssistant = true;
        setChatRunning(true);
        closeActiveResendEditor();
        post({ type: 'user/resend', id: message.id, text: text });
    }

    /**
     * 打开 user 消息的就地重发编辑框。
     *
     * 点击原「重发」图标后，不再立即发送，而是把原气泡替换成多行 textarea；
     * 用户可修改文本，下方通过「发送」或「取消」图标完成操作。快捷键规则：
     * Enter 或 Ctrl+Enter / Cmd+Enter 提交，Shift+Enter 保留换行。
     *
     * @param {any} message 待重发的 user 消息。
     * @param {HTMLElement} item 当前消息外层容器。
     * @param {HTMLElement} messageBubble 原 user 气泡。
     * @param {HTMLElement} actions 原操作按钮栏。
     */
    function openResendEditor(message, item, messageBubble, actions) {
        if (!message || !message.id || !(item instanceof HTMLElement)) return;
        closeActiveResendEditor();

        var editor = document.createElement('div');
        editor.className = 'userMessageResendEditor_07S1Yg';

        var textarea = document.createElement('textarea');
        textarea.className = 'userMessageResendTextarea_07S1Yg';
        textarea.value = getUserMessageEditableText(message);
        textarea.setAttribute('aria-label', t('resendEditorAria'));
        textarea.spellcheck = false;

        var toolbar = document.createElement('div');
        toolbar.className = 'userMessageResendToolbar_07S1Yg';

        var sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'userMessageActionBtn_07S1Yg userMessageResendIcon_07S1Yg userMessageResendIcon_07S1Yg--send';
        sendBtn.title = t('resendConfirm');
        sendBtn.setAttribute('aria-label', t('resendConfirm'));
        sendBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.4 10.8 3.2 7.6 2.1 8.7l4.3 4.3 7.5-7.5-1.1-1.1z"/></svg>';

        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'userMessageActionBtn_07S1Yg userMessageResendIcon_07S1Yg';
        cancelBtn.title = t('resendCancel');
        cancelBtn.setAttribute('aria-label', t('resendCancel'));
        cancelBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.3 3.3 8 7l3.7-3.7 1 1L9 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L7 8 3.3 4.3z"/></svg>';

        sendBtn.addEventListener('click', function () { submitResendEditor(message, textarea); });
        cancelBtn.addEventListener('click', closeActiveResendEditor);
        textarea.addEventListener('input', function () { autoResizeResendEditor(textarea); });
        const resendImeGuard = installImeEnterGuard(textarea, function () {
            submitResendEditor(message, textarea);
        });
        textarea.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeActiveResendEditor();
                return;
            }
            if (event.shiftKey && event.key === 'Enter') return; // Shift+Enter 保留换行。
            // 其余按键交给护栏：跟踪方向键状态，识别「方向键选字 → 回车确认」。
            resendImeGuard(event);
        });

        toolbar.append(sendBtn, cancelBtn);
        editor.append(textarea, toolbar);
        messageBubble.hidden = true;
        actions.hidden = true;
        item.classList.add('userMessageContainer_07S1Yg--editing');
        item.insertBefore(editor, actions);
        activeResendEditor = { item: item, editor: editor, messageBubble: messageBubble, actions: actions };
        autoResizeResendEditor(textarea);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    /**
     * 构建 user 消息下方的操作按钮栏。
     *
    * 目前只包含一个"重发"按钮：点击时进入就地编辑态，由用户确认后再通过
    * `user/resend` 协议提交编辑后的文本。
     *
     * @param {any} message 对应的 ChatMessage 对象（需要其 id）。
    * @param {HTMLElement} item 当前消息外层容器。
    * @param {HTMLElement} messageBubble 当前 user 消息气泡。
     * @returns {HTMLElement} 操作按钮栏 DOM。
     */
    function buildUserActionsBar(message, item, messageBubble) {
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
            openResendEditor(message, item, messageBubble, actions);
        });
        actions.appendChild(resendBtn);

        return actions;
    }

    function assistantRouteLabel(route) {
        switch (route) {
            case 'expert': return 'EXPERT';
            case 'plan': return 'PLAN';
            case 'review': return 'REVIEW';
            case 'normal':
            default: return 'NORMAL';
        }
    }

    function assistantSourcePrefixText(message) {
        if (!message || message.role !== 'assistant') return '';
        var modelLabel = String(message.modelLabel || '').trim();
        if (!modelLabel) return '';
        return '[' + assistantRouteLabel(message.route || 'normal') + '][' + modelLabel + ']';
    }

    function assistantSourcePrefixTextFromItem(item) {
        if (!(item instanceof HTMLElement) || item.dataset.role !== 'assistant') return '';
        var modelLabel = String(item.dataset.modelLabel || '').trim();
        if (!modelLabel) return '';
        return '[' + assistantRouteLabel(item.dataset.route || 'normal') + '][' + modelLabel + ']';
    }

    function createAssistantSourceLabel(text) {
        if (!text) return null;
        var label = document.createElement('div');
        label.className = 'assistantSourcePrefix_07S1Yg';
        label.textContent = text;
        return label;
    }

    function prependAssistantSourceLabel(target, text) {
        if (!target || !text) return;
        var label = createAssistantSourceLabel(text);
        if (!label) return;
        target.insertBefore(label, target.firstChild);
    }

    function appendSegmentWithInlinePrefix(container, segment, prefixState) {
        appendSegment(container, segment);
        if (!prefixState || prefixState.used || !prefixState.text || !segment || isHiddenChatToolSegment(segment)) return;
        if (segment.kind === 'usage' || segment.kind === 'task' || segment.kind === 'image') return;
        var target = container.lastElementChild;
        if (!(target instanceof HTMLElement)) return;
        prependAssistantSourceLabel(target, prefixState.text);
        prefixState.used = true;
    }

    function contentAlreadyHasAssistantSourceLabel(content) {
        return !!(content && content.querySelector && content.querySelector('.assistantSourcePrefix_07S1Yg'));
    }

    function appendSegmentWithPatchPrefix(item, content, segment, forcePrefix) {
        var prefixText = '';
        if (forcePrefix) {
            prefixText = assistantSourcePrefixTextFromItem(item);
        } else if (!contentAlreadyHasAssistantSourceLabel(content)) {
            prefixText = assistantSourcePrefixTextFromItem(item);
        }
        appendSegmentWithInlinePrefix(content, segment, { text: prefixText, used: false });
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
        // 把 pending 状态同步到 DOM，便于 CSS 在助手"消息流式完成"时为最后一段
        // 加上时间线结束点（见 style.css 末尾 [data-pending] 选择器）。
        if (message.role === 'assistant') {
            item.dataset.pending = message.pending ? 'true' : 'false';
            item.dataset.route = message.route || 'normal';
            if (message.modelLabel) item.dataset.modelLabel = String(message.modelLabel);
        }
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
            item.appendChild(buildUserActionsBar(message, item, userMsg));
            messagesEl.appendChild(item);
            // 若当前发送动作正在等待 pending assistant 占位，则不要在 user 消息阶段
            // 抢先滚动；最终滚动交给 pending 动画渲染后的 assistant 分支处理。
            if (!scrollAfterNextPendingAssistant) {
                // user 消息是用户刚刚发出的：无论之前在哪儿，都强制滚到底让用户
                // 立即看到自己刚发的内容（重发场景也走这条路径，因此不需要额外
                // 依赖 forceScrollToBottomOnce flag）。
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if (message.role === 'assistant') setChatPendingFromMessage(!!message.pending);
            return;
        }

        // Assistant 消息内容
        var content = document.createElement('div');
        content.className = 'assistantMessage_07S1Yg';
        var prefixState = { text: assistantSourcePrefixText(message), used: false };
        if (message.segments) {
            for (var _s2 = 0; _s2 < message.segments.length; _s2++) {
                var _seg = message.segments[_s2];
                appendSegmentWithInlinePrefix(content, _seg, prefixState);
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
        if (message.role === 'assistant') setChatPendingFromMessage(!!message.pending);
    }

    /**
     * 兼容旧调用点：原本会在 assistant 消息内部插入 .chat-pending-indicator
     * 三点动画，但只在"还没有任何内容"时才显示，模型一旦开始输出就会消失。
     *
     * 现已改为由输入框上方的全局 .chat-global-pending 统一展示生成中状态，
     * 模型整个输出期间常驻显示。为避免视觉重复，这里只负责清理可能残留
     * 在消息内部的旧 indicator，不再向消息容器追加任何节点。
     *
     * @param {HTMLElement} content 消息内容容器。
     * @param {any} _message 兼容旧签名，未使用。
     */
    function renderPendingIndicator(content, _message) {
        const existing = content && content.querySelector ? content.querySelector('.chat-pending-indicator') : null;
        if (existing) existing.remove();
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
        if (item.dataset.role === 'assistant') {
            setChatPendingFromMessage(!!pending);
            item.dataset.pending = pending ? 'true' : 'false';
        }
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
                    // 在替换前记录工具卡片的展开/折叠状态，避免状态刷新时折叠状态被重置。
                    var wasToolExpanded = existing.classList && existing.classList.contains('root_ZUQaOA')
                        && !existing.classList.contains('is-collapsed');
                    var replacement = document.createElement('div');
                    replacement.style.display = 'contents';
                    var hadSourceLabel = !!(existing.querySelector && existing.querySelector('.assistantSourcePrefix_07S1Yg'));
                    appendSegmentWithPatchPrefix(item, replacement, segment, hadSourceLabel);
                    var newNode = replacement.firstChild;
                    if (newNode) {
                        if (wasToolExpanded && newNode instanceof HTMLElement && newNode.classList.contains('root_ZUQaOA')) {
                            newNode.classList.remove('is-collapsed');
                            var sumBtn = newNode.querySelector(':scope > .toolSummary_ZUQaOA');
                            if (sumBtn) sumBtn.setAttribute('aria-expanded', 'true');
                        }
                        content.replaceChild(newNode, existing);
                        continue;
                    }
                }
            }
            appendSegmentWithPatchPrefix(item, content, segment);
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
    *
    * 点击发送后会立即把输入框切到运行中状态，这样蓝色边框动画不必等到
    * 扩展宿主回传第一条 assistant pending 消息才出现；如果发送后宿主返回
    * error 或完成消息，后续 message/patch、message/error 会再关闭该状态。
     *
     * 仅发送用户已点击激活（source !== 'default'）的附件；
     * 默认显示的当前文件附件以虚线 pill 形式预览，不会真正进入 prompt，
     * 用户点击对应 pill 后才会被提升为 manual 并参与本次发送。
     */
    function sendComposerText() {
        if (!(composerEl instanceof HTMLTextAreaElement)) return;
        const text = composerEl.value.trim();
        const activeItems = composerState.attachments.filter((item) => item.source !== 'default');
        const attachments = activeItems.map((item) => ({ path: item.path, name: item.name }));
        if (!text && attachments.length === 0) return;
        scrollAfterNextPendingAssistant = true;
        setChatRunning(true);
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
            case 'browser/autoApproveState':
                browserAutoApproveState.supported = message.supported === true;
                browserAutoApproveState.enabled = message.enabled === true;
                renderBrowserAutoApproveHint();
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
                syncClaudeTodoFromMessages(initMessages);
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
                syncClaudeTodoFromMessages(renderedMessagesCache);
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
            case 'expert/model/options':
                composerState.expertModelOptions = message.models || [];
                composerState.expertEnabled = !!message.current?.enabled;
                composerState.expertModelId = message.current?.modelId || '';
                renderExpertModelOptions();
                break;
            case 'models/snapshot':
                composerState.modelOptions = message.normalModels || [];
                composerState.expertModelOptions = message.expertModels || [];
                composerState.planModelOptions = message.planModels || [];
                composerState.reviewModelOptions = message.reviewModels || [];
                composerState.compactionModelOptions = message.compactionModels || [];
                composerState.currentModelKey = message.currentNormal
                    ? message.currentNormal.providerId + '/' + message.currentNormal.modelId
                    : '';
                composerState.expertEnabled = !!(message.currentExpert && message.currentExpert.enabled);
                composerState.expertModelId = message.currentExpert ? (message.currentExpert.modelId || '') : '';
                composerState.planEnabled = !!(message.currentPlan && message.currentPlan.enabled);
                composerState.planModelId = message.currentPlan ? (message.currentPlan.modelId || '') : '';
                composerState.reviewEnabled = !!(message.currentReview && message.currentReview.enabled);
                composerState.reviewModelId = message.currentReview ? (message.currentReview.modelId || '') : '';
                composerState.compactionEnabled = !!(message.currentCompaction && message.currentCompaction.enabled);
                composerState.compactionModelId = message.currentCompaction ? (message.currentCompaction.modelId || '') : '';
                renderModelOptions();
                renderExpertModelOptions();
                renderModelPickerPlanList();
                renderModelPickerReviewList();
                renderModelPickerCompactionList();
                break;
            case 'chat/running':
                composerState.backendRunning = !!message.running;
                setChatRunning(composerState.backendRunning);
                break;
            case 'route/changed':
                // legacy noop：按需专家方案已退役 route/changed 协议，旧版缓存的 webview
                // 仍��能订阅此消息，这里显式吞掉，避免控制台报 warn。
                break;
            case 'expert/availability':
                composerState.expertAvailable = !!message.available;
                composerState.expertAvailableModelName = typeof message.modelName === 'string' ? message.modelName : '';
                renderModelsBar();
                break;
            case 'permissionMode/current':
                composerState.permissionMode = message.mode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
                renderPermissionModeSelect();
                break;
            case 'cacheTtl/current':
                composerState.cacheTtl = message.ttl === '5m' || message.ttl === '1h' ? message.ttl : 'default';
                renderCacheTtlSelect();
                break;
            case 'taskFlow/status':
                updateTaskFlowTodoStatus(message.snapshot);
                break;
            case 'taskFlow/restorePrompt':
                showTaskRestoreDialog({
                    title: message.title,
                    summary: message.summary,
                    progress: message.progress
                });
                break;
            case 'message/error':
                setChatRunning(false);
                showToast('error', message.detail ? (message.error || t('unknownError')) + ': ' + message.detail : (message.error || t('unknownError')));
                break;
            case 'tokenBudget/usage':
                renderTokenMeter({
                    used: Number(message.used) || 0,
                    limit: Number(message.limit) || 0,
                    threshold: Number(message.threshold) || 0,
                    source: message.source === 'api' ? 'api' : 'estimated'
                });
                break;
            case 'compaction/started':
                setComposerCompacting(true);
                setTokenMeterCompacting(true);
                showToast('info', '正在压缩上下文…');
                break;
            case 'compaction/finished':
                setComposerCompacting(false);
                setTokenMeterCompacting(false);
                if (Number(message.beforeTokens) > 0 || Number(message.afterTokens) > 0 || message.summary) {
                    renderCompactionCard({
                        oldSessionId: message.oldSessionId,
                        newSessionId: message.newSessionId,
                        beforeTokens: Number(message.beforeTokens) || 0,
                        afterTokens: Number(message.afterTokens) || 0,
                        summary: message.summary || ''
                    });
                }
                break;
            case 'compaction/failed':
                setComposerCompacting(false);
                setTokenMeterCompacting(false);
                showToast('error', '压缩失败：' + (message.error || t('unknownError')) + '，建议手动清空上下文。');
                break;
            case 'sessions/list/result':
                renderSessionList(message.sessions || []);
                break;
            case 'session/title':
                applySessionTitle(message.title || '', message.sessionId || '');
                break;
            default:
                break;
        }
    }

    /**
     * 把会话标题应用到顶部 H1。
     *
     * 标题为空时回退到默认标题（data-default-title）。显示时截断到 10 个字符并追加
     * 省略号，完整标题写入 title 属性与内部状态，便于悬停查看与内联编辑回填。
     * 编辑态下跳过应用，避免推送覆盖正在编辑的输入框。
     *
     * @param {string} title 会话标题，空字符串表示无标题。
     * @param {string} [sessionId] 该标题所属会话 ID，用于编辑写回。
     */
    function applySessionTitle(title, sessionId) {
        if (!sessionTitleEl) return;
        if (typeof sessionId === 'string') {
            currentSessionTitleId = sessionId;
        }
        if (sessionTitleEditing) return;
        const fallback = sessionTitleEl.getAttribute('data-default-title') || 'LLS CLAUDE CHAT';
        const text = (title || '').trim();
        currentSessionTitleFull = text;
        const display = text || fallback;
        const truncated = display.length > 25 ? display.slice(0, 25) + '…' : display;
        sessionTitleEl.textContent = truncated;
        sessionTitleEl.title = display;
    }

    /**
     * 弹出会话标题编辑对话框。
     *
     * 用一个临时创建的原生 <dialog> 承载输入框与确定/取消按钮，回填完整标题并
     * 全选。回车或点确定提交，Esc 或点取消放弃。提交时把新标题通过
     * session/set-title 回传给扩展宿主写回 JSONL，并乐观地本地应用截断显示。
     * 无活动会话 ID 时不弹出。对话框关闭后从 DOM 移除，避免堆积。
     */
    function beginSessionTitleEdit() {
        if (!sessionTitleEl || sessionTitleEditing) return;
        if (!currentSessionTitleId) return;
        if (typeof HTMLDialogElement === 'undefined') return;
        sessionTitleEditing = true;

        const dialog = document.createElement('dialog');
        dialog.className = 'session-title-dialog';

        const titleLabel = document.createElement('div');
        titleLabel.className = 'session-title-dialog__label';
        titleLabel.textContent = t('sessionTitleEditLabel');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'session-title-dialog__input';
        input.value = currentSessionTitleFull;
        input.maxLength = 60;

        const actions = document.createElement('div');
        actions.className = 'session-title-dialog__actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'session-title-dialog__btn';
        cancelBtn.textContent = t('cancel');
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'session-title-dialog__btn session-title-dialog__btn--primary';
        okBtn.textContent = t('confirm');
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);

        dialog.appendChild(titleLabel);
        dialog.appendChild(input);
        dialog.appendChild(actions);
        document.body.appendChild(dialog);

        let settled = false;
        const cleanup = () => {
            sessionTitleEditing = false;
            if (dialog.open) dialog.close();
            dialog.remove();
        };
        const finish = (commit) => {
            if (settled) return;
            settled = true;
            const next = (input.value || '').trim();
            if (commit && next !== currentSessionTitleFull) {
                post({ type: 'session/set-title', title: next, sessionId: currentSessionTitleId });
                applySessionTitle(next, currentSessionTitleId);
            }
            cleanup();
        };

        okBtn.addEventListener('click', () => finish(true));
        cancelBtn.addEventListener('click', () => finish(false));
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        });
        // 原生 dialog 的 Esc / 取消由 cancel 事件统一处理为放弃。
        dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); finish(false); });
        dialog.addEventListener('close', () => finish(false));

        dialog.showModal();
        input.focus();
        input.select();
    }

    /**
     * 切换 webview 输入框 / 发送按钮 / 附件按钮的「压缩中」禁用状态。
     *
     * 与 setChatRunning 互不冲突：compacting=true 时强制禁用并加 hover 提示；
     * compacting=false 时恢复，由 setChatRunning 当前状态决定按钮形态。
     *
     * @param {boolean} compacting 是否处于自动压缩流程中。
     */
    function setComposerCompacting(compacting) {
        var disabled = !!compacting;
        composerState.compacting = disabled;
        if (composerEl instanceof HTMLTextAreaElement) {
            composerEl.disabled = disabled;
            if (disabled) {
                composerEl.dataset.compacting = 'true';
                composerEl.title = '正在压缩上下文…';
            } else {
                delete composerEl.dataset.compacting;
                composerEl.removeAttribute('title');
            }
        }
        if (sendEl instanceof HTMLButtonElement) {
            sendEl.disabled = disabled;
            if (disabled) sendEl.title = '正在压缩上下文…';
            else sendEl.title = composerState.chatRunning ? t('stopResponse') : t('sendMessage');
        }
        if (attachFileEl instanceof HTMLButtonElement) attachFileEl.disabled = disabled;
        if (composerShellEl instanceof HTMLElement) {
            composerShellEl.classList.toggle('chat-input--compacting', disabled);
        }
        if (tokenMeterWrapEl instanceof HTMLElement) {
            tokenMeterWrapEl.classList.toggle('is-disabled', disabled || composerState.chatRunning);
            if (disabled || composerState.chatRunning) closeTokenMeterPopover();
        }
    }

    /**
     * 把整数 token 数格式化为紧凑形式：1234 → "1.2k"，1234567 → "1.23m"。
     *
     * @param {number} n token 数。
     * @returns {string} 紧凑展示文本。
     */
    function formatTokenCount(n) {
        if (!Number.isFinite(n) || n <= 0) return '0';
        if (n < 1000) return String(Math.round(n));
        if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.0+$/, '') + 'k';
        return (n / 1_000_000).toFixed(2).replace(/\.0+$/, '') + 'm';
    }

    /** 关闭 token meter 的上下文窗口弹层。 */
    function closeTokenMeterPopover() {
        if (!(tokenMeterWrapEl instanceof HTMLElement)) return;
        tokenMeterWrapEl.classList.remove('is-popover-open');
        if (tokenMeterEl instanceof HTMLElement) tokenMeterEl.setAttribute('aria-expanded', 'false');
        if (tokenMeterPopoverEl instanceof HTMLElement) tokenMeterPopoverEl.setAttribute('aria-hidden', 'true');
    }

    /** 切换 token meter 的上下文窗口弹层。 */
    function toggleTokenMeterPopover() {
        if (!(tokenMeterWrapEl instanceof HTMLElement)) return;
        if (composerState.chatRunning || composerState.compacting || tokenMeterWrapEl.hidden) return;
        var open = !tokenMeterWrapEl.classList.contains('is-popover-open');
        tokenMeterWrapEl.classList.toggle('is-popover-open', open);
        if (tokenMeterEl instanceof HTMLElement) tokenMeterEl.setAttribute('aria-expanded', String(open));
        if (tokenMeterPopoverEl instanceof HTMLElement) tokenMeterPopoverEl.setAttribute('aria-hidden', String(!open));
    }

    /**
     * 渲染 bypass 下拉右侧的 token meter 芯片，以及点击展开的上下文窗口弹层。
     *
     * 阈值配色：
     *  - < 70%       默��；
     *  - 70% – 90%   黄色；
     *  - ≥ 90%       红色；
     *  - 触达 threshold（约 limit-60k）额外加 `is-over-threshold` 类，
     *    提示即将触发自动压缩。
     *
     * @param {{used:number,limit:number,threshold:number,source:'api'|'estimated'}} info usage 快照。
     */
    /** 缓存最后一次成功渲染的 usage 快照，用于压缩失败时恢复芯片文本。 */
    let lastTokenMeterInfo = null;

    function renderTokenMeter(info) {
        if (!(tokenMeterEl instanceof HTMLElement) || !(tokenMeterWrapEl instanceof HTMLElement)) return;
        if (!info || !info.limit || info.limit <= 0) {
            tokenMeterWrapEl.hidden = true;
            closeTokenMeterPopover();
            return;
        }
        lastTokenMeterInfo = {
            used: Number(info.used) || 0,
            limit: Number(info.limit) || 0,
            threshold: Number(info.threshold) || 0,
            source: info.source === 'api' ? 'api' : 'estimated'
        };
        var used = Math.max(0, Number(info.used) || 0);
        var limit = Math.max(1, Number(info.limit) || 0);
        var pct = Math.round((used / limit) * 1000) / 10;
        if (!Number.isFinite(pct) || pct < 0) pct = 0;
        if (pct > 999) pct = 999;
        tokenMeterWrapEl.hidden = false;
        tokenMeterEl.textContent = formatTokenCount(used) + '/' + formatTokenCount(limit) + ' · ' + pct.toFixed(1) + '%';
        tokenMeterEl.classList.remove('is-warn', 'is-danger', 'is-over-threshold', 'is-estimated', 'is-compacting');
        if (pct >= 90) tokenMeterEl.classList.add('is-danger');
        else if (pct >= 70) tokenMeterEl.classList.add('is-warn');
        if (info.threshold > 0 && used >= info.threshold) tokenMeterEl.classList.add('is-over-threshold');
        if (info.source === 'estimated') tokenMeterEl.classList.add('is-estimated');
        var hint = used.toLocaleString() + ' / ' + limit.toLocaleString() + ' tokens · ' + pct.toFixed(1) + '%';
        tokenMeterEl.title = hint;
        if (tokenMeterUsedEl instanceof HTMLElement) {
            var tokensSuffix = currentLanguage && currentLanguage.indexOf('zh') === 0 ? ' 个令牌' : ' tokens';
            tokenMeterUsedEl.textContent = formatTokenCount(used) + '/' + formatTokenCount(limit) + tokensSuffix;
        }
        if (tokenMeterPctEl instanceof HTMLElement) tokenMeterPctEl.textContent = pct.toFixed(0) + '%';
        var usedPctClamped = Math.max(0, Math.min(100, (used / limit) * 100));
        if (tokenMeterBarUsedEl instanceof HTMLElement) tokenMeterBarUsedEl.style.width = usedPctClamped.toFixed(2) + '%';
        if (tokenMeterBarReservedEl instanceof HTMLElement) {
            var reservedRaw = (info.threshold && info.threshold > 0)
                ? Math.max(0, limit - info.threshold)
                : 0;
            var reservedPct = Math.max(0, Math.min(100 - usedPctClamped, (reservedRaw / limit) * 100));
            tokenMeterBarReservedEl.style.width = reservedPct.toFixed(2) + '%';
        }
    }

    /**
     * 切换 token meter 的「压缩中…」临时态。
     *
     * @param {boolean} compacting 是否处于自动压缩流程中。
     */
    function setTokenMeterCompacting(compacting) {
        if (!(tokenMeterEl instanceof HTMLElement) || !(tokenMeterWrapEl instanceof HTMLElement)) return;
        if (compacting) {
            tokenMeterWrapEl.hidden = false;
            tokenMeterEl.classList.add('is-compacting');
            tokenMeterEl.textContent = '压缩中…';
            tokenMeterEl.title = '正在压缩上下文，完成后会切换到新会话';
            closeTokenMeterPopover();
        } else {
            tokenMeterEl.classList.remove('is-compacting');
            // 立刻恢复到上一次已知的 usage 渲染，避免在 tokenBudget/usage
            // 下一次推送之前，芯片一直停留在「压缩中…」文案。
            if (lastTokenMeterInfo) {
                renderTokenMeter(lastTokenMeterInfo);
            }
        }
    }

    /**
     * 在消息列表底部插入「上下文已压缩」卡片，视觉对齐"任务完成"卡片风格。
     *
     * @param {{oldSessionId:string,newSessionId:string,beforeTokens:number,afterTokens:number,summary:string}} info 压缩结果。
     */
    function renderCompactionCard(info) {
        if (!(messagesEl instanceof HTMLElement)) return;
        var compactionKey = [info.oldSessionId || '', info.newSessionId || '', String(info.beforeTokens || 0), String(info.afterTokens || 0)].join('|');
        if (composerState.renderedCompactions.has(compactionKey)) {
            post({ type: 'log', level: 'warn', message: '[tokenBudget] duplicate compaction card ignored: ' + compactionKey });
            return;
        }
        composerState.renderedCompactions.add(compactionKey);
        var card = document.createElement('div');
        card.className = 'message_07S1Yg compaction-card_07S1Yg';
        card.setAttribute('data-role', 'compaction-card');
        var ratio = info.beforeTokens > 0
            ? Math.round((1 - info.afterTokens / info.beforeTokens) * 1000) / 10
            : 0;
        var header = document.createElement('div');
        header.className = 'compaction-card-header';
        header.textContent = '🗜 上下文已压缩';
        var body = document.createElement('div');
        body.className = 'compaction-card-body';
        body.innerHTML =
            '<div>已开启新会话，原会话历史已被压缩为摘要。</div>'
            + '<div class="compaction-card-stats">'
            +   '<span>压缩前：' + info.beforeTokens.toLocaleString() + ' tokens</span>'
            +   '<span>压缩后：' + info.afterTokens.toLocaleString() + ' tokens</span>'
            +   '<span>节省：' + (ratio > 0 ? ratio.toFixed(1) : '0') + '%</span>'
            + '</div>';
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'compaction-card-toggle';
        toggle.textContent = '▾ 展开摘要';
        var summaryEl = document.createElement('pre');
        summaryEl.className = 'compaction-card-summary';
        summaryEl.style.display = 'none';
        summaryEl.style.whiteSpace = 'pre-wrap';
        summaryEl.textContent = info.summary || '';
        toggle.addEventListener('click', function () {
            var open = summaryEl.style.display === 'none';
            summaryEl.style.display = open ? 'block' : 'none';
            toggle.textContent = open ? '▴ 收起摘要' : '▾ 展开摘要';
        });
        card.append(header, body, toggle, summaryEl);
        messagesEl.appendChild(card);
        if (typeof messagesEl.scrollTo === 'function') {
            messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
        } else {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    ensureComposerShortcutBar();
    applyI18n();
    setChatRunning(false);

    sendEl?.addEventListener('click', handleComposerAction);
    attachFileEl?.addEventListener('click', () => post({ type: 'file/pick' }));
    openModelPickerEl?.addEventListener('click', openModelPicker);
    composerNormalChipEl?.addEventListener('click', openModelPicker);
    composerExpertChipEl?.addEventListener('click', openModelPicker);
    modelPickerCancelEls.forEach((el) => {
        if (el instanceof HTMLElement) el.addEventListener('click', closeModelPicker);
    });
    taskRestoreContinueEl?.addEventListener('click', () => resolveTaskRestore('continue'));
    taskRestoreClearEl?.addEventListener('click', () => resolveTaskRestore('clear'));
    taskRestoreDismissEl?.addEventListener('click', () => resolveTaskRestore('dismiss'));
    taskRestoreDialogEl?.addEventListener('cancel', (event) => {
        event.preventDefault();
        resolveTaskRestore('dismiss');
    });
    browserAutoApproveOkEl?.addEventListener('click', () => closeBrowserAutoApproveConfirm(true));
    browserAutoApproveCancelEl?.addEventListener('click', () => closeBrowserAutoApproveConfirm(false));
    browserAutoApproveDialogEl?.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeBrowserAutoApproveConfirm(false);
    });
    modelPickerFormEl?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitModelPicker();
    });
    if (modelPickerDialogEl instanceof HTMLDialogElement) {
        modelPickerDialogEl.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeModelPicker();
        });
    }
    permissionModeSelectEl?.addEventListener('change', () => {
        if (!(permissionModeSelectEl instanceof HTMLSelectElement)) return;
        const mode = permissionModeSelectEl.value === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits';
        composerState.permissionMode = mode;
        renderPermissionModeSelect();
        post({ type: 'permissionMode/select', mode });
    });
    modelPickerCacheTtlSelectEl?.addEventListener('change', () => {
        if (!(modelPickerCacheTtlSelectEl instanceof HTMLSelectElement)) return;
        const ttl = modelPickerCacheTtlSelectEl.value === '5m' || modelPickerCacheTtlSelectEl.value === '1h' ? modelPickerCacheTtlSelectEl.value : 'default';
        composerState.cacheTtl = ttl;
        renderCacheTtlSelect();
        post({ type: 'cacheTtl/select', ttl });
    });
    tokenMeterEl?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleTokenMeterPopover();
    });
    tokenMeterCompactEl?.addEventListener('click', (event) => {
        event.stopPropagation();
        post({ type: 'log', level: 'info', message: '[tokenBudget] compact button clicked' });
        if (composerState.chatRunning || composerState.compacting) {
            post({ type: 'log', level: 'warn', message: '[tokenBudget] compact button ignored: chatRunning=' + composerState.chatRunning + ', compacting=' + composerState.compacting });
            return;
        }
        closeTokenMeterPopover();
        setComposerCompacting(true);
        setTokenMeterCompacting(true);
        showToast('info', '已发送压缩会话指令…');
        post({ type: 'tokenBudget/compactNow' });
    });
    document.addEventListener('click', (event) => {
        if (!(tokenMeterWrapEl instanceof HTMLElement)) return;
        if (event.target instanceof Node && tokenMeterWrapEl.contains(event.target)) return;
        closeTokenMeterPopover();
    });
    restartCliEl?.addEventListener('click', () => post({ type: 'cli/restart' }));
    newSessionEl?.addEventListener('click', () => { applySessionTitle('', ''); post({ type: 'session/clear' }); });
    sessionTitleEl?.addEventListener('click', beginSessionTitleEdit);
    openSessionsEl?.addEventListener('click', openSessions);
    sessionListCloseEls.forEach((el) => {
        if (el instanceof HTMLElement) el.addEventListener('click', closeSessionList);
    });
    if (sessionListDialogEl instanceof HTMLElement) {
        sessionListDialogEl.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeSessionList();
        });
    }
    contextClearEl?.addEventListener('click', clearAttachments);
    installAssistantMessageNormalizer();
    const composerImeGuard = installImeEnterGuard(composerEl, sendComposerText);
    composerEl?.addEventListener('keydown', (event) => {
        // 所有按键都交给护栏：它需要跟踪方向键状态以识别「方向键选字 → 回车确认」。
        composerImeGuard(event);
    });
    composerEl?.addEventListener('input', autoResizeComposer);
    document.addEventListener('paste', (event) => {
        void handlePaste(event);
    }, true);

    // ---------------------------------------------------------------------
    // 旧版 Expert mode 折叠面板（ExpertPanel）已废弃
    // ---------------------------------------------------------------------
    //
    // 每次主模型调用 ask_expert，扩展端会推送一系列 `expert/event` 消息：
    //   start → analysis* / tool_call+ / tool_result* → final | error | cancelled
    //
    // Webview 用 `runId` 作为面板键，把同一 run 的所有事件聚合到一个折叠面板里，
    // 并把面板**插入到** `parentMessageId` 对应的 assistant 消息节点之后。
    // 运行中默认展开，进入终结态自动折叠（用户仍可手动展开查看完整 trace）。
    //
    // 面板**不进入** chatMessages 数组，也不会被 sessionStore 持久化——这是
    // 「专家上下文与主对话隔离」设计目标的一部分，详见 EXPERT_MODE_DESIGN.md §7。

    /**
     * 已渲染的 ExpertPanel 缓存：runId → 关键 DOM 节点。
     *
     * 复用同一引用便于增量更新（避免每次重渲染整个 panel），并在面板被移除时
     * 同步清理本表，防止内存泄漏。
     *
     * @type {Map<string, { wrapper: HTMLElement; header: HTMLElement; body: HTMLElement; status: HTMLElement; toggleBtn: HTMLElement; eventsContainer: HTMLElement }>}
     */
    const expertPanels = new Map();

    /**
     * 处理一条专家事件：找到 / 创建面板，追加事件项，按需触发自动折叠。
     *
     * 滚动行为：在追加任何专家事件 DOM 之前，先记录外层主消息容器是否已在底部；
     * 内部各滚动容器（工具卡片实时 Output、ExpertPanel 事件列表）由各自的
     * append 函数内部独立维护"尾部跟随"，互不干扰。所有 DOM 操作完成后再
     * 调用 {@link scrollToBottomIfNeeded} 让主区域跟随到底部，避免专家事件
     * 流到来时主对话不自动下移。
     *
     * @param {any} event {@link ExpertEventPayload}
     */
    function handleExpertEvent(event) {
        if (!event || !event.runId || !event.parentMessageId) return;
        // 外层主消息容器在所有专家 DOM 变更前的"贴近底部"状态。
        var outerWasAtBottom = isScrolledNearBottom();
        appendExpertEventToToolOutput(event);
        const panel = ensureExpertPanel(event);
        if (panel) {
            appendExpertEventItem(panel, event);
            updateExpertPanelStatus(panel, event);
        }
        // 等下一帧，让面板高度/折叠动画影响后的 scrollHeight 稳定后再决定跟随。
        scrollToBottomIfNeeded(outerWasAtBottom);
        if (outerWasAtBottom && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(function () {
                scrollToBottomIfNeeded(true);
            });
        }
    }

    /**
     * 找到或创建一个 ExpertPanel。
     *
     * - 若已存在：直接返回缓存；
     * - 若不存在：在对应 assistant 消息节点之后插入一个新面板节点。
     *   找不到 parentMessageId 时则追加到 messagesEl 末尾兜底显示。
     *
     * @param {any} event 触发面板创建的首个事件（通常是 `start`）。
     * @returns {{ wrapper: HTMLElement; header: HTMLElement; body: HTMLElement; status: HTMLElement; toggleBtn: HTMLElement; eventsContainer: HTMLElement } | null}
     */
    function ensureExpertPanel(event) {
        const existing = expertPanels.get(event.runId);
        if (existing) return existing;
        if (!messagesEl) return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'expertPanel_07S1Yg expertPanelRunning_07S1Yg';
        wrapper.dataset.runId = event.runId;
        wrapper.dataset.parentMessageId = event.parentMessageId;

        // ----- 头部（点击折叠）-----
        const header = document.createElement('div');
        header.className = 'expertPanelHeader_07S1Yg';

        const titleEl = document.createElement('span');
        titleEl.className = 'expertPanelTitle_07S1Yg';
        titleEl.textContent = '🧑\u200d🏫 ' + t('expertPanelTitle');
        header.appendChild(titleEl);

        const modelEl = document.createElement('span');
        modelEl.className = 'expertPanelModel_07S1Yg';
        if (event.kind === 'start' && event.expertModel) {
            modelEl.textContent = String(event.expertModel);
        }
        header.appendChild(modelEl);

        const status = document.createElement('span');
        status.className = 'expertPanelStatus_07S1Yg';
        status.textContent = t('expertPanelStatusRunning');
        header.appendChild(status);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'expertPanelToggle_07S1Yg';
        toggleBtn.setAttribute('aria-label', t('expertPanelToggleAria'));
        toggleBtn.textContent = '▾';
        header.appendChild(toggleBtn);

        wrapper.appendChild(header);

        // ----- 内容 body -----
        const body = document.createElement('div');
        body.className = 'expertPanelBody_07S1Yg';

        // 顶部 question 展示（来自 start 事件）
        if (event.kind === 'start' && event.question) {
            const q = document.createElement('div');
            q.className = 'expertPanelQuestion_07S1Yg';
            q.textContent = String(event.question);
            body.appendChild(q);
        }

        // 事件列表容器
        const eventsContainer = document.createElement('div');
        eventsContainer.className = 'expertPanelEvents_07S1Yg';
        body.appendChild(eventsContainer);

        wrapper.appendChild(body);

        // 点击 header 切换折叠（按钮单独点击也走同一逻辑）
        header.addEventListener('click', function () {
            wrapper.classList.toggle('expertPanelCollapsed_07S1Yg');
            toggleBtn.textContent = wrapper.classList.contains('expertPanelCollapsed_07S1Yg') ? '▸' : '▾';
        });

        // 找到挂载锚点：parentMessageId 对应的 assistant 消息节点
        const parentItem = messagesEl.querySelector('.message_07S1Yg[data-id="' + cssEscape(event.parentMessageId) + '"]');
        if (parentItem && parentItem.parentNode === messagesEl) {
            messagesEl.insertBefore(wrapper, parentItem.nextSibling);
        } else {
            messagesEl.appendChild(wrapper);
        }

        const entry = { wrapper, header, body, status, toggleBtn, eventsContainer };
        expertPanels.set(event.runId, entry);
        return entry;
    }

    /**
     * 把一条事件渲染为面板内的一项。
     *
     * `start` 事件已在 ensureExpertPanel 中渲染过 question，这里不再重复；
     * `final` / `error` / `cancelled` 事件除了渲染条目外，还会触发面板自动折叠
     * （由 updateExpertPanelStatus 完成）。
     *
     * 滚动行为：ExpertPanel 的 `panel.body` 自身设置了 `max-height: 480px;
     * overflow-y: auto`，事件多了会出现独立滚动条。这里在追加事件项前记录
     * body 是否贴近底部，追加后据此跟随到底部，避免新事件出现在视口外。
     *
     * @param {{ eventsContainer: HTMLElement; body: HTMLElement }} panel ensureExpertPanel 返回的句柄。
     * @param {any} event 待渲染事件。
     */
    function appendExpertEventItem(panel, event) {
        if (event.kind === 'tool_result' && !event.toolIsError) return;

        const item = document.createElement('div');
        item.className = 'expertEvent_07S1Yg expertEvent_' + String(event.kind) + '_07S1Yg';
        if (event.kind === 'tool_call' || event.kind === 'tool_result') {
            item.classList.add('expertEventCompact_07S1Yg');
        }

        const label = document.createElement('span');
        label.className = 'expertEventLabel_07S1Yg';
        label.textContent = expertEventOneLineText(event) || expertEventLabel(event);
        item.appendChild(label);

        const detail = event.kind === 'tool_call' || event.kind === 'tool_result' ? '' : expertEventDetailText(event);
        if (detail) {
            const detailEl = document.createElement('div');
            detailEl.className = 'expertEventDetail_07S1Yg';
            detailEl.textContent = detail;
            item.appendChild(detailEl);
        }

        // start 事件在 ensureExpertPanel 里已经把 question 放在 body 顶部，这里不再追加
        if (event.kind !== 'start') {
            const bodyEl = panel.body instanceof HTMLElement ? panel.body : null;
            const bodyWasAtBottom = bodyEl ? isElementScrolledNearBottom(bodyEl) : true;
            panel.eventsContainer.appendChild(item);
            if (bodyEl) {
                scrollElementToBottomIfNeeded(bodyEl, bodyWasAtBottom);
                if (bodyWasAtBottom && typeof window.requestAnimationFrame === 'function') {
                    window.requestAnimationFrame(function () {
                        bodyEl.scrollTop = bodyEl.scrollHeight;
                    });
                }
            }
        }
    }

    /**
     * 根据事件 kind 返回 i18n 标签文本。
     *
     * @param {any} event 事件对象。
     * @returns {string} 标签字符串。
     */
    function expertEventLabel(event) {
        switch (event.kind) {
            case 'start': return t('expertEventStart');
            case 'analysis': return t('expertEventAnalysis');
            case 'tool_call': return t('expertEventToolCall') + (event.toolName ? ' · ' + event.toolName : '');
            case 'tool_result': return t('expertEventToolResult') + (event.toolName ? ' · ' + event.toolName : '');
            case 'final': return t('expertEventFinal');
            case 'error': return t('expertEventError');
            case 'cancelled': return t('expertEventCancelled');
            default: return String(event.kind || '');
        }
    }

    /**
     * 提取事件的可读详情：assistant 文本 / 工具参数 / 工具结果摘要。
     *
     * @param {any} event 事件对象。
     * @returns {string} 详情字符串（可能为空字符串）。
     */
    function expertEventDetailText(event) {
        if (event.kind === 'analysis' || event.kind === 'final' || event.kind === 'error' || event.kind === 'cancelled') {
            return String(event.text || '');
        }
        if (event.kind === 'tool_call') {
            try {
                return event.toolArgs !== undefined ? JSON.stringify(event.toolArgs, null, 2) : '';
            } catch (_e) {
                return String(event.toolArgs || '');
            }
        }
        if (event.kind === 'tool_result') {
            return String(event.toolResultSummary || '');
        }
        return '';
    }

    /**
     * 为专家工具事件生成单行摘要。
     *
     * 目标展示形态：
     * - Read / Edit / MultiEdit：`读取 xxx` / `编辑 xxx`；
     * - 其它工具：`工具名 内容`；
     * - 错误 tool_result：`工具名 失败：摘要`。
     *
     * @param {any} event 专家事件对象。
     * @returns {string} 单行摘要；非工具事件返回空字符串。
     */
    function expertEventOneLineText(event) {
        if (!event || event.kind === 'tool_call') {
            return formatExpertToolCallLine(event);
        }
        if (event && event.kind === 'tool_result' && event.toolIsError) {
            return formatExpertToolResultLine(event);
        }
        return '';
    }

    /**
     * 格式化专家工具调用的一行摘要。
     *
     * @param {any} event `kind='tool_call'` 的专家事件。
     * @returns {string} 一行工具调用摘要。
     */
    function formatExpertToolCallLine(event) {
        if (!event || event.kind !== 'tool_call') return '';
        const name = String(event.toolName || 'Tool');
        const args = event.toolArgs;
        const target = extractExpertToolTarget(name, args);
        if (name === 'Read') return '读取 ' + (target || summarizeExpertToolArgs(name, args));
        if (name === 'Edit' || name === 'MultiEdit') return '编辑 ' + (target || summarizeExpertToolArgs(name, args));
        if (name === 'Write') return '写入 ' + (target || summarizeExpertToolArgs(name, args));
        const summary = summarizeExpertToolArgs(name, args);
        return summary ? name + ' ' + summary : name;
    }

    /**
     * 格式化专家工具错误结果的一行摘要。
     *
     * @param {any} event `kind='tool_result'` 的专家事件。
     * @returns {string} 一行错误摘要。
     */
    function formatExpertToolResultLine(event) {
        const name = String(event && event.toolName || 'Tool');
        const detail = compactOneLine(String(event && event.toolResultSummary || ''));
        return detail ? name + ' 失败：' + detail : name + ' 失败';
    }

    /**
     * 从工具入参中提取最像“目标文件/目标资源”的字段。
     *
     * @param {string} _name 工具名，保留参数便于后续按工具名扩展。
     * @param {unknown} args 工具入参。
     * @returns {string} 目标路径或资源摘要。
     */
    function extractExpertToolTarget(_name, args) {
        if (!args || typeof args !== 'object') return '';
        const record = args;
        const candidates = ['file_path', 'notebook_path', 'path', 'file', 'filename', 'url'];
        for (let i = 0; i < candidates.length; i++) {
            const value = record[candidates[i]];
            if (typeof value === 'string' && value.trim()) return shortenPath(value.trim());
        }
        return '';
    }

    /**
     * 将任意工具入参压缩成一行内容摘要。
     *
     * 优先选择 Bash.command、搜索 query/pattern、Task.description/prompt 等最能表达
     * “这个工具在做什么”的字段；找不到时退化为紧凑 JSON。
     *
     * @param {string} name 工具名。
     * @param {unknown} args 工具入参。
     * @returns {string} 一行内容摘要。
     */
    function summarizeExpertToolArgs(name, args) {
        if (!args || typeof args !== 'object') return compactOneLine(String(args || ''));
        const record = args;
        const preferredFieldsByTool = {
            Bash: ['command', 'description'],
            Grep: ['pattern', 'path', 'glob'],
            Glob: ['pattern', 'path'],
            WebSearch: ['query'],
            WebFetch: ['url', 'prompt'],
            Task: ['description', 'prompt'],
            TodoWrite: ['todos'],
            AskUserQuestion: ['questions']
        };
        const fields = preferredFieldsByTool[name] || ['command', 'query', 'pattern', 'description', 'prompt', 'content', 'text'];
        const parts = [];
        for (let i = 0; i < fields.length; i++) {
            const value = record[fields[i]];
            const text = summarizeExpertValue(value);
            if (text) parts.push(text);
        }
        if (parts.length > 0) return compactOneLine(parts.join(' '));
        try {
            return compactOneLine(JSON.stringify(record));
        } catch (_e) {
            return compactOneLine(String(record));
        }
    }

    /**
     * 将工具入参字段值转换为短文本。
     *
     * @param {unknown} value 字段值。
     * @returns {string} 字段摘要。
     */
    function summarizeExpertValue(value) {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) return value.length + ' 项';
        if (value && typeof value === 'object') {
            try { return JSON.stringify(value); } catch (_e) { return String(value); }
        }
        return '';
    }

    /**
     * 把多行或过长文本压缩为适合专家工具列表展示的一行。
     *
     * @param {string} text 原始文本。
     * @returns {string} 最多 160 字符的一行文本。
     */
    function compactOneLine(text) {
        const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
        return oneLine.length > 160 ? oneLine.slice(0, 157) + '…' : oneLine;
    }

    /**
     * 把专家事件实时追加到主聊天 ask_expert 工具卡片 Output 中。
     *
     * 这条链路独立于 MCP 最终 tool_result：专家一边输出 analysis / tool_call /
     * tool_result，Webview 就一边更新对应工具卡片，避免用户只能在专家结束后
     * 才看到一次性结果。
     *
     * 滚动行为：stream 容器自身设置了 `max-height + overflow:auto`，长内容会出现
     * 独立滚动条。这里在 append 前记录 stream 是否贴近自身底部，append 后按需
     * 把 scrollTop 拉到 scrollHeight，做"跟随尾部"，保证用户首次或一直查看时
     * 始终能看到最新一行，而向上回看时不会被打断。
     *
     * @param {any} event 专家事件对象。
     */
    function appendExpertEventToToolOutput(event) {
        const toolCard = findExpertToolCard(event);
        if (!toolCard) return;
        const stream = ensureExpertToolStream(toolCard);
        const line = buildExpertToolStreamLine(event);
        if (!line) return;
        const lineEl = document.createElement('div');
        lineEl.className = 'expertToolStreamLine_07S1Yg expertToolStreamLine_' + String(event.kind) + '_07S1Yg';
        renderMarkdown(lineEl, line);
        // 追加前记录当前是否处于尾部，决定追加后是否跟随。
        const innerWasAtBottom = isElementScrolledNearBottom(stream);
        stream.appendChild(lineEl);
        scrollElementToBottomIfNeeded(stream, innerWasAtBottom);
        // 下一帧再做一次：renderMarkdown 内异步代码块高亮 / 图片懒加载 等可能在
        // 同步追加之后再撑高高度，单纯同步一次写 scrollTop 可能落在"前一次"高度。
        if (innerWasAtBottom && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(function () {
                stream.scrollTop = stream.scrollHeight;
            });
        }
    }

    /**
     * 定位承载本次专家 run 的 ask_expert 工具卡片。
     *
     * 优先使用后端传来的 `toolSegmentId`；若缺失，则按 `callId` 推导 `tool:<id>`；
     * 再兜底寻找当前消息下最后一个 ask_expert 工具卡片。
     *
     * @param {any} event 专家事件对象。
     * @returns {HTMLElement | null} 工具卡片 DOM。
     */
    function findExpertToolCard(event) {
        if (!messagesEl) return null;
        const parentItem = messagesEl.querySelector('.message_07S1Yg[data-id="' + cssEscape(event.parentMessageId) + '"]');
        if (!(parentItem instanceof HTMLElement)) return null;
        const content = parentItem.querySelector('.assistantMessage_07S1Yg') || parentItem;
        const ids = [];
        if (event.toolSegmentId) ids.push(String(event.toolSegmentId));
        if (event.callId) ids.push('tool:' + String(event.callId));
        for (let i = 0; i < ids.length; i++) {
            const found = content.querySelector('[data-segment-id="' + cssEscape(ids[i]) + '"]');
            if (found instanceof HTMLElement) return found;
        }
        const cards = Array.from(content.querySelectorAll('.root_ZUQaOA[data-tool-name="mcp__llsExpert__ask_expert"], .root_ZUQaOA[data-tool-name="ask_expert"]'));
        const last = cards[cards.length - 1];
        return last instanceof HTMLElement ? last : null;
    }

    /**
     * 获取或创建 ask_expert 工具卡片内的实时专家 Output 容器。
     *
     * @param {HTMLElement} toolCard ask_expert 工具卡片根节点。
     * @returns {HTMLElement} 可追加流式行的容器。
     */
    function ensureExpertToolStream(toolCard) {
        let stream = toolCard.querySelector('.expertToolStream_07S1Yg');
        if (stream instanceof HTMLElement) return stream;
        const body = toolCard.querySelector('.toolBody_ZUQaOA') || toolCard;
        const wrap = document.createElement('div');
        wrap.className = 'toolResultWrap_ZUQaOA expertToolStreamWrap_07S1Yg';
        const label = document.createElement('div');
        label.className = 'toolResultLabel_ZUQaOA';
        label.textContent = 'Output · streaming';
        wrap.appendChild(label);
        stream = document.createElement('div');
        stream.className = 'toolResultMarkdown_ZUQaOA expertToolStream_07S1Yg';
        wrap.appendChild(stream);
        body.appendChild(wrap);
        return stream;
    }

    /**
     * 把专家事件转换成可渲染到工具 Output 的 Markdown 行。
     *
     * @param {any} event 专家事件对象。
     * @returns {string} Markdown 文本；无需展示时返回空字符串。
     */
    function buildExpertToolStreamLine(event) {
        switch (event.kind) {
            case 'start':
                return '**专家开始**' + (event.expertModel ? ' · `' + String(event.expertModel) + '`' : '');
            case 'analysis':
                return String(event.text || '').trim();
            case 'tool_call':
                return '- 🔧 ' + (formatExpertToolCallLine(event) || expertEventLabel(event));
            case 'tool_result':
                if (event.toolIsError) return '- ⚠️ ' + formatExpertToolResultLine(event);
                return '- ✅ ' + String(event.toolName || 'Tool') + ' 完成';
            case 'final':
                return String(event.text || '').trim();
            case 'error':
                return '**专家错误：** ' + String(event.text || '').trim();
            case 'cancelled':
                return '**专家已取消：** ' + String(event.text || '').trim();
            default:
                return '';
        }
    }

    /**
     * 根据事件 kind 更新面板状态（运行中 / 完成 / 错误 / 取消）。
     *
     * 进入终结态时：
     *   - 切换 status 文案；
     *   - 移除 `running` className；
     *   - 自动折叠面板，便于阅读主对话（用户仍可手动展开查看详情）。
     *
     * @param {{ wrapper: HTMLElement; status: HTMLElement; toggleBtn: HTMLElement }} panel ensureExpertPanel 返回的句柄。
     * @param {any} event 当前事件。
     */
    function updateExpertPanelStatus(panel, event) {
        if (event.kind === 'final') {
            panel.status.textContent = t('expertPanelStatusDone') + formatExpertDuration(event.durationMs);
            panel.wrapper.classList.remove('expertPanelRunning_07S1Yg');
            panel.wrapper.classList.add('expertPanelDone_07S1Yg');
            collapseExpertPanel(panel);
        } else if (event.kind === 'error') {
            panel.status.textContent = t('expertPanelStatusError') + formatExpertDuration(event.durationMs);
            panel.wrapper.classList.remove('expertPanelRunning_07S1Yg');
            panel.wrapper.classList.add('expertPanelError_07S1Yg');
            collapseExpertPanel(panel);
        } else if (event.kind === 'cancelled') {
            panel.status.textContent = t('expertPanelStatusCancelled') + formatExpertDuration(event.durationMs);
            panel.wrapper.classList.remove('expertPanelRunning_07S1Yg');
            panel.wrapper.classList.add('expertPanelCancelled_07S1Yg');
            collapseExpertPanel(panel);
        }
    }

    /**
     * 把面板设为折叠态并把切换按钮指向 "▸"。
     *
     * @param {{ wrapper: HTMLElement; toggleBtn: HTMLElement }} panel ensureExpertPanel 返回的句柄。
     */
    function collapseExpertPanel(panel) {
        panel.wrapper.classList.add('expertPanelCollapsed_07S1Yg');
        panel.toggleBtn.textContent = '▸';
    }

    /**
     * 把毫秒级耗时格式化为人类可读后缀（` · 12.3s`），无值时返回空串。
     *
     * @param {number | undefined} ms 耗时毫秒数。
     * @returns {string} 已加分隔符的后缀串。
     */
    function formatExpertDuration(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
        if (ms < 1000) return ' · ' + ms + 'ms';
        return ' · ' + (ms / 1000).toFixed(1) + 's';
    }

    /**
     * CSS.escape polyfill：用于把 messageId 安全插入 querySelector 字符串。
     *
     * 现代 webview runtime 都已实现 CSS.escape，这里仅在缺失时退化到简单的
     * 双重转义实现，避免恶意构造的 messageId 破坏选择器语法。
     *
     * @param {string} value 任意字符串。
     * @returns {string} 安全的 CSS 标识字符串。
     */
    function cssEscape(value) {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            return CSS.escape(value);
        }
        return String(value).replace(/(["\\\[\]\.#:>\+~\*\^\$\|=\(\)\s])/g, '\\$1');
    }

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
    renderExpertModelOptions();
    autoResizeComposer();
    renderEmptyState();
    post({ type: 'webview/ready' });
    post({ type: 'log', level: 'info', message: '[boot] chat webview script loaded, drop handlers attached (v2)' });
}());
