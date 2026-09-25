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
    if (name === "BACKGROUND_MOBILE_SECONDARY") return "#2C142C";
    if (name === "PANEL_BG" || name === "BACKGROUND_SECONDARY_ALT") {
      return "#2C142C";
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

  function recolorNeutral(value, numericFormat = "argb") {
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
      const replacement = recolorNeutral(source, numericFormat);

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
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;

    // Only replace genuinely neutral Discord greys. Existing purple, pink,
    // gold, avatars and wallpapers stay untouched.
    if (maximum - minimum > 16) return value;

    // The bottom profile panel in the current Discord build is a hard-coded
    // Android grey (#252429) instead of a semantic theme token. Keep this
    // narrow so the already-correct server rail and open-chat header do not
    // get recoloured with it.
    if (
      Math.abs(red - 37) <= 5 &&
      Math.abs(green - 36) <= 5 &&
      Math.abs(blue - 41) <= 5
    ) {
      return "#5A2947" + alpha;
    }

    let replacement;
    if (brightness <= 14) replacement = "#030204";       // True Onyx / server rail
    else if (brightness <= 24) replacement = "#050407";  // Almost black
    else if (brightness <= 36) replacement = "#1C0D2A";  // Deep violet / chat header
    else if (brightness <= 50) return value;               // Preserve other dark UI chrome
    else if (brightness <= 68) replacement = "#5A2C50";  // Plum rose cards
    else if (brightness <= 95) replacement = "#7A436D";  // Dusky rose
    else if (brightness <= 130) replacement = "#A07CAD"; // Muted lilac
    else if (brightness <= 175) replacement = "#D0A9D9"; // Lilac
    else if (brightness <= 215) replacement = "#D69AB4"; // Muted old rose / names
    else return value;

    return replacement + alpha;
  }

  return {
    onLoad() {
      if (!resolver?.resolveSemanticColor) {
        throw new Error("Discords Farbauflösung wurde nicht gefunden.");
      }

      unpatches.push(
        after("resolveSemanticColor", resolver, (args, result) =>
          semanticOverride(args) ?? recolorNeutral(result)
        )
      );

      // Some newer Discord components feed colours directly into React
      // Native instead of using semantic tokens. This catches those greys,
      // including attachment cards and a few navigation/profile surfaces.
      if (ReactNative?.processColor) {
        unpatches.push(
          instead("processColor", ReactNative, function (args, original) {
            if (typeof args[0] === "string" || typeof args[0] === "number") {
              args[0] = recolorNeutral(
                args[0],
                typeof args[0] === "number" ? "rgba" : "argb"
              );
            }
            return original.apply(this, args);
          })
        );
      }
    },

    onUnload() {
      unpatches.splice(0).forEach(unpatch => unpatch());
    }
  };
})()
