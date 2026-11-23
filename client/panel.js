// 客户端面板（CommonJS 模块体）
//
// 这个文件的最终形态是 DSH 客户端模块加载器里的 lazy CJS factory：
// `scripts/build-client.mjs` 把它包进 `window.__ModuleLoader__.load({...})`，注入
// `require` / `module` / `exports` 与 React，因此这里可以直接使用 CJS 语义，也能在
// Node 里用假 require 直接跑单元测试。
//
// UI 原则（对齐 DSH 官方规范）
//   · 只使用 --dsw-alias-* 语义 token，不写颜色字面量；
//   · 控件高度、圆角、边框统一取自同一组常量（见 CONTROLS），输入框 / 下拉框 /
//     按钮共用 H32 + R8 + 0.5px 发丝线，不各写一套；
//   · 文案只保留功能信息：能由界面自身表达的内容（状态、地址、端口、网络）
//     不再额外写一句解释。

const { RPC_CHANNEL, ENDPOINTS, LAN_PORT } = require('./constants.js');
const { zh, en, LOCALE_NAMESPACE } = require('./locales.js');

const h = React.createElement;
const PREFIX = 'dsh-remote';

/** 导航图标：用 DSH 图标精灵里真实存在的 symbol（已验证存在）。 */
const NAV_ICON_SYMBOL = 'dsw-icon-globe-outline-medium';
/** 工具栏刷新图标：同样来自精灵，不再自绘路径。 */
const REFRESH_ICON_SYMBOL = 'dsw-icon-refresh-outline-medium';

/** 忙碌态的最短展示时间：让图标旋转可见，并真正吸掉连点。 */
const MIN_BUSY_MS = 600;

/**
 * 把一次调用的失败翻译成可读文案。
 *
 * 浏览器在连接断开时只会给 "Failed to fetch" 这类内部措辞，直接展示对用户没有
 * 价值；这里把它们归一成一句人话，其余错误保留原始信息便于排查。
 * @param {(key: string, vars?: object) => string} t
 * @param {string} message
 * @returns {string}
 */
function describeFailure(t, message) {
  const raw = String(message ?? '');
  if (raw === '' || /failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return t('error.network');
  }
  return t('error.actionFailed', { message: raw });
}

// ---- 端点调用 -------------------------------------------------------------

/**
 * 调一次插件 RPC，并把失败统一成可展示的文案。
 * @param {object} ctx Cordis 客户端上下文
 * @param {string} endpoint 端点名
 * @param {object} [payload]
 * @returns {Promise<{ok: true, value: object} | {ok: false, message: string}>}
 */
