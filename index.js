(() => {
  const { after, instead } = vendetta.patcher;
  const tokens = vendetta.metro.findByProps("SemanticColor");
  const resolver = tokens?.default?.meta ?? tokens?.default?.internal;
  const ReactNative = vendetta.metro.common.ReactNative;
  const React = vendetta.metro.common.React;

  const unpatches = [];
  const styleCache = new WeakMap();

  function getSemanticName(args) {
    const candidates = ["name", "key", "id", "token", "semanticColor", "color"];
    const wanted = new Set([
      "CHANNELS_DEFAULT",
      "TEXT_MUTED",
      "PANEL_BG",
      "BACKGROUND_SECONDARY_ALT",
      "BACKGROUND_MOBILE_SECONDARY",
      "BACKGROUND_PRIMARY",
      "BACKGROUND_MOBILE_PRIMARY",
      "BG_BASE_PRIMARY",
      "BACKGROUND_BASE_LOW"
    ]);

    for (const arg of args) {
      if (typeof arg === "string") {
        const name = arg.toUpperCase();
        if (wanted.has(name)) return name;
      }

      if (typeof arg === "symbol") {
        const name = String(arg.description ?? "").toUpperCase();
        if (wanted.has(name)) return name;
      }

      if (arg && typeof arg === "object") {
        for (const candidate of candidates) {
          if (typeof arg[candidate] === "string") {
            const name = arg[candidate].toUpperCase();
            if (wanted.has(name)) return name;
          }
        }
      }
    }

    return "";
  }

  function semanticOverride(args) {
    const name = getSemanticName(args);

    if (name === "CHANNELS_DEFAULT") return "#E9A0BE";
    if (name === "TEXT_MUTED") return "#C4A7D6";
    if (name === "BACKGROUND_MOBILE_SECONDARY") return "#351923";
    if (name === "PANEL_BG" || name === "BACKGROUND_SECONDARY_ALT") {
      return "#351923";
    }
    if (
      name === "BACKGROUND_PRIMARY" ||
      name === "BACKGROUND_MOBILE_PRIMARY" ||
      name === "BG_BASE_PRIMARY" ||
      name === "BACKGROUND_BASE_LOW"
    ) {
      return "#32162F";
    }

    return null;
  }

  function replaceKnownColor(value, numericFormat = "argb") {
    if (typeof value === "number") {
      const unsigned = value >>> 0;
      const isArgb = numericFormat === "argb";
      const alpha = isArgb ? (unsigned >>> 24) & 255 : unsigned & 255;
      const red = isArgb ? (unsigned >>> 16) & 255 : (unsigned >>> 24) & 255;
      const green = isArgb ? (unsigned >>> 8) & 255 : (unsigned >>> 16) & 255;
      const blue = isArgb ? unsigned & 255 : (unsigned >>> 8) & 255;
      const source = `#${red.toString(16).padStart(2, "0")}${green
        .toString(16)
        .padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
      const replacement = replaceKnownColor(source, numericFormat);

      if (replacement === source) return value;

      const rgb = Number.parseInt(replacement.slice(1, 7), 16);
      return isArgb
        ? (((alpha << 24) | rgb) >>> 0)
        : (((rgb << 8) | alpha) >>> 0);
    }

    if (typeof value !== "string") return value;

    const match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (!match) return value;

    const rgb = match[1];
    const alpha = match[2] ?? "";
    const red = Number.parseInt(rgb.slice(0, 2), 16);
    const green = Number.parseInt(rgb.slice(2, 4), 16);
    const blue = Number.parseInt(rgb.slice(4, 6), 16);
    const source = `#${rgb.toLowerCase()}`;
    const replacements = {
      "#252429": "#5A2947", // bottom profile panel -> lighter old rose
      "#b5bac1": "#F0A0C8", // regular DM names -> pink
      "#dbdee1": "#F0A0C8", // brighter DM-name variant -> pink
      "#949ba4": "#C4A7D6", // preview/activity text -> pastel lilac
      "#80848e": "#A982AD"  // strongly muted preview text -> muted lilac
    };
    const replacement = replacements[source];
    return replacement ? replacement + alpha : value;
  }

  function recolorStyle(style) {
    if (style == null) return style;

    if (typeof style === "object" && !Array.isArray(style)) {
      const cached = styleCache.get(style);
      if (cached) return cached;
    }

    let flat;
    try {
      flat = ReactNative?.StyleSheet?.flatten?.(style) ?? style;
    } catch {
      return style;
    }
    if (!flat || typeof flat !== "object") return style;

    let changed = false;
    const next = { ...flat };
    for (const key of ["color", "backgroundColor"]) {
      const value = next[key];
      if (typeof value !== "string" && typeof value !== "number") continue;
      const replacement = replaceKnownColor(value, "argb");
      if (replacement !== value) {
        next[key] = replacement;
        changed = true;
      }
    }

    const result = changed ? next : style;
    if (typeof style === "object" && !Array.isArray(style)) {
      styleCache.set(style, result);
    }
    return result;
  }

  function recolorProps(props) {
    if (!props || typeof props !== "object" || props.style == null) return props;
    const style = recolorStyle(props.style);
    return style === props.style ? props : { ...props, style };
  }

  function patchElementFactory(module, key) {
    if (!module || typeof module[key] !== "function") return;
    try {
      unpatches.push(
        instead(key, module, function (args, original) {
          if (args.length > 1) args[1] = recolorProps(args[1]);
          return original.apply(this, args);
        })
      );
    } catch {}
  }

  function patchNativePayloads() {
    const found = vendetta.metro.findAllByProps?.("create", "diff");
    const candidates = Array.isArray(found) ? found : found ? [found] : [];

    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate.create !== "function" ||
        typeof candidate.diff !== "function" ||
        candidate.create.length < 2 ||
        candidate.diff.length < 3
      ) continue;

      try {
        unpatches.push(
          instead("create", candidate, function (args, original) {
            if (args.length > 0) args[0] = recolorProps(args[0]);
            return original.apply(this, args);
          })
        );
        unpatches.push(
          instead("diff", candidate, function (args, original) {
            if (args.length > 0) args[0] = recolorProps(args[0]);
            if (args.length > 1) args[1] = recolorProps(args[1]);
            return original.apply(this, args);
          })
        );
      } catch {}
    }
  }

  return {
    onLoad() {
      if (!resolver?.resolveSemanticColor) {
        throw new Error("Discords Farbauflösung wurde nicht gefunden.");
      }

      unpatches.push(
        after("resolveSemanticColor", resolver, (args, result) =>
          semanticOverride(args) ?? replaceKnownColor(result, "argb")
        )
      );

      // Some newer Discord components feed colours directly into React
      // Native instead of using semantic tokens. This catches those greys,
      // including attachment cards and a few navigation/profile surfaces.
      if (ReactNative?.processColor) {
        unpatches.push(
          instead("processColor", ReactNative, function (args, original) {
            if (typeof args[0] === "string" || typeof args[0] === "number") {
              args[0] = replaceKnownColor(
                args[0],
                typeof args[0] === "number" ? "rgba" : "argb"
              );
            }
            return original.apply(this, args);
          })
        );
      }

      // Current Discord builds keep the DM names and bottom profile panel in
      // already-created React Native styles. Recolour those exact default
      // values as elements render, without touching the server rail or chat.
      patchElementFactory(React, "createElement");
      const jsxFound = vendetta.metro.findAllByProps?.("jsx", "jsxs");
      const jsxModules = Array.isArray(jsxFound)
        ? jsxFound
        : jsxFound
          ? [jsxFound]
          : [];
      for (const jsxModule of jsxModules) {
        patchElementFactory(jsxModule, "jsx");
        patchElementFactory(jsxModule, "jsxs");
        patchElementFactory(jsxModule, "jsxDEV");
      }
      patchNativePayloads();
    },

    onUnload() {
      unpatches.splice(0).forEach(unpatch => unpatch());
    }
  };
})()
