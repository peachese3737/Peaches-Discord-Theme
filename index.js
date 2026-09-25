(() => {
  const { after, instead } = vendetta.patcher;
  const tokens = vendetta.metro.findByProps("SemanticColor");
  const resolver = tokens?.default?.meta ?? tokens?.default?.internal;
  const ReactNative = vendetta.metro.common.ReactNative;

  const unpatches = [];

  function recolorNeutral(value) {
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
    else if (brightness <= 36) replacement = "#08050B";  // Black violet
    else if (brightness <= 50) replacement = "#3B1A2E";  // Dark old rose / composer
    else if (brightness <= 68) replacement = "#5A2C50";  // Plum rose cards
    else if (brightness <= 95) replacement = "#7A436D";  // Dusky rose
    else if (brightness <= 130) replacement = "#A07CAD"; // Muted lilac
    else if (brightness <= 175) replacement = "#D0A9D9"; // Lilac
    else if (brightness <= 215) replacement = "#E7BDD1"; // Soft pink
    else return value;

    return replacement + alpha;
  }

  return {
    onLoad() {
      if (!resolver?.resolveSemanticColor) {
        throw new Error("Discords Farbauflösung wurde nicht gefunden.");
      }

      unpatches.push(
        after("resolveSemanticColor", resolver, (_args, result) =>
          recolorNeutral(result)
        )
      );

      // Some newer Discord components feed colours directly into React
      // Native instead of using semantic tokens. This catches those greys,
      // including attachment cards and a few navigation/profile surfaces.
      if (ReactNative?.processColor) {
        unpatches.push(
          instead("processColor", ReactNative, function (args, original) {
            if (typeof args[0] === "string") {
              args[0] = recolorNeutral(args[0]);
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
