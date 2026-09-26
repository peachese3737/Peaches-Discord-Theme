(() => {
  "use strict";
  // Peaches 15: API repairs + restoration. No native payload hooks.
  const VERSION = "15.2";
  const { after, instead } = vendetta.patcher;
  const metro = vendetta.metro;
  const tokens = metro.findByProps("SemanticColor");
  const resolver = tokens?.default?.meta ?? tokens?.default?.internal;
  const { React, ReactNative: RN, clipboard } = metro.common;
  const unpatches = [];
  const stats = { resolver: 0, named: 0, elements: 0, changed: 0, rowNames: 0, panels: 0, hooks: [], failures: [] };
  const observed = new Map();
  let recording = false;
  let timer;
  let active = false;
  let dropped = 0;
  let ownersSeen = 0;

  const palette = Object.freeze({
    name: "#F0A0C8", preview: "#C4A7D6", header: "#1C0D2A",
    composer: "#3B1A2E", panel: "#5A2947", button: "#9B4F84"
  });

  // Revenge 1b1d297: colors/patches/resolver.ts, extractInfo(). The token's
  // name is the VALUE of a symbol-keyed property, not the symbol description.
  function semanticName(value) {
    if (!value || typeof value !== "object") return "";
    try {
      for (const symbol of Object.getOwnPropertySymbols(value)) {
        const name = value[symbol];
        if (typeof name === "string" &&
            Object.prototype.hasOwnProperty.call(tokens.SemanticColor, name)) return name;
      }
    } catch { /* An unrelated/dynamic native colour is not a semantic token. */ }
    return "";
  }

  function hexParts(value) {
    if (typeof value !== "string") return null;
    const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    if (!match) return null;
    const rgb = parseInt(match[1], 16);
    return { r: rgb >>> 16, g: (rgb >>> 8) & 255, b: rgb & 255,
      alpha: match[2] || "" };
  }

  function neutral(value) {
    const p = hexParts(value);
    return p && Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) <= 16;
  }

  function withAlpha(replacement, original) {
    return replacement + (hexParts(original)?.alpha || "");
  }

  // Restore the proven 17:28 conversion for grey chrome, but retain black
  // verbatim. Existing rose/lilac backgrounds and bright message text bypass it.
  // A grey alone CANNOT distinguish a profile panel from an input field.
  function restoreGrey(value) {
    const p = hexParts(value);
    if (!p || !neutral(value)) return value;
    const brightness = (p.r + p.g + p.b) / 3;
    let target;
    if (brightness <= 24) return value;
    if (brightness <= 36) target = palette.header;
    else if (brightness <= 50) target = palette.composer;
    else if (brightness <= 68) target = "#5A2C50";
    else if (brightness <= 95) target = "#7A436D";
    else if (brightness <= 130) target = "#A07CAD";
    else if (brightness <= 175) target = palette.preview;
    else if (brightness <= 215) target = palette.name;
    else return value; // White message text must NOT become pink.
    return target + p.alpha;
  }

  function colour(value) {
    // React Native JS styles and processColor INPUT use RRGGBBAA, not ARGB.
    // Leave resolver numbers alone: its contract is a string, not native ARGB.
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      const hex = "#" + value.toString(16).padStart(8, "0");
      const next = colour(hex);
      return next === hex ? value : parseInt(next.slice(1), 16);
    }
    if (typeof value !== "string") return value;
    // Existing Discord brand blue only; never globally replace purple colours.
    if (/^#5865f2([0-9a-f]{2})?$/i.test(value)) return withAlpha(palette.button, value);
    return restoreGrey(value);
  }

  function semanticColour(name, original) {
    if (typeof original !== "string") return original;
    if (name === "CHANNELS_DEFAULT" || name === "REDESIGN_CHANNEL_NAME_TEXT") {
      return withAlpha(palette.name, original);
    }
    // Only override a grey PANEL_BG. A coloured result may be the already
    // approved DM background (#351923), so never replace that by assumption.
    if (name === "PANEL_BG" && neutral(original)) return withAlpha(palette.panel, original);
    return colour(original);
  }

  function colourLabel(value) {
    // Read-only diagnostics: show colour syntax, never arbitrary string props.
    if (typeof value === "string") {
      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value;
      if (/^(?:rgba?|hsla?)\([0-9.,%+\-\s/deg]*\)$/i.test(value) && value.length <= 90) return value;
      if (/^(transparent|black|white|currentColor)$/i.test(value)) return value;
      const normalized = value.replace(/-/g, "_").toUpperCase();
      if (Object.prototype.hasOwnProperty.call(tokens.SemanticColor || {}, normalized)) return "token:" + normalized;
      return "string(nicht als Farbsyntax erkannt)";
    }
    const name = semanticName(value);
    if (name) return "token:" + name;
    if (typeof value === "number" && Number.isFinite(value)) return "0x" + (value >>> 0).toString(16);
    return typeof value;
  }

  // Explicit opt-in, bounded, memory-only. No text, children, IDs, URLs,
  // accessibility labels, props dumps, network requests or persisted telemetry.
  function note(source, name, before, next) {
    if (!recording) return;
    if (before === undefined && next === undefined) return;
    const key = `${source} ${name || "unbekannt"}: ${colourLabel(before)} -> ${colourLabel(next)}`;
    if (observed.has(key)) observed.set(key, observed.get(key) + 1);
    else if (observed.size < 240) observed.set(key, 1);
    else dropped++;
  }

  function componentName(type) {
    try {
      for (let depth = 0; type && depth < 4; depth++) {
        const name = typeof type === "string" ? type : type.displayName || type.name;
        if (typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_.$()-]{0,70}$/.test(name)) return name;
        // React.memo / forwardRef may hold the useful name on the wrapped type.
        type = type.render || type.type;
      }
    } catch { /* Diagnostic naming must never interrupt rendering. */ }
    return "Komponente";
  }

  function textShape(props, style) {
    const parts = [];
    for (const key of ["fontSize", "lineHeight", "opacity", "height", "borderRadius"]) {
      if (typeof style?.[key] === "number" && Number.isFinite(style[key])) parts.push(key + "=" + style[key]);
    }
    if (/^(normal|bold|[1-9]00)$/.test(String(style?.fontWeight))) parts.push("weight=" + style.fontWeight);
    if (typeof props?.variant === "string" && /^(text|heading|display|label)-[a-z0-9/-]{1,35}$/.test(props.variant)) {
      parts.push("variant=" + props.variant);
    }
    return parts.length ? "[" + parts.join(",") + "]" : "";
  }

  function observeContext(type, props, element) {
    if (!recording || !props || typeof props !== "object") return;
    try {
      const path = [];
      // Optional owner metadata only. Never inspect fiber props/state or text.
      let owner = element?._owner;
      for (let i = 0; owner && i < 6; i++, owner = owner.return) path.push(componentName(owner.type));
      if (path.length) ownersSeen++;
      const prefix = (path.length ? path.reverse().join(" > ") + " > " : "") + componentName(type);
      const flat = props.style == null ? null : RN.StyleSheet.flatten(props.style);
      const shape = textShape(props, flat);
      for (const key of ["color", "backgroundColor"]) {
        if (flat?.[key] !== undefined) note("kontext", prefix + shape + "." + key, flat[key], flat[key]);
      }
      for (const key of ["color", "backgroundColor", "textColor", "tintColor"]) {
        if (props[key] !== undefined) note("kontext-prop", prefix + shape + "." + key, props[key], props[key]);
      }
    } catch { /* Read-only diagnostics cannot break a screen. */ }
  }

  function startRecording() {
    clearTimeout(timer); observed.clear(); dropped = 0; ownersSeen = 0; recording = true;
    timer = setTimeout(() => { recording = false; }, 30000);
  }

  function recolorStyle(style, owner) {
    if (style == null) return style;
    let flat;
    try { flat = RN.StyleSheet.flatten(style); } catch { return style; }
    if (!flat || typeof flat !== "object") return style;
    let next;
    for (const key of ["color", "backgroundColor"]) {
      const value = flat[key];
      // Semantic/dynamic native colour objects are resolved by their owner.
      if (typeof value !== "string" && typeof value !== "number") continue;
      // 15.1 device recording: the bottom pill is a View, height 60,
      // radius 30, #242429. Match all three; never remap this grey globally.
      const profile = key === "backgroundColor" && owner === "View" &&
        flat.height === 60 && flat.borderRadius === 30 &&
        typeof value === "string" && /^(#242429|#3b1a2e)$/i.test(value);
      const result = profile ? palette.panel : colour(value);
      if (profile) stats.panels++;
      note("style", owner + "." + key, value, result);
      if (result !== value) {
        next ??= { ...flat };
        next[key] = result;
        stats.changed++;
      }
    }
    return next || style;
  }

  function recolorRowName(element) {
    if (typeof React.isValidElement !== "function" || typeof React.cloneElement !== "function") return element;
    // Inspect element structure only, never message strings, IDs or callbacks.
    // A preview is the row anchor; its subtree (including activity) is opaque.
    // Reject ambiguous, large or deep trees rather than guessing at a label.
    let budget = 64, overflow = false, previews = 0;
    const candidates = [];
    function inspect(node, depth, path) {
      if (--budget < 0 || depth > 6) { overflow = true; return; }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && !overflow; i++) inspect(node[i], depth + 1, path.concat(i));
        return;
      }
      if (!React.isValidElement(node)) return;
      const name = componentName(node.type);
      if (name === "ChannelRowPreview") { previews++; return; }
      if (name === "ActivityStatusText") return;
      if (node.props?.variant === "text-md/medium") {
        candidates.push({ node, path }); return;
      }
      if (node.props?.children != null) inspect(node.props.children, depth + 1, path.concat("children"));
    }
    try {
      inspect(element, 0, []);
      if (overflow || previews !== 1 || candidates.length !== 1) return element;
      const { node, path } = candidates[0];
      const style = RN.StyleSheet.flatten(node.props.style);
      if (style?.color === palette.name) return element;
      const knownStyle = typeof style?.color === "string" && /^(#abacb2|#c4a7d6|#fbfbfb)$/i.test(style.color);
      const label = colourLabel(node.props.color);
      const knownToken = label === "token:MOBILE_TEXT_HEADING_PRIMARY" || label === "token:TEXT_DEFAULT";
      if (!knownStyle && !(style?.color == null && knownToken)) return element;
      // Preserve the component's colour-prop contract, key, ref and children.
      const replacement = React.cloneElement(node, { style: [node.props.style, { color: palette.name }] });
      function replace(current, index) {
        if (index === path.length) return replacement;
        const part = path[index];
        if (part === "children") return React.cloneElement(current, { children: replace(current.props.children, index + 1) });
        const copy = current.slice(); copy[part] = replace(current[part], index + 1); return copy;
      }
      const result = replace(element, 0);
      stats.rowNames++; stats.changed++;
      note("gezielt", "Chatzeile.Name", style?.color ?? node.props.color, palette.name);
      return result;
    } catch { return element; }
  }

  function patchFactory(module, key, seen) {
    if (!module || typeof module[key] !== "function") return;
    let keys = seen.get(module);
    if (keys?.has(key)) return;
    if (!keys) seen.set(module, keys = new Set());
    keys.add(key);
    try {
      unpatches.push(instead(key, module, function (args, original) {
        stats.elements++;
        const props = args[1];
        const owner = componentName(args[0]);
        // Observe direct native/component colour props, but never modify them
        // without establishing what that component expects.
        if (recording && props && typeof props === "object") {
          for (const key of Object.keys(props)) {
            if (/^(?:color|backgroundColor|tintColor|[A-Za-z]+Color)$/.test(key)) {
              note("prop", owner + "." + key, props[key], props[key]);
            }
          }
        }
        if (props && typeof props === "object" && props.style != null) {
          const style = recolorStyle(props.style, owner);
          if (style !== props.style) args[1] = { ...props, style };
        }
        const element = original.apply(this, args);
        observeContext(args[0], props, element);
        return recolorRowName(element);
      }));
      stats.hooks.push(key);
    } catch { stats.failures.push(key); }
  }

  function report() {
    return [
      `Peaches ${VERSION} – lokale Farbdiagnose`,
      `Hooks: ${stats.hooks.join(", ") || "keine"}`,
      `Nicht verfügbar: ${stats.failures.join(", ") || "keine"}`,
      `Farbaufrufe: ${stats.resolver}; erkannte Tokens: ${stats.named}`,
      `Darstellungselemente: ${stats.elements}; Stiländerungen: ${stats.changed}`,
      `Gezielte Regeln seit Laden: Chatnamen ${stats.rowNames}; Profilleisten ${stats.panels}`,
      `Zuordnungen über Render-Eltern: ${ownersSeen}; verworfene Einträge: ${dropped}`,
      "Keine Chattexte oder Kontodaten erfasst. Kein Upload.",
      "Messung: " + (recording ? "läuft" : "gestoppt"),
      ...Array.from(observed, ([key, count]) => `${count}x ${key}`)
    ].join("\n");
  }

  function Settings() {
    const [output, setOutput] = React.useState(report);
    const e = React.createElement;
    const textStyle = { color: "#F4E9FF", fontSize: 15, marginBottom: 14 };
    const buttonStyle = { backgroundColor: palette.panel, padding: 14, borderRadius: 10, marginBottom: 12 };
    const button = (label, onPress) => e(RN.TouchableOpacity, { style: buttonStyle, onPress },
      e(RN.Text, { style: { color: "#FFFFFF", fontSize: 16 } }, label));
    return e(RN.ScrollView, { style: { backgroundColor: "#351923" }, contentContainerStyle: { padding: 18 } },
      e(RN.Text, { style: textStyle }, "Peaches 15.2 · Rosa Übersichtsnamen und altrosa Profilleiste"),
      e(RN.Text, { style: textStyle }, "Falls noch etwas grau bleibt: Messung starten, zur betroffenen Ansicht wechseln, dann hierher zurückkommen und Bericht kopieren. Es werden nur Farbwerte gezählt."),
      button("Messung starten (30 Sekunden)", () => {
        startRecording();
        setOutput(report());
      }),
      button("Messung stoppen / Bericht anzeigen", () => {
        clearTimeout(timer); recording = false; setOutput(report());
      }),
      button("Bericht kopieren", () => {
        clearTimeout(timer); recording = false;
        const output = report();
        try { clipboard.setString(output); setOutput("Bericht kopiert.\n\n" + output); }
        catch { setOutput("Kopieren nicht verfügbar. Text unten auswählen:\n\n" + output); }
      }),
      button("Beim nächsten Neustart messen", () => {
        try {
          if (!vendetta.plugin?.storage) throw new Error("storage unavailable");
          vendetta.plugin.storage.peachesRecordNextStart = true;
          setOutput("Vorgemerkt. Revenge vollständig neu starten, direkt die Chatübersicht öffnen und dort 30 Sekunden bleiben. Danach hier den Bericht kopieren.");
        } catch { setOutput("Startmessung nicht verfügbar. Bitte die normale Messung verwenden."); }
      }),
      e(RN.Text, { selectable: true, style: { ...textStyle, fontSize: 12 } }, output)
    );
  }

  function unload() {
    clearTimeout(timer); recording = false;
    for (const undo of unpatches.splice(0).reverse()) {
      try { undo(); } catch { /* Continue removing other hooks. */ }
    }
    active = false;
    observed.clear();
  }

  return {
    onLoad() {
      if (active) return;
      if (typeof resolver?.resolveSemanticColor !== "function") {
        throw new Error("Peaches 15: Farbauflösung nicht gefunden; keine Änderungen vorgenommen.");
      }
      stats.hooks.length = 0; stats.failures.length = 0;
      try {
        unpatches.push(after("resolveSemanticColor", resolver, (args, original) => {
          stats.resolver++;
          const name = semanticName(args[1]);
          if (name) stats.named++;
          const result = semanticColour(name, original);
          note("token", name, original, result);
          return result;
        }));
        stats.hooks.push("resolveSemanticColor");
        if (typeof RN.processColor === "function") {
          try {
            unpatches.push(instead("processColor", RN, function (args, original) {
              const next = colour(args[0]);
              note("processColor", "input", args[0], next);
              args[0] = next;
              return original.apply(this, args);
            }));
            stats.hooks.push("processColor");
          } catch { stats.failures.push("processColor"); }
        }
        const seen = new WeakMap();
        patchFactory(React, "createElement", seen);
        // Confirmed API: core/vendetta/api.tsx. findAllByProps never existed.
        if (typeof metro.findByPropsAll === "function") {
          const found = metro.findByPropsAll("jsx", "jsxs");
          if (!Array.isArray(found) || !found.length) stats.failures.push("jsx/jsxs: keine Module");
          if (Array.isArray(found)) for (const mod of found) {
            for (const key of ["jsx", "jsxs", "jsxDEV"]) patchFactory(mod, key, seen);
          }
        } else stats.failures.push("findByPropsAll");
        active = true;
        if (vendetta.plugin?.storage?.peachesRecordNextStart === true) {
          vendetta.plugin.storage.peachesRecordNextStart = false;
          startRecording();
        }
      } catch (error) { unload(); throw error; }
    },
    onUnload: unload,
    settings: Settings
  };
})()
