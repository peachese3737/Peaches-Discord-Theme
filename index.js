(() => {
  const { after, instead } = vendetta.patcher;
  const unpatches = [];
  const wanted = new Set([
    "CHANNELS_DEFAULT", "TEXT_MUTED", "PANEL_BG", "BACKGROUND_SECONDARY_ALT",
    "BACKGROUND_PRIMARY", "BACKGROUND_MOBILE_PRIMARY", "BG_BASE_PRIMARY", "BACKGROUND_BASE_LOW"
  ]);

  function semanticName(args) {
    const keys = ["name", "key", "id", "token", "semanticColor", "color"];
    for (const arg of args) {
      if (typeof arg === "string" && wanted.has(arg.toUpperCase())) return arg.toUpperCase();
      if (typeof arg === "symbol") {
        const n = String(arg.description || "").toUpperCase();
        if (wanted.has(n)) return n;
      }
      if (arg && typeof arg === "object") for (const k of keys) {
        if (typeof arg[k] === "string" && wanted.has(arg[k].toUpperCase())) return arg[k].toUpperCase();
      }
    }
    return "";
  }

  function semanticOverride(args) {
    const n = semanticName(args);
    if (n === "CHANNELS_DEFAULT") return "#D69AB4";
    if (n === "TEXT_MUTED") return "#B596C8";
    if (n === "PANEL_BG" || n === "BACKGROUND_SECONDARY_ALT") return "#5A2947";
    if (["BACKGROUND_PRIMARY", "BACKGROUND_MOBILE_PRIMARY", "BG_BASE_PRIMARY", "BACKGROUND_BASE_LOW"].includes(n)) return "#32162F";
    return null;
  }

  function replacementForRGB(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 16) return null;
    const v = (r + g + b) / 3;
    if (v <= 14) return [3,2,4];
    if (v <= 24) return [5,4,7];
    if (v <= 36) return [28,13,42];
    if (v <= 50) return [90,41,71];
    if (v <= 68) return [90,44,80];
    if (v <= 95) return [122,67,109];
    if (v <= 130) return [160,124,173];
    if (v <= 175) return [208,169,217];
    if (v <= 215) return [214,154,180];
    return null;
  }

  function hex2(n) { return n.toString(16).padStart(2, "0"); }

  function recolorString(value) {
    if (typeof value !== "string") return value;
    const m = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (!m) return value;
    const rgb = m[1];
    const r = parseInt(rgb.slice(0,2),16), g = parseInt(rgb.slice(2,4),16), b = parseInt(rgb.slice(4,6),16);
    const rep = replacementForRGB(r,g,b);
    return rep ? `#${hex2(rep[0])}${hex2(rep[1])}${hex2(rep[2])}${m[2] || ""}` : value;
  }

  // RN input colour: 0xRRGGBBAA.
  function recolorRNInputNumber(value) {
    if (typeof value !== "number") return value;
    const u = value >>> 0;
    const r=(u>>>24)&255, g=(u>>>16)&255, b=(u>>>8)&255, a=u&255;
    const rep = replacementForRGB(r,g,b);
    if (!rep) return value;
    return ((((rep[0]<<24) | (rep[1]<<16) | (rep[2]<<8) | a)) >>> 0);
  }

  // Android/native processed colour: 0xAARRGGBB.
  function recolorNativeNumber(value) {
    if (typeof value !== "number") return value;
    const u = value >>> 0;
    const a=(u>>>24)&255, r=(u>>>16)&255, g=(u>>>8)&255, b=u&255;
    const rep = replacementForRGB(r,g,b);
    if (!rep) return value;
    return ((a<<24) | (rep[0]<<16) | (rep[1]<<8) | rep[2]) | 0;
  }

  function recolorInput(v) {
    return typeof v === "string" ? recolorString(v) : recolorRNInputNumber(v);
  }

  const colorKey = /(?:^color$|color$|tintcolor$|shadowcolor$|overlaycolor$)/i;
  function sanitizeNative(value, key, depth=0) {
    if (depth > 6 || value == null) return value;
    if (colorKey.test(String(key || ""))) {
      if (typeof value === "number") return recolorNativeNumber(value);
      if (typeof value === "string") return recolorString(value);
    }
    if (Array.isArray(value)) {
      let changed=false;
      const out=value.map((x,i)=>{ const y=sanitizeNative(x,i,depth+1); if(y!==x) changed=true; return y; });
      return changed ? out : value;
    }
    if (typeof value === "object") {
      let out=value, changed=false;
      for (const k of Object.keys(value)) {
        const y=sanitizeNative(value[k],k,depth+1);
        if (y!==value[k]) { if(!changed) out={...value}; out[k]=y; changed=true; }
      }
      return out;
    }
    return value;
  }

  function install() {
    const tokens = vendetta.metro.findByProps("SemanticColor");
    const resolver = tokens?.default?.meta ?? tokens?.default?.internal;
    if (resolver?.resolveSemanticColor) {
      unpatches.push(after("resolveSemanticColor", resolver, (args, result) => semanticOverride(args) ?? (typeof result === "string" ? recolorString(result) : result)));
    }

    const RN = vendetta.metro.common.ReactNative;
    if (RN?.processColor) {
      unpatches.push(instead("processColor", RN, function(args, original) {
        if (typeof args[0] === "string" || typeof args[0] === "number") args[0] = recolorInput(args[0]);
        return original.apply(this,args);
      }));
    }

    // Discord creates many styles lazily after startup. Patch StyleSheet.create so
    // those late-created screens cannot fall back to neutral grey.
    if (RN?.StyleSheet?.create) {
      unpatches.push(instead("create", RN.StyleSheet, function(args, original) {
        if (args[0] && typeof args[0] === "object") args[0] = sanitizeNative(args[0], "style");
        return original.apply(this,args);
      }));
    }

    // Final native-view funnel. This catches colours from components that captured
    // old resolver/processColor references before this plugin loaded.
    const payload = vendetta.metro.findByProps("create", "diff");
    if (payload?.create) {
      unpatches.push(instead("create", payload, function(args, original) {
        if (args[0] && typeof args[0] === "object") args[0] = sanitizeNative(args[0], "props");
        return original.apply(this,args);
      }));
    }
    if (payload?.diff) {
      unpatches.push(instead("diff", payload, function(args, original) {
        if (args[0] && typeof args[0] === "object") args[0] = sanitizeNative(args[0], "props");
        if (args[1] && typeof args[1] === "object") args[1] = sanitizeNative(args[1], "props");
        return original.apply(this,args);
      }));
    }
  }

  return {
    onLoad() { install(); },
    onUnload() { unpatches.splice(0).reverse().forEach(fn => { try { fn(); } catch {} }); }
  };
})()
