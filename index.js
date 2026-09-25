(() => {
  const { after, instead } = vendetta.patcher;
  const tokens = vendetta.metro.findByProps("SemanticColor");
  const resolver = tokens?.default?.meta ?? tokens?.default?.internal;
  const ReactNative = vendetta.metro.common.ReactNative;

  const unpatches = [];

  function getSemanticName(args) {
    const candidates = ["name", "key", "id", "token", "semanticColor", "color"];
    const wanted = new Set([
      "CHANNELS_DEFAULT",
      "TEXT_MUTED",
      "PANEL_BG",
      "BACKGROUND_SECONDARY_ALT",
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

    if (name === "CHANNELS_DEFAULT") return "#D69AB4";
    if (name === "TEXT_MUTED") return "#B596C8";
    if (name === "PANEL_BG" || name === "BACKGROUND_SECONDARY_ALT") {
      return "#5A2947";
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

  function recolorNeutral(value) {
    if (typeof value === "number") {
      const unsigned = value >>> 0;
      // React Native accepts numeric colours as 0xRRGGBBAA before
      // processColor converts them to Android's internal representation.
      const red = (unsigned >>> 24) & 255;
      const green = (unsigned >>> 16) & 255;
      const blue = (unsigned >>> 8) & 255;
      const alpha = unsigned & 255;
      const source = `#${red.toString(16).padStart(2, "0")}${green
        .toString(16)
        .padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
      const replacement = recolorNeutral(source);

      if (replacement === source) return value;

      const rgb = Number.parseInt(replacement.slice(1, 7), 16);
      return (((rgb << 8) | alpha) >>> 0);
    }

    if (typeof value !== "string") return value;

    const match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (!match) return value;

    const rgb = match[1];
    const alpha = match[2] ?? "";
    const red = Number.parseInt(rgb.slice(0, 2), 16);
    const green = Number.parseInt(rgb.slice(2, 4), 16);
    const blue = Number.parseInt(rgb.slice(4, 6), 16);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;

    // Only replace genuinely neutral Discord greys. Existing purple, pink,
    // gold, avatars and wallpapers stay untouched.
    if (maximum - minimum > 16) return value;

    let replacement;
    if (brightness <= 14) replacement = "#030204";       // True Onyx / server rail
    else if (brightness <= 24) replacement = "#050407";  // Almost black
    else if (brightness <= 36) replacement = "#1C0D2A";  // Deep violet / chat header
    else if (brightness <= 50) replacement = "#5A2947";  // Old rose / profile panel
    else if (brightness <= 68) replacement = "#5A2C50";  // Plum rose cards
    else if (brightness <= 95) replacement = "#7A436D";  // Dusky rose
    else if (brightness <= 130) replacement = "#A07CAD"; // Muted lilac
    else if (brightness <= 175) replacement = "#D0A9D9"; // Lilac
    else if (brightness <= 215) replacement = "#D69AB4"; // Muted old rose / names
    else return value;

    return replacement + alpha;
  }

  let retryTimer = null;
  let installed = false;
  let attempts = 0;

  function installPatches() {
    if (installed) return true;

    // Resolve these at installation time rather than only when the plugin file
    // is evaluated. During some Discord/Revenge starts the modules appear later.
    const liveTokens = vendetta.metro.findByProps("SemanticColor");
    const liveResolver = liveTokens?.default?.meta ?? liveTokens?.default?.internal;
    const liveReactNative = vendetta.metro.common.ReactNative;

    if (!liveResolver?.resolveSemanticColor) return false;

    unpatches.push(
      after("resolveSemanticColor", liveResolver, (args, result) =>
        semanticOverride(args) ?? recolorNeutral(result)
      )
    );

    // Preserve the existing direct React Native colour patch.
    if (liveReactNative?.processColor) {
      unpatches.push(
        instead("processColor", liveReactNative, function (args, original) {
          if (typeof args[0] === "string" || typeof args[0] === "number") {
            args[0] = recolorNeutral(args[0]);
          }
          return original.apply(this, args);
        })
      );
    }

    installed = true;
    return true;
  }

  return {
    onLoad() {
      // Try immediately. If Discord has not finished exposing its colour
      // resolver yet, retry every 500 ms for up to 10 seconds.
      if (installPatches()) return;

      attempts = 0;
      retryTimer = setInterval(() => {
        attempts += 1;
        if (installPatches() || attempts >= 20) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 500);
    },

    onUnload() {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }

      installed = false;
      attempts = 0;
      unpatches.splice(0).forEach(unpatch => unpatch());
    }
  };
})()
