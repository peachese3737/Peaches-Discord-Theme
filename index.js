(() => {
  const { after } = vendetta.patcher;
  const tokens = vendetta.metro.findByProps("SemanticColor");
  const resolver = tokens?.default?.meta ?? tokens?.default?.internal;

  let unpatch;

  function recolorDarkNeutral(value) {
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

    // Only replace genuinely neutral, dark Discord greys. Purple, pink,
    // gold, avatars, wallpapers and readable light text stay untouched.
    if (maximum - minimum > 12 || brightness > 88) return value;

    let replacement;
    if (brightness <= 13) replacement = "#09070D";      // Onyx
    else if (brightness <= 23) replacement = "#100815"; // Black violet
    else if (brightness <= 34) replacement = "#180B21"; // Deep aubergine
    else if (brightness <= 48) replacement = "#24122D"; // Input/header violet
    else if (brightness <= 66) replacement = "#321540"; // Raised cards
    else replacement = "#472356";                       // Selected/pressed

    return replacement + alpha;
  }

  return {
    onLoad() {
      if (!resolver?.resolveSemanticColor) {
        throw new Error("Discords Farbauflösung wurde nicht gefunden.");
      }

      unpatch = after("resolveSemanticColor", resolver, (_args, result) =>
        recolorDarkNeutral(result)
      );
    },

    onUnload() {
      unpatch?.();
      unpatch = undefined;
    }
  };
})()
