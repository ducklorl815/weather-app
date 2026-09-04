/**
 * 聯絡人／空間 Icon（頭像 URL 或名稱開頭 emoji）
 * 資料來自 People photos／Chat spaces 原始欄位，不做本機手動設定。
 */

function leadingEmojiFromText(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  try {
    const m = s.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u);
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}

function pickPhotoUrl(photos) {
  const list = Array.isArray(photos) ? photos : [];
  const nonDefault = list.find((p) => p?.url && p.default === false);
  const any = list.find((p) => p?.url);
  return String(nonDefault?.url || any?.url || '').trim();
}

/** 從 Chat Space 原始物件抽出可能的 icon（含未文件化欄位／spaceDetails 深層探測） */
function extractIconFromSpaceRaw(space) {
  if (!space || typeof space !== 'object') return { emoji: '', iconUrl: '' };
  const emoji = String(
    space.emoji
    || space.avatarEmoji
    || space.iconEmoji
    || space.spaceEmoji
    || space.spaceDetails?.emoji
    || space.spaceDetails?.avatarEmoji
    || space.spaceDetails?.iconEmoji
    || leadingEmojiFromText(space.displayName)
    || ''
  ).trim().slice(0, 16);

  const pickUrl = (...vals) => {
    for (const v of vals) {
      const u = String(v || '').trim();
      if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
    }
    return '';
  };

  let iconUrl = pickUrl(
    space.avatarUrl,
    space.avatar?.url,
    space.iconUrl,
    space.icon?.url,
    space.spaceAvatarUrl,
    space.thumbnailUrl,
    space.avatarInfo?.url,
    space.spaceDetails?.avatarUrl,
    space.spaceDetails?.iconUrl,
    space.spaceDetails?.avatar?.url,
    space.spaceDetails?.icon?.url
  );

  // [Temporary] Chat API 文件未暴露 avatar；深層掃描字串值找可能的圖片 URL
  if (!iconUrl) {
    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || iconUrl) return;
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k || '').toLowerCase();
        if (typeof v === 'string') {
          if ((/avatar|icon|thumb|photo|image/i.test(key) || /avatar|icon/i.test(v))
            && (/^https?:\/\//i.test(v) || /^data:image\//i.test(v))) {
            iconUrl = v.trim();
            return;
          }
        } else if (v && typeof v === 'object') {
          walk(v, depth + 1);
        }
      }
    };
    walk(space);
  }

  return { emoji, iconUrl };
}

function extractIconFromMember(member) {
  if (!member || typeof member !== 'object') return { emoji: '', iconUrl: '' };
  const emoji = String(
    member.emoji
    || leadingEmojiFromText(member.displayName)
    || ''
  ).trim().slice(0, 16);
  const iconUrl = String(member.avatarUrl || member.photoUrl || '').trim();
  return { emoji, iconUrl };
}

function userNameToPeopleResource(userName) {
  const raw = String(userName || '').trim().replace(/^users\//i, '');
  if (!raw || raw.includes('@') || raw === 'me') return '';
  const id = raw.startsWith('c') && /^\d+$/.test(raw.slice(1)) ? raw.slice(1) : raw;
  if (!/^\d+$/.test(id)) return '';
  return `people/${id}`;
}

function mergeIcon(prev, next) {
  const a = prev && typeof prev === 'object' ? prev : {};
  const b = next && typeof next === 'object' ? next : {};
  return {
    emoji: String(b.emoji || a.emoji || '').trim().slice(0, 16),
    iconUrl: String(b.iconUrl || a.iconUrl || '').trim()
  };
}

function isUsableIconUrl(url) {
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u) || /^data:image\//i.test(u);
}