async function call(ctx, endpoint, payload = {}) {
  try {
    const result = await ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload);
    if (result?.ok) return { ok: true, value: result.value };
    return { ok: false, message: result?.error?.message ?? 'RPC failed' };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

// ---- 统一控件规范 ---------------------------------------------------------

/**
 * 一套尺寸，所有控件共用。
 *
 * 取值依据 DSH 的圆角规范：紧凑控件（H20–28）用 R8，标准控件（H32–40）用 R12。
 * 这里把地址框、下拉框、按钮统一到 H32 / R8（`--dsw-radius-sm`）——它们是同一行
 * 里并排的紧凑控件，混用 R12 会显得大小不一。
 */
const CONTROLS = {
  height: 32,
  radius: 'var(--dsw-radius-sm)',
  /** 发丝线：DSH 全部平面边框统一 0.5px。 */
  border: '0.5px solid var(--dsw-alias-border-l3)',
  /** 控件内部左右留白。 */
  paddingX: 10,
  fontSize: 13,
  lineHeight: 20,
  /** 相邻控件之间的水平间距。 */
  gap: 8,
  /** 段落之间的垂直间距。 */
  stackGap: 12,
};

// ---- 样式 -----------------------------------------------------------------

/**
 * 面板样式。全部走语义 token，明暗主题自动跟随；不定义任何主题选择器。
 * @param {string} prefix 本插件独有的类名前缀，避免与宿主样式相撞
 * @returns {string}
 */
function panelCss(prefix) {
  const p = `.${prefix}`;
  const c = CONTROLS;
  return `
${p}-section{display:flex;flex-direction:column;max-width:720px;color:var(--dsw-alias-label-primary)}
${p}-head{display:flex;flex-direction:column}
/* 页面标题：与 DSH 插件页 / 设置页的 .pageTitle 完全一致（20/28/500） */
${p}-title{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary)}
/* 页面说明：.pageIntro（13/20，次级色，上间距 4px） */
${p}-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}

/* 主卡片：唯一的内容容器，内边距与行距统一 */
${p}-card{margin-top:5px;display:flex;flex-direction:column;gap:${c.stackGap}px;padding:14px;border:0.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}

/* 顶部状态行：状态点 + 状态词 + 来源标签，垂直居中 */
${p}-statusRow{display:flex;align-items:center;gap:8px;min-height:${c.height}px}
${p}-statusLeft{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
${p}-dot{position:relative;display:inline-block;flex:none;width:10px;height:10px;color:var(--dsw-alias-state-idle-primary)}
${p}-dot::after{content:'';position:absolute;inset:20%;border-radius:50%;corner-shape:round;background:currentColor}
${p}-dot[data-state='done']{color:var(--dsw-alias-state-success-primary)}
${p}-dot[data-state='warning']{color:var(--dsw-alias-state-warn-primary)}
${p}-statusText{font-size:${c.fontSize}px;line-height:${c.lineHeight}px;color:var(--dsw-alias-label-primary)}

/* 标签：胶囊，与 ui-primitives 的 Tag 几何一致 */
${p}-tag{display:inline-flex;align-items:center;border-radius:999px;corner-shape:round;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}
${p}-tag[data-tone='success']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
${p}-tag[data-tone='info']{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}
${p}-tag[data-tone='warning']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}

/* 一行控件：地址 + 复制 + 打开，全部 H32 垂直居中 */
${p}-row{display:flex;align-items:center;gap:${c.gap}px}
${p}-address{box-sizing:border-box;flex:1 1 auto;min-width:0;height:${c.height}px;display:flex;align-items:center;padding:0 ${c.paddingX}px;border-radius:${c.radius};border:${c.border};background:var(--dsw-alias-bg-layer-1);font-family:var(--ds-font-family-code);font-size:${c.fontSize}px;line-height:${c.lineHeight}px;color:var(--dsw-alias-label-primary);overflow-x:auto;white-space:nowrap}

/* 按钮：与输入框同高同圆角同边框粗细 */
${p}-btn{box-sizing:border-box;height:${c.height}px;flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 ${c.paddingX}px;border:${c.border};border-radius:${c.radius};font-size:${c.fontSize}px;line-height:${c.lineHeight}px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;white-space:nowrap;text-decoration:none}
${p}-btn:disabled{cursor:not-allowed;opacity:.4}
@media (hover:hover){${p}-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
${p}-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
${p}-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

/* 纯图标按钮：与普通按钮同高，宽度收窄 */
${p}-iconBtn{box-sizing:border-box;height:${c.height}px;width:${c.height}px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:${c.radius};background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
${p}-iconBtn:disabled{cursor:not-allowed;opacity:.45}
${p}-iconBtn[data-spinning='true'] svg{animation:${prefix}-spin 900ms linear infinite}
@keyframes ${prefix}-spin{to{transform:rotate(360deg)}}
@media (hover:hover){${p}-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
${p}-iconBtn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
${p}-iconBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

/* 二维码：白底容器保证对比度 */
${p}-qrRow{display:flex;align-items:flex-start;gap:14px}
${p}-qr{display:block;width:160px;height:160px;padding:8px;box-sizing:border-box;border-radius:${c.radius};border:${c.border};background:#fff;flex:none}
${p}-qrSide{display:flex;flex-direction:column;gap:${c.gap}px;min-width:0;flex:1 1 auto;justify-content:center}
${p}-facts{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
${p}-fact{display:flex;gap:6px;min-width:0}
${p}-factKey{flex:none;color:var(--dsw-alias-label-tertiary)}
${p}-factValue{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 网络选择：自绘下拉，箭头由容器控制留白 */
${p}-selectWrap{position:relative;display:flex;align-items:center}
${p}-select{box-sizing:border-box;width:100%;height:${c.height}px;appearance:none;-webkit-appearance:none;padding:0 40px 0 ${c.paddingX}px;border-radius:${c.radius};border:${c.border};background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:${c.fontSize}px;line-height:${c.lineHeight}px;cursor:pointer;text-overflow:ellipsis}
${p}-select:disabled{cursor:not-allowed;opacity:.5}
${p}-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
/* 箭头：距右边缘 12px，与左侧文字留白对称；不拦截指针事件，点击仍落在 select 上 */
${p}-selectCaret{position:absolute;right:16px;display:flex;align-items:center;pointer-events:none;color:var(--dsw-alias-label-tertiary)}

/* 次级地址行 */
${p}-groupLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
${p}-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:${c.gap}px}
${p}-listRow{display:flex;align-items:center;gap:${c.gap}px;min-height:${c.height}px}
${p}-listAddr{font-family:var(--ds-font-family-code);font-size:${c.fontSize}px;line-height:${c.lineHeight}px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${p}-listNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:1 1 auto;min-width:0}

/* 问题提示：仅在真的没有可用入口时出现 */
${p}-notice{display:flex;align-items:flex-start;gap:8px;margin:0;padding:10px 12px;border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:${c.radius};font-size:${c.fontSize}px;line-height:${c.lineHeight}px;color:var(--dsw-alias-label-primary);background:transparent}
`;
}

/** 注入一次样式表；返回清理函数。 */
function installStyles(prefix) {
  if (typeof document === 'undefined') return () => {};
  const element = document.createElement('style');
  element.setAttribute('data-dsh-remote-styles', '1');
  element.textContent = panelCss(prefix);
  document.head.appendChild(element);
  return () => element.remove();
}

// ---- 基础组件 -------------------------------------------------------------

/** 精灵图标：`<use>` 引用 DSH 图标 sprite，随 currentColor 变色。 */
function SpriteIcon({ symbol, size = 16 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false',
  }, h('use', { href: `#${symbol}` }));
}

