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
    /** 清空并新建按钮文案。 */
    clearAndNew: string;
    /** 取消按钮文案。 */
    cancel: string;
    /** 输出语言名称。 */
    outputLanguageName: string;
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
        planningPathLabel: 'Planning file path',
        startPrompt: '@llsccai-task Please open a Markdown planning document in the IDE, or delete this sentence and use your own prompt.',
        openMarkdownOrEditPrompt: 'Please open a Markdown planning document in the IDE, or modify the prompt after @llsccai-task and try again.',
        startTooltip: 'Click to send @llsccai-task to Claude Code and start a workflow',
        completedTooltip: 'Click to clear the completed workflow and start a new one',
        clearAndNew: 'Clear and Start New',
        cancel: 'Cancel',
        outputLanguageName: 'English'
    },
    'zh-cn': {
        statusLabel: '任务流',
        analyzing: '正在分析方案规划文档并生成任务流...',
        completed: '任务流已完成',
        failed: '任务流失败',
        continuePrompt: '请继续执行当前 llsccai-task 任务流。',
        continuePromptWhenToolMissing: '上一轮你只输出了文字，没有真正调用任何工具。本轮必须以真实的 tool_use 工具调用形式执行（如 update_llsccai_task_workflow、Write、Edit、Bash），禁止只用文字声称已完成任务或已更新状态。',
        planningPathLabel: '方案文件路径',
        startPrompt: '@llsccai-task 请先在 IDE 中打开 Markdown 文档，或者删除这段使用自己的提示词',
        openMarkdownOrEditPrompt: '请先在 IDE 中打开 Markdown 方案规划文档，或者修改 @llsccai-task 后面的提示词再试。',
        startTooltip: '点击向 Claude Code 发送 @llsccai-task 启动任务流',
        completedTooltip: '点击清空已完成任务流并发起新的 @llsccai-task',
        clearAndNew: '清空并新建',
        cancel: '取消',
        outputLanguageName: '简体中文'
    },
    'zh-tw': {
        statusLabel: '任務流',
        analyzing: '正在分析方案規劃文件並產生任務流...',
        completed: '任務流已完成',
        failed: '任務流失敗',
        continuePrompt: '請繼續執行目前 llsccai-task 任務流。',
        continuePromptWhenToolMissing: '上一輪你只輸出了文字，沒有真正呼叫任何工具。本輪必須以真實的 tool_use 工具呼叫形式執行（如 update_llsccai_task_workflow、Write、Edit、Bash），禁止只用文字宣稱已完成任務或已更新狀態。',
        planningPathLabel: '方案檔案路徑',
        startPrompt: '@llsccai-task 請先在 IDE 中開啟 Markdown 方案規劃文件，或刪除此句並使用自己的提示詞',
        openMarkdownOrEditPrompt: '請先在 IDE 中開啟 Markdown 方案規劃文件，或修改 @llsccai-task 後面的提示詞再試。',
        startTooltip: '點擊向 Claude Code 發送 @llsccai-task 以啟動任務流',
        completedTooltip: '點擊清空已完成任務流並發起新的 @llsccai-task',
        clearAndNew: '清空並新建',
        cancel: '取消',
        outputLanguageName: '繁體中文'
    },
    ko: {
        statusLabel: '작업 흐름',
        analyzing: '계획 문서를 분석하고 작업 흐름을 생성하는 중...',
        completed: '작업 흐름 완료',
        failed: '작업 흐름 실패',
        continuePrompt: '현재 llsccai-task 작업 흐름을 계속 실행하세요.',
        continuePromptWhenToolMissing: '이전 턴에서는 텍스트만 출력하고 실제 도구를 호출하지 않았습니다. 이번 턴에서는 반드시 실제 tool_use 호출(update_llsccai_task_workflow, Write, Edit, Bash 등)로 실행하세요. 텍스트만으로 작업 완료나 상태 업데이트를 주장하지 마세요.',
        planningPathLabel: '계획 파일 경로',
        startPrompt: '@llsccai-task IDE에서 Markdown 계획 문서를 열거나 이 문장을 삭제하고 직접 프롬프트를 입력하세요.',
        openMarkdownOrEditPrompt: 'IDE에서 Markdown 계획 문서를 열거나 @llsccai-task 뒤의 프롬프트를 수정한 뒤 다시 시도하세요.',
        startTooltip: 'Claude Code에 @llsccai-task를 보내 작업 흐름 시작',
        completedTooltip: '완료된 작업 흐름을 지우고 새 작업 흐름 시작',
        clearAndNew: '지우고 새로 시작',
        cancel: '취소',
        outputLanguageName: 'Korean'
    },
    ja: {
        statusLabel: 'タスクフロー',
        analyzing: '計画ドキュメントを分析してタスクフローを生成しています...',
        completed: 'タスクフロー完了',
        failed: 'タスクフロー失敗',
        continuePrompt: '現在の llsccai-task タスクフローを続行してください。',
        continuePromptWhenToolMissing: '前回のターンではテキストのみを出力し、実際にツールを呼び出していません。今回のターンでは必ず実際の tool_use 呼び出し（update_llsccai_task_workflow、Write、Edit、Bash など）で実行してください。テキストだけでタスク完了やステータス更新を主張してはいけません。',
        planningPathLabel: '計画ファイルパス',
        startPrompt: '@llsccai-task IDE で Markdown 計画ドキュメントを開くか、この文を削除して独自のプロンプトを入力してください。',
        openMarkdownOrEditPrompt: 'IDE で Markdown 計画ドキュメントを開くか、@llsccai-task の後ろのプロンプトを変更してから再試行してください。',
        startTooltip: 'Claude Code に @llsccai-task を送信してタスクフローを開始',
        completedTooltip: '完了したタスクフローをクリアして新規作成',
        clearAndNew: 'クリアして新規作成',
        cancel: 'キャンセル',
        outputLanguageName: 'Japanese'
    },
    fr: {
        statusLabel: 'Flux de tâches',
        analyzing: 'Analyse du document de planification et génération du flux de tâches...',
        completed: 'Flux de tâches terminé',
        failed: 'Échec du flux de tâches',
        continuePrompt: 'Continuez à exécuter le flux de tâches llsccai-task actif.',
        continuePromptWhenToolMissing: 'Au tour précédent vous n’avez produit que du texte sans appeler aucun outil. Ce tour-ci vous DEVEZ exécuter via de vrais appels d’outils (update_llsccai_task_workflow, Write, Edit, Bash, etc.). N’affirmez jamais qu’une tâche est terminée ou que le statut est mis à jour uniquement en texte.',
        planningPathLabel: 'Chemin du fichier de planification',
        startPrompt: '@llsccai-task Ouvrez un document de planification Markdown dans l’IDE, ou supprimez cette phrase et utilisez votre propre prompt.',
        openMarkdownOrEditPrompt: 'Ouvrez un document de planification Markdown dans l’IDE, ou modifiez le prompt après @llsccai-task puis réessayez.',
        startTooltip: 'Cliquer pour envoyer @llsccai-task à Claude Code et démarrer un flux de tâches',
        completedTooltip: 'Cliquer pour effacer le flux terminé et en démarrer un nouveau',
        clearAndNew: 'Effacer et recommencer',
        cancel: 'Annuler',
        outputLanguageName: 'French'
    },
    de: {
        statusLabel: 'Task-Flow',
        analyzing: 'Planungsdokument wird analysiert und Task-Flow wird erzeugt...',
        completed: 'Task-Flow abgeschlossen',
        failed: 'Task-Flow fehlgeschlagen',
        continuePrompt: 'Führen Sie den aktiven llsccai-task Task-Flow weiter aus.',
        continuePromptWhenToolMissing: 'In der letzten Runde haben Sie nur Text ausgegeben und kein Tool wirklich aufgerufen. In dieser Runde MÜSSEN Sie über echte Tool-Aufrufe (update_llsccai_task_workflow, Write, Edit, Bash usw.) ausführen. Behaupten Sie nicht nur in Text, dass eine Aufgabe abgeschlossen oder der Status aktualisiert wurde.',
        planningPathLabel: 'Pfad der Planungsdatei',
        startPrompt: '@llsccai-task Öffnen Sie ein Markdown-Planungsdokument in der IDE, oder löschen Sie diesen Satz und verwenden Sie Ihren eigenen Prompt.',
        openMarkdownOrEditPrompt: 'Öffnen Sie ein Markdown-Planungsdokument in der IDE, oder ändern Sie den Prompt nach @llsccai-task und versuchen Sie es erneut.',
        startTooltip: 'Klicken, um @llsccai-task an Claude Code zu senden und einen Task-Flow zu starten',
        completedTooltip: 'Klicken, um den abgeschlossenen Task-Flow zu löschen und neu zu starten',
        clearAndNew: 'Löschen und neu starten',
        cancel: 'Abbrechen',
        outputLanguageName: 'German'
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