/** 群組／無大頭時的字母／emoji 圓形頭像（Chat API 無空間 avatar 欄位時的伺服器側兜底） */
function letterAvatarDataUrl(label, seed = '') {
  const raw = String(label || '').trim() || '?';
  const emoji = leadingEmojiFromText(raw);
  let letter = emoji;
  if (!letter) {
    const cleaned = raw.replace(/^spaces\//i, '').replace(/^[@#\s]+/, '');
    letter = cleaned.charAt(0) || '?';
    if (/[a-z]/.test(letter)) letter = letter.toUpperCase();
  }
  const palette = ['#4f6f8f', '#3d7a5c', '#8a5a3a', '#6a5a8a', '#3a6f7a', '#7a4a5a', '#4a6a4a', '#5a5a7a'];
  const key = String(seed || raw);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash) + key.charCodeAt(i);
  const bg = palette[Math.abs(hash) % palette.length];
  const safe = String(letter).slice(0, 2)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const fontSize = emoji ? 34 : 28;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="32" r="32" fill="${bg}"/>`
    + `<text x="32" y="34" text-anchor="middle" dominant-baseline="central" `
    + `font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, Segoe UI, sans-serif" `
    + `font-size="${fontSize}" fill="#fff">${safe}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * @param {{
 *   getUserIcons: () => Record<string, { emoji?: string, iconUrl?: string }>,
 *   setUserIcon: (userName: string, icon: { emoji?: string, iconUrl?: string }) => void,
 *   getSpaceIcons: () => Record<string, { emoji?: string, iconUrl?: string }>,
 *   setSpaceIcon: (spaceName: string, icon: { emoji?: string, iconUrl?: string }) => void,
 *   getPeopleService: () => object | null,
 *   getSpaceRaw?: (spaceName: string) => Promise<object | null>,
 *   listSpaceMembersRaw?: (spaceName: string, opts?: object) => Promise<object[]>,
 *   isSelfUserName?: (userName: string) => boolean,
 *   withAuthRetry?: (fn: () => Promise<unknown>) => Promise<unknown>
 * }} deps
 */
function createIconService(deps) {
  const withAuthRetry = deps.withAuthRetry || ((fn) => fn());

  function cachedUserIcon(userName) {
    const key = String(userName || '').trim();
    if (!key) return { emoji: '', iconUrl: '' };
    return mergeIcon({}, deps.getUserIcons()?.[key] || {});
  }

  function cachedSpaceIcon(spaceName) {
    const key = String(spaceName || '').trim();
    if (!key) return { emoji: '', iconUrl: '' };
    return mergeIcon({}, deps.getSpaceIcons()?.[key] || {});
  }

  function rememberUserIcon(userName, icon) {
    const key = String(userName || '').trim();
    if (!key || !icon) return;
    const next = mergeIcon(deps.getUserIcons()?.[key], icon);
    if (!next.emoji && !next.iconUrl) return;
    deps.setUserIcon(key, next);
  }

  function rememberSpaceIcon(spaceName, icon) {
    const key = String(spaceName || '').trim();
    if (!key || !icon) return;
    const next = mergeIcon(deps.getSpaceIcons()?.[key], icon);
    if (!next.emoji && !next.iconUrl) return;
    deps.setSpaceIcon(key, next);
  }

  function ingestPersonPhotos(person) {
    if (!person) return;
    const iconUrl = pickPhotoUrl(person.photos);
    if (!iconUrl) return;
    const rn = String(person.resourceName || '');
    if (rn.startsWith('people/')) {
      const rawId = rn.slice('people/'.length);
      if (rawId) {
        rememberUserIcon(`users/${rawId}`, { iconUrl });
        if (rawId.startsWith('c')) rememberUserIcon(`users/${rawId.slice(1)}`, { iconUrl });
      }
    }
    for (const source of person.metadata?.sources || []) {
      const sid = String(source?.id || '').trim();
      if (!sid) continue;
      rememberUserIcon(`users/${sid}`, { iconUrl });
      if (sid.startsWith('c')) rememberUserIcon(`users/${sid.slice(1)}`, { iconUrl });
    }
    for (const email of person.emailAddresses || []) {
      if (email?.value) rememberUserIcon(`users/${email.value}`, { iconUrl });
    }
  }

  async function fetchContactIconFromPeople(userName) {
    const people = deps.getPeopleService?.();
    const resourceName = userNameToPeopleResource(userName);
    if (!people || !resourceName) return { emoji: '', iconUrl: '' };
    try {
      const res = await withAuthRetry(() => people.people.get({
        resourceName,
        personFields: 'photos,names,emailAddresses,metadata'
      }));
      const person = res?.data || null;
      if (!person) return { emoji: '', iconUrl: '' };
      ingestPersonPhotos(person);
      return {
        emoji: leadingEmojiFromText(person.names?.[0]?.displayName),
        iconUrl: pickPhotoUrl(person.photos)
      };
    } catch (_) {
      return { emoji: '', iconUrl: '' };
    }
  }

  async function resolveContactIcon(userName, { force = false } = {}) {
    const key = String(userName || '').trim();
    if (!key) return { emoji: '', iconUrl: '' };
    const cached = cachedUserIcon(key);
    if (!force && (cached.iconUrl || cached.emoji)) return cached;
    const fetched = await fetchContactIconFromPeople(key);
    const next = mergeIcon(cached, fetched);
    rememberUserIcon(key, next);
    return next;
  }

  async function resolveDmPeerUserName(spaceName, preferredPeer = '') {
    const preferred = String(preferredPeer || '').trim();
    if (preferred && !deps.isSelfUserName?.(preferred)) return preferred;
    if (!deps.listSpaceMembersRaw || !spaceName) return preferred && !deps.isSelfUserName?.(preferred) ? preferred : '';
    try {
      const memberships = await deps.listSpaceMembersRaw(spaceName, { pageSize: 12 });
      for (const m of memberships || []) {
        const member = m?.member || {};
        if (member.type === 'BOT') continue;
        const un = String(member.name || '').trim();
        if (!un || un === 'users/me' || un.endsWith('/me')) continue;
        if (deps.isSelfUserName?.(un)) continue;
        return un;
      }
    } catch (_) {}
    return '';
  }

  async function resolveSpaceIcon(spaceName, {
    isDm = false,
    peerUserName = '',
    label = '',
    force = false
  } = {}) {
    const key = String(spaceName || '').trim();
    if (!key) {
      if (peerUserName && !deps.isSelfUserName?.(peerUserName)) {
        return resolveContactIcon(peerUserName, { force });
      }
      return { emoji: leadingEmojiFromText(label), iconUrl: '' };
    }

    // [Important] 私人密語頭像＝對方聯絡人，不可用空間 raw／自己成員大頭
    if (isDm) {
      const peer = await resolveDmPeerUserName(key, peerUserName);
      if (peer) {
        const peerCached = cachedUserIcon(peer);
        if (!force && peerCached.iconUrl) {
          rememberSpaceIcon(key, peerCached);
          return peerCached;
        }
        const peerIcon = await resolveContactIcon(peer, { force });
        const next = mergeIcon({ emoji: leadingEmojiFromText(label) }, peerIcon);
        if (!isUsableIconUrl(next.iconUrl)) {
          next.iconUrl = letterAvatarDataUrl(next.emoji || label || peer, peer);
        }
        rememberUserIcon(peer, next);
        rememberSpaceIcon(key, next);
        return next;
      }
      // 尚無對方 id：不要沿用可能誤存的「自己」spaceIcons
      const seed = { emoji: leadingEmojiFromText(label), iconUrl: '' };
      if (!isUsableIconUrl(seed.iconUrl)) {
        seed.iconUrl = letterAvatarDataUrl(seed.emoji || label || key, key);
      }
      return seed;
    }

    const cached = cachedSpaceIcon(key);
    if (!force && (cached.iconUrl || cached.emoji)) return cached;

    let next = mergeIcon(cached, { emoji: leadingEmojiFromText(label) });

    if (deps.getSpaceRaw) {
      try {
        const space = await deps.getSpaceRaw(key);
        next = mergeIcon(next, extractIconFromSpaceRaw(space));
      } catch (_) {}
    }

    rememberSpaceIcon(key, next);

    // Chat API 不回傳空間自訂 emoji／avatar → 用名稱字母／開頭 emoji 圓形圖
    if (!isUsableIconUrl(next.iconUrl)) {
      const seedLabel = next.emoji || label || key;
      next.iconUrl = letterAvatarDataUrl(seedLabel, key);
      rememberSpaceIcon(key, next);
    }
    return next;
  }

  return {
    leadingEmojiFromText,
    pickPhotoUrl,
    extractIconFromSpaceRaw,
    extractIconFromMember,
    ingestPersonPhotos,
    resolveContactIcon,
    resolveSpaceIcon,
    cachedUserIcon,
    cachedSpaceIcon,
    rememberUserIcon,
    rememberSpaceIcon,
    letterAvatarDataUrl,
    isUsableIconUrl
  };
}

module.exports = {
  createIconService,
  leadingEmojiFromText,
  pickPhotoUrl,
  extractIconFromSpaceRaw,
  extractIconFromMember,
  userNameToPeopleResource,
  mergeIcon,
  letterAvatarDataUrl,
  isUsableIconUrl
};