/**
 * 状态点 + 状态词 +（可选）来源标签，右侧是「重新检测」图标。
 *
 * 刷新只做成图标：这个页面的主任务是看地址，工具栏不该再占一行文字宽度。
 */
function StatusRow({ t, status, busy, onRefresh }) {
  const primary = status?.primary ?? null;
  const hasEntry = Boolean(primary?.url);
  const dotState = hasEntry ? 'done' : (status?.error ? 'warning' : 'idle');
  return h('div', { className: `${PREFIX}-statusRow` },
    h('div', { className: `${PREFIX}-statusLeft` },
      h('span', { className: `${PREFIX}-dot`, 'data-state': dotState, 'aria-hidden': 'true' }),
      h('span', { className: `${PREFIX}-statusText` },
        hasEntry ? t('status.available') : t('status.unavailable')),
      primary?.source === 'existing' && h('span', { className: `${PREFIX}-tag`, 'data-tone': 'success' }, t('tag.existing')),
      primary?.source === 'gateway' && h('span', { className: `${PREFIX}-tag`, 'data-tone': 'info' }, t('tag.gateway')),
    ),
    h('button', {
      type: 'button',
      className: `${PREFIX}-iconBtn`,
      'data-spinning': busy ? 'true' : 'false',
      onClick: onRefresh,
      disabled: busy,
      title: t('action.refresh'),
      'aria-label': t('action.refresh'),
    }, h(SpriteIcon, { symbol: REFRESH_ICON_SYMBOL, size: 16 })),
  );
}

/** 复制按钮。 */
function CopyButton({ t, url, link }) {
  const [copied, setCopied] = React.useState(false);
  const onClick = React.useCallback(() => {
    // 优先复制带票据的地址：它在任何设备上都能直接打开，且短时效。
    const target = link || url;
    if (!target) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    // 局域网是 HTTP，Clipboard API 在非安全上下文不可用，必须保留 execCommand 兜底。
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = target;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { if (document.execCommand('copy')) done(); } catch { /* 复制失败不打断界面 */ }
      document.body.removeChild(area);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(target).then(done).catch(fallback);
    } else {
      fallback();
    }
  }, [url, link]);

  return h('button', { type: 'button', className: `${PREFIX}-btn`, onClick, disabled: !url },
    copied ? t('address.copied') : t('address.copy'));
}

