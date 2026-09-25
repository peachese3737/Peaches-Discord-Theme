(() => {
  const api = globalThis.vendetta;
  if (!api?.patcher || !api?.metro || !api?.plugin?.storage) {
    throw new Error("Peaches MessageVault Persistent benötigt Revenge Classic/Vendetta API.");
  }

  const { before } = api.patcher;
  const metro = api.metro;
  const storage = api.plugin.storage;
  const dispatcher = metro.findByProps("dispatch", "subscribe") ?? metro.findByProps("dispatch", "wait");
  const MessageStore = metro.findByStoreName("MessageStore");

  const MAX_ENTRIES = 1000;
  const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
  const LOAD_ACTIONS = new Set([
    "LOAD_MESSAGES_SUCCESS",
    "LOAD_MESSAGES_SUCCESS_CACHED",
    "LOAD_MESSAGES_AROUND_SUCCESS",
    "LOAD_MESSAGES_BEFORE_SUCCESS",
    "LOAD_MESSAGES_AFTER_SUCCESS"
  ]);

  let unpatch = null;
  let vault = null;

  function toPlain(message) {
    if (!message) return null;
    try {
      const source = typeof message.toJS === "function" ? message.toJS() : message;
      return JSON.parse(JSON.stringify(source, (_key, value) =>
        typeof value === "function" || typeof value === "symbol" ? undefined : value
      ));
    } catch {
      const copy = {};
      for (const key of Object.keys(message)) {
        const value = message[key];
        if (typeof value === "function" || typeof value === "symbol") continue;
        try { JSON.stringify(value); copy[key] = value; } catch {}
      }
      return copy;
    }
  }

  function initialiseVault() {
    const current = storage.peachesMessageVault;
    const deleted = current?.version === 2 && current.deleted && typeof current.deleted === "object"
      ? current.deleted
      : {};

    // One-time migration from the first Deleted Keeper build.
    if (storage.deletedMessages && typeof storage.deletedMessages === "object") {
      for (const [key, record] of Object.entries(storage.deletedMessages)) {
        if (!deleted[key] && record?.messageId && record?.message) deleted[key] = record;
      }
    }

    vault = { version: 2, deleted };
    pruneAndPersist();
  }

  function pruneAndPersist() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const entries = Object.entries(vault?.deleted || {})
      .filter(([, record]) => Number(record?.savedAt || 0) >= cutoff && record?.messageId && record?.message)
      .sort((a, b) => Number(b[1].savedAt || 0) - Number(a[1].savedAt || 0))
      .slice(0, MAX_ENTRIES);
    vault = { version: 2, deleted: Object.fromEntries(entries) };
    // Assign the complete object so the JSON-backed plugin storage reliably
    // notices the update on every supported Revenge Classic build.
    storage.peachesMessageVault = vault;
  }

  function channelIdOf(action, message) {
    return String(
      action?.channelId ?? action?.channel_id ??
      message?.channel_id ?? message?.channelId ?? ""
    );
  }

  function saveDeleted(channelId, message) {
    const plain = toPlain(message);
    const messageId = String(plain?.id ?? message?.id ?? "");
    if (!channelId || !messageId || !plain) return;
    plain.id = messageId;
    if (!plain.channel_id && !plain.channelId) plain.channel_id = channelId;
    vault.deleted[`${channelId}:${messageId}`] = {
      channelId,
      messageId,
      savedAt: Date.now(),
      message: plain
    };
    pruneAndPersist();
  }

  function captureDelete(action) {
    const ids = action?.type === "MESSAGE_DELETE_BULK"
      ? (action.ids ?? action.messageIds ?? [])
      : [action?.id ?? action?.messageId ?? action?.message?.id];
    const hintedMessage = action?.message;
    for (const rawId of ids || []) {
      const id = String(rawId || "");
      const channelId = channelIdOf(action, hintedMessage);
      if (!id || !channelId) continue;
      let original = null;
      try { original = MessageStore?.getMessage?.(channelId, id); } catch {}
      if (!original && String(hintedMessage?.id || "") === id) original = hintedMessage;
      if (original) saveDeleted(channelId, original);
    }
  }

  function snowflake(value) {
    try { return BigInt(String(value)); } catch { return null; }
  }

  function asDeleted(message, prototype) {
    const restored = Object.assign(Object.create(prototype || Object.prototype), message);
    const content = String(message?.content || "*(kein Textinhalt)*")
      .replace(/^🗑️\s*~~/, "")
      .replace(/~~$/, "");
    restored.content = `🗑️ ~~${content}~~`;
    restored.__vaultDeleted = true;
    restored.__peachesRestored = true;
    return restored;
  }

  function getAtPath(object, path) {
    let current = object;
    for (const key of path) current = current?.[key];
    return current;
  }

  function setAtPath(object, path, value) {
    if (!path.length) return value;
    const root = { ...object };
    let source = object;
    let target = root;
    for (let index = 0; index < path.length - 1; index++) {
      const key = path[index];
      const nextSource = source?.[key];
      const nextTarget = Array.isArray(nextSource) ? [...nextSource] : { ...(nextSource || {}) };
      target[key] = nextTarget;
      source = nextSource;
      target = nextTarget;
    }
    target[path[path.length - 1]] = value;
    return root;
  }

  function collectionAdapter(value) {
    if (Array.isArray(value)) {
      return { items: value, rebuild: items => items };
    }
    if (Array.isArray(value?._array)) {
      return {
        items: value._array,
        rebuild: items => ({ ...value, _array: items })
      };
    }
    if (typeof value?.toArray === "function" && typeof value?.clear === "function" && typeof value?.push === "function") {
      try {
        return {
          items: value.toArray(),
          rebuild: items => {
            let collection = value.clear();
            for (const item of items) collection = collection.push(item);
            return collection;
          }
        };
      } catch {}
    }
    return null;
  }

  function isLatestWindow(action) {
    if (action?.hasMoreAfter === false || action?.isAfter === false) return true;
    if (action?.before || action?.after || action?.around || action?.jumpTargetId || action?.messageId) return false;
    // A normal chat-open load has no pagination or jump marker, including in
    // quiet DMs whose newest real message may already be months old.
    return true;
  }

  function mergeDeleted(action, items) {
    if (!items.length) return null;
    const channelId = channelIdOf(action, items[0]);
    if (!channelId) return null;

    const existing = new Set(items.map(message => String(message?.id || "")).filter(Boolean));
    const ids = items.map(message => snowflake(message?.id)).filter(id => id !== null);
    if (!ids.length) return null;
    let oldest = ids[0];
    let newest = ids[0];
    for (const id of ids) {
      if (id < oldest) oldest = id;
      if (id > newest) newest = id;
    }

    const latest = isLatestWindow(action);
    const prototype = Object.getPrototypeOf(items[0]) || Object.prototype;
    const merged = [...items];
    let changed = false;

    for (const record of Object.values(vault?.deleted || {})) {
      if (String(record?.channelId || "") !== channelId || !record?.message) continue;
      const id = snowflake(record.messageId);
      if (id === null || existing.has(String(record.messageId))) continue;
      const inWindow = id >= oldest && id <= newest;
      const belongsToLatestPage = latest && id >= oldest;
      if (!inWindow && !belongsToLatestPage) continue;
      merged.push(asDeleted(record.message, prototype));
      existing.add(String(record.messageId));
      changed = true;
    }

    if (!changed) return null;
    merged.sort((left, right) => {
      const a = snowflake(left?.id);
      const b = snowflake(right?.id);
      return a === null || b === null ? 0 : a < b ? -1 : a > b ? 1 : 0;
    });
    return merged;
  }

  function restoreIntoAction(action) {
    const paths = [
      ["messages"],
      ["messageRecords"],
      ["body", "messages"],
      ["data", "messages"],
      ["result", "messages"],
      ["payload", "messages"]
    ];

    for (const path of paths) {
      const originalCollection = getAtPath(action, path);
      const adapter = collectionAdapter(originalCollection);
      if (!adapter) continue;
      const merged = mergeDeleted(action, adapter.items);
      if (!merged) return action;
      return setAtPath(action, path, adapter.rebuild(merged));
    }
    return action;
  }

  return {
    onLoad() {
      initialiseVault();
      if (!dispatcher?.dispatch || !MessageStore) {
        throw new Error("Discords Dispatcher oder MessageStore wurde nicht gefunden.");
      }
      unpatch = before("dispatch", dispatcher, args => {
        try {
          const action = args?.[0];
          if (!action?.type) return;
          if (action.type === "MESSAGE_DELETE" || action.type === "MESSAGE_DELETE_BULK") {
            captureDelete(action);
          } else if (LOAD_ACTIONS.has(action.type)) {
            args[0] = restoreIntoAction(action);
          }
        } catch {}
      });
    },
    onUnload() {
      try { unpatch?.(); } catch {}
      unpatch = null;
    }
  };
})()
