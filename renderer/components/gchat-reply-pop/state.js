// [Important] Reply Pop · state — classic script; shared state in state.js (var/function globals)
    var ctx = null;
    var sending = false;
    var replyTarget = null;
    var myUserName = '';
    var myIds = [];
    var myLabels = [];
    var minimized = false;
    var pendingAttachments = [];
    var urlParams = new URLSearchParams(location.search);
    var focusName = urlParams.get('name') || '';
    var focusSpace = urlParams.get('space') || '';
    var focusUser = urlParams.get('user') || '';
    var focusContactLabel = urlParams.get('contactTitle') || '';
    var focusSpaceIsDm = urlParams.get('isDm') === '1';
    // [Important] 專注討論串模式：獨立泡泡＋bar，只延續該回覆串
    var isFocusThreadMode = urlParams.get('focusThread') === '1';
    var focusThreadName = urlParams.get('threadName') || '';
    var focusRootTextParam = urlParams.get('focusRootText') || '';
    var focusContactTitleParam = urlParams.get('contactTitle') || '';
    var focusRootMessageName = urlParams.get('rootMessageName') || '';
    // 開啟當下的已讀水位（標已讀前）：用來捲到 firstUnreadMessage；Initial Scroll 完成後才清空
    // [TODO] Phase 2: readUntil 可能在 markConversationRead() 後才被 capture，需延後標已讀
    var openReadUntil = urlParams.get('readUntil') || '';
    var openJumpTo = urlParams.get('jumpTo') || '';
    var headerIconUrl = urlParams.get('iconUrl') || '';
    var headerEmoji = urlParams.get('emoji') || '';
    // [Development Only] Phase 1：Opening Scroll 單一控制器狀態
    var SCROLL_DEBUG = true;
    var openScrollIntent = null;
    var openingScrollState = {
      isOpening: false,
      initialScrollCompleted: false
    };
    var openingScrollGeneration = 0;
    var expandedThreadKeys = new Set();
    var focusRootText = focusRootTextParam;
    var focusContactTitle = focusContactTitleParam;
    var mediaStore = {};
    var mediaSeq = 0;
    var mediaLightboxExternalUrl = '';
    var popCustomEmojiCache = null;
    var popCustomEmojiCachePromise = null;
    var popCustomEmojiWarning = '';
    var REACT_FREQ_KEY = 'gchat-react-freq-v1';
    var DEFAULT_QUICK_REACTS = ['👍', '❤️', '😂', '🆗', '🎉'];
    var QUICK_REACT_SLOTS = 5;
    var mentionTimer = null;
    var mentionHits = [];
    var mentionActive = -1;
    var mentionQuery = '';
    var spaceMembersCache = new Map();
    /** @type {Map<string, Promise<any[]>>} 同一 space 的成員載入去重 */
    var spaceMembersInflight = new Map();
    var liveThread = [];
    var refreshBusy = false;
    var historyHydrating = false;
    var apiQuotaBlockedUntil = 0;
    var livePollTimer = null;
    var pingBound = false;
    var lastThreadPingMessageName = '';
    var failedOptimisticById = new Map();
