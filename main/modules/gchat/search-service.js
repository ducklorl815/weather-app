/**
 * GChat Search Service — 聯絡人／空間搜尋（Phase 4A）
 * 不含 IPC／視窗；由 runtime 注入 cache、People API、Chat API。
 */

function extractPersonLabelTail(label) {
  const m = String(label || '').trim().match(/([\u4e00-\u9fff]{2,10}\d{3,5})$/);
  return m ? m[1] : '';
}

function canonicalGchatPersonKey(userName, label, email = '') {
  const tail = extractPersonLabelTail(label);
  if (tail) return `tail:${tail.toLowerCase()}`;
  const em = String(email || '').trim()
    || (String(userName || '').includes('@') ? String(userName).replace(/^users\//i, '') : '');
  if (em.includes('@')) return `email:${em.toLowerCase()}`;
  const raw = String(userName || '').replace(/^users\//i, '');
  const uid = raw.replace(/^c/i, '');
  if (/^\d{5,}$/.test(uid)) return `uid:${uid}`;
  return `raw:${userName}:${label}`;
}

function gchatPersonSearchFields(person) {
  const label = person?.names?.[0]?.displayName
    || person?.emailAddresses?.[0]?.value
    || '';
  const emails = (person?.emailAddresses || []).map((e) => e?.value).filter(Boolean);
  const phones = (person?.phoneNumbers || []).map((p) => String(p?.value || '').replace(/\D/g, '')).filter(Boolean);
  const orgs = (person?.organizations || []).map((o) => [o?.title, o?.department, o?.name].filter(Boolean).join(' ')).filter(Boolean);
  const ids = [];
  for (const source of person?.metadata?.sources || []) {
    if (!source?.id) continue;
    ids.push(`users/${source.id}`);
    if (String(source.id).startsWith('c')) ids.push(`users/${String(source.id).slice(1)}`);
  }
  for (const email of emails) ids.push(`users/${email}`);
  const hay = [label, ...emails, ...phones, ...orgs].join(' ').toLowerCase();
  return { label, emails, phones, orgs, ids, hay };
}

function normalizeGchatSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchGchatQuery(hay, query) {
  const qNorm = normalizeGchatSearchText(query);
  if (!qNorm) return false;
  const hNorm = normalizeGchatSearchText(hay);
  if (!hNorm) return false;
  if (hNorm.includes(qNorm)) return true;
  const tokens = qNorm.split(' ').filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => hNorm.includes(token))) return true;
  const digits = qNorm.replace(/\D/g, '');
  if (digits.length >= 2 && hNorm.replace(/\D/g, '').includes(digits)) return true;
  return false;
}

function isWeakGchatSpaceSearchLabel(label) {
  const s = String(label || '').trim();
  if (!s) return true;
  return s === '對話' || s === '私人訊息' || s === '私人' || s === '成員' || s === '未知';
}

function preferGchatUserName(a, b) {
  const score = (un) => {
    const raw = String(un || '').replace(/^users\//i, '');
    if (/^\d+$/.test(raw)) return 3;
    if (/^c\d+$/i.test(raw)) return 2;
    if (raw.includes('@')) return 1;
    return 0;
  };
  return score(a) >= score(b) ? a : b;
}

/**
 * @param {{
 *   getUserNames: () => Record<string, string>,
 *   getSpaceListState: () => { list: object[], at: number },
 *   setSpaceList: (list: object[]) => void,
 *   getSpaceNames: () => Record<string, string>,
 *   getSpaceTypes?: () => Record<string, string>,
 *   getPinnedSpaces?: () => object[],
 *   getTodayTouchedSpaces?: () => object[],
 *   setSpaceName: (spaceName: string, label: string) => void,
 *   setSpaceType: (spaceName: string, spaceType: string) => void,
 *   isChatReady: () => boolean,
 *   getPeopleService: () => object | null,
 *   listSpaces: (opts: object) => Promise<{ spaces?: object[], nextPageToken?: string }>,
 *   findDirectMessage: (resource: string) => Promise<object | null>,
 *   setupSpace: (body: object) => Promise<object>,
 *   pickRicherLabel: (a: string, b: string) => string,
 *   ingestDirectoryPerson: (person: object) => void,
 *   noteDirectoryError: (err: unknown) => void,
 *   googleErrText: (err: unknown) => string
 * }} deps
 */
function createSearchService(deps) {
  const MAX_SPACE_LIST_PAGES = 20;

  function mergeSpaceHits(existing, incoming) {
    const map = new Map();
    for (const item of existing || []) {
      if (item?.spaceName) map.set(item.spaceName, item);
    }
    for (const item of incoming || []) {
      if (!item?.spaceName) continue;
      const prev = map.get(item.spaceName);
      if (!prev) {
        map.set(item.spaceName, item);
        continue;
      }
      map.set(item.spaceName, {
        ...prev,
        ...item,
        label: deps.pickRicherLabel(prev.label, item.label)
      });
    }
    return [...map.values()];
  }

  function collectSupplementalSpaces() {
    const out = [];
    const seen = new Set();
    const push = (spaceName, label, spaceType = '', isDm = false) => {
      const sn = String(spaceName || '').trim();
      const lbl = String(label || '').trim();
      if (!sn.startsWith('spaces/') || seen.has(sn) || isWeakGchatSpaceSearchLabel(lbl)) return;
      seen.add(sn);
      const resolvedType = String(spaceType || '').trim();
      const dm = isDm || resolvedType === 'DIRECT_MESSAGE';
      out.push({
        kind: 'space',
        spaceName: sn,
        label: lbl,
        spaceType: resolvedType,
        isDm: dm
      });
    };

    const spaceNames = deps.getSpaceNames() || {};
    const spaceTypes = deps.getSpaceTypes?.() || {};
    for (const [spaceName, label] of Object.entries(spaceNames)) {
      push(spaceName, label, spaceTypes[spaceName] || '', spaceTypes[spaceName] === 'DIRECT_MESSAGE');
    }
    for (const item of deps.getPinnedSpaces?.() || []) {
      push(item?.spaceName, item?.label || item?.userName, item?.spaceType || '', !!item?.isDm);
    }
    for (const item of deps.getTodayTouchedSpaces?.() || []) {
      push(
        item?.spaceName,
        item?.label || item?.spaceDisplayName,
        item?.spaceType || '',
        !!item?.isDm
      );
    }
    return out;
  }
    function mergeContactHits(a, b) {
    const label = deps.pickRicherLabel(a?.label, b?.label);
    const richness = (s) => {
      const t = String(s || '').trim();
      if (!t) return 0;
      return t.split(/[-_]/).filter(Boolean).length * 100 + t.length;
    };
    const pickHint = richness(a?.label) >= richness(b?.label) ? a?.hint : b?.hint;
    return {
      kind: 'contact',
      userName: preferGchatUserName(a?.userName, b?.userName),
      label,
      email: a?.email || b?.email || '',
      hint: pickHint || a?.hint || b?.hint || '通訊錄快取',
      iconUrl: a?.iconUrl || b?.iconUrl || '',
      emoji: a?.emoji || b?.emoji || ''
    };
  }

  function attachContactIcon(item) {
    if (!item?.userName) return item;
    const icons = deps.getUserIcons?.() || {};
    const hit = icons[item.userName] || {};
    return {
      ...item,
      iconUrl: item.iconUrl || hit.iconUrl || '',
      emoji: item.emoji || hit.emoji || ''
    };
  }

  function attachSpaceIcon(item) {
    if (!item?.spaceName) return item;
    const icons = deps.getSpaceIcons?.() || {};
    const hit = icons[item.spaceName] || {};
    let iconUrl = item.iconUrl || hit.iconUrl || '';
    let emoji = item.emoji || hit.emoji || '';
    if (!iconUrl && !emoji) {
      try {
        const { letterAvatarDataUrl, leadingEmojiFromText } = require('./icon-service');
        emoji = leadingEmojiFromText(item.label || '');
        iconUrl = letterAvatarDataUrl(emoji || item.label || item.spaceName, item.spaceName);
      } catch (_) {}
    }
    return {
      ...item,
      iconUrl,
      emoji
    };
  }

  async function searchContacts(query, limit = 12) {
    const q = String(query || '').trim();
    if (!q) return [];
    const byPerson = new Map();
    const upsertContact = (item) => {
      if (!item?.userName && !item?.label) return;
      const key = canonicalGchatPersonKey(item.userName, item.label, item.email);
      const prev = byPerson.get(key);
      byPerson.set(key, prev ? mergeContactHits(prev, item) : item);
    };

    for (const [userName, label] of Object.entries(deps.getUserNames() || {})) {
      if (!matchGchatQuery(`${label} ${userName}`, q)) continue;
      upsertContact({
        kind: 'contact',
        userName,
        label: label || userName,
        email: userName.includes('@') ? userName.replace(/^users\//, '') : '',
        hint: '通訊錄快取'
      });
    }

    let results = [...byPerson.values()];
    if (results.length >= limit) return results.slice(0, limit);

    const peopleService = deps.getPeopleService?.();
    if (peopleService) {
      try {
        const res = await peopleService.people.searchDirectoryPeople({
          query: q,
          readMask: 'names,emailAddresses,organizations,phoneNumbers,metadata,photos',
          sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
          pageSize: Math.min(20, limit)
        });
        const userNames = deps.getUserNames() || {};
        for (const person of res.data.people || []) {
          deps.ingestDirectoryPerson?.(person);
          const f = gchatPersonSearchFields(person);
          if (!f.label && !f.emails.length) continue;
          const cachedLabel = f.ids.map((id) => userNames[id]).find(Boolean) || '';
          const label = deps.pickRicherLabel(cachedLabel, f.label || f.emails[0] || '');
          const userName = f.ids.find((id) => id.startsWith('users/') && !id.includes('@'))
            || (f.emails[0] ? `users/${f.emails[0]}` : '')
            || f.ids[0]
            || '';
          upsertContact({
            kind: 'contact',
            userName,
            label: label || f.emails[0] || userName,
            email: f.emails[0] || '',
            hint: f.orgs[0] || (f.phones[0] ? `分機/電話 ${f.phones[0]}` : '網域通訊錄')
          });
          if (byPerson.size >= limit) break;
        }
        results = [...byPerson.values()];
      } catch (err) {
        deps.noteDirectoryError?.(err);
      }
    }
    return results.slice(0, limit).map(attachContactIcon);
  }

  async function listKnownSpaces({ force = false } = {}) {
    if (!deps.isChatReady()) return [];
    const state = deps.getSpaceListState?.() || { list: [], at: 0 };
    if (!force && Array.isArray(state.list) && state.at
        && Date.now() - state.at < 5 * 60 * 1000) {
      return state.list;
    }
    const spaces = [];
    let pageToken = '';
    let pages = 0;
    const spaceNames = deps.getSpaceNames() || {};
    const pull = async (filter) => {
      const res = await deps.listSpaces({
        pageSize: 100,
        pageToken,
        filter
      });
      for (const s of res.spaces || []) {
        const spaceName = s.name || '';
        if (!spaceName) continue;
        const spaceType = s.spaceType || '';
        const label = s.displayName
          || spaceNames[spaceName]
          || (spaceType === 'DIRECT_MESSAGE' ? '私人訊息' : spaceName.replace('spaces/', ''));
        deps.setSpaceName?.(spaceName, label);
        deps.setSpaceType?.(spaceName, spaceType);
        spaces.push({
          kind: 'space',
          spaceName,
          label,
          spaceType,
          isDm: spaceType === 'DIRECT_MESSAGE'
        });
      }
      pageToken = res.nextPageToken || '';
    };
    try {
      do {
        await pull('spaceType = "SPACE" OR spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"');
        pages += 1;
      } while (pageToken && pages < MAX_SPACE_LIST_PAGES);
    } catch (_) {
      pageToken = '';
      pages = 0;
      do {
        await pull('');
        pages += 1;
      } while (pageToken && pages < MAX_SPACE_LIST_PAGES);
    }
    deps.setSpaceList?.(spaces);
    return spaces;
  }

  async function searchSpaces(query, limit = 12) {
    const q = String(query || '').trim();
    if (!q) return [];
    let spaces = [];
    try {
      spaces = await listKnownSpaces({ force: true });
    } catch (err) {
      console.warn('列出 Chat 空間失敗:', err.message);
      try {
        spaces = await listKnownSpaces({ force: false });
      } catch (_) {}
    }
    spaces = mergeSpaceHits(spaces, collectSupplementalSpaces());
    const hits = [];
    for (const s of spaces) {
      if (!matchGchatQuery(`${s.label} ${s.spaceName}`, q)) continue;
      hits.push({
        ...s,
        hint: s.isDm ? '私人訊息' : (s.spaceType === 'GROUP_CHAT' ? '群組' : '空間')
      });
      if (hits.length >= limit) break;
    }
    return hits.map(attachSpaceIcon);
  }

  async function findOrOpenDmSpace(userName) {
    const name = String(userName || '').trim();
    if (!name) throw new Error('缺少聯絡人');
    const resource = name.startsWith('users/') ? name : `users/${name}`;
    const found = await deps.findDirectMessage(resource);
    if (found?.name) return found;
    try {
      const created = await deps.setupSpace({
        space: { spaceType: 'DIRECT_MESSAGE' },
        memberships: [{ member: { name: resource, type: 'HUMAN' } }]
      });
      return created;
    } catch (err) {
      throw new Error(deps.googleErrText(err) || '無法開啟私人訊息（可能尚未有對話，或需重新授權 Chat）');
    }
  }

  return {
    searchContacts,
    listKnownSpaces,
    searchSpaces,
    findOrOpenDmSpace
  };
}

module.exports = {
  createSearchService,
  canonicalGchatPersonKey,
  matchGchatQuery,
  normalizeGchatSearchText
};