/** 网络选择：原生 select 负责交互，箭头由外层容器定位。 */
function NetworkSelect({ t, status, disabled, onSelect }) {
  const entries = status?.entries ?? [];
  // 只有一个候选时不显示选择器：没有可选项的控件只是噪音。
  if (entries.length < 2) return null;

  const value = status?.selectedIp ?? '';
  return h('div', { className: `${PREFIX}-selectWrap` },
    h('select', {
      className: `${PREFIX}-select`,
      'aria-label': t('field.network'),
      value,
      disabled,
      onChange: (event) => onSelect(event.target.value),
    },
      h('option', { value: '' }, t('network.auto')),
      entries.map((entry) => h('option', { key: entry.address, value: entry.address },
        `${entry.address} · ${entry.label}${entry.url ? '' : ` · ${t('network.unusable')}`}`)),
    ),
    h('span', { className: `${PREFIX}-selectCaret`, 'aria-hidden': 'true' },
      h(SpriteIcon, { symbol: 'dsw-icon-chevron-down-outline-medium', size: 16 })),
  );
}

/** 主卡片：状态 + 地址 + 二维码 + 网络选择。 */
function MainCard({ t, status, busy, onSelect, onRefresh }) {
  const primary = status?.primary ?? null;
  const url = primary?.url ?? null;

  return h('div', { className: `${PREFIX}-card` },
    h(StatusRow, { t, status, busy, onRefresh }),

    // 没有任何可用入口时，只在这一种情况下解释原因
    !url && status?.error && h('p', { className: `${PREFIX}-notice`, role: 'status' },
      t(({
        'port-in-use': 'error.portInUse',
        'no-interface': 'error.noInterface',
        'auth-failed': 'error.authFailed',
      })[status.error.code] ?? 'error.listenFailed',
      { port: status?.port ?? LAN_PORT })),

    url && h('div', { className: `${PREFIX}-row` },
      h('code', { className: `${PREFIX}-address`, title: url }, url),
      h(CopyButton, { t, url, link: primary.link }),
      h('a', {
        className: `${PREFIX}-btn`,
        href: primary.link || url,
        target: '_blank',
        rel: 'noreferrer',
      }, t('address.open')),
    ),

    url && h('div', { className: `${PREFIX}-qrRow` },
      primary.qr
        ? h('img', { className: `${PREFIX}-qr`, src: primary.qr, alt: t('qr.alt'), width: 160, height: 160 })
        : null,
      h('div', { className: `${PREFIX}-qrSide` },
        h('div', { className: `${PREFIX}-facts` },
          h('div', { className: `${PREFIX}-fact` },
            h('span', { className: `${PREFIX}-factKey` }, t('field.network')),
            h('span', { className: `${PREFIX}-factValue` }, `${primary.address} · ${primary.label}`)),
          h('div', { className: `${PREFIX}-fact` },
            h('span', { className: `${PREFIX}-factKey` }, t('field.port')),
            h('span', { className: `${PREFIX}-factValue` }, String(status?.port ?? LAN_PORT))),
        ),
      ),
    ),

    h(NetworkSelect, {
      t, status, disabled: busy, onSelect,
    }),
  );
}

/**
 * 局域网访问面板。
 * @param {{t: (key: string, vars?: object) => string}} props
 */
