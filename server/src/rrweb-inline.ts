// Post-process a recorded rrweb event stream into a SELF-CONTAINED, offline-faithful capture: every
// external asset (cross-origin stylesheets, fonts, images) is fetched via the extension (no CORS wall,
// session cookies) and inlined into the serialized nodes. Foreign-extension nodes (chrome-extension://
// injected by OTHER extensions) are stripped. Verified levers (rrweb 2.1.1 rebuild):
//   - a <link rel=stylesheet> node with `_cssText` is rebuilt as an inline <style> (href never loaded)
//   - an <img> with `rr_dataURL` has img.src set to it (srcset auto-neutralized)
// All snapshot URLs are already absolute (rrweb absolutizes at record time), so we fetch directly.

// One batched fetch through the extension: url -> result.
export type FetchResult = { ok: boolean; mime?: string; base64?: string; bytes?: number; error?: string; status?: number };
export type FetchBatch = (urls: string[]) => Promise<Record<string, FetchResult>>;

export interface InlineOpts {
  perAssetMaxBytes?: number; // default 2 MB
  totalBudgetBytes?: number; // default 50 MB (raw)
}
export interface InlineReport {
  inlined: number;
  bytesInlined: number;
  skipped: { url: string; reason: string; bytes?: number }[];
}

// rrweb's own url() matcher (quoted single/double, unquoted).
const URL_IN_CSS = /url\((?:(')([^']*)'|(")(.*?)"|([^)]*))\)/gm;
// @import url("x") | @import "x"  (+ optional trailing media query up to ;)
const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;

const isHttp = (u: string) => /^https?:\/\//i.test(u || "");
const isChromeExt = (u: string) => /^chrome-extension:\/\//i.test(u || "");
const isInlineable = (u: string) => isHttp(u) && !/^data:|^blob:|^about:/i.test(u);

// Parse a srcset into {url, desc} candidates, comma-in-URL safe. `split(",")` breaks on URLs that
// contain commas (data: URIs, some CDN paths); the HTML srcset grammar ends a non-data URL at the
// first comma but lets a data: URL keep its commas up to whitespace.
function parseSrcsetCandidates(srcset: string): { url: string; desc: string }[] {
  const s = String(srcset || "");
  const n = s.length;
  const out: { url: string; desc: string }[] = [];
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  let i = 0;
  while (i < n) {
    while (i < n && (isWs(s[i]) || s[i] === ",")) i++; // skip separators
    if (i >= n) break;
    const start = i;
    while (i < n && !isWs(s[i])) i++;
    let url = s.slice(start, i);
    if (!/^data:/i.test(url)) {
      const ci = url.indexOf(",");
      if (ci !== -1) { url = url.slice(0, ci); i = start + ci; } // non-data URL ends at its first comma
    }
    while (i < n && isWs(s[i])) i++;
    const dStart = i;
    while (i < n && s[i] !== ",") i++; // descriptor runs to the next candidate comma
    const desc = s.slice(dStart, i).trim();
    if (url) out.push({ url, desc });
  }
  return out;
}
// Highest-resolution candidate: max `w` descriptor, else max `x`/density, else the last listed.
function pickLargestSrcset(srcset: string): string {
  const cands = parseSrcsetCandidates(srcset);
  if (!cands.length) return "";
  let best = cands[cands.length - 1], bestScore = -1;
  for (const c of cands) {
    const mw = /(\d+(?:\.\d+)?)w/.exec(c.desc), mx = /(\d+(?:\.\d+)?)x/.exec(c.desc);
    const score = mw ? parseFloat(mw[1]) : mx ? parseFloat(mx[1]) : 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best.url;
}

export async function inlineAssets(events: any[], fetchBatch: FetchBatch, opts: InlineOpts = {}): Promise<InlineReport> {
  const perAssetMax = opts.perAssetMaxBytes ?? 2 * 1024 * 1024;
  const totalBudget = opts.totalBudgetBytes ?? 50 * 1024 * 1024;
  let used = 0;
  let inlined = 0;
  const skipped: InlineReport["skipped"] = [];
  const dataUriCache = new Map<string, string | null>(); // absolute url -> data: URI (or null = unavailable)
  const cssTextCache = new Map<string, string | null>(); // absolute css url -> rewritten CSS text

  // Fetch binaries (batched, deduped, budgeted) into dataUriCache. Returns nothing; read via getDataUri.
  async function ensureBinaries(urls: string[]) {
    const need = urls.filter((u) => isInlineable(u) && !dataUriCache.has(u));
    if (!need.length) return;
    const res = await fetchBatch(need);
    for (const u of need) {
      const r = res[u];
      if (!r || !r.ok || !r.base64) {
        dataUriCache.set(u, null);
        skipped.push({ url: u, reason: r?.error || "fetch-failed", bytes: r?.bytes });
        continue;
      }
      const b = r.bytes ?? Math.floor((r.base64.length * 3) / 4);
      if (b > perAssetMax) {
        // Defensive server-side cap (the extension is also asked to enforce it via perAssetMaxBytes).
        dataUriCache.set(u, null);
        skipped.push({ url: u, reason: "per-asset-exceeded", bytes: b });
        continue;
      }
      if (used + b > totalBudget) {
        dataUriCache.set(u, null);
        skipped.push({ url: u, reason: "budget-exceeded", bytes: b });
        continue;
      }
      used += b;
      inlined++;
      dataUriCache.set(u, `data:${r.mime || "application/octet-stream"};base64,${r.base64}`);
    }
  }
  const getDataUri = (u: string) => dataUriCache.get(u) ?? null;

  // Rewrite url() + @import inside a CSS string. baseUrl = the stylesheet's own URL (resolves relatives).
  async function rewriteCss(css: string, baseUrl: string, depth = 0): Promise<string> {
    if (!css) return css;
    // 1) @import: fetch, recursively rewrite, and inline in place (flattens the chain).
    if (depth < 5 && css.indexOf("@import") !== -1) {
      const imports: { stmt: string; url: string; media: string }[] = [];
      css.replace(IMPORT_RE, (stmt, u1, u2, u3, u4, u5, media) => {
        const u = (u1 || u2 || u3 || u4 || u5 || "").trim();
        if (u) imports.push({ stmt, url: u, media: (media || "").trim() });
        return stmt;
      });
      for (const imp of imports) {
        let abs: string;
        try {
          abs = new URL(imp.url, baseUrl || undefined).href;
        } catch {
          continue;
        }
        if (!isInlineable(abs)) continue;
        let inner = cssTextCache.get(abs);
        if (inner === undefined) {
          const res = await fetchBatch([abs]);
          const r = res[abs];
          if (r && r.ok && r.base64) {
            inner = await rewriteCss(Buffer.from(r.base64, "base64").toString("utf8"), abs, depth + 1);
          } else {
            inner = null;
            skipped.push({ url: abs, reason: r?.error || "import-fetch-failed" });
          }
          cssTextCache.set(abs, inner);
        }
        css = css.split(imp.stmt).join(inner != null ? (imp.media ? `@media ${imp.media}{${inner}}` : inner) : "");
      }
    }
    // 2) url() refs -> data URIs. RESOLVE against baseUrl FIRST, then gate on the absolute URL, so
    //    relative refs (url(../fonts/x.woff2), self-hosted sprites) are inlined - not silently dropped.
    //    Base-less callers (style attr/tag, incremental rules) throw on a relative and skip it as before.
    const refs = new Set<string>();
    css.replace(URL_IN_CSS, (_m, _q1, u1, _q2, u2, u3) => {
      const raw = (u1 ?? u2 ?? u3 ?? "").trim();
      if (!raw || isChromeExt(raw)) return _m;
      let abs: string;
      try {
        abs = new URL(raw, baseUrl || undefined).href;
      } catch {
        return _m; // unresolvable relative with no base
      }
      if (isInlineable(abs)) refs.add(abs);
      return _m;
    });
    await ensureBinaries([...refs]);
    css = css.replace(URL_IN_CSS, (m, _q1, u1, _q2, u2, u3) => {
      const raw = (u1 ?? u2 ?? u3 ?? "").trim();
      if (!raw) return m;
      if (isChromeExt(raw)) return "url()"; // neutralize a foreign extension's asset
      let abs: string;
      try {
        abs = new URL(raw, baseUrl || undefined).href;
      } catch {
        return m;
      }
      if (!isInlineable(abs)) return m;
      const du = getDataUri(abs);
      return du ? `url("${du}")` : m; // leave live if unavailable/over budget
    });
    return css;
  }

  // Rewrite a srcset in place: inline every candidate URL to a data URI, preserving descriptors, so
  // whichever candidate the replay browser picks is already inlined.
  async function rewriteSrcset(srcset: string): Promise<string> {
    const cands = parseSrcsetCandidates(srcset);
    if (!cands.length) return srcset;
    await ensureBinaries(cands.map((c) => c.url).filter(isInlineable));
    return cands
      .map((c) => {
        const du = isInlineable(c.url) ? getDataUri(c.url) : null;
        const u = du || c.url;
        return c.desc ? `${u} ${c.desc}` : u;
      })
      .join(", ");
  }

  // Inline asset-bearing attributes on a mutation attribute-update object. A source-0 mutation entry
  // ({id, attributes:{name:value}}) carries no tagName, so we key off attribute names. rrweb encodes
  // attribute REMOVAL as `false`, so every value is guarded with typeof === "string". URLs in mutations
  // are already absolutized by rrweb at record time.
  async function inlineAttrs(a: any) {
    if (!a || typeof a !== "object") return;
    for (const attr of ["src", "poster", "href", "xlink:href"]) {
      const v = a[attr];
      if (typeof v === "string" && isInlineable(v)) {
        await ensureBinaries([v]);
        const du = getDataUri(v);
        if (du) a[attr] = du;
      }
    }
    if (typeof a.srcset === "string" && a.srcset) a.srcset = await rewriteSrcset(a.srcset);
    if (typeof a.style === "string" && a.style.indexOf("url(") !== -1) a.style = await rewriteCss(a.style, "", 0);
  }

  // Inline the assets referenced by a single serialized element node (no strip, no recursion).
  async function inlineNode(node: any) {
    if (!node || node.type !== 2) return;
    const a = node.attributes || (node.attributes = {});
    const tag = node.tagName;
    if (tag === "link" && /stylesheet/i.test(String(a.rel || ""))) {
      if (!a._cssText && isInlineable(a.href || "")) {
        let text = cssTextCache.get(a.href);
        if (text === undefined) {
          const res = await fetchBatch([a.href]);
          const r = res[a.href];
          if (r && r.ok && r.base64) text = await rewriteCss(Buffer.from(r.base64, "base64").toString("utf8"), a.href, 0);
          else {
            text = null;
            skipped.push({ url: a.href, reason: r?.error || "css-fetch-failed" });
          }
          cssTextCache.set(a.href, text);
        }
        if (text != null) {
          a._cssText = text;
          inlined++;
        }
      } else if (a._cssText) {
        a._cssText = await rewriteCss(a._cssText, a.href || "", 0);
      }
    } else if (tag === "style" && a._cssText) {
      a._cssText = await rewriteCss(a._cssText, "", 0);
    } else if (tag === "img") {
      if (!a.rr_dataURL) {
        const url = a.src && isInlineable(a.src) ? a.src : pickLargestSrcset(a.srcset || "");
        if (isInlineable(url)) {
          await ensureBinaries([url]);
          const du = getDataUri(url);
          if (du) a.rr_dataURL = du;
        }
      }
      if (typeof a.srcset === "string" && a.srcset) a.srcset = await rewriteSrcset(a.srcset);
    } else if (tag === "source" || tag === "video" || tag === "audio" || tag === "image") {
      for (const attr of ["src", "poster", "href", "xlink:href"]) {
        const v = a[attr];
        if (isInlineable(v)) {
          await ensureBinaries([v]);
          const du = getDataUri(v);
          if (du) a[attr] = du;
        }
      }
      // Inline every srcset candidate in place (a <source> in <picture> is selected by srcset, not src).
      if (typeof a.srcset === "string" && a.srcset) a.srcset = await rewriteSrcset(a.srcset);
    }
    if (typeof a.style === "string" && a.style.indexOf("url(") !== -1) a.style = await rewriteCss(a.style, "", 0);
  }

  // Recurse a node's children: strip foreign-extension nodes, else inline + recurse.
  async function walkChildren(node: any) {
    const kids = node && node.childNodes;
    if (!Array.isArray(kids)) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const a = (c && c.attributes) || {};
      if (isChromeExt(a.href || "") || isChromeExt(a.src || "")) {
        kids.splice(i, 1);
        i--;
        continue;
      }
      await inlineNode(c);
      await walkChildren(c);
    }
  }

  for (const e of events) {
    const t = e?.type;
    const d = e?.data;
    if (t === 2 && d?.node) {
      await walkChildren(d.node); // FullSnapshot (document root)
    } else if (t === 3 && d?.source === 0 && Array.isArray(d.adds)) {
      // Drop foreign-extension nodes injected via mutation. walkChildren only strips at the child
      // level, so a chrome-extension:// node that is itself an add root (e.g. a <script src> another
      // extension appends post-load) would otherwise survive.
      d.adds = d.adds.filter((add: any) => {
        const a = (add?.node && add.node.attributes) || {};
        return !(isChromeExt(a.href || "") || isChromeExt(a.src || ""));
      });
      for (const add of d.adds) {
        if (add?.node) {
          await inlineNode(add.node); // the added node itself
          await walkChildren(add.node);
        }
      }
      // Lazy-loaded assets arrive as attribute mutations (img src/srcset set by JS after load, etc.);
      // inline them too, or a scroll-triggered image stays a live URL and breaks offline.
      if (Array.isArray(d.attributes)) {
        for (const upd of d.attributes) await inlineAttrs(upd?.attributes);
      }
    } else if (t === 3 && d?.source === 8) {
      // Incremental CSS: inserted rules (adds[].rule) + whole-sheet replace()/replaceSync().
      if (Array.isArray(d.adds)) {
        for (const ad of d.adds) if (typeof ad?.rule === "string") ad.rule = await rewriteCss(ad.rule, "", 0);
      }
      if (typeof d.replace === "string") d.replace = await rewriteCss(d.replace, "", 0);
      if (typeof d.replaceSync === "string") d.replaceSync = await rewriteCss(d.replaceSync, "", 0);
    } else if (t === 3 && d?.source === 13 && d?.set && typeof d.set.value === "string" && d.set.value.indexOf("url(") !== -1) {
      // StyleDeclaration: a single property set to a url()-bearing value (e.g. background-image).
      d.set.value = await rewriteCss(d.set.value, "", 0);
    } else if (t === 3 && d?.source === 15 && Array.isArray(d.styles)) {
      // AdoptedStyleSheet: constructable stylesheets attached post-snapshot.
      for (const st of d.styles) {
        if (Array.isArray(st?.rules)) for (const rl of st.rules) if (typeof rl?.rule === "string") rl.rule = await rewriteCss(rl.rule, "", 0);
      }
    }
  }

  return { inlined, bytesInlined: used, skipped };
}
