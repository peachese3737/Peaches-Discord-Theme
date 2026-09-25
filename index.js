(() => {
  const api = globalThis.vendetta;
  if (!api?.patcher || !api?.metro) {
    throw new Error("Peaches Onyx Fix benötigt Revenge Classic/Vendetta API.");
  }

  const { after, instead } = api.patcher;
  const metro = api.metro;
  const unpatches = [];
  const timers = [];
  const patched = new WeakMap();

  const SEMANTIC_OVERRIDES = {
    CHANNELS_DEFAULT: "#D69AB4",
    TEXT_MUTED: "#B596C8",
    PANEL_BG: "#5A2947",
    BACKGROUND_SECONDARY_ALT: "#5A2947",
    BACKGROUND_PRIMARY: "#32162F",
    BACKGROUND_MOBILE_PRIMARY: "#32162F",
    BG_BASE_PRIMARY: "#32162F",
    BACKGROUND_BASE_LOW: "#32162F"
  };

  const SEMANTIC_NAMES = new Set(Object.keys(SEMANTIC_OVERRIDES));
  const COLOR_KEYS = /(?:^|_)(?:color|tint|background|foreground)(?:$|_)|(?:color|tintcolor)$/i;

  function remember(target, key) {
    if (!target || typeof target[key] !== "function") return false;
    let keys = patched.get(target);
    if (!keys) patched.set(target, keys = new Set());
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  }

  function semanticName(args) {
    const keys = ["name", "key", "id", "token", "semanticColor", "color"];
    for (const arg of args || []) {
      if (typeof arg === "string") {
        const name = arg.toUpperCase();
        if (SEMANTIC_NAMES.has(name)) return name;
      } else if (typeof arg === "symbol") {
        const name = String(arg.description || "").toUpperCase();
        if (SEMANTIC_NAMES.has(name)) return name;
      } else if (arg && typeof arg === "object") {
        for (const key of keys) {
          if (typeof arg[key] !== "string") continue;
          const name = arg[key].toUpperCase();
          if (SEMANTIC_NAMES.has(name)) return name;
        }
      }
    }
    return "";
  }

  function replacementRGB(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 16) return null;
    const value = (r + g + b) / 3;
    if (value <= 14) return [3, 2, 4];
    if (value <= 24) return [5, 4, 7];
    if (value <= 36) return [28, 13, 42];
    if (value <= 50) return [90, 41, 71];
    if (value <= 68) return [90, 44, 80];
    if (value <= 95) return [122, 67, 109];
    if (value <= 130) return [160, 124, 173];
    if (value <= 175) return [208, 169, 217];
    if (value <= 215) return [214, 154, 180];
    return null;
  }

  function hex2(value) {
    return value.toString(16).padStart(2, "0");
  }

  function recolorHex(value) {
    if (typeof value !== "string") return value;
    const match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (!match) return value;
    const rgb = match[1];
    const replacement = replacementRGB(
      parseInt(rgb.slice(0, 2), 16),
      parseInt(rgb.slice(2, 4), 16),
      parseInt(rgb.slice(4, 6), 16)
    );
    if (!replacement) return value;
    return `#${hex2(replacement[0])}${hex2(replacement[1])}${hex2(replacement[2])}${match[2] || ""}`;
  }

  // React Native returns Android colours as signed 0xAARRGGBB values.
  function recolorProcessedColor(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    const unsigned = value >>> 0;
    const alpha = (unsigned >>> 24) & 255;
    const red = (unsigned >>> 16) & 255;
    const green = (unsigned >>> 8) & 255;
    const blue = unsigned & 255;
    const replacement = replacementRGB(red, green, blue);
    if (!replacement) return value;
    return ((alpha << 24) | (replacement[0] << 16) | (replacement[1] << 8) | replacement[2]) | 0;
  }

  function sanitizeStyle(value, key, depth = 0, seen = new WeakSet()) {
    if (depth > 7 || value == null) return value;
    if (typeof value === "string") {
      return COLOR_KEYS.test(String(key || "")) ? recolorHex(value) : value;
    }
    if (typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      let changed = false;
      const copy = value.map((entry, index) => {
        const next = sanitizeStyle(entry, index, depth + 1, seen);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? copy : value;
    }

    let copy = value;
    let changed = false;
    for (const childKey of Object.keys(value)) {
      const next = sanitizeStyle(value[childKey], childKey, depth + 1, seen);
      if (next === value[childKey]) continue;
      if (!changed) copy = { ...value };
      copy[childKey] = next;
      changed = true;
    }
    return copy;
  }

  function installSemanticPatch() {
    const tokens = metro.findByProps("SemanticColor");
    const resolver = tokens?.default?.meta ?? tokens?.default?.internal ?? tokens?.meta ?? tokens?.internal;
    if (!resolver?.resolveSemanticColor || !remember(resolver, "resolveSemanticColor")) return false;
    unpatches.push(after("resolveSemanticColor", resolver, (args, result) => {
      try {
        const name = semanticName(args);
        return SEMANTIC_OVERRIDES[name] ?? recolorHex(result);
      } catch {
        return result;
      }
    }));
    return true;
  }

  function installReactNativePatches() {
    const ReactNative = metro.common?.ReactNative;
    if (!ReactNative) return false;
    let installed = false;

    // Recolour the processed result, not the input. This avoids confusing
    // 0xRRGGBBAA with Android's 0xAARRGGBB on newer Discord builds.
    if (ReactNative.processColor && remember(ReactNative, "processColor")) {
      unpatches.push(instead("processColor", ReactNative, function (args, original) {
        const result = original.apply(this, args);
        try { return recolorProcessedColor(result); } catch { return result; }
      }));
      installed = true;
    }

    if (ReactNative.StyleSheet?.create && remember(ReactNative.StyleSheet, "create")) {
      unpatches.push(instead("create", ReactNative.StyleSheet, function (args, original) {
        try {
          if (args[0] && typeof args[0] === "object") {
            args[0] = sanitizeStyle(args[0], "styles");
          }
        } catch {}
        return original.apply(this, args);
      }));
      installed = true;
    }

    if (ReactNative.StyleSheet?.flatten && remember(ReactNative.StyleSheet, "flatten")) {
      unpatches.push(after("flatten", ReactNative.StyleSheet, (_args, result) => {
        try { return sanitizeStyle(result, "style"); } catch { return result; }
      }));
      installed = true;
    }

    return installed;
  }

  function installAvailablePatches() {
    try { installSemanticPatch(); } catch {}
    try { installReactNativePatches(); } catch {}
  }

  function stop() {
    while (timers.length) clearTimeout(timers.pop());
    while (unpatches.length) {
      try { unpatches.pop()(); } catch {}
    }
  }

  return {
    onLoad() {
      installAvailablePatches();
      // Discord loads some Metro modules lazily. Short guarded retries catch
      // them without leaving a permanent interval running.
      for (const delay of [500, 1500, 4000]) {
        timers.push(setTimeout(installAvailablePatches, delay));
      }
    },
    onUnload: stop
  };
})()
