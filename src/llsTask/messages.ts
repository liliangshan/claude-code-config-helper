/** @file @llsccai-task 任务流多语言文案。 */

import type { ResolvedAppLanguage } from '../types';

/** 任务流本地化文案集合。 */
export interface LlsCcaiTaskTexts {
    /** 状态栏基础标签。 */
    statusLabel: string;
    /** 正在分析规划文档提示。 */
    analyzing: string;
    /** 任务流已完成提示。 */
    completed: string;
    /** 任务流失败提示前缀。 */
    failed: string;
    /** 继续推进提示开头。 */
    continuePrompt: string;
    /**
     * 上一轮主对话只回文本、没真正调用任务流工具时的强约束补充提示。
     *
     * 拼接在 {@link continuePrompt} 之后使用。某些上游模型会"幻觉"地用文字
     * 声称已经执行了 update_llsccai_task_workflow / Write / Edit 等工具，但
     * 实际未发出任何 tool_use；用本段加重提示强制本轮必须以工具调用形式执行。
     */
    continuePromptWhenToolMissing: string;
    /** 续推消息中「下一个待执行任务」标签。 */
    continueNextTaskLabel: string;
    /**
     * 续推消息中要求回写任务状态的指示文案。
     *
     * 文案内含 `{{tool}}` 占位符，调用方会替换为实际的状态更新工具名
     * （update_llsccai_task_workflow），指示模型执行后必须调用该工具回写状态、
     * 禁止只用文字声称完成、禁止询问是否继续。
     */
    continueUpdateInstruction: string;
    /** 规划文件路径标签。 */
    planningPathLabel: string;
    /** 启动任务流占位提示。 */
    startPrompt: string;
    /** 默认启动提示未带有效规划文档时的提示。 */
    openMarkdownOrEditPrompt: string;
    /** 点击启动任务流提示。 */
    startTooltip: string;
    /** 点击清空已完成任务流提示。 */
    completedTooltip: string;
    /** 任务流仍在运行时点击 CC 任务流按钮的确认提示。 */
    runningTooltip: string;
    /** 运行中任务流的「继续推进」按钮文案。 */
    continueAction: string;
    /** 清空并新建按钮文案。 */
    clearAndNew: string;
    /** 取消按钮文案。 */
    cancel: string;
    /** 输出语言名称。 */
    outputLanguageName: string;
    /**
     * 连续多次缺失任务流工具调用时，熔断自动续推后弹出的警告文案。
     *
     * 出现该提示意味着模型连续若干轮只回文字、未调用任何工具，自动续推已
     * 停止；用户需要手动判断后续操作（继续追问、修改提示词或清空任务流）。
     */
    missingToolCircuitBreaker: string;
}

