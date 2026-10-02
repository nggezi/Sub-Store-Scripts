async function operator(proxies, targetPlatform, context) {
  let arg = (typeof $arguments !== "undefined") ? $arguments : "";

  if (typeof arg === "string") {
    const s = arg.trim();
    if (s.startsWith("{")) {
      try { arg = JSON.parse(s); } catch (e) {}
    }
  }

  let text = "";
  if (arg && typeof arg === "object") {
    text = String(arg.hosts != null ? arg.hosts : (Object.values(arg)[0] || ""));
  } else {
    text = String(arg || "");
  }

  const hosts = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^["']?([^"':]+?)["']?\s*:\s*(.+)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (k && k !== "hosts" && v) hosts[k] = v;
  }

  return proxies.map((p) => {
    if (p && p.server && hosts[p.server] != null) p.server = hosts[p.server];
    return p;
  });
}