function LanPanel({ t }) {
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const sequence = React.useRef(0);
  const inFlight = React.useRef(false);
  /** 是否已经拿到过至少一次状态；用于区分「首次失败」与「轮询抖动」。 */
  const hasStatusRef = React.useRef(false);
  const ctx = window.__dshClientCtx;

  const load = React.useCallback(async () => {
    if (!ctx || inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current;
    try {
      const result = await call(ctx, ENDPOINTS.getStatus);
      if (current !== sequence.current) return;
      if (result.ok) {
        hasStatusRef.current = true;
        setStatus(result.value);
        // 一次成功就清掉历史错误：面板不该一边显示可用地址一边挂着红条。
        setError(null);
      } else {
        // 轮询失败多半是瞬时抖动（连接重建、页面切后台）。已经有数据时保持静默，
        // 交给下一次轮询自愈；只有完全拿不到状态时才打扰用户。
        setError((previous) => (hasStatusRef.current ? previous : describeFailure(t, result.message)));
      }
    } finally {
      inFlight.current = false;
    }
  }, [ctx]);

  React.useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  /**
   * 串行化执行一次带反馈的操作。
   *
   * busy 期间拒绝再次触发，避免连点造成重复检测。重检本身在本机只要几毫秒，
   * 直接结束会让图标完全不转、防连点窗口也形同虚设，因此给「忙碌态」保底
   * MIN_BUSY_MS：操作真的跑完，只是不把反馈瞬间抹掉（不是假进度条）。
   */
  const run = React.useCallback(async (endpoint, payload) => {
    if (!ctx || busy) return;
    setBusy(true);
    const startedAt = Date.now();
    try {
      const result = await call(ctx, endpoint, payload);
      if (result.ok) {
        setStatus(result.value);
        setError(null);
      } else {
        setError(describeFailure(t, result.message));
      }
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_BUSY_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_BUSY_MS - elapsed));
      }
      setBusy(false);
    }
  }, [ctx, busy]);

  const onSelect = React.useCallback((ip) => {
    void run(ENDPOINTS.setLanIp, { ip });
  }, [run]);

  if (!status && !error) {
    return h('div', { className: `${PREFIX}-section` });
  }

  return h('div', { className: `${PREFIX}-section` },
    h('div', { className: `${PREFIX}-head` },
      h('h2', { className: `${PREFIX}-title` }, t('section.title')),
      h('p', { className: `${PREFIX}-intro` }, t('section.intro')),
    ),

    // 只有「确实给不出可用入口」时才报错。轮询偶发抖动不该在已经能用的面板上
    // 挂一条红条——那会让用户怀疑一个其实正常的地址。
    error && !status?.available
      && h('p', { className: `${PREFIX}-notice`, role: 'alert' }, t('error.load', { message: error })),

    status && h(MainCard, {
      t, status, busy, onSelect, onRefresh: () => { void run(ENDPOINTS.refresh); },
    }),
  );
}

// ---- 插件 -----------------------------------------------------------------

// locale 故意不写进 inject：宿主环境没有该服务时也要能激活（用内置兜底文案）。
const inject = ['slots', 'connection'];

/**
 * 创建翻译器：优先用宿主 locale 服务，拿不到就按 <html lang> 本地兜底。
 * @param {object} ctx
 * @returns {(key: string, vars?: object) => string}
 */
function createTranslator(ctx) {
  const dictionaries = { zh, en };
  let translate = null;

  try {
    if (typeof ctx.locale?.register === 'function') {
      ctx.effect?.(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-remote: locale dictionary');
      if (typeof ctx.locale.bind === 'function') translate = ctx.locale.bind(LOCALE_NAMESPACE);
    }
  } catch { /* 旧宿主没有 locale 服务：走下面的兜底 */ }

  const isChinese = () => {
    const lang = typeof document !== 'undefined' ? (document.documentElement.lang || '') : '';
    return /^zh/i.test(lang) || (!lang && typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || ''));
  };

  return (key, vars) => {
    let text;
    if (translate) {
      try { text = translate(key, vars); } catch { text = undefined; }
    }
    if (text === undefined || text === key) {
      const dict = isChinese() ? dictionaries.zh : dictionaries.en;
      text = dict[key] ?? dictionaries.en[key] ?? key;
    }
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`\${${name}}`).join(String(value));
      }
    }
    return text;
  };
}

/** 导航图标。 */
function NavIcon({ size = 16 }) {
  const px = Number(size) > 0 ? Number(size) : 16;
  return h(SpriteIcon, { symbol: NAV_ICON_SYMBOL, size: px });
}

function apply(ctx) {
  window.__dshClientCtx = ctx;
  const t = createTranslator(ctx);

  ctx.effect(() => installStyles(PREFIX), 'dsh-remote: panel styles');

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote',
    order: 10,
    label: () => t('section.title'),
    inject: () => ({ t }),
  }, LanPanel));

  // 设置页左侧导航图标：注册到官方 settings.section.icon 槽位，按行 id 取用。
  try {
    ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
      { name: 'settings.section.icon', id: 'dsh-remote', order: 10 },
      NavIcon,
    ));
  } catch { /* 旧宿主没有该槽位：宿主会画默认齿轮，不影响功能 */ }

}

module.exports = { inject, apply, LanPanel, panelCss, createTranslator };
