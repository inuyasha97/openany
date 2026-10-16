/**
 * OMP model-role rows (Settings → Session Defaults) — merged into each locale's
 * main dictionary.
 *
 * Only the labels around the table are translated: a role name (`default`,
 * `smol`, …) and a model id are identifiers that come from OMP's config, so
 * they are rendered as they are.
 */
export const modelRolesI18n = {
  en: {
    'settings.openchamber.modelRoles.title': 'Model roles',
    'settings.openchamber.modelRoles.info': "OMP resolves each role to its own model. A role with no model set falls back to OMP's own default.",
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Applies to sessions started after the change.',
    'settings.openchamber.modelRoles.unset': 'Not set',
    'settings.openchamber.modelRoles.chooseModel': 'Choose a model for the {role} role',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Search models',
  },
  de: {
    'settings.openchamber.modelRoles.title': 'Modellrollen',
    'settings.openchamber.modelRoles.info': 'OMP löst jede Rolle auf ihr eigenes Modell auf. Eine Rolle ohne gesetztes Modell greift auf OMPs eigenen Standard zurück.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Gilt für Sitzungen, die nach der Änderung gestartet werden.',
    'settings.openchamber.modelRoles.unset': 'Nicht festgelegt',
    'settings.openchamber.modelRoles.chooseModel': 'Ein Modell für die Rolle {role} auswählen',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Modelle durchsuchen',
  },
  fr: {
    'settings.openchamber.modelRoles.title': 'Rôles de modèle',
    'settings.openchamber.modelRoles.info': "OMP associe chaque rôle à son propre modèle. Un rôle sans modèle défini retombe sur la valeur par défaut d'OMP.",
    'settings.openchamber.modelRoles.appliesToNewSessions': 'S\'applique aux sessions démarrées après la modification.',
    'settings.openchamber.modelRoles.unset': 'Non défini',
    'settings.openchamber.modelRoles.chooseModel': 'Choisir un modèle pour le rôle {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Rechercher des modèles',
  },
  nl: {
    'settings.openchamber.modelRoles.title': 'Modelrollen',
    'settings.openchamber.modelRoles.info': 'OMP koppelt elke rol aan zijn eigen model. Een rol zonder ingesteld model valt terug op de eigen standaard van OMP.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Geldt voor sessies die na de wijziging zijn gestart.',
    'settings.openchamber.modelRoles.unset': 'Niet ingesteld',
    'settings.openchamber.modelRoles.chooseModel': 'Kies een model voor de rol {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Modellen zoeken',
  },
  es: {
    'settings.openchamber.modelRoles.title': 'Roles de modelo',
    'settings.openchamber.modelRoles.info': 'OMP resuelve cada rol con su propio modelo. Un rol sin modelo definido usa el valor predeterminado de OMP.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Se aplica a las sesiones iniciadas después del cambio.',
    'settings.openchamber.modelRoles.unset': 'Sin definir',
    'settings.openchamber.modelRoles.chooseModel': 'Elegir un modelo para el rol {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Buscar modelos',
  },
  ja: {
    'settings.openchamber.modelRoles.title': 'モデルの役割',
    'settings.openchamber.modelRoles.info': 'OMP は各役割をそれぞれのモデルに割り当てます。モデルが設定されていない役割は OMP 自身の既定値にフォールバックします。',
    'settings.openchamber.modelRoles.appliesToNewSessions': '変更後に開始したセッションに適用されます。',
    'settings.openchamber.modelRoles.unset': '未設定',
    'settings.openchamber.modelRoles.chooseModel': '{role} の役割に使うモデルを選択',
    'settings.openchamber.modelRoles.searchPlaceholder': 'モデルを検索',
  },
  'pt-BR': {
    'settings.openchamber.modelRoles.title': 'Funções de modelo',
    'settings.openchamber.modelRoles.info': 'O OMP resolve cada função com o seu próprio modelo. Uma função sem modelo definido usa o padrão do próprio OMP.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Vale para sessões iniciadas após a alteração.',
    'settings.openchamber.modelRoles.unset': 'Não definido',
    'settings.openchamber.modelRoles.chooseModel': 'Escolher um modelo para a função {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Pesquisar modelos',
  },
  uk: {
    'settings.openchamber.modelRoles.title': 'Ролі моделей',
    'settings.openchamber.modelRoles.info': 'OMP зіставляє кожну роль з окремою моделлю. Роль без заданої моделі використовує власне значення OMP за замовчуванням.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Застосовується до сесій, розпочатих після зміни.',
    'settings.openchamber.modelRoles.unset': 'Не задано',
    'settings.openchamber.modelRoles.chooseModel': 'Виберіть модель для ролі {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Пошук моделей',
  },
  ko: {
    'settings.openchamber.modelRoles.title': '모델 역할',
    'settings.openchamber.modelRoles.info': 'OMP는 각 역할을 해당하는 모델로 해석합니다. 모델이 지정되지 않은 역할은 OMP 자체 기본값으로 대체됩니다.',
    'settings.openchamber.modelRoles.appliesToNewSessions': '변경 후 시작된 세션에 적용됩니다.',
    'settings.openchamber.modelRoles.unset': '설정 안 됨',
    'settings.openchamber.modelRoles.chooseModel': '{role} 역할에 사용할 모델 선택',
    'settings.openchamber.modelRoles.searchPlaceholder': '모델 검색',
  },
  pl: {
    'settings.openchamber.modelRoles.title': 'Role modeli',
    'settings.openchamber.modelRoles.info': 'OMP przypisuje każdej roli własny model. Rola bez ustawionego modelu korzysta z domyślnego ustawienia OMP.',
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Dotyczy sesji rozpoczętych po zmianie.',
    'settings.openchamber.modelRoles.unset': 'Nie ustawiono',
    'settings.openchamber.modelRoles.chooseModel': 'Wybierz model dla roli {role}',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Szukaj modeli',
  },
  'zh-CN': {
    'settings.openchamber.modelRoles.title': '模型角色',
    'settings.openchamber.modelRoles.info': 'OMP 会将每个角色解析为各自的模型。未设置模型的角色会回退到 OMP 自身的默认值。',
    'settings.openchamber.modelRoles.appliesToNewSessions': '对更改后启动的会话生效。',
    'settings.openchamber.modelRoles.unset': '未设置',
    'settings.openchamber.modelRoles.chooseModel': '为 {role} 角色选择模型',
    'settings.openchamber.modelRoles.searchPlaceholder': '搜索模型',
  },
  'zh-TW': {
    'settings.openchamber.modelRoles.title': '模型角色',
    'settings.openchamber.modelRoles.info': 'OMP 會將每個角色解析為各自的模型。未設定模型的角色會回退到 OMP 本身的預設值。',
    'settings.openchamber.modelRoles.appliesToNewSessions': '對變更後啟動的工作階段生效。',
    'settings.openchamber.modelRoles.unset': '未設定',
    'settings.openchamber.modelRoles.chooseModel': '為 {role} 角色選擇模型',
    'settings.openchamber.modelRoles.searchPlaceholder': '搜尋模型',
  },
  tr: {
    'settings.openchamber.modelRoles.title': 'Model rolleri',
    'settings.openchamber.modelRoles.info': "OMP her rolü kendi modeline çözer. Model atanmamış bir rol OMP'nin kendi varsayılanına döner.",
    'settings.openchamber.modelRoles.appliesToNewSessions': 'Değişiklikten sonra başlatılan oturumlarda geçerlidir.',
    'settings.openchamber.modelRoles.unset': 'Ayarlanmadı',
    'settings.openchamber.modelRoles.chooseModel': '{role} rolü için model seç',
    'settings.openchamber.modelRoles.searchPlaceholder': 'Model ara',
  },
} as const;
