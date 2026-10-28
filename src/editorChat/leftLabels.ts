/** @file Localized labels for the left conversation list; session commands and storage identifiers stay stable. */
export interface LeftSessionLabels {
    title: string; intro: string; create: string; empty: string; active: string; saved: string;
    occupied: string; unavailable: string; settings: string; refresh: string; back: string; working: string; switchBusy: string;
}

/** Resolve list controls from the same seven-language setting used by chat. */
export function leftSessionLabels(language: string): LeftSessionLabels {
    const labels: Record<string, string[]> = {
        en: ['Parallel sessions', 'Open a conversation on the left; the main chat stays on the right.', 'New conversation', 'No saved conversations.', 'Current', 'Saved', 'In use', 'Unavailable', 'Settings', 'Refresh', 'Conversation list', 'Opening…'],
        'zh-cn': ['并行会话', '在左侧打开一个独立会话，右侧主会话保持不变。', '新建会话', '暂无已保存的会话。', '当前会话', '已保存', '正在使用', '不可用', '设置', '刷新', '会话列表', '正在打开…'],
        'zh-tw': ['並行會話', '在左側開啟一個獨立會話，右側主會話保持不變。', '新增會話', '暫無已儲存的會話。', '目前會話', '已儲存', '使用中', '無法使用', '設定', '重新整理', '會話列表', '正在開啟…'],
        ja: ['並行セッション', '左側で会話を開きます。右側のメインチャットは変わりません。', '新しい会話', '保存済みの会話はありません。', '現在の会話', '保存済み', '使用中', '利用不可', '設定', '更新', '会話一覧', '開いています…'],
        ko: ['병렬 대화', '왼쪽에서 독립 대화를 엽니다. 오른쪽 기본 대화는 유지됩니다.', '새 대화', '저장된 대화가 없습니다.', '현재 대화', '저장됨', '사용 중', '사용 불가', '설정', '새로 고침', '대화 목록', '여는 중…'],
        fr: ['Sessions parallèles', 'Ouvrez une conversation à gauche ; le chat principal reste à droite.', 'Nouvelle conversation', 'Aucune conversation enregistrée.', 'Actuelle', 'Enregistrée', 'En cours', 'Indisponible', 'Paramètres', 'Actualiser', 'Liste des conversations', 'Ouverture…'],
        de: ['Parallele Sitzungen', 'Unterhaltung links öffnen; der Hauptchat bleibt rechts.', 'Neue Unterhaltung', 'Keine gespeicherten Unterhaltungen.', 'Aktuell', 'Gespeichert', 'Belegt', 'Nicht verfügbar', 'Einstellungen', 'Aktualisieren', 'Unterhaltungsliste', 'Wird geöffnet…']
    };
    const busy: Record<string, string> = {
        en: 'The left conversation is running. Stop its task before switching conversations.',
        'zh-cn': '左侧会话正在执行任务，请先停止该任务再切换会话。',
        'zh-tw': '左側會話正在執行任務，請先停止該任務再切換會話。',
        ja: '左側の会話でタスクを実行中です。切り替える前にタスクを停止してください。',
        ko: '왼쪽 대화에서 작업 중입니다. 대화를 전환하기 전에 작업을 중지하세요.',
        fr: 'La conversation de gauche est active. Arrêtez sa tâche avant de changer de conversation.',
        de: 'Die linke Unterhaltung führt eine Aufgabe aus. Vor dem Wechsel die Aufgabe stoppen.'
    };
    const values = labels[language] || labels.en;
    return { ...Object.fromEntries(['title', 'intro', 'create', 'empty', 'active', 'saved', 'occupied', 'unavailable', 'settings', 'refresh', 'back', 'working']
        .map((key, index) => [key, values[index]])), switchBusy: busy[language] || busy.en } as unknown as LeftSessionLabels;
}