/** 任务流多语言文案字典，覆盖当前支持的所有 UI 语言。 */
const LLS_CCAI_TASK_TEXTS: Record<ResolvedAppLanguage, LlsCcaiTaskTexts> = {
    en: {
        statusLabel: 'Task Flow',
        analyzing: 'Analyzing the planning document and generating a workflow...',
        completed: 'Task flow completed',
        failed: 'Task flow failed',
        continuePrompt: 'Continue executing the active llsccai-task workflow.',
        continuePromptWhenToolMissing: 'In the previous turn you only produced text without actually invoking any tool. This turn you MUST execute via real tool calls (e.g. update_llsccai_task_workflow, Write, Edit, Bash). Do NOT claim a task is finished or the status is updated using plain text only.',
        continueNextTaskLabel: 'Next task to execute',
        continueUpdateInstruction: 'Execute the next pending or in-progress task directly. After the work is actually done, you MUST call the {{tool}} tool to update its status. Do not only describe the step, do not claim completion in text without calling the tool, and do not ask whether to continue, start, or proceed. The only allowed statuses are pending, in_progress and completed; there is no blocked or failed status. If a task cannot be finished (blocked, failed, or missing prerequisites), append a short explanation to .LLSOAI/task_error.md (create the file if needed), then still mark the task completed and move on, so the workflow never stalls.',
        planningPathLabel: 'Planning file path',
        startPrompt: '@llsccai-task Please open a Markdown planning document in the IDE, or delete this sentence and use your own prompt.',
        openMarkdownOrEditPrompt: 'Please open a Markdown planning document in the IDE, or modify the prompt after @llsccai-task and try again.',
        startTooltip: 'Click to send @llsccai-task to Claude Code and start a workflow',
        completedTooltip: 'Click to clear the completed workflow and start a new one',
        runningTooltip: 'A workflow is still running. Continue it, or clear and start a new one?',
        continueAction: 'Continue',
        clearAndNew: 'Clear and Start New',
        cancel: 'Cancel',
        outputLanguageName: 'English',
        missingToolCircuitBreaker: 'The llsccai-task workflow has been auto-continued multiple times but the model keeps responding with plain text without calling any tool. Auto-continue has been paused. Please review the workflow and send a new prompt manually if needed.'
    },
    'zh-cn': {
        statusLabel: '任务流',
        analyzing: '正在分析方案规划文档并生成任务流...',
        completed: '任务流已完成',
        failed: '任务流失败',
        continuePrompt: '请继续执行当前 llsccai-task 任务流。',
        continuePromptWhenToolMissing: '上一轮你只输出了文字，没有真正调用任何工具。本轮必须以真实的 tool_use 工具调用形式执行（如 update_llsccai_task_workflow、Write、Edit、Bash），禁止只用文字声称已完成任务或已更新状态。',
        continueNextTaskLabel: '下一个待执行任务',
        continueUpdateInstruction: '请直接执行下一个 pending 或 in_progress 的任务。任务实际完成后，必须调用 {{tool}} 工具回写其状态。不要只描述步骤，不要在未调用工具的情况下用文字声称已完成，也不要询问是否继续、是否开始、是否推进。状态只允许 pending、in_progress、completed，没有阻塞或失败状态。若某个任务确实无法完成（被阻塞、失败或缺少前置条件），请把简要错误说明追加写入 .LLSOAI/task_error.md（文件不存在则创建），然后仍将该任务标记为 completed 并继续下一个，避免任务流卡死。',
        planningPathLabel: '方案文件路径',
        startPrompt: '@llsccai-task 请先在 IDE 中打开 Markdown 文档，或者删除这段使用自己的提示词',
        openMarkdownOrEditPrompt: '请先在 IDE 中打开 Markdown 方案规划文档，或者修改 @llsccai-task 后面的提示词再试。',
        startTooltip: '点击向 Claude Code 发送 @llsccai-task 启动任务流',
        completedTooltip: '点击清空已完成任务流并发起新的 @llsccai-task',
        runningTooltip: '当前任务流仍在运行，是否继续推进，或清空并发起新的任务流？',
        continueAction: '继续推进',
        clearAndNew: '清空并新建',
        cancel: '取消',
        outputLanguageName: '简体中文',
        missingToolCircuitBreaker: '当前 llsccai-task 任务流连续多轮只输出文字、未调用任何工具，自动续推已暂停。请检查任务流状态，如需继续请手动发送新的提示词。'
    },
    'zh-tw': {
        statusLabel: '任務流',
        analyzing: '正在分析方案規劃文件並產生任務流...',
        completed: '任務流已完成',
        failed: '任務流失敗',
        continuePrompt: '請繼續執行目前 llsccai-task 任務流。',
        continuePromptWhenToolMissing: '上一輪你只輸出了文字，沒有真正呼叫任何工具。本輪必須以真實的 tool_use 工具呼叫形式執行（如 update_llsccai_task_workflow、Write、Edit、Bash），禁止只用文字宣稱已完成任務或已更新狀態。',
        continueNextTaskLabel: '下一個待執行任務',
        continueUpdateInstruction: '請直接執行下一個 pending 或 in_progress 的任務。任務實際完成後，必須呼叫 {{tool}} 工具回寫其狀態。不要只描述步驟，不要在未呼叫工具的情況下用文字宣稱已完成，也不要詢問是否繼續、是否開始、是否推進。狀態只允許 pending、in_progress、completed，沒有阻塞或失敗狀態。若某個任務確實無法完成（被阻塞、失敗或缺少前置條件），請把簡要錯誤說明追加寫入 .LLSOAI/task_error.md（檔案不存在則建立），然後仍將該任務標記為 completed 並繼續下一個，避免任務流卡死。',
        planningPathLabel: '方案檔案路徑',
        startPrompt: '@llsccai-task 請先在 IDE 中開啟 Markdown 方案規劃文件，或刪除此句並使用自己的提示詞',
        openMarkdownOrEditPrompt: '請先在 IDE 中開啟 Markdown 方案規劃文件，或修改 @llsccai-task 後面的提示詞再試。',
        startTooltip: '點擊向 Claude Code 發送 @llsccai-task 以啟動任務流',
        completedTooltip: '點擊清空已完成任務流並發起新的 @llsccai-task',
        runningTooltip: '目前任務流仍在執行中，是否繼續推進，或清空並發起新的任務流？',
        continueAction: '繼續推進',
        clearAndNew: '清空並新建',
        cancel: '取消',
        outputLanguageName: '繁體中文',
        missingToolCircuitBreaker: '目前 llsccai-task 任務流連續多輪只輸出文字、未呼叫任何工具，自動續推已暫停。請檢查任務流狀態，如需繼續請手動發送新的提示詞。'
    },
    ko: {
        statusLabel: '작업 흐름',
        analyzing: '계획 문서를 분석하고 작업 흐름을 생성하는 중...',
        completed: '작업 흐름 완료',
        failed: '작업 흐름 실패',
        continuePrompt: '현재 llsccai-task 작업 흐름을 계속 실행하세요.',
        continuePromptWhenToolMissing: '이전 턴에서는 텍스트만 출력하고 실제 도구를 호출하지 않았습니다. 이번 턴에서는 반드시 실제 tool_use 호출(update_llsccai_task_workflow, Write, Edit, Bash 등)로 실행하세요. 텍스트만으로 작업 완료나 상태 업데이트를 주장하지 마세요.',
        continueNextTaskLabel: '다음 실행할 작업',
        continueUpdateInstruction: 'pending 또는 in_progress 상태의 다음 작업을 바로 실행하세요. 작업이 실제로 완료되면 반드시 {{tool}} 도구를 호출하여 상태를 갱신해야 합니다. 단계만 설명하지 말고, 도구를 호출하지 않은 채 텍스트로 완료를 주장하지 말며, 계속·시작·진행 여부를 묻지 마세요. 허용되는 상태는 pending, in_progress, completed 뿐이며 차단(blocked)이나 실패 상태는 없습니다. 어떤 작업을 끝낼 수 없다면(차단, 실패, 선행 조건 부족) 간단한 오류 설명을 .LLSOAI/task_error.md 에 추가로 기록한 뒤(파일이 없으면 생성), 그래도 해당 작업을 completed 로 표시하고 다음으로 진행하여 작업 흐름이 멈추지 않게 하세요.',
        planningPathLabel: '계획 파일 경로',
        startPrompt: '@llsccai-task IDE에서 Markdown 계획 문서를 열거나 이 문장을 삭제하고 직접 프롬프트를 입력하세요.',
        openMarkdownOrEditPrompt: 'IDE에서 Markdown 계획 문서를 열거나 @llsccai-task 뒤의 프롬프트를 수정한 뒤 다시 시도하세요.',
        startTooltip: 'Claude Code에 @llsccai-task를 보내 작업 흐름 시작',
        completedTooltip: '완료된 작업 흐름을 지우고 새 작업 흐름 시작',
        runningTooltip: '작업 흐름이 아직 실행 중입니다. 계속 진행하시겠습니까, 아니면 지우고 새 작업 흐름을 시작하시겠습니까?',
        continueAction: '계속 진행',
        clearAndNew: '지우고 새로 시작',
        cancel: '취소',
        outputLanguageName: 'Korean',
        missingToolCircuitBreaker: 'llsccai-task 작업 흐름이 여러 차례 텍스트만 응답하고 어떤 도구도 호출하지 않았습니다. 자동 진행이 일시 중지되었습니다. 작업 흐름을 확인하고 필요 시 새 프롬프트를 수동으로 보내세요.'
    },
    ja: {
        statusLabel: 'タスクフロー',
        analyzing: '計画ドキュメントを分析してタスクフローを生成しています...',
        completed: 'タスクフロー完了',
        failed: 'タスクフロー失敗',
        continuePrompt: '現在の llsccai-task タスクフローを続行してください。',
        continuePromptWhenToolMissing: '前回のターンではテキストのみを出力し、実際にツールを呼び出していません。今回のターンでは必ず実際の tool_use 呼び出し（update_llsccai_task_workflow、Write、Edit、Bash など）で実行してください。テキストだけでタスク完了やステータス更新を主張してはいけません。',
        continueNextTaskLabel: '次に実行するタスク',
        continueUpdateInstruction: 'pending または in_progress の次のタスクを直接実行してください。タスクが実際に完了したら、必ず {{tool}} ツールを呼び出してステータスを更新してください。手順を説明するだけにせず、ツールを呼び出さずにテキストで完了を主張せず、続行・開始・進行の可否を尋ねないでください。 使用できるステータスは pending、in_progress、completed のみで、ブロックや失敗のステータスはありません。タスクを完了できない場合（ブロック、失敗、前提条件の不足）は、簡潔なエラー説明を .LLSOAI/task_error.md に追記し（ファイルがなければ作成）、それでもそのタスクを completed にして次へ進み、タスクフローが停止しないようにしてください。',
        planningPathLabel: '計画ファイルパス',
        startPrompt: '@llsccai-task IDE で Markdown 計画ドキュメントを開くか、この文を削除して独自のプロンプトを入力してください。',
        openMarkdownOrEditPrompt: 'IDE で Markdown 計画ドキュメントを開くか、@llsccai-task の後ろのプロンプトを変更してから再試行してください。',
        startTooltip: 'Claude Code に @llsccai-task を送信してタスクフローを開始',
        completedTooltip: '完了したタスクフローをクリアして新規作成',
        runningTooltip: 'タスクフローはまだ実行中です。続行しますか、それともクリアして新規作成しますか？',
        continueAction: '続行',
        clearAndNew: 'クリアして新規作成',
        cancel: 'キャンセル',
        outputLanguageName: 'Japanese',
        missingToolCircuitBreaker: 'llsccai-task タスクフローが連続して複数回テキストのみを返し、ツールを呼び出していません。自動続行を一時停止しました。タスクフローを確認し、必要に応じて新しいプロンプトを手動で送信してください。'
    },
    fr: {
        statusLabel: 'Flux de tâches',
        analyzing: 'Analyse du document de planification et génération du flux de tâches...',
        completed: 'Flux de tâches terminé',
        failed: 'Échec du flux de tâches',
        continuePrompt: 'Continuez à exécuter le flux de tâches llsccai-task actif.',
        continuePromptWhenToolMissing: 'Au tour précédent vous n’avez produit que du texte sans appeler aucun outil. Ce tour-ci vous DEVEZ exécuter via de vrais appels d’outils (update_llsccai_task_workflow, Write, Edit, Bash, etc.). N’affirmez jamais qu’une tâche est terminée ou que le statut est mis à jour uniquement en texte.',
        continueNextTaskLabel: 'Prochaine tâche à exécuter',
        continueUpdateInstruction: 'Exécutez directement la prochaine tâche pending ou in_progress. Une fois le travail réellement effectué, vous DEVEZ appeler l’outil {{tool}} pour mettre à jour son statut. Ne vous contentez pas de décrire l’étape, n’affirmez pas l’achèvement en texte sans appeler l’outil, et ne demandez pas s’il faut continuer, démarrer ou poursuivre. Les seuls statuts autorisés sont pending, in_progress et completed ; il n’existe ni statut bloqué ni statut échoué. Si une tâche ne peut pas être terminée (blocage, échec ou prérequis manquant), ajoutez une brève explication dans .LLSOAI/task_error.md (créez le fichier si nécessaire), puis marquez tout de même la tâche comme completed et passez à la suivante, afin que le flux ne se bloque jamais.',
        planningPathLabel: 'Chemin du fichier de planification',
        startPrompt: '@llsccai-task Ouvrez un document de planification Markdown dans l’IDE, ou supprimez cette phrase et utilisez votre propre prompt.',
        openMarkdownOrEditPrompt: 'Ouvrez un document de planification Markdown dans l’IDE, ou modifiez le prompt après @llsccai-task puis réessayez.',
        startTooltip: 'Cliquer pour envoyer @llsccai-task à Claude Code et démarrer un flux de tâches',
        completedTooltip: 'Cliquer pour effacer le flux terminé et en démarrer un nouveau',
        runningTooltip: 'Un flux de tâches est encore en cours. Continuer, ou effacer et en démarrer un nouveau ?',
        continueAction: 'Continuer',
        clearAndNew: 'Effacer et recommencer',
        cancel: 'Annuler',
        outputLanguageName: 'French',
        missingToolCircuitBreaker: 'Le flux de tâches llsccai-task a répondu plusieurs fois en texte uniquement sans appeler aucun outil. La continuation automatique est suspendue. Vérifiez le flux et envoyez manuellement un nouveau prompt si besoin.'
    },
    de: {
        statusLabel: 'Task-Flow',
        analyzing: 'Planungsdokument wird analysiert und Task-Flow wird erzeugt...',
        completed: 'Task-Flow abgeschlossen',
        failed: 'Task-Flow fehlgeschlagen',
        continuePrompt: 'Führen Sie den aktiven llsccai-task Task-Flow weiter aus.',
        continuePromptWhenToolMissing: 'In der letzten Runde haben Sie nur Text ausgegeben und kein Tool wirklich aufgerufen. In dieser Runde MÜSSEN Sie über echte Tool-Aufrufe (update_llsccai_task_workflow, Write, Edit, Bash usw.) ausführen. Behaupten Sie nicht nur in Text, dass eine Aufgabe abgeschlossen oder der Status aktualisiert wurde.',
        continueNextTaskLabel: 'Nächste auszuführende Aufgabe',
        continueUpdateInstruction: 'Führen Sie die nächste Aufgabe mit Status pending oder in_progress direkt aus. Sobald die Arbeit tatsächlich erledigt ist, MÜSSEN Sie das Tool {{tool}} aufrufen, um den Status zu aktualisieren. Beschreiben Sie nicht nur den Schritt, behaupten Sie den Abschluss nicht in Text ohne Tool-Aufruf, und fragen Sie nicht, ob fortgefahren, begonnen oder weitergemacht werden soll. Erlaubt sind ausschließlich die Status pending, in_progress und completed; einen Status für blockiert oder fehlgeschlagen gibt es nicht. Kann eine Aufgabe nicht abgeschlossen werden (blockiert, fehlgeschlagen oder fehlende Voraussetzungen), hängen Sie eine kurze Fehlerbeschreibung an .LLSOAI/task_error.md an (Datei bei Bedarf anlegen), markieren Sie die Aufgabe dennoch als completed und fahren Sie fort, damit der Ablauf nicht stehen bleibt.',
        planningPathLabel: 'Pfad der Planungsdatei',
        startPrompt: '@llsccai-task Öffnen Sie ein Markdown-Planungsdokument in der IDE, oder löschen Sie diesen Satz und verwenden Sie Ihren eigenen Prompt.',
        openMarkdownOrEditPrompt: 'Öffnen Sie ein Markdown-Planungsdokument in der IDE, oder ändern Sie den Prompt nach @llsccai-task und versuchen Sie es erneut.',
        startTooltip: 'Klicken, um @llsccai-task an Claude Code zu senden und einen Task-Flow zu starten',
        completedTooltip: 'Klicken, um den abgeschlossenen Task-Flow zu löschen und neu zu starten',
        runningTooltip: 'Ein Task-Flow läuft noch. Fortsetzen oder löschen und neu starten?',
        continueAction: 'Fortsetzen',
        clearAndNew: 'Löschen und neu starten',
        cancel: 'Abbrechen',
        outputLanguageName: 'German',
        missingToolCircuitBreaker: 'Der llsccai-task Task-Flow hat mehrfach nur Text geantwortet, ohne ein Tool aufzurufen. Die automatische Fortsetzung wurde pausiert. Prüfen Sie den Task-Flow und senden Sie bei Bedarf manuell einen neuen Prompt.'
    }
};

/**
 * 根据 UI 语言读取任务流文案。
 *
 * @param language 当前已解析 UI 语言。
 * @returns 对应语言的任务流文案，缺失时回落英文。
 */
export function getLlsCcaiTaskTexts(language: ResolvedAppLanguage): LlsCcaiTaskTexts {
    return LLS_CCAI_TASK_TEXTS[language] ?? LLS_CCAI_TASK_TEXTS.en;
}
